import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server.ts";
import { tasksDir, toolCacheDir, toolsDir, type Settings } from "../src/config.ts";
import { TaskStore, createTask, utcnow } from "../src/store.ts";
import { ToolRegistry, type ToolInput } from "../src/tools.ts";

const ADMIN = "test-token";
const adminAuth = { authorization: `Bearer ${ADMIN}` };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function settingsFor(dir: string): Settings {
  const workerScript = join(dir, "worker.sh");
  writeFileSync(workerScript, "#!/bin/sh\ncat >/dev/null\nprintf 'hello from the agent\\n'\n");
  return {
    stateDir: join(dir, "state"),
    host: "127.0.0.1",
    port: 0,
    token: ADMIN,
    model: null,
    workerScript,
    workerBin: "sh",
    piMode: "print",
    maxWorkers: 2,
    timeout: null,
    maxOutput: 200_000,
    schedulerUrl: null,
    schedulerToken: null,
    schedulerTokenFile: null,
    telegramToken: null,
    telegramChats: new Set(),
    telegramWebhookUrl: null,
    telegramWebhookSecret: null,
    sandboxBin: null,
    unsafeNoSandbox: true,
  };
}

type App = Awaited<ReturnType<typeof createApp>>["app"];

async function waitForTerminal(app: App, id: string): Promise<any> {
  for (let i = 0; i < 250; i++) {
    const response = await app.inject({ method: "GET", url: `/api/tasks/${id}`, headers: adminAuth });
    const task = response.json();
    if (task.done) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("task did not finish");
}

/** Create a task as admin and wait for it to finish; returns its public record. */
async function makeTask(app: App, prompt: string): Promise<any> {
  const created = await app.inject({ method: "POST", url: "/api/tasks", headers: adminAuth, payload: { prompt } });
  assert.equal(created.statusCode, 202);
  return waitForTerminal(app, created.json().id);
}

test("serves the UI, API and runs a task end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const { app } = await createApp(settingsFor(dir));
  try {
    const index = await app.inject({ method: "GET", url: "/", headers: adminAuth });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /id="run"/);
    assert.match(index.body, /isidore/);

    const taskPage = await app.inject({ method: "GET", url: "/tasks/t_abc", headers: adminAuth });
    assert.equal(taskPage.statusCode, 200);
    assert.match(taskPage.body, /id="ask"/);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().ok, true);

    const info = await app.inject({ method: "GET", url: "/api/info", headers: adminAuth });
    assert.equal(info.statusCode, 200);
    assert.equal(info.json().scheduler, false);
    assert.equal(info.json().telegram_mode, null);

    const webhook = await app.inject({ method: "POST", url: "/telegram/webhook", payload: {} });
    assert.equal(webhook.statusCode, 404);
    assert.equal(info.json().max_workers, 2);

    const empty = await app.inject({ method: "POST", url: "/api/tasks", headers: adminAuth, payload: { prompt: "" } });
    assert.equal(empty.statusCode, 400);

    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: adminAuth,
      payload: { prompt: "say hello" },
    });
    assert.equal(created.statusCode, 202);
    const task = created.json();
    assert.equal(task.status, "queued");
    assert.equal(task.done, false);

    const finished = await waitForTerminal(app, task.id);
    assert.equal(finished.status, "succeeded");
    assert.match(finished.output, /hello from the agent/);

    const list = await app.inject({ method: "GET", url: "/api/tasks?limit=50", headers: adminAuth });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);

    const thread = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/thread`, headers: adminAuth });
    assert.equal(thread.statusCode, 200);
    assert.equal(thread.json().id, task.id);
    assert.equal(thread.json().running, false);
    assert.equal(thread.json().turns.length, 1);

    const followup = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/followup`,
      headers: adminAuth,
      payload: { prompt: "again" },
    });
    assert.equal(followup.statusCode, 202);
    const followTask = followup.json();
    assert.equal(followTask.thread_id, task.id);
    await waitForTerminal(app, followTask.id);

    const thread2 = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/thread`, headers: adminAuth });
    assert.equal(thread2.json().turns.length, 2);

    const deleted = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}`, headers: adminAuth });
    assert.equal(deleted.statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/api/tasks", headers: adminAuth })).json().length, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no token => 401 on every authenticated surface", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const { app } = await createApp(settingsFor(dir));
  try {
    for (const [method, url] of [
      ["GET", "/api/info"],
      ["GET", "/api/tasks"],
      ["POST", "/api/tasks"],
      ["GET", "/api/auth/whoami"],
      ["GET", "/"],
      ["GET", "/tasks/t_abc"],
    ] as const) {
      const response = await app.inject({ method, url, payload: method === "POST" ? { prompt: "x" } : undefined });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
    }
    // healthz stays open.
    assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin token via Bearer and ?token=; ?token= is admin-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const { app, tokens } = await createApp(settingsFor(dir));
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/info", headers: adminAuth })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/info?token=${ADMIN}` })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/info?token=wrong` })).statusCode, 401);

    const task = await makeTask(app, "a");
    const taskToken = tokens.issue(task);
    // A task token works as a Bearer...
    assert.equal((await app.inject({ method: "GET", url: "/api/info", headers: bearer(taskToken) })).statusCode, 200);
    // ...but NOT via ?token= (admin-only), and never opens the UI.
    assert.equal((await app.inject({ method: "GET", url: `/api/info?token=${taskToken}` })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/", headers: bearer(taskToken) })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: `/tasks/${task.id}`, headers: bearer(taskToken) })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: `/?token=${ADMIN}` })).statusCode, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("whoami reports task scope, admin, or 401", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const { app, tokens } = await createApp(settingsFor(dir));
  try {
    const task = await makeTask(app, "a");
    const taskToken = tokens.issue(task);

    const scope = await app.inject({ method: "GET", url: "/api/auth/whoami", headers: bearer(taskToken) });
    assert.equal(scope.statusCode, 200);
    assert.deepEqual(scope.json(), { task_id: task.id, root_id: task.id, origin: "web" });

    const admin = await app.inject({ method: "GET", url: "/api/auth/whoami", headers: adminAuth });
    assert.deepEqual(admin.json(), { admin: true });

    assert.equal((await app.inject({ method: "GET", url: "/api/auth/whoami" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/whoami", headers: bearer("bogus") })).statusCode, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task token sees only its own conversation; cross-conversation => 404", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const { app, tokens } = await createApp(settingsFor(dir));
  try {
    const taskA = await makeTask(app, "conversation A");
    const taskB = await makeTask(app, "conversation B");
    const tokenA = tokens.issue(taskA);

    const list = await app.inject({ method: "GET", url: "/api/tasks", headers: bearer(tokenA) });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().map((t: any) => t.id), [taskA.id]);
    // Admin still sees both.
    assert.equal((await app.inject({ method: "GET", url: "/api/tasks", headers: adminAuth })).json().length, 2);

    // Own conversation is readable.
    assert.equal((await app.inject({ method: "GET", url: `/api/tasks/${taskA.id}`, headers: bearer(tokenA) })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/tasks/${taskA.id}/thread`, headers: bearer(tokenA) })).statusCode, 200);

    // Every cross-conversation surface is a 404 (no existence leak).
    for (const [method, url, payload] of [
      ["GET", `/api/tasks/${taskB.id}`, undefined],
      ["GET", `/api/tasks/${taskB.id}/thread`, undefined],
      ["POST", `/api/tasks/${taskB.id}/cancel`, undefined],
      ["DELETE", `/api/tasks/${taskB.id}`, undefined],
      ["POST", `/api/tasks/${taskB.id}/followup`, { prompt: "x" }],
    ] as const) {
      const response = await app.inject({ method, url, headers: bearer(tokenA), payload });
      assert.equal(response.statusCode, 404, `${method} ${url}`);
    }
    // B is untouched.
    assert.equal((await app.inject({ method: "GET", url: `/api/tasks/${taskB.id}`, headers: adminAuth })).statusCode, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task-token POST /api/tasks derives parent/thread/origin and ignores body overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const { app, tokens } = await createApp(settingsFor(dir));
  try {
    const taskA = await makeTask(app, "root");
    const tokenA = tokens.issue(taskA);
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: bearer(tokenA),
      payload: { prompt: "child", origin: "evil", schedule_id: "s_evil", parent_id: "t_evil", thread_id: "t_evil" },
    });
    assert.equal(created.statusCode, 202);
    const child = created.json();
    assert.equal(child.parent_id, taskA.id);
    assert.equal(child.thread_id, taskA.id);
    assert.equal(child.origin, "web");
    assert.equal(child.schedule_id, null);
    await waitForTerminal(app, child.id);
    // The child shares A's conversation, so A's token sees both turns.
    const thread = await app.inject({ method: "GET", url: `/api/tasks/${taskA.id}/thread`, headers: bearer(tokenA) });
    assert.equal(thread.json().turns.length, 2);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("own-conversation DELETE keeps the running-turn 409 guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const settings = settingsFor(dir);
  // A worker that stays alive until cancelled, so a turn is running.
  writeFileSync(settings.workerScript, "#!/bin/sh\ncat >/dev/null\nsleep 30\n");
  const { app, tokens } = await createApp(settings);
  try {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: adminAuth, payload: { prompt: "slow" } });
    const task = created.json();
    const token = tokens.issue(task);
    // Wait until it is running.
    for (let i = 0; i < 100; i++) {
      const got = await app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers: adminAuth });
      if (got.json().status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const deleted = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}`, headers: bearer(token) });
    assert.equal(deleted.statusCode, 409);
    // Cancelling own conversation works.
    const cancelled = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/cancel`, headers: bearer(token) });
    assert.equal(cancelled.statusCode, 200);
    await waitForTerminal(app, task.id);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a conversation cascades its registry tools and tool-cache dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const settings = settingsFor(dir);
  // Seed a finished conversation and its tools BEFORE createApp so the app's
  // registry loads them (mirrors tools authored while the conversation lived).
  const store = new TaskStore(tasksDir(settings), settings.maxOutput);
  const seeded = createTask("seed", { id: "t_cascade" });
  seeded.status = "succeeded";
  seeded.finished_at = utcnow();
  store.add(seeded);
  const input = (name: string): ToolInput => ({
    name,
    kind: "command",
    description: `cascade ${name}`,
    input_schema: { type: "object", properties: {} },
    command: { argv: ["echo", "hi"], files: { "run.sh": "#!/bin/sh\necho hi\n" } },
  });
  const registry = new ToolRegistry(toolsDir(settings), {});
  const mine = registry.create(input("convtool"), { scope: "conversation", rootId: "t_cascade", taskId: "t_cascade", origin: "task" });
  const mineTask = registry.create(input("tasktool"), { scope: "task", rootId: "t_cascade", taskId: "t_cascade-2", origin: "task" });
  const other = registry.create(input("othertool"), { scope: "conversation", rootId: "t_other", taskId: "t_other", origin: "task" });
  // The runner's spawn-time cache copies for the conversation.
  const cacheDir = join(toolCacheDir(settings), "t_cascade", mine.id, "1");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "run.sh"), "#!/bin/sh\necho hi\n");
  const { app } = await createApp(settings);
  try {
    const deleted = await app.inject({ method: "DELETE", url: "/api/tasks/t_cascade", headers: adminAuth });
    assert.equal(deleted.statusCode, 204);
    // Registry records (index + version dirs) are gone for BOTH owned scopes…
    assert.ok(!existsSync(join(toolsDir(settings), mine.id)));
    assert.ok(!existsSync(join(toolsDir(settings), mineTask.id)));
    // …and so is the conversation's tool-cache dir.
    assert.ok(!existsSync(join(toolCacheDir(settings), "t_cascade")));
    // A fresh registry no longer resolves the deleted conversation's tools.
    const fresh = new ToolRegistry(toolsDir(settings), {});
    assert.equal(fresh.get(mine.id), undefined);
    assert.equal(fresh.get(mineTask.id), undefined);
    // Other conversations are untouched.
    assert.ok(existsSync(join(toolsDir(settings), other.id, "index.json")));
    assert.ok(fresh.get(other.id));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedules proxy sends the conversation header for task tokens only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const settings = settingsFor(dir);
  settings.schedulerUrl = "http://scheduler.test";
  settings.schedulerToken = "sched-admin";
  const { app, tokens } = await createApp(settings);

  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url: String(url), method, headers: init.headers ?? {}, body: init.body });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "POST") {
      return new Response(JSON.stringify({ id: "s_new", prompt: "p" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ schedules: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const taskA = await makeTask(app, "a");
    const tokenA = tokens.issue(taskA);

    await app.inject({ method: "GET", url: "/api/schedules", headers: bearer(tokenA) });
    await app.inject({ method: "POST", url: "/api/schedules", headers: bearer(tokenA), payload: { prompt: "p", at: "+1h" } });
    await app.inject({ method: "DELETE", url: "/api/schedules/s_new", headers: bearer(tokenA) });
    await app.inject({ method: "GET", url: "/api/schedules", headers: adminAuth });

    assert.equal(calls.length, 4);
    for (const call of calls.slice(0, 3)) {
      assert.equal(call.headers.authorization, "Bearer sched-admin");
      assert.equal(call.headers["x-isidore-conversation-id"], taskA.id, `${call.method} carries conversation`);
    }
    // Plain admin: admin Bearer, no conversation header.
    assert.equal(calls[3].headers.authorization, "Bearer sched-admin");
    assert.equal(calls[3].headers["x-isidore-conversation-id"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedules proxy reads the scheduler token file when no env token is set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const settings = settingsFor(dir);
  settings.schedulerUrl = "http://scheduler.test";
  settings.schedulerToken = null;
  settings.schedulerTokenFile = join(dir, "scheduler-token");
  writeFileSync(settings.schedulerTokenFile, "generated-sched-token\n");
  const { app } = await createApp(settings);

  const calls: { headers: Record<string, string> }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any = {}) => {
    calls.push({ headers: init.headers ?? {} });
    return new Response(JSON.stringify({ schedules: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const response = await app.inject({ method: "GET", url: "/api/schedules", headers: adminAuth });
    assert.equal(response.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.authorization, "Bearer generated-sched-token");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createApp generates a fallback admin token when settings.token is null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const settings = settingsFor(dir);
  settings.token = null;
  const { app } = await createApp(settings);
  try {
    // Unauthenticated is refused even though no token was configured.
    assert.equal((await app.inject({ method: "GET", url: "/api/info" })).statusCode, 401);
    // The generated token was published to the shared file and works.
    const { readFileSync } = await import("node:fs");
    const generated = readFileSync(join(settings.stateDir, "shared", "admin-token"), "utf8").trim();
    assert.match(generated, /^[0-9a-f]{64}$/);
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/info", headers: bearer(generated) })).statusCode,
      200,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
