import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runner, buildSandboxArgs, buildWorkerRequest, prepareAgentDir, summariseEvent } from "../src/runner.ts";
import { TaskStore, createTask } from "../src/store.ts";
import { TokenRegistry } from "../src/tokens.ts";
import { ToolRegistry, type ResolvedTool } from "../src/tools.ts";

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

/** True if pid is gone (or an unreaped zombie — dead, just not reaped by pid 1). */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

test("buildWorkerRequest prefers the task model", () => {
  const task = createTask("hello", { model: "task-model" });
  const request = buildWorkerRequest(task, "default-model");
  assert.equal(request.prompt, "hello");
  assert.equal(request.model, "task-model");
  assert.equal(request.sessionId, task.id);
  assert.equal(request.apiKey, null);
  assert.equal(request.tools, undefined);
  assert.equal(buildWorkerRequest(task, null, "sk-or-x").apiKey, "sk-or-x");
});

test("buildWorkerRequest carries the resolved tool set (additive)", () => {
  const task = createTask("hello");
  const tools: ResolvedTool[] = [
    {
      manifest: {
        id: "tl_0123456789ab",
        name: "echoer",
        version: 1,
        kind: "command",
        description: "echo",
        scope: "conversation",
        status: "active",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
        command: { argv: ["echo", "{{text}}"], files: { "run.sh": "#!/bin/sh\n" } },
        provenance: { task_id: task.id, root_id: task.id, origin: "task", created_at: "now", sha256: "x" },
      },
      cachePath: "/state/tool-cache/" + task.id + "/tl_0123456789ab/1",
    },
  ];
  const request = buildWorkerRequest(task, null, null, tools);
  assert.deepEqual(request.tools, tools);
  // Without tools the field stays absent (old workers ignore it either way).
  assert.ok(!("tools" in buildWorkerRequest(task, null)));
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

test("buildSandboxArgs appends tool-cache paths (rx), never /state/tools", () => {
  const args = buildSandboxArgs("/state/workspaces/t_1", [], ["/state/tool-cache/t_1"]);
  const joined = args.join(" ");
  assert.ok(joined.includes("--rx /state/tool-cache/t_1"));
  // The registry itself stays service-only: never listed, even as a parent.
  assert.ok(!joined.includes("/state/tools"));
  assert.ok(!args.includes("/state"));
  // Default: no extra entries.
  assert.deepEqual(buildSandboxArgs("/state/workspaces/t_1", []), buildSandboxArgs("/state/workspaces/t_1", [], []));
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
    writeFileSync(join(shared, "models-store.json"), '{"openrouter":{}}\n');
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
    for (const name of ["models.json", "models-store.json", "mcp.json", "settings.json"]) {
      assert.ok(lstatSync(join(pi, name)).isFile(), `${name} must be a copy`);
      assert.equal(readFileSync(join(pi, name), "utf8"), readFileSync(join(shared, name), "utf8"));
    }
    // mcp.json is neither copied nor linked any more (Phase 2: MCP servers
    // are registered per worker by the registry extension).
    assert.ok(!existsSync(join(pi, "mcp.json")), "mcp.json must not be copied or linked");
    assert.ok(!targets.includes(join(shared, "mcp.json")));
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
    writeFileSync(join(shared, "models.json"), '{"models":2}\n');
    const again = prepareAgentDir(ws, shared);
    assert.equal(readFileSync(join(pi, "models.json"), "utf8"), '{"models":2}\n');
    assert.ok(again.includes(join(shared, "npm")));
    assert.ok(lstatSync(join(pi, "npm")).isSymbolicLink());

    // A workspace created before models-store.json was copied may still have a
    // symlink there; a followup must replace the link with a real copy. Pi
    // locks the resolved file, so writing through the link would land in the
    // read-only shared dir.
    rmSync(join(pi, "models-store.json"));
    symlinkSync(join(shared, "models-store.json"), join(pi, "models-store.json"));
    prepareAgentDir(ws, shared);
    assert.ok(!lstatSync(join(pi, "models-store.json")).isSymbolicLink());
    writeFileSync(join(pi, "models-store.json"), '{"openrouter":{"local":true}}\n');
    assert.equal(readFileSync(join(shared, "models-store.json"), "utf8"), '{"openrouter":{}}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareAgentDir deletes a stale per-task mcp.json on refresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-agentdir-"));
  try {
    const shared = join(dir, "shared-pi");
    const ws = join(dir, "ws");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "mcp.json"), '{"mcpServers":{"evil":{"url":"http://evil"}}}\n');
    // A leftover copy from a pre-Phase-2 spawn must not survive a refresh.
    mkdirSync(join(ws, ".pi"), { recursive: true });
    writeFileSync(join(ws, ".pi", "mcp.json"), '{"mcpServers":{"stale":{"url":"http://stale"}}}\n');
    const targets = prepareAgentDir(ws, shared);
    assert.ok(!existsSync(join(ws, ".pi", "mcp.json")), "stale mcp.json must be removed");
    assert.ok(!targets.includes(join(shared, "mcp.json")));
    // And a second refresh stays clean.
    prepareAgentDir(ws, shared);
    assert.ok(!existsSync(join(ws, ".pi", "mcp.json")));
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
        // mcp.json is no longer copied or linked (Phase 2): reading it fails.
        'if cat .pi/mcp.json 2>/dev/null; then echo "mcp-content: $(cat .pi/mcp.json)"; else echo mcp-absent; fi',
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
    assert.match(task.output, /mcp-absent/);
    // No per-task mcp.json copy or symlink exists any more.
    const wsCopy = join(runner.workspaceFor(task), ".pi", "mcp.json");
    assert.ok(!existsSync(wsCopy), "per-task .pi/mcp.json must not exist");
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

// --- Phase 2: composition at spawn ---

test("execute copies command sources into the tool-cache and passes resolved tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const registry = new ToolRegistry(join(dir, "tools"), {});
    const manifest = registry.create(
      {
        name: "echoer",
        kind: "command",
        description: "echo text",
        input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        command: { argv: ["echo", "{{text}}"], files: { "run.sh": "#!/bin/sh\necho cached-source\n", "lib/helper.sh": "echo helper\n" } },
      },
      { scope: "conversation", rootId: "t_conv", taskId: "t_conv-1", origin: "task" },
    );
    const script = fakeWorker(dir, "cat > request.json\n");
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
      registry,
      toolCacheRoot: join(dir, "tool-cache"),
    });
    // Pin the conversation root so the cache layout is predictable.
    const task = runner.create("compose", { thread_id: "t_conv" });
    await waitDone(store, task.id);
    assert.equal(task.status, "succeeded");
    const request = JSON.parse(readFileSync(join(runner.workspaceFor(task), "request.json"), "utf8"));
    assert.ok(Array.isArray(request.tools));
    const resolved = request.tools.find((tool: { manifest: { id: string } }) => tool.manifest.id === manifest.id);
    assert.ok(resolved, "resolved tool missing from the worker request");
    const cachePath = join(dir, "tool-cache", "t_conv", manifest.id, "1");
    assert.equal(resolved.cachePath, cachePath);
    assert.equal(readFileSync(join(cachePath, "run.sh"), "utf8"), "#!/bin/sh\necho cached-source\n");
    assert.equal(readFileSync(join(cachePath, "lib", "helper.sh"), "utf8"), "echo helper\n");
    // Sources are executable and the Landlock cache rule is --rx, so a shebang
    // script named as argv[0] runs directly under the sandbox.
    assert.ok(statSync(join(cachePath, "run.sh")).mode & 0o111);
    // Builtin informational entries travel too, with no cache copy.
    const builtin = request.tools.find((tool: { manifest: { id: string } }) => tool.manifest.id === "builtin:codemode");
    assert.ok(builtin);
    assert.equal(builtin.cachePath, null);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool-cache copies are immutable: an existing version dir is never rewritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const store = new TaskStore(join(dir, "tasks"));
    const registry = new ToolRegistry(join(dir, "tools"), {});
    const manifest = registry.create(
      {
        name: "echoer",
        kind: "command",
        description: "echo text",
        input_schema: { type: "object", properties: {} },
        command: { argv: ["echo", "hi"], files: { "run.sh": "#!/bin/sh\necho v1\n" } },
      },
      { scope: "conversation", rootId: "t_fixed", taskId: "t_fixed-1", origin: "task" },
    );
    // Pre-existing cache copy (e.g. staged by an earlier spawn): sentinel must survive.
    const cachePath = join(dir, "tool-cache", "t_fixed", manifest.id, "1");
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, "sentinel.txt"), "do-not-touch");
    const script = fakeWorker(dir, "cat > request.json\n");
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
      registry,
      toolCacheRoot: join(dir, "tool-cache"),
    });
    const task = createTask("immutable", { id: "t_fixed", thread_id: "t_fixed" });
    runner.submit(task);
    await waitDone(store, task.id);
    assert.equal(task.status, "succeeded");
    assert.equal(readFileSync(join(cachePath, "sentinel.txt"), "utf8"), "do-not-touch");
    assert.ok(!existsSync(join(cachePath, "run.sh")), "absent-only copy must not fill in an existing dir");
    const request = JSON.parse(readFileSync(join(runner.workspaceFor(task), "request.json"), "utf8"));
    const resolved = request.tools.find((tool: { manifest: { id: string } }) => tool.manifest.id === manifest.id);
    assert.equal(resolved.cachePath, cachePath);
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup sweeps crash-orphaned .tmp-* staging dirs in the tool-cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  try {
    const cacheRoot = join(dir, "tool-cache");
    const toolDir = join(cacheRoot, "t_conv", "tl_0123456789ab");
    const orphan = join(toolDir, ".tmp-deadbeef");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "run.sh"), "partial staging");
    const versionDir = join(toolDir, "1");
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(join(versionDir, "run.sh"), "#!/bin/sh\necho v1\n");
    const options = {
      store: new TaskStore(join(dir, "tasks")),
      workspaceRoot: join(dir, "ws"),
      workerScript: fakeWorker(dir, "true"),
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print" as const,
      unsafeNoSandbox: true,
    };
    const runner = new Runner({ ...options, toolCacheRoot: cacheRoot });
    // The orphan is swept; the immutable version dir is untouched.
    assert.ok(!existsSync(orphan));
    assert.equal(readFileSync(join(versionDir, "run.sh"), "utf8"), "#!/bin/sh\necho v1\n");
    // A missing cache root is fine (nothing to sweep).
    const absent = new Runner({ ...options, toolCacheRoot: join(dir, "absent-cache") });
    await runner.close();
    await absent.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real launcher: tool-cache readable, /state/tools denied, cache not writable", async () => {
  assert.ok(existsSync(SANDBOX_BIN), `missing ${SANDBOX_BIN} — run: make -C sandbox (npm pretest does this)`);
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  const state = mkdtempSync(join(tmpdir(), "isidore-state-"));
  try {
    const store = new TaskStore(join(state, "tasks"));
    const registry = new ToolRegistry(join(state, "tools"), {});
    const manifest = registry.create(
      {
        name: "echoer",
        kind: "command",
        description: "echo text",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
        command: { argv: ["echo", "{{text}}"], files: { "hello.sh": "#!/bin/sh\necho hello-from-cache\n" } },
      },
      { scope: "conversation", rootId: "t_conv", taskId: "t_conv-1", origin: "task" },
    );
    const sourceFile = join(state, "tools", manifest.id, "1", "files", "hello.sh");
    // The fake worker extracts cachePath from the stdin request, then probes
    // the cache (read ok, write denied) and the registry (read denied).
    const script = fakeWorker(
      dir,
      [
        "cat > request.json",
        `cache=$(grep -o '"cachePath":"[^"]*"' request.json | head -n 1 | cut -d'"' -f4)`,
        'if cat "$cache/hello.sh" >/dev/null 2>&1; then echo cache-read-ok; else echo cache-read-denied; fi',
        'if echo x > "$cache/new.txt" 2>/dev/null; then echo cache-write-leak; else echo cache-write-denied; fi',
        `if cat ${sourceFile} >/dev/null 2>&1; then echo tools-read-leak; else echo tools-read-denied; fi`,
        `if echo x > ${join(state, "tools", "new.txt")} 2>/dev/null; then echo tools-write-leak; else echo tools-write-denied; fi`,
      ].join("\n"),
    );
    const runner = new Runner({
      store,
      workspaceRoot: join(state, "ws"),
      workerScript: script,
      workerBin: "sh",
      maxWorkers: 1,
      timeout: null,
      model: null,
      mode: "print",
      sandboxBin: SANDBOX_BIN,
      agentDir: join(state, "shared-pi"),
      registry,
      toolCacheRoot: join(state, "tool-cache"),
    });
    const task = runner.create("cache", { thread_id: "t_conv" });
    await waitDone(store, task.id, 15000);
    assert.equal(task.status, "succeeded", task.error ?? "");
    assert.match(task.output, /cache-read-ok/);
    assert.match(task.output, /cache-write-denied/);
    assert.match(task.output, /tools-read-denied/);
    assert.match(task.output, /tools-write-denied/);
    assert.ok(!task.output.includes("leak"));
    assert.ok(!existsSync(join(state, "tools", "new.txt")));
    // The service-side copy landed in the cache, executable, source untouched.
    const cacheFile = join(state, "tool-cache", "t_conv", manifest.id, "1", "hello.sh");
    assert.equal(readFileSync(cacheFile, "utf8"), "#!/bin/sh\necho hello-from-cache\n");
    assert.ok(!existsSync(join(state, "tool-cache", "t_conv", manifest.id, "1", "new.txt")));
    await runner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("cancel sweeps detached command-tool grandchildren (whole process tree)", { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-runner-"));
  const pidFile = join(dir, "grandchild.pid");
  const logFile = join(dir, "grandchild.log");
  let grandchild: number | null = null;
  try {
    const store = new TaskStore(join(dir, "tasks"));
    // Mimic registry-extension runCommand: the worker spawns a DETACHED
    // (setsid) background loop — its own session/group, OUTSIDE the worker's
    // group — then stays alive so the task can be cancelled mid-run. The loop
    // records its pid and heartbeats into a marker file.
    const script = fakeWorker(
      dir,
      [
        "cat >/dev/null",
        `setsid sh -c 'echo $$ > "${pidFile}"; while true; do echo alive >> "${logFile}"; sleep 0.2; done' &`,
        "sleep 30",
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
      mode: "json",
      unsafeNoSandbox: true,
    });
    try {
      const task = runner.create("detached-grandchild");
      // Wait until the detached grandchild is up and heartbeating.
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (existsSync(pidFile) && existsSync(logFile)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(existsSync(pidFile), "detached grandchild never started");
      grandchild = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      assert.ok(Number.isInteger(grandchild) && grandchild > 0);
      assert.equal(task.status, "running");
      assert.ok(runner.cancel(task.id));
      await waitDone(store, task.id);
      assert.equal(task.status, "cancelled");
      // The detached grandchild must be swept, not orphaned: its pid is gone
      // (or an unreaped zombie) shortly after the cancel.
      let gone = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (processGone(grandchild)) {
          gone = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(gone, `detached grandchild ${grandchild} survived cancel`);
      // And its heartbeat marker stops growing.
      const size = statSync(logFile).size;
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(statSync(logFile).size, size);
    } finally {
      // Belt and braces: sweep the loop BEFORE close() so a regression fails
      // fast instead of hanging close() on the grandchild's inherited stdout
      // pipe (an orphan keeps the worker's stdio open forever).
      if (grandchild !== null) {
        for (const target of [grandchild, -grandchild]) {
          try {
            process.kill(target, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      await runner.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
