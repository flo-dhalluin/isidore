import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runner, buildSandboxArgs, buildWorkerRequest, prepareAgentDir, summariseEvent } from "../src/runner.ts";
import { TaskStore, createTask } from "../src/store.ts";
import { TokenRegistry } from "../src/tokens.ts";

const SANDBOX_BIN = join(import.meta.dirname, "..", "sandbox", "isidore-sandbox");

function fakeWorker(dir: string, body: string): string {
  const path = join(dir, "worker.sh");
  writeFileSync(path, `#!/bin/sh\n${body}`);
  return path;
}

async function waitDone(store: TaskStore, id: string, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const task = store.get(id);
    if (task && ["succeeded", "failed", "cancelled", "timeout"].includes(task.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("task did not finish");
}

test("buildWorkerRequest prefers the task model", () => {
  const task = createTask("hello", { model: "task-model" });
  const request = buildWorkerRequest(task, "default-model");
  assert.equal(request.prompt, "hello");
  assert.equal(request.model, "task-model");
  assert.equal(request.sessionId, task.id);
  assert.equal(request.apiKey, null);
  assert.equal(buildWorkerRequest(task, null, "sk-or-x").apiKey, "sk-or-x");
});

test("summariseEvent extracts streamed text", () => {
  assert.equal(
    summariseEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abc" } }),
    "abc",
  );
  assert.equal(summariseEvent({ type: "message_end", message: { role: "assistant" } }), null);
  assert.equal(summariseEvent({ type: "something_new" }), null);
});

test("json mode builds a transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const script = fakeWorker(
      dir,
      "cat >/dev/null\nprintf '%s\\n' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"Hel\"}}' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"lo\"}}'\n",
    );
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "json",
      unsafeNoSandbox: true,
    });
    const task = runner.create("json");
    await waitDone(store, task.id);
    assert.equal(task.status, "succeeded");
    assert.match(task.output, /Hello/);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("json mode captures tool calls and does not duplicate streamed text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const events = [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "thinking" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "thinking" }] } },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.txt" } },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false, durationMs: 12 },
      { type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_end", toolCallId: "c2", toolName: "bash", isError: true },
    ];
    const script = fakeWorker(dir, `cat >/dev/null\nprintf '%s\\n' ${events.map((e) => `'${JSON.stringify(e)}'`).join(" ")}\n`);
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "json",
      unsafeNoSandbox: true,
    });
    const task = runner.create("tools");
    await waitDone(store, task.id);
    assert.equal(task.status, "succeeded");
    // The streamed delta and the final message must not both appear.
    assert.equal(task.output.match(/thinking/g)?.length, 1);
    assert.equal(task.tool_calls.length, 2);
    assert.deepEqual(
      task.tool_calls.map((call) => [call.name, call.status]),
      [["read", "ok"], ["bash", "error"]],
    );
    assert.equal(task.tool_calls[0].duration_ms, 12);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("print mode keeps the final answer but still records tool calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const events = [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "let me look" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "let me look" }] } },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a" } },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "the answer" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the answer" }] } },
    ];
    const script = fakeWorker(dir, `cat >/dev/null\nprintf '%s\\n' ${events.map((e) => `'${JSON.stringify(e)}'`).join(" ")}\n`);
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      unsafeNoSandbox: true,
    });
    const task = runner.create("print with tools");
    await waitDone(store, task.id);
    assert.equal(task.status, "succeeded");
    assert.equal(task.output, "the answer");
    assert.deepEqual(task.tool_calls.map((call) => call.name), ["read"]);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("print mode captures the final text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const script = fakeWorker(dir, "cat >/dev/null\nprintf 'final answer\\n'\n");
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      unsafeNoSandbox: true,
    });
    const task = runner.create("print");
    await waitDone(store, task.id);
    assert.equal(task.status, "succeeded");
    assert.match(task.output, /final answer/);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs a TypeScript worker with type stripping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const script = join(dir, "worker.ts");
    writeFileSync(
      script,
      [
        "const chunks: Buffer[] = [];",
        "for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as string));",
        "const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
        "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ts:' + request.prompt }] } }) + '\\n');",
      ].join("\n"),
    );
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: process.execPath,
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "json",
      unsafeNoSandbox: true,
    });
    const task = runner.create("devmode");
    await waitDone(store, task.id);
    assert.equal(task.status, "succeeded");
    assert.match(task.output, /ts:devmode/);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failure captures stderr and exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const script = fakeWorker(dir, "cat >/dev/null\necho boom >&2\nexit 3\n");
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      unsafeNoSandbox: true,
    });
    const task = runner.create("fail");
    await waitDone(store, task.id);
    assert.equal(task.status, "failed");
    assert.equal(task.exit_code, 3);
    assert.match(task.error ?? "", /boom/);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Phase 0 isolation (Worker A) ---

