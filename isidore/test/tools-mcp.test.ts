/**
 * Tools authoring MCP tests (Phase 3).
 *
 * Two layers:
 *  1. HTTP roundtrips through app.inject: JSON-RPC protocol shapes (initialize,
 *     notifications, ping, tools/list, tools/call, batches, 405s), auth,
 *     conversation scoping, provenance-from-token, cache staging, promotion,
 *     update/remove, admin path, child authoring scope.
 *  2. The REAL Pi MCP client (createMcpExtension + createRegistryExtension in
 *     a real AgentSession) against the live Fastify endpoint — including the
 *     same-turn tool_result hook driven through ctx.executeTool (the nested
 *     codemode path): a command tool created over MCP is live and callable
 *     before the creating call's result returns.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { tasksDir, toolCacheDir, toolsDir, type Settings } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { createTask } from "../src/store.ts";
import { builtinManifests, ToolRegistry, type ToolManifest } from "../src/tools.ts";

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
    toolsUrl: null,
  };
}

type App = Awaited<ReturnType<typeof createApp>>["app"];
type Tokens = Awaited<ReturnType<typeof createApp>>["tokens"];

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });

async function post(app: App, token: string | null, payload: unknown, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/mcp/tools",
    headers: { ...(token ? bearer(token) : {}), ...extraHeaders },
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

const createArgs = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  kind: "command",
  description: `test tool ${name}`,
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  argv: ["echo", "{{text}}"],
  files: { "run.sh": "#!/bin/sh\necho hello\n" },
  ...overrides,
});

/** Mint a task token for a fresh conversation (no worker needs to run). */
function conversation(tokens: Tokens, origin = "web") {
  const task = createTask("authoring conversation", { origin });
  return { task, rootId: task.id, token: tokens.issue(task) };
}

