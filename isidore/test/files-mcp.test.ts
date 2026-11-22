/**
 * Files MCP tests: the send_file tool, workspace confinement, the download
 * route, conversation scoping and cleanup.
 */
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactsDir, tasksDir, workspacesDir, type Settings } from "../src/config.ts";
import { MAX_ARTIFACT_BYTES } from "../src/limits.ts";
import { createApp } from "../src/server.ts";
import { TaskStore, createTask, utcnow } from "../src/store.ts";
import { builtinManifests } from "../src/tools.ts";

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
    models: [],
    workerScript,
    workerBin: "sh",
    piMode: "print",
    maxWorkers: 1,
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
    toolsUrl: null,
  };
}

/** Seed a finished task and its conversation workspace before createApp. */
function seedConversation(settings: Settings, id: string) {
  const store = new TaskStore(tasksDir(settings), settings.maxOutput);
  const task = createTask("produce a report", { id });
  task.status = "succeeded";
  task.finished_at = utcnow();
  store.add(task);
  const workspace = join(workspacesDir(settings), id);
  mkdirSync(workspace, { recursive: true });
  return { store, task, workspace };
}

type App = Awaited<ReturnType<typeof createApp>>["app"];
type Tokens = Awaited<ReturnType<typeof createApp>>["tokens"];

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

async function post(app: App, token: string | null, payload: unknown) {
  return app.inject({
    method: "POST",
    url: "/mcp/files",
    headers: token ? bearer(token) : {},
    payload: payload as never,
  });
}

/** tools/call helper: returns the CallToolResult ({content, structuredContent?, isError?}). */
async function call(app: App, token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await post(app, token, rpc("tools/call", { name, arguments: args }));
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.ok(body.result, `expected a result, got: ${JSON.stringify(body)}`);
  return body.result as { content: Array<{ type: string; text?: string }>; structuredContent?: any; isError?: boolean };
}