test("buildSandboxArgs allows the workspace, ro targets and devices, never /state or secrets", () => {
  const args = buildSandboxArgs("/state/workspaces/t_1", ["/state/pi/npm", "/state/pi/extensions"]);
  assert.equal(args[0], "--rw");
  assert.equal(args[1], "/state/workspaces/t_1");
  const joined = args.join(" ");
  assert.ok(joined.includes("--ro /state/pi/npm"));
  assert.ok(joined.includes("--ro /state/pi/extensions"));
  assert.ok(joined.includes("--rw /dev/null"));
  assert.ok(joined.includes("--rw /dev/tty"));
  assert.ok(joined.includes("--rx /usr"));
  assert.ok(joined.includes("--ro /proc/self"));
  // Deny-by-default: no wholesale access to state, secrets or tmp.
  assert.ok(!args.includes("/state"));
  assert.ok(!args.includes("/state/pi"));
  assert.ok(!args.includes("/run/secrets"));
  assert.ok(!args.includes("/tmp"));
  assert.ok(!args.includes("/proc"));
});

test("prepareAgentDir copies config, symlinks the rest, denies secrets; idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-agentdir-"));
  try {
    const shared = join(dir, "shared-pi");
    const ws = join(dir, "ws");
    mkdirSync(join(shared, "npm", "pkg"), { recursive: true });
    mkdirSync(join(shared, "sessions"), { recursive: true });
    mkdirSync(join(shared, "web-search-cache"), { recursive: true });
    mkdirSync(join(shared, "tmp"), { recursive: true });
    writeFileSync(join(shared, "models.json"), '{"models":1}\n');
    writeFileSync(join(shared, "mcp.json"), '{"servers":1}\n');
    writeFileSync(join(shared, "settings.json"), "{}\n");
    writeFileSync(join(shared, "auth.json"), '{"secret":1}\n');
    writeFileSync(join(shared, ".seed"), "tag");
    writeFileSync(join(shared, "store.lock"), "lock");
    writeFileSync(join(shared, "npm", "pkg", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(shared, "sessions", "s.jsonl"), "{}\n");

    const targets = prepareAgentDir(ws, shared);
    const pi = join(ws, ".pi");
    // Small configs are per-task writable copies.
    for (const name of ["models.json", "mcp.json", "settings.json"]) {
      assert.ok(lstatSync(join(pi, name)).isFile(), `${name} must be a copy`);
      assert.equal(readFileSync(join(pi, name), "utf8"), readFileSync(join(shared, name), "utf8"));
    }
    // Everything else is a symlink to the shared dir (Landlock gets the target).
    assert.ok(lstatSync(join(pi, "npm")).isSymbolicLink());
    assert.equal(readlinkSync(join(pi, "npm")), join(shared, "npm"));
    assert.ok(targets.includes(join(shared, "npm")));
    // Denylisted entries never appear.
    for (const name of ["auth.json", "sessions", ".seed", "store.lock", "tmp"]) {
      assert.ok(!existsSync(join(pi, name)), `${name} must not leak`);
    }
    // web-search-cache is a real writable per-task dir.
    assert.ok(lstatSync(join(pi, "web-search-cache")).isDirectory());

    // Idempotent refresh (followup): copies updated, targets still returned.
    writeFileSync(join(shared, "mcp.json"), '{"servers":2}\n');
    const again = prepareAgentDir(ws, shared);
    assert.equal(readFileSync(join(pi, "mcp.json"), "utf8"), '{"servers":2}\n');
    assert.ok(again.includes(join(shared, "npm")));
    assert.ok(lstatSync(join(pi, "npm")).isSymbolicLink());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails closed when the sandbox binary is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const tokens = new TokenRegistry();
    const script = fakeWorker(dir, "cat >/dev/null\necho should-not-run\n");
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      tokens,
      sandboxBin: join(dir, "no-such-sandbox"),
    });
    const task = runner.create("fail-closed");
    await waitDone(store, task.id);
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /sandbox binary not found/);
    assert.ok(!task.output.includes("should-not-run"));
    // The token minted before the failure was revoked: no registry leak.
    assert.equal(tokens.size, 0);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("api key travels via the stdin request, never the exec env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const script = fakeWorker(dir, "cat > request.json\nenv > env-dump.txt\n");
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      unsafeNoSandbox: true,
      baseEnv: { ...process.env, OPENROUTER_API_KEY: "sk-or-stdin-test" },
    });
    const task = runner.create("key");
    await waitDone(store, task.id);
    assert.equal(task.status, "succeeded");
    const workspace = runner.workspaceFor(task);
    const request = JSON.parse(readFileSync(join(workspace, "request.json"), "utf8"));
    assert.equal(request.apiKey, "sk-or-stdin-test");
    const dump = readFileSync(join(workspace, "env-dump.txt"), "utf8");
    assert.ok(!dump.includes("OPENROUTER_API_KEY"), "key must be absent from the worker exec env");
    assert.ok(!dump.includes("sk-or-stdin-test"));
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsafeNoSandbox override runs without the launcher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const script = fakeWorker(dir, "cat >/dev/null\nprintf 'unsafe-ok\\n'\n");
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      sandboxBin: join(dir, "no-such-sandbox"),
      unsafeNoSandbox: true,
    });
    const task = runner.create("unsafe");
    await waitDone(store, task.id);
    assert.equal(task.status, "succeeded");
    assert.match(task.output, /unsafe-ok/);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mints a task token while running and revokes it at finalise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const tokens = new TokenRegistry();
    const script = fakeWorker(dir, "cat >/dev/null\nenv > env-dump.txt\nsleep 0.3\n");
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      tokens,
      unsafeNoSandbox: true,
      baseEnv: {
        ...process.env,
        ISIDORE_SCHEDULER_TOKEN: "svc-secret",
        SCHEDULER_TOKEN: "sched-secret",
        PI_SANDBOX_BROWSER_URL: "http://browser",
      },
    });
    const task = runner.create("token", { origin: "telegram" });
    const dumpPath = join(runner.workspaceFor(task), "env-dump.txt");
    // While the worker runs, its token resolves to the conversation scope.
    let dump = "";
    for (let i = 0; i < 200 && !dump; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (existsSync(dumpPath)) dump = readFileSync(dumpPath, "utf8");
    }
    assert.ok(dump, "worker never dumped its env");
    const match = dump.match(/^ISIDORE_TASK_TOKEN=([0-9a-f]{64})$/m);
    assert.ok(match, "ISIDORE_TASK_TOKEN missing from worker env");
    assert.deepEqual(tokens.resolve(match![1]), { taskId: task.id, rootId: task.id, origin: "telegram" });
    assert.match(dump, /^ISIDORE_TASK_ORIGIN=telegram$/m);
    // Service credentials never reach the worker.
    assert.ok(!dump.includes("svc-secret"));
    assert.ok(!dump.includes("sched-secret"));
    assert.ok(!dump.includes("ISIDORE_SCHEDULER_TOKEN"));
    assert.ok(!dump.includes("PI_SANDBOX_"));
    await waitDone(store, task.id);
    assert.equal(task.status, "succeeded");
    // Revoked once the task finalises.
    assert.equal(tokens.resolve(match![1]), undefined);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("followup reuses the conversation workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const script = fakeWorker(
      dir,
      'cat >/dev/null\nif [ -f marker.txt ]; then printf "second:%s\\n" "$(cat marker.txt)"; else printf first > marker.txt; printf "first\\n"; fi\n',
    );
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      unsafeNoSandbox: true,
    });
    const first = runner.create("one");
    await waitDone(store, first.id);
    assert.equal(first.status, "succeeded");
    assert.match(first.output, /first/);
    const second = runner.create("two", { thread_id: first.id, parent_id: first.id });
    await waitDone(store, second.id);
    assert.equal(second.status, "succeeded");
    assert.match(second.output, /second:first/);
    assert.equal(runner.workspaceFor(second), runner.workspaceFor(first));
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Real-launcher integration: the binary is built by `pretest` (make -C sandbox).
// These tests fail loudly if it is absent — no skipping.