test("protocol: initialize, notifications, ping, tools/list, 405s, batches, session header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const { app, tokens } = await createApp(settingsFor(dir));
  const { token } = conversation(tokens);
  try {
    const init = await post(app, token, rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pi", version: "1" } }));
    assert.equal(init.statusCode, 200);
    assert.match(String(init.headers["content-type"]), /^application\/json/);
    const result = init.json().result;
    assert.equal(result.protocolVersion, "2025-03-26");
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.equal(result.serverInfo.name, "isidore-tools");
    assert.ok(result.serverInfo.version);

    // Notifications get 202 with an empty body.
    const notified = await post(app, token, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notified.statusCode, 202);
    assert.equal(notified.body, "");

    const ping = await post(app, token, rpc("ping"));
    assert.deepEqual(ping.json().result, {});

    const list = await post(app, token, rpc("tools/list"));
    const names = list.json().result.tools.map((tool: { name: string }) => tool.name);
    assert.deepEqual(names.sort(), [
      "tool_create",
      "tool_disable",
      "tool_get",
      "tool_list",
      "tool_remove",
      "tool_request_promotion",
      "tool_update",
    ]);
    for (const tool of list.json().result.tools) {
      assert.equal(tool.inputSchema.type, "object");
    }

    // GET/DELETE are not part of the stateless surface.
    for (const method of ["GET", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/mcp/tools", headers: bearer(token) });
      assert.equal(response.statusCode, 405);
    }

    // An incoming Mcp-Session-Id is tolerated and ignored.
    const withSession = await post(app, token, rpc("ping", undefined, 7), { "mcp-session-id": "stale-session" });
    assert.equal(withSession.statusCode, 200);
    assert.equal(withSession.json().id, 7);
    assert.equal(withSession.headers["mcp-session-id"], undefined);

    // Batch: requests get an array of responses; notifications are dropped.
    const batch = await post(app, token, [rpc("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("ping", undefined, 2)]);
    assert.equal(batch.statusCode, 200);
    assert.deepEqual(batch.json().map((entry: { id: number }) => entry.id), [1, 2]);
    const allNotifications = await post(app, token, [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    assert.equal(allNotifications.statusCode, 202);
    const emptyBatch = await post(app, token, []);
    assert.equal(emptyBatch.json().error.code, -32600);

    // Protocol errors: unknown method / unknown tool name.
    const unknownMethod = await post(app, token, rpc("resources/list"));
    assert.equal(unknownMethod.json().error.code, -32601);
    const unknownTool = await post(app, token, rpc("tools/call", { name: "tool_nope", arguments: {} }));
    assert.equal(unknownTool.json().error.code, -32602);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("401 without a token or with a bogus token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const { app } = await createApp(settingsFor(dir));
  try {
    for (const token of [null, "bogus"]) {
      const response = await post(app, token, rpc("initialize", {}));
      assert.equal(response.statusCode, 401);
    }
    // ?token= is admin-only on the REST UI; the MCP accepts the admin Bearer.
    assert.equal((await post(app, ADMIN, rpc("ping"))).statusCode, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool_create: provenance from the token, cache copy + cachePath, same-turn payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const { task, rootId, token } = conversation(tokens, "telegram:42");
  try {
    const result = await call(app, token, "tool_create", createArgs("echoer"));
    assert.ok(!result.isError, JSON.stringify(result));
    const { manifest, cachePath } = result.structuredContent as { manifest: ToolManifest; cachePath: string };
    assert.match(manifest.id, /^tl_[0-9a-f]{12}$/);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.status, "active");
    assert.equal(manifest.scope, "conversation");
    // Provenance comes from the token scope, never from arguments.
    assert.deepEqual(manifest.provenance.task_id, task.id);
    assert.equal(manifest.provenance.root_id, rootId);
    assert.equal(manifest.provenance.origin, "telegram:42");
    assert.match(manifest.provenance.sha256, /^[0-9a-f]{64}$/);
    // Sources were copied into the caller's read-only tool-cache.
    assert.equal(cachePath, join(toolCacheDir(settings), rootId, manifest.id, "1"));
    const cached = join(cachePath, "run.sh");
    assert.equal(readFileSync(cached, "utf8"), "#!/bin/sh\necho hello\n");
    assert.equal(statSync(cached).mode & 0o777, 0o755);
    // The service-only registry holds the immutable original.
    assert.ok(existsSync(join(toolsDir(settings), manifest.id, "1", "files", "run.sh")));
    // The text content mirrors the structured payload (JSON-text fallback).
    assert.deepEqual(JSON.parse(result.content[0].text!), result.structuredContent);
    // The tool resolves for the owner conversation with the cache path set.
    const registry = new ToolRegistry(toolsDir(settings), {});
    const resolved = registry.resolveFor({ rootId, taskId: task.id });
    const mine = resolved.find((tool) => tool.manifest.id === manifest.id);
    assert.ok(mine);

    // Provenance/ownership fields cannot be smuggled through arguments.
    for (const smuggle of [{ task_id: "t_evil" }, { root_id: "t_evil" }, { origin: "human" }, { provenance: {} }, { owner_root_id: "t_evil" }]) {
      const rejected = await call(app, token, "tool_create", createArgs("smuggled", smuggle));
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text!, /unknown argument/);
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension kind is rejected for ALL callers (human-authored via the admin API); mcp tools need no cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  // Seed a human-authored extension tool BEFORE createApp so the app's
  // registry loads it (the registry keeps extension support for Phase 4).
  const seeded = new ToolRegistry(toolsDir(settings), {});
  const humanExt = seeded.create(
    { name: "humanext", kind: "extension", description: "d", extension: { entry: "ext.ts" } },
    { scope: "global", rootId: null, taskId: null, origin: "human" },
    { allowExtension: true },
  );
  const { app, tokens } = await createApp(settings);
  const { token } = conversation(tokens);
  try {
    // Inert through this MCP (sources are human-managed, never staged), so
    // extension authoring is rejected for task tokens AND admin alike.
    for (const caller of [token, ADMIN]) {
      const ext = await call(app, caller, "tool_create", {
        name: "myext",
        kind: "extension",
        description: "d",
      });
      assert.equal(ext.isError, true);
      assert.match(ext.content[0].text!, /admin API/);
      assert.match(ext.content[0].text!, /POST \/api\/tools/);
    }
    // The extension-only "entry" argument is no longer accepted at all.
    const entryArg = await call(app, token, "tool_create", createArgs("withentry", { entry: "ext.ts" }));
    assert.equal(entryArg.isError, true);
    assert.match(entryArg.content[0].text!, /unknown argument/);
    // Updating an existing extension tool through the MCP is rejected too.
    const extUpdate = await call(app, ADMIN, "tool_update", { id: humanExt.id, description: "changed" });
    assert.equal(extUpdate.isError, true);
    assert.match(extUpdate.content[0].text!, /admin API/);

    const mcp = await call(app, token, "tool_create", {
      name: "remote",
      kind: "mcp",
      description: "a remote server",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${ISIDORE_TASK_TOKEN}" },
    });
    assert.ok(!mcp.isError, JSON.stringify(mcp));
    assert.equal(mcp.structuredContent.manifest.kind, "mcp");
    assert.equal(mcp.structuredContent.cachePath, null);
    // Agent-supplied auth/oauth blocks stay rejected (validateToolInput).
    const oauth = await call(app, token, "tool_create", { name: "oauthish", kind: "mcp", description: "d", url: "http://x/mcp", oauth: {} });
    assert.equal(oauth.isError, true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("global scope from a task token forces pending_approval (even origin 'human')", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const { rootId, token } = conversation(tokens);
  const humanish = conversation(tokens, "human");
  try {
    for (const caller of [{ rootId, token }, humanish]) {
      const result = await call(app, caller.token, "tool_create", createArgs(`glob${caller.rootId.slice(-4)}`, { scope: "global" }));
      assert.ok(!result.isError, JSON.stringify(result));
      const manifest = result.structuredContent.manifest as ToolManifest;
      assert.equal(manifest.scope, "global");
      assert.equal(manifest.status, "pending_approval");
      // Not resolved for anyone until a human approves.
      const registry = new ToolRegistry(toolsDir(settings), {});
      assert.ok(!registry.resolveFor({ rootId: caller.rootId, taskId: "t_x" }).some((tool) => tool.manifest.id === manifest.id));
      // Pending globals are not runnable: no cache copy was staged. Creator
      // ownership is KEPT on the index (visibility/quota/mutation rights)
      // until a human approval clears it (Phase 4).
      assert.equal(result.structuredContent.cachePath, null);
      assert.ok(!existsSync(join(toolCacheDir(settings), caller.rootId, manifest.id)));
      const index = registry.getIndex(manifest.id);
      assert.equal(index?.owner_root_id, caller.rootId);
      assert.equal(index?.status, "pending_approval");
      // The immutable version manifest carries the FINAL status (no flip).
      const onDisk = JSON.parse(readFileSync(join(toolsDir(settings), manifest.id, "1", "manifest.json"), "utf8"));
      assert.equal(onDisk.status, "pending_approval");
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conversation B cannot see, get, update, disable or remove A's tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = conversation(tokens);
  const b = conversation(tokens);
  try {
    const created = await call(app, a.token, "tool_create", createArgs("secret-tool"));
    const id = created.structuredContent.manifest.id as string;

    // B's list shows neither the tool nor its existence.
    const listB = await call(app, b.token, "tool_list");
    assert.ok(!listB.structuredContent.tools.some((manifest: ToolManifest) => manifest.id === id));
    const listA = await call(app, a.token, "tool_list");
    assert.ok(listA.structuredContent.tools.some((manifest: ToolManifest) => manifest.id === id));

    // Every cross-conversation operation fails with the same no-leak message.
    for (const [name, args] of [
      ["tool_get", { id }],
      ["tool_update", { id, description: "hijacked" }],
      ["tool_disable", { id }],
      ["tool_remove", { id }],
      ["tool_request_promotion", { id, reason: "mine now" }],
    ] as const) {
      const result = await call(app, b.token, name, args);
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text!, /unknown tool/);
    }
    // A's tool is untouched, and B has no cache copy of it.
    const registry = new ToolRegistry(toolsDir(settings), {});
    assert.equal(registry.get(id)?.description, "test tool secret-tool");
    assert.ok(!existsSync(join(toolCacheDir(settings), b.rootId, id)));
    // A can still get it (own conversation), including a pinned old version.
    const got = await call(app, a.token, "tool_get", { id, version: 1 });
    assert.equal(got.structuredContent.manifest.version, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool_update writes a new immutable version and re-copies the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const { rootId, token } = conversation(tokens);
  try {
    const created = await call(app, token, "tool_create", createArgs("echoer"));
    const id = created.structuredContent.manifest.id as string;
    const v1Cache = created.structuredContent.cachePath as string;

    // Partial update: only description + files change; argv/schema carry over.
    const updated = await call(app, token, "tool_update", { id, description: "v2", files: { "run.sh": "#!/bin/sh\necho v2\n" } });
    assert.ok(!updated.isError, JSON.stringify(updated));
    const manifest = updated.structuredContent.manifest as ToolManifest;
    assert.equal(manifest.version, 2);
    assert.equal(manifest.description, "v2");
    assert.deepEqual(manifest.command?.argv, ["echo", "{{text}}"]);
    const v2Cache = updated.structuredContent.cachePath as string;
    assert.equal(v2Cache, join(toolCacheDir(settings), rootId, id, "2"));
    assert.equal(readFileSync(join(v2Cache, "run.sh"), "utf8"), "#!/bin/sh\necho v2\n");
    // v1 bytes are immutable in both the registry and the cache.
    assert.equal(readFileSync(join(v1Cache, "run.sh"), "utf8"), "#!/bin/sh\necho hello\n");
    assert.equal(readFileSync(join(toolsDir(settings), id, "1", "files", "run.sh"), "utf8"), "#!/bin/sh\necho hello\n");
    // Kind cannot change between versions.
    const kindChange = await call(app, token, "tool_update", { id, kind: "mcp", url: "http://x/mcp" });
    assert.equal(kindChange.isError, true);
    assert.match(kindChange.content[0].text!, /kind cannot change/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool_disable and tool_remove: status, resolution and cache sweep", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const { rootId, token } = conversation(tokens);
  try {
    const created = await call(app, token, "tool_create", createArgs("doomed"));
    const id = created.structuredContent.manifest.id as string;
    // A pinned copy in ANOTHER conversation (a child inherited it at spawn).
    const childCopy = join(toolCacheDir(settings), "t_child", id, "1");
    mkdirSync(childCopy, { recursive: true });
    writeFileSync(join(childCopy, "run.sh"), "#!/bin/sh\necho hello\n");

    const disabled = await call(app, token, "tool_disable", { id });
    assert.ok(!disabled.isError);
    assert.deepEqual(disabled.structuredContent, { id, name: "doomed", kind: "command", status: "disabled" });
    const registry = new ToolRegistry(toolsDir(settings), {});
    assert.ok(!registry.resolveFor({ rootId, taskId: "t_x" }).some((tool) => tool.manifest.id === id));
    // list reflects the LIVE status even though manifests are immutable.
    const listed = await call(app, token, "tool_list");
    assert.equal(listed.structuredContent.tools.find((m: ToolManifest) => m.id === id).status, "disabled");

    const removed = await call(app, token, "tool_remove", { id });
    assert.ok(!removed.isError);
    assert.deepEqual(removed.structuredContent, { id, name: "doomed", kind: "command", removed: true });
    assert.ok(!existsSync(join(toolsDir(settings), id)));
    // Cache copies are swept in EVERY conversation, not just the caller's.
    assert.ok(!existsSync(join(toolCacheDir(settings), rootId, id)));
    assert.ok(!existsSync(join(toolCacheDir(settings), "t_child", id)));
    const gone = await call(app, token, "tool_get", { id });
    assert.equal(gone.isError, true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool_request_promotion sets pending_approval and records the reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const { rootId, token } = conversation(tokens);
  try {
    const created = await call(app, token, "tool_create", createArgs("promising"));
    const id = created.structuredContent.manifest.id as string;
    const noReason = await call(app, token, "tool_request_promotion", { id, reason: "  " });
    assert.equal(noReason.isError, true);
    const promoted = await call(app, token, "tool_request_promotion", { id, reason: "useful for every conversation" });
    assert.ok(!promoted.isError);
    assert.equal(promoted.structuredContent.status, "pending_approval");
    assert.equal(promoted.structuredContent.reason, "useful for every conversation");
    const index = JSON.parse(readFileSync(join(toolsDir(settings), id, "index.json"), "utf8"));
    assert.equal(index.status, "pending_approval");
    assert.equal(index.promotion_reason, "useful for every conversation");
    // Pending tools no longer resolve for new spawns.
    const registry = new ToolRegistry(toolsDir(settings), {});
    assert.ok(!registry.resolveFor({ rootId, taskId: "t_x" }).some((tool) => tool.manifest.id === id));
    // A later status change clears the stale reason.
    registry.setStatus(id, "active");
    const reloaded = JSON.parse(readFileSync(join(toolsDir(settings), id, "index.json"), "utf8"));
    assert.equal(reloaded.promotion_reason, undefined);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin path: global tools are active, admin may modify any tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const { rootId, token } = conversation(tokens);
  try {
    const created = await call(app, ADMIN, "tool_create", createArgs("humantool", { scope: "global" }));
    assert.ok(!created.isError, JSON.stringify(created));
    const manifest = created.structuredContent.manifest as ToolManifest;
    assert.equal(manifest.scope, "global");
    assert.equal(manifest.status, "active");
    assert.equal(manifest.provenance.origin, "human");
    assert.equal(manifest.provenance.task_id, null);
    // Admin sees and may disable a conversation-owned tool.
    const mine = await call(app, token, "tool_create", createArgs("convtool"));
    const id = mine.structuredContent.manifest.id as string;
    const listAdmin = await call(app, ADMIN, "tool_list");
    assert.ok(listAdmin.structuredContent.tools.some((m: ToolManifest) => m.id === id));
    const disabled = await call(app, ADMIN, "tool_disable", { id });
    assert.ok(!disabled.isError);
    // Admin cannot author conversation-scoped tools (no conversation context).
    const convScoped = await call(app, ADMIN, "tool_create", createArgs("nocontext", { scope: "conversation" }));
    assert.equal(convScoped.isError, true);
    // Task tokens cannot modify globals.
    const globalId = manifest.id;
    const touchGlobal = await call(app, token, "tool_disable", { id: globalId });
    assert.equal(touchGlobal.isError, true);
    assert.match(touchGlobal.content[0].text!, /human admin/);
    // Globals ARE visible to task callers.
    const got = await call(app, token, "tool_get", { id: globalId });
    assert.ok(!got.isError);
    assert.ok(existsSync(join(toolsDir(settings), globalId)));
    assert.ok(!existsSync(join(toolCacheDir(settings), rootId, globalId)));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("child authoring scope: a child's tool is invisible to the parent unless promoted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  // Parent conversation and a spawned child (NEW root, own workspace).
  const parent = conversation(tokens);
  const childTask = createTask("child", { inherited_from: parent.rootId, inherited_tools: [] });
  const childToken = tokens.issue(childTask);
  try {
    const parentTool = await call(app, parent.token, "tool_create", createArgs("parenttool"));
    const childTool = await call(app, childToken, "tool_create", createArgs("childtool"));
    const parentId = parentTool.structuredContent.manifest.id as string;
    const childId = childTool.structuredContent.manifest.id as string;
    // Ownership follows the CHILD's token scope, not the lineage field.
    assert.equal(childTool.structuredContent.manifest.provenance.root_id, childTask.id);
    const registry = new ToolRegistry(toolsDir(settings), {});
    assert.equal(registry.getIndex(childId)?.owner_root_id, childTask.id);
    // The child's cache copy lives under the child's root.
    assert.equal(childTool.structuredContent.cachePath, join(toolCacheDir(settings), childTask.id, childId, "1"));
    // Parent neither lists nor resolves the child's tool…
    const parentList = await call(app, parent.token, "tool_list");
    assert.ok(!parentList.structuredContent.tools.some((m: ToolManifest) => m.id === childId));
    assert.ok(!registry.resolveFor({ rootId: parent.rootId, taskId: parent.task.id }).some((tool) => tool.manifest.id === childId));
    const parentGet = await call(app, parent.token, "tool_get", { id: childId });
    assert.equal(parentGet.isError, true);
    // …and the child does not see the parent's tool either (no pin was given).
    const childList = await call(app, childToken, "tool_list");
    assert.ok(!childList.structuredContent.tools.some((m: ToolManifest) => m.id === parentId));
    // Promotion REQUEST keeps the tool conversation-scoped and pending: the
    // parent still cannot see it (visibility changes only on human approval).
    await call(app, childToken, "tool_request_promotion", { id: childId, reason: "share it" });
    const afterRequest = await call(app, parent.token, "tool_list");
    assert.ok(!afterRequest.structuredContent.tools.some((m: ToolManifest) => m.id === childId));
    const pendingRegistry = new ToolRegistry(toolsDir(settings), {});
    const pendingIndex = pendingRegistry.getIndex(childId);
    assert.equal(pendingIndex?.status, "pending_approval");
    assert.equal(pendingIndex?.promotion_reason, "share it");
    assert.equal(pendingIndex?.scope, "conversation");
    // Still not active anywhere until a human approves.
    assert.ok(!pendingRegistry.resolveFor({ rootId: parent.rootId, taskId: parent.task.id }).some((tool) => tool.manifest.id === childId));
    // Simulate the Phase 4 human approval (scope global + active) on disk:
    // NOW the parent resolves it.
    const indexPath = join(toolsDir(settings), childId, "index.json");
    const approved = { ...JSON.parse(readFileSync(indexPath, "utf8")), scope: "global", status: "active", owner_root_id: null, owner_task_id: null };
    writeFileSync(indexPath, JSON.stringify(approved));
    const afterApproval = new ToolRegistry(toolsDir(settings), {});
    assert.ok(afterApproval.resolveFor({ rootId: parent.rootId, taskId: parent.task.id }).some((tool) => tool.manifest.id === childId));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending globals: invisible to other conversations, creator keeps full control, no name squatting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = conversation(tokens);
  const b = conversation(tokens);
  try {
    const created = await call(app, a.token, "tool_create", createArgs("secret-global", { scope: "global", files: { "run.sh": "#!/bin/sh\necho SECRET\n" } }));
    assert.ok(!created.isError, JSON.stringify(created));
    const id = created.structuredContent.manifest.id as string;
    assert.equal(created.structuredContent.manifest.status, "pending_approval");
    // A second pending global to probe name squatting (and its -/_ variant).
    const squatted = await call(app, a.token, "tool_create", createArgs("dash-name", { scope: "global" }));
    assert.ok(!squatted.isError, JSON.stringify(squatted));

    // B neither lists nor gets A's pending globals: no manifest/source leak,
    // no existence leak — every operation says "unknown tool".
    const listB = await call(app, b.token, "tool_list");
    assert.ok(!listB.structuredContent.tools.some((manifest: ToolManifest) => manifest.id === id || manifest.id === squatted.structuredContent.manifest.id));
    for (const [name, args] of [
      ["tool_get", { id }],
      ["tool_update", { id, description: "hijacked" }],
      ["tool_disable", { id }],
      ["tool_remove", { id }],
      ["tool_request_promotion", { id, reason: "mine now" }],
    ] as const) {
      const result = await call(app, b.token, name, args);
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text!, /unknown tool/);
    }

    // B may create the names held by A's pending globals (no squatting),
    // including the MCP-namespace variant (- vs _).
    const bCopy = await call(app, b.token, "tool_create", createArgs("secret-global"));
    assert.ok(!bCopy.isError, JSON.stringify(bCopy));
    const bVariant = await call(app, b.token, "tool_create", createArgs("dash_name"));
    assert.ok(!bVariant.isError, JSON.stringify(bVariant));

    // A sees its OWN pending global, sources included, and keeps control.
    const listA = await call(app, a.token, "tool_list");
    assert.ok(listA.structuredContent.tools.some((manifest: ToolManifest) => manifest.id === id));
    const gotA = await call(app, a.token, "tool_get", { id });
    assert.ok(!gotA.isError);
    assert.equal(gotA.structuredContent.manifest.status, "pending_approval");
    assert.equal(gotA.structuredContent.manifest.command.files["run.sh"], "#!/bin/sh\necho SECRET\n");
    // Update: new immutable version, still pending, no cache staging.
    const updated = await call(app, a.token, "tool_update", { id, description: "v2" });
    assert.ok(!updated.isError, JSON.stringify(updated));
    assert.equal(updated.structuredContent.manifest.version, 2);
    assert.equal(updated.structuredContent.manifest.status, "pending_approval");
    assert.equal(updated.structuredContent.cachePath, null);
    assert.ok(!existsSync(join(toolCacheDir(settings), a.rootId, id)));
    // Disable and remove its own pending global (withdraw before approval).
    const disabled = await call(app, a.token, "tool_disable", { id });
    assert.ok(!disabled.isError, JSON.stringify(disabled));
    assert.equal(disabled.structuredContent.status, "disabled");
    const removed = await call(app, a.token, "tool_remove", { id });
    assert.ok(!removed.isError, JSON.stringify(removed));
    assert.ok(!existsSync(join(toolsDir(settings), id)));

    // ACTIVE globals remain visible to every conversation.
    const active = await call(app, ADMIN, "tool_create", createArgs("active-global", { scope: "global" }));
    assert.ok(!active.isError, JSON.stringify(active));
    const activeId = active.structuredContent.manifest.id as string;
    for (const caller of [a, b]) {
      const list = await call(app, caller.token, "tool_list");
      assert.ok(list.structuredContent.tools.some((manifest: ToolManifest) => manifest.id === activeId));
      const got = await call(app, caller.token, "tool_get", { id: activeId });
      assert.ok(!got.isError);
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota counts pending globals: the 33rd create fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const { app, tokens } = await createApp(settingsFor(dir));
  const a = conversation(tokens);
  const b = conversation(tokens);
  try {
    for (let i = 0; i < 32; i++) {
      const result = await call(app, a.token, "tool_create", createArgs(`pg${i}`, { scope: "global" }));
      assert.ok(!result.isError, `create ${i}: ${JSON.stringify(result)}`);
      assert.equal(result.structuredContent.manifest.status, "pending_approval");
    }
    // The 33rd create fails even though every tool is a pending global.
    const over = await call(app, a.token, "tool_create", createArgs("onetoomany"));
    assert.equal(over.isError, true);
    assert.match(over.content[0].text!, /32 tools/);
    const overGlobal = await call(app, a.token, "tool_create", createArgs("pgextra", { scope: "global" }));
    assert.equal(overGlobal.isError, true);
    assert.match(overGlobal.content[0].text!, /32 tools/);
    // B is unaffected — and may reuse A's pending names.
    const okB = await call(app, b.token, "tool_create", createArgs("pg0"));
    assert.ok(!okB.isError, JSON.stringify(okB));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool_update rejects the scope argument (create-only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const { app, tokens } = await createApp(settingsFor(dir));
  const { token } = conversation(tokens);
  try {
    const created = await call(app, token, "tool_create", createArgs("scoped"));
    const id = created.structuredContent.manifest.id as string;
    for (const scope of ["global", "conversation", "task"]) {
      const result = await call(app, token, "tool_update", { id, scope });
      assert.equal(result.isError, true, scope);
      assert.match(result.content[0].text!, /create-only/);
    }
    // Nothing changed: still version 1, conversation scope.
    const got = await call(app, token, "tool_get", { id });
    assert.equal(got.structuredContent.manifest.version, 1);
    assert.equal(got.structuredContent.manifest.scope, "conversation");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool_update on a disabled tool does not stage a cache copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const { rootId, token } = conversation(tokens);
  try {
    const created = await call(app, token, "tool_create", createArgs("sleeper"));
    const id = created.structuredContent.manifest.id as string;
    await call(app, token, "tool_disable", { id });
    const updated = await call(app, token, "tool_update", { id, description: "still disabled" });
    assert.ok(!updated.isError, JSON.stringify(updated));
    assert.equal(updated.structuredContent.manifest.status, "disabled");
    assert.equal(updated.structuredContent.cachePath, null);
    assert.ok(!existsSync(join(toolCacheDir(settings), rootId, id, "2")));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- real Pi MCP client against the live endpoint ---------------------------

interface RealSession {
  session: AgentSession;
  dispose: () => void;
}

/**
 * Real AgentSession with a dummy model (no provider request is ever made).
 * `seedAssistantMessage` gives ctx.executeTool a calling assistant message so
 * nested tool calls (the codemode path) go through the session's tool pipeline
 * and fire tool_result events.
 */
async function realSession(cwd: string, factories: ExtensionFactory[]): Promise<RealSession> {
  const root = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-session-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), "{}");
  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async (_providerId, fn) => fn(undefined),
      delete: async () => {},
    },
    modelsPath: join(agentDir, "models.json"),
  });
  const dummyModel = {
    id: "dummy",
    name: "Dummy",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: factories });
  await resourceLoader.reload();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
  // A minimal assistant message so nested ctx.executeTool calls have a caller.
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "driving tools" }],
    api: "openai-completions",
    provider: "openrouter",
    model: "dummy",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    stopReason: "stop",
  } as never);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: dummyModel as never,
    resourceLoader,
    settingsManager,
    sessionManager,
  });
  await session.bindExtensions({});
  return {
    session,
    dispose: () => {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitFor<T>(probe: () => T | undefined, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error("timed out waiting for probe");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("real Pi MCP client: roundtrip + same-turn create/disable through the nested tool pipeline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-mcp-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const { rootId, token } = conversation(tokens);
  const saved = { ...process.env };
  let real: RealSession | undefined;
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/mcp/tools`;
    process.env.ISIDORE_TASK_TOKEN = token;
    const toolsBuiltin = builtinManifests({ ISIDORE_TOOLS_URL: url }).find((manifest) => manifest.id === "builtin:tools");
    assert.ok(toolsBuiltin);

    // A real nested tool context (the same one codemode's execute receives):
    // ctx.executeTool goes through the session's tool pipeline and fires
    // tool_result with parentToolCallId set.
    const nestedContext = () => real!.session.extensionRunner.createToolContext("call-driver", undefined);

    const workspace = join(dir, "ws");
    mkdirSync(workspace, { recursive: true });
    real = await realSession(workspace, [
      createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) }),
      // Same wiring as the worker: builtin:tools registers the endpoint, and
      // the registry extension's tool_result hook provides same-turn liveness.
      (await import("../src/registry-extension.ts")).createRegistryExtension({
        tools: [{ manifest: toolsBuiltin, cachePath: null }],
        cwd: workspace,
      }),
    ]);

    // The real client connected and registered the authoring tools.
    const createName = await waitFor(() =>
      real!.session.getAllTools().some((tool) => tool.name === "mcp__tools__tool_create") ? "mcp__tools__tool_create" : undefined,
    );
    assert.ok(real.session.getActiveToolNames().includes(createName));

    // Plain roundtrip: tool_list through Pi's MCP pipeline.
    const listDef = real.session.getToolDefinition("mcp__tools__tool_list");
    assert.ok(listDef);
    const listResult = await listDef.execute("call-list", {}, undefined, undefined, { cwd: workspace } as never);
    assert.ok(!listResult.isError);
    // Verified SDK shape: event/result structuredContent is the WHOLE
    // CallToolResult; the server payload sits at .structuredContent.
    const listPayload = (listResult.structuredContent as { structuredContent?: { tools?: unknown[] } }).structuredContent;
    assert.ok(Array.isArray(listPayload?.tools));

    // Same-turn create: drive tool_create through the nested pipeline. The
    // tool_result hook must register the new command tool BEFORE the creating
    // call resolves.
    const createOutcome = await nestedContext().executeTool("mcp__tools__tool_create", createArgs("same-turn-echo"));
    assert.ok(!createOutcome.isError, JSON.stringify(createOutcome.result.content));
    assert.ok(real.session.getActiveToolNames().includes("same-turn-echo"), "created tool not live in the same turn");
    // The cache copy exists and the tool actually runs.
    const registry = new ToolRegistry(toolsDir(settings), {});
    const manifest = registry.list().find((index) => index.name === "same-turn-echo");
    assert.ok(manifest);
    assert.equal(manifest.owner_root_id, rootId);
    assert.ok(existsSync(join(toolCacheDir(settings), rootId, manifest.id, "1", "run.sh")));
    const echoDef = real.session.getToolDefinition("same-turn-echo");
    assert.ok(echoDef);
    const echoResult = await echoDef.execute("call-echo", { text: "live!" }, undefined, undefined, { cwd: workspace } as never);
    assert.ok(!echoResult.isError);
    assert.deepEqual(echoResult.content, [{ type: "text", text: "live!\n" }]);

    // Same-turn disable: the command tool becomes an error stub.
    const disableOutcome = await nestedContext().executeTool("mcp__tools__tool_disable", { id: manifest.id });
    assert.ok(!disableOutcome.isError, JSON.stringify(disableOutcome.result.content));
    const stubDef = real.session.getToolDefinition("same-turn-echo");
    assert.ok(stubDef);
    const stubResult = await stubDef.execute("call-stub", { text: "x" }, undefined, undefined, { cwd: workspace } as never);
    assert.equal(stubResult.isError, true);
    assert.match((stubResult.content[0] as { text: string }).text, /disabled/);
  } finally {
    process.env = saved;
    real?.dispose();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