test("protocol: initialize, notifications, tools/list, 405s, auth and the builtin manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-files-mcp-"));
  const settings = settingsFor(dir);
  const { task } = seedConversation(settings, "t_files");
  const { app, tokens } = await createApp(settings);
  const token = tokens.issue(task);
  try {
    const init = await post(app, token, rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    assert.equal(init.statusCode, 200);
    assert.equal(init.json().result.protocolVersion, "2025-03-26");
    assert.equal(init.json().result.serverInfo.name, "isidore-files");
    assert.deepEqual(init.json().result.capabilities, { tools: {} });

    const notified = await post(app, token, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notified.statusCode, 202);

    const ping = await post(app, token, rpc("ping"));
    assert.deepEqual(ping.json().result, {});

    const list = await post(app, token, rpc("tools/list"));
    assert.deepEqual(list.json().result.tools.map((tool: { name: string }) => tool.name), ["send_file"]);

    assert.equal((await app.inject({ method: "GET", url: "/mcp/files", headers: bearer(token) })).statusCode, 405);
    assert.equal((await app.inject({ method: "DELETE", url: "/mcp/files", headers: bearer(token) })).statusCode, 405);
    assert.equal((await app.inject({ method: "POST", url: "/mcp/files", payload: rpc("ping") })).statusCode, 401);

    const builtin = builtinManifests({}, 8920).find((manifest) => manifest.id === "builtin:files");
    assert.ok(builtin);
    assert.equal(builtin.name, "files");
    assert.equal(builtin.kind, "mcp");
    assert.deepEqual(builtin.mcp, {
      url: "http://127.0.0.1:8920/mcp/files",
      headers: { Authorization: "Bearer ${ISIDORE_TASK_TOKEN}" },
      exposure: "direct",
      timeout: 30,
    });
    assert.equal(builtin.scope, "global");
    assert.equal(builtin.status, "active");
    assert.equal(builtin.provenance.origin, "builtin");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send_file copies the file, records it on the task and serves a download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-files-mcp-"));
  const settings = settingsFor(dir);
  const { task, workspace } = seedConversation(settings, "t_files");
  const body = "# Report\n\nAll good.\n";
  writeFileSync(join(workspace, "report.md"), body);
  const { app, tokens } = await createApp(settings);
  const token = tokens.issue(task);
  try {
    const result = await call(app, token, "send_file", {
      path: "report.md",
      name: "report.md",
      description: "the report",
    });
    assert.equal(result.isError, undefined);
    const artifact = result.structuredContent.artifact;
    assert.match(artifact.id, /^a_[0-9a-f]{12}$/);
    assert.equal(artifact.name, "report.md");
    assert.equal(artifact.description, "the report");
    assert.equal(artifact.size, Buffer.byteLength(body));
    assert.equal(artifact.content_type, "text/markdown; charset=utf-8");
    assert.match(result.content[0].text ?? "", /download link is now shown/);

    // Persisted on the turn, so the task view renders it.
    const thread = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/thread`, headers: adminAuth });
    assert.equal(thread.statusCode, 200);
    const turns = thread.json().turns;
    assert.equal(turns.length, 1);
    assert.equal(turns[0].artifacts.length, 1);
    assert.equal(turns[0].artifacts[0].id, artifact.id);

    // The bytes live in the service-only store, outside the workspace.
    const stored = join(artifactsDir(settings), task.id, artifact.id);
    assert.ok(existsSync(stored));

    const download = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}/artifacts/${artifact.id}`,
      headers: adminAuth,
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers["content-type"], "text/markdown; charset=utf-8");
    assert.match(String(download.headers["content-disposition"]), /^attachment; filename="report\.md"/);
    assert.equal(download.headers["x-content-type-options"], "nosniff");
    assert.equal(download.rawPayload.toString("utf8"), body);

    // The browser UI authenticates downloads with ?token=.
    const query = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/artifacts/${artifact.id}?token=${ADMIN}` });
    assert.equal(query.statusCode, 200);

    // A task token scoped to the same conversation can download it too.
    const scoped = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}/artifacts/${artifact.id}`,
      headers: bearer(token),
    });
    assert.equal(scoped.statusCode, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin cannot call send_file; another conversation cannot download an artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-files-mcp-"));
  const settings = settingsFor(dir);
  const a = seedConversation(settings, "t_a");
  const b = seedConversation(settings, "t_b");
  writeFileSync(join(a.workspace, "report.md"), "report\n");
  writeFileSync(join(b.workspace, "report.md"), "other\n");
  const { app, tokens } = await createApp(settings);
  const tokenA = tokens.issue(a.task);
  const tokenB = tokens.issue(b.task);
  try {
    const denied = await call(app, ADMIN, "send_file", { path: "report.md" });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text ?? "", /requires a task token/);

    const shared = await call(app, tokenA, "send_file", { path: "report.md" });
    const artifact = shared.structuredContent.artifact;

    const cross = await app.inject({
      method: "GET",
      url: `/api/tasks/${a.task.id}/artifacts/${artifact.id}`,
      headers: bearer(tokenB),
    });
    assert.equal(cross.statusCode, 404);
    // An unknown artifact id is a 404, not a path probe.
    const unknown = await app.inject({
      method: "GET",
      url: `/api/tasks/${a.task.id}/artifacts/a_000000000000`,
      headers: adminAuth,
    });
    assert.equal(unknown.statusCode, 404);
    // B never gets A's file through its own task id either.
    const wrongTask = await app.inject({
      method: "GET",
      url: `/api/tasks/${b.task.id}/artifacts/${artifact.id}`,
      headers: adminAuth,
    });
    assert.equal(wrongTask.statusCode, 404);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send_file refuses escapes, directories, missing files, unknown args and oversized files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-files-mcp-"));
  const settings = settingsFor(dir);
  const { task, workspace } = seedConversation(settings, "t_files");
  writeFileSync(join(workspace, "ok.txt"), "ok\n");
  mkdirSync(join(workspace, "folder"));
  // A file that exists just outside the workspace, reachable relatively and
  // absolutely, plus a symlink in the workspace pointing at it.
  const outside = join(workspacesDir(settings), "outside.txt");
  writeFileSync(outside, "secret\n");
  writeFileSync(join(dir, "absolute-outside.txt"), "secret\n");
  symlinkSync(outside, join(workspace, "link.txt"));
  const { app, tokens } = await createApp(settings);
  const token = tokens.issue(task);
  try {
    const escape = await call(app, token, "send_file", { path: "../outside.txt" });
    assert.equal(escape.isError, true);
    assert.match(escape.content[0].text ?? "", /outside the task workspace/);

    const absolute = await call(app, token, "send_file", { path: join(dir, "absolute-outside.txt") });
    assert.equal(absolute.isError, true);
    assert.match(absolute.content[0].text ?? "", /outside the task workspace/);

    const symlink = await call(app, token, "send_file", { path: "link.txt" });
    assert.equal(symlink.isError, true);
    assert.match(symlink.content[0].text ?? "", /outside the task workspace/);

    const directory = await call(app, token, "send_file", { path: "folder" });
    assert.equal(directory.isError, true);
    assert.match(directory.content[0].text ?? "", /not a regular file/);

    const missing = await call(app, token, "send_file", { path: "missing.txt" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text ?? "", /file not found/);

    const unknownArg = await call(app, token, "send_file", { path: "ok.txt", scope: "global" });
    assert.equal(unknownArg.isError, true);
    assert.match(unknownArg.content[0].text ?? "", /unknown argument: scope/);

    const big = join(workspace, "big.bin");
    const fd = openSync(big, "w");
    ftruncateSync(fd, MAX_ARTIFACT_BYTES + 1);
    closeSync(fd);
    const oversized = await call(app, token, "send_file", { path: "big.bin" });
    assert.equal(oversized.isError, true);
    assert.match(oversized.content[0].text ?? "", /larger than/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a conversation removes its artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-files-mcp-"));
  const settings = settingsFor(dir);
  const { task, workspace } = seedConversation(settings, "t_files");
  writeFileSync(join(workspace, "report.md"), "report\n");
  const { app, tokens } = await createApp(settings);
  const token = tokens.issue(task);
  try {
    const result = await call(app, token, "send_file", { path: "report.md" });
    const artifact = result.structuredContent.artifact;
    assert.ok(existsSync(join(artifactsDir(settings), task.id, artifact.id)));

    const deleted = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}`, headers: adminAuth });
    assert.equal(deleted.statusCode, 204);
    assert.ok(!existsSync(join(artifactsDir(settings), task.id)));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