test("real launcher: worker runs sandboxed (workspace writes ok, outside denied)", async () => {
  assert.ok(existsSync(SANDBOX_BIN), `missing ${SANDBOX_BIN} — run: make -C sandbox (npm pretest does this)`);
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  const outside = mkdtempSync(join(tmpdir(), "isidore-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "top-secret");
    const store = new TaskStore(join(dir, "tasks"));
    const script = fakeWorker(
      dir,
      [
        "cat >/dev/null",
        "echo inside > inside.txt",
        `if cat ${join(outside, "secret.txt")} 2>/dev/null; then echo read-leak; else echo read-denied; fi`,
        `if echo x > ${join(outside, "new.txt")} 2>/dev/null; then echo write-leak; else echo write-denied; fi`,
      ].join("\n"),
    );
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      sandboxBin: SANDBOX_BIN,
      agentDir: join(dir, "shared-pi"),
    });
    const task = runner.create("sandboxed");
    await waitDone(store, task.id, 15000);
    assert.equal(task.status, "succeeded", task.error ?? "");
    assert.match(task.output, /read-denied/);
    assert.match(task.output, /write-denied/);
    assert.ok(!task.output.includes("leak"));
    assert.equal(readFileSync(join(runner.workspaceFor(task), "inside.txt"), "utf8"), "inside\n");
    assert.ok(!existsSync(join(outside, "new.txt")));
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("real launcher: per-task .pi symlinks are readable, shared dir writes denied", async () => {
  assert.ok(existsSync(SANDBOX_BIN), `missing ${SANDBOX_BIN} — run: make -C sandbox (npm pretest does this)`);
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const shared = join(dir, "shared-pi");
    mkdirSync(join(shared, "npm", "pkg"), { recursive: true });
    writeFileSync(join(shared, "npm", "pkg", "index.js"), "module.exports = 42;\n");
    writeFileSync(join(shared, "mcp.json"), '{"servers":1}\n');
    writeFileSync(join(shared, "auth.json"), '{"secret":1}\n');
    const store = new TaskStore(join(dir, "tasks"));
    const script = fakeWorker(
      dir,
      [
        "cat >/dev/null",
        "cat .pi/npm/pkg/index.js",
        // Prefix the content: a bare `{"servers":1}` line is valid JSON and
        // would be consumed (and dropped) by the runner's JSONL parser.
        'echo "mcp-content: $(cat .pi/mcp.json)"',
        "if cat .pi/auth.json 2>/dev/null; then echo auth-leak; else echo auth-denied; fi",
        `if echo x > ${join(shared, "mcp.json")} 2>/dev/null; then echo shared-write-leak; else echo shared-write-denied; fi`,
      ].join("\n"),
    );
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      sandboxBin: SANDBOX_BIN,
      agentDir: shared,
    });
    const task = runner.create("agent-dir");
    await waitDone(store, task.id, 15000);
    assert.equal(task.status, "succeeded", task.error ?? "");
    assert.match(task.output, /module\.exports = 42/);
    assert.match(task.output, /mcp-content: \{"servers":1\}/);
    // mcp.json is COPIED into the per-task dir (writable), not symlinked.
    const wsCopy = join(runner.workspaceFor(task), ".pi", "mcp.json");
    assert.ok(existsSync(wsCopy), "per-task .pi/mcp.json copy missing");
    assert.equal(readFileSync(wsCopy, "utf8"), '{"servers":1}\n');
    assert.ok(!lstatSync(wsCopy).isSymbolicLink(), "mcp.json must be a copy, not a symlink");
    assert.match(task.output, /auth-denied/);
    assert.match(task.output, /shared-write-denied/);
    assert.equal(readFileSync(join(shared, "mcp.json"), "utf8"), '{"servers":1}\n');
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real launcher: task token reaches the worker, service env does not", async () => {
  assert.ok(existsSync(SANDBOX_BIN), `missing ${SANDBOX_BIN} — run: make -C sandbox (npm pretest does this)`);
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const tokens = new TokenRegistry();
    const script = fakeWorker(dir, "cat >/dev/null\nenv > env-dump.txt\ntr '\\0' '\\n' < /proc/self/environ > proc-dump.txt\n");
    const runner = new Runner({
      store,
      workspaceRoot: join(dir, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      sandboxBin: SANDBOX_BIN,
      agentDir: join(dir, "shared-pi"),
      tokens,
      baseEnv: { ...process.env, ISIDORE_TOKEN: "admin-secret", OPENROUTER_API_KEY: "sk-or-test" },
    });
    const task = runner.create("env");
    await waitDone(store, task.id, 15000);
    assert.equal(task.status, "succeeded", task.error ?? "");
    const dump = readFileSync(join(runner.workspaceFor(task), "env-dump.txt"), "utf8");
    const match = dump.match(/^ISIDORE_TASK_TOKEN=([0-9a-f]{64})$/m);
    assert.ok(match, "task token missing under the launcher");
    assert.match(dump, /^ISIDORE_TASK_ORIGIN=web$/m);
    assert.ok(!dump.includes("admin-secret"));
    // The key never enters the exec env: it travels via the stdin request, so
    // it is absent from `env` AND from the worker's own /proc/self/environ
    // (which reflects exec-time env and is readable by in-worker tools).
    assert.ok(!dump.includes("OPENROUTER_API_KEY"));
    assert.ok(!dump.includes("sk-or-test"));
    const procDump = readFileSync(join(runner.workspaceFor(task), "proc-dump.txt"), "utf8");
    assert.ok(!procDump.includes("OPENROUTER_API_KEY"));
    assert.ok(!procDump.includes("sk-or-test"));
    assert.equal(tokens.resolve(match![1]), undefined);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
