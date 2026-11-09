import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runner, buildWorkerRequest, summariseEvent } from "../src/runner.ts";
import { TaskStore, createTask } from "../src/store.ts";

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
