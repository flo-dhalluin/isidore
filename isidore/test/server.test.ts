import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server.ts";
import type { Settings } from "../src/config.ts";

function settingsFor(dir: string): Settings {
  const workerScript = join(dir, "worker.sh");
  writeFileSync(workerScript, "#!/bin/sh\ncat >/dev/null\nprintf 'hello from the agent\\n'\n");
  return {
    stateDir: join(dir, "state"),
    host: "127.0.0.1",
    port: 0,
    token: null,
    model: null,
    workerScript,
    workerBin: "sh",
    piMode: "print",
    maxWorkers: 2,
    timeout: null,
    maxOutput: 200_000,
    schedulerUrl: null,
    schedulerToken: null,
    telegramToken: null,
    telegramChats: new Set(),
  };
}

async function waitForTerminal(app: Awaited<ReturnType<typeof createApp>>["app"], id: string): Promise<any> {
  for (let i = 0; i < 250; i++) {
    const response = await app.inject({ method: "GET", url: `/api/tasks/${id}` });
    const task = response.json();
    if (task.done) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("task did not finish");
}

test("serves the UI, API and runs a task end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const { app } = await createApp(settingsFor(dir));
  try {
    const index = await app.inject({ method: "GET", url: "/" });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /id="run"/);
    assert.match(index.body, /isidore/);

    const taskPage = await app.inject({ method: "GET", url: "/tasks/t_abc" });
    assert.equal(taskPage.statusCode, 200);
    assert.match(taskPage.body, /id="ask"/);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().ok, true);

    const info = await app.inject({ method: "GET", url: "/api/info" });
    assert.equal(info.statusCode, 200);
    assert.equal(info.json().scheduler, false);
    assert.equal(info.json().max_workers, 2);

    const empty = await app.inject({ method: "POST", url: "/api/tasks", payload: { prompt: "" } });
    assert.equal(empty.statusCode, 400);

    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { prompt: "say hello" },
    });
    assert.equal(created.statusCode, 202);
    const task = created.json();
    assert.equal(task.status, "queued");
    assert.equal(task.done, false);

    const finished = await waitForTerminal(app, task.id);
    assert.equal(finished.status, "succeeded");
    assert.match(finished.output, /hello from the agent/);

    const list = await app.inject({ method: "GET", url: "/api/tasks?limit=50" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);

    const thread = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/thread` });
    assert.equal(thread.statusCode, 200);
    assert.equal(thread.json().id, task.id);
    assert.equal(thread.json().running, false);
    assert.equal(thread.json().turns.length, 1);

    const followup = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/followup`,
      payload: { prompt: "again" },
    });
    assert.equal(followup.statusCode, 202);
    const followTask = followup.json();
    assert.equal(followTask.thread_id, task.id);
    await waitForTerminal(app, followTask.id);

    const thread2 = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/thread` });
    assert.equal(thread2.json().turns.length, 2);

    const deleted = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}` });
    assert.equal(deleted.statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/api/tasks" })).json().length, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requires a token when configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-server-"));
  const settings = settingsFor(dir);
  settings.token = "secret";
  const { app } = await createApp(settings);
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/info" })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/info", headers: { authorization: "Bearer secret" } })).statusCode,
      200,
    );
    assert.equal((await app.inject({ method: "GET", url: "/api/info?token=secret" })).statusCode, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
