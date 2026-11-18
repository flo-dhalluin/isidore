/**
 * Human admin surface tests (Phase 4): /api/tools is ADMIN-ONLY on every
 * route (task tokens get 401, not 404), approval is the only human-gated
 * path to active+global (with a name-collision re-check), reject/disable/
 * enable semantics, rollback to immutable versions, and delete sweeping
 * every tool-cache copy. Spawn effects are verified through the real runner
 * with a worker that dumps its WorkerRequest; conversation-scoped tools are
 * checked via lineage children (conversation_id) of the authoring conversation.
 * Registration (not just composition) is verified by feeding the resolved
 * post-approval tool set through createRegistryExtension with a fake pi that
 * captures registerTool/registerMcpServer calls.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolCacheDir, toolsDir, type Settings } from "../src/config.ts";
import { createRegistryExtension } from "../src/registry-extension.ts";
import { createApp } from "../src/server.ts";
import { ToolRegistry } from "../src/tools.ts";

const ADMIN = "test-token";
const adminAuth = { authorization: `Bearer ${ADMIN}` };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function settingsFor(dir: string): Settings {
  const workerScript = join(dir, "worker.sh");
  // Dump the WorkerRequest so tests can verify the composed tool set.
  writeFileSync(workerScript, "#!/bin/sh\ncat > request.json\nprintf 'ok\\n'\n");
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

/**
 * Mint a task token for a REAL persisted conversation. The conversation must
 * exist in the store so spawns can target it via conversation_id (lineage);
 * the runner revokes the spawn token at finalise, so re-issue one afterwards.
 */
async function conversation(app: App, tokens: Tokens, origin = "web") {
  const task = await makeTask(app, "authoring conversation", undefined, origin);
  return { task, rootId: task.id, token: tokens.issue(task) };
}

const rpc = (method: string, params?: unknown, id: number = 1) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });

/** tools/call over the authoring MCP; returns the CallToolResult. */
async function call(app: App, token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await app.inject({ method: "POST", url: "/mcp/tools", headers: bearer(token), payload: rpc("tools/call", { name, arguments: args }) as never });
  assert.equal(response.statusCode, 200);
  const result = response.json().result;
  assert.ok(result, `expected a result: ${response.body}`);
  return result as { content: Array<{ type: string; text?: string }>; structuredContent?: any; isError?: boolean };
}

const createArgs = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  kind: "command",
  description: `test tool ${name}`,
  input_schema: { type: "object", properties: {} },
  argv: ["echo", "hi"],
  files: { "run.sh": "#!/bin/sh\necho hi\n" },
  ...overrides,
});

/** Create a tool through the MCP as a task; returns its manifest. */
async function author(app: App, token: string, name: string, overrides: Record<string, unknown> = {}) {
  const created = await call(app, token, "tool_create", createArgs(name, overrides));
  assert.ok(!created.isError, JSON.stringify(created));
  return created.structuredContent.manifest;
}

async function makeTask(app: App, prompt: string, conversationId?: string, origin = "web"): Promise<any> {
  const created = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: adminAuth,
    payload: { prompt, origin, ...(conversationId !== undefined ? { conversation_id: conversationId } : {}) },
  });
  assert.equal(created.statusCode, 202);
  const id = created.json().id;
  for (let i = 0; i < 250; i++) {
    const response = await app.inject({ method: "GET", url: `/api/tasks/${id}`, headers: adminAuth });
    const task = response.json();
    if (task.done) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("task did not finish");
}

const workerRequest = (task: any): any => JSON.parse(readFileSync(join(task.workspace, "request.json"), "utf8"));

/** Fake pi capturing registrations, to assert tools are REGISTERED, not just composed. */
function registrationProbe() {
  const toolNames: string[] = [];
  const serverNames: string[] = [];
  const pi = {
    registerTool: (def: { name: string }) => {
      toolNames.push(def.name);
    },
    registerMcpServer: (name: string) => {
      serverNames.push(name);
    },
    unregisterMcpServer: () => {},
    on: () => () => {},
  } as unknown as ExtensionAPI;
  return { pi, toolNames, serverNames };
}

test("every /api/tools route is admin-only: no token, bogus token and task tokens get 401", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const owner = await conversation(app, tokens);
  const other = await conversation(app, tokens);
  try {
    const manifest = await author(app, owner.token, "owned");
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/api/tools"],
      ["POST", "/api/tools", { name: "sneaky", kind: "command", description: "d" }],
      ["GET", `/api/tools/${manifest.id}`],
      ["GET", `/api/tools/${manifest.id}?version=1`],
      ["POST", `/api/tools/${manifest.id}/approve`],
      ["POST", `/api/tools/${manifest.id}/reject`],
      ["POST", `/api/tools/${manifest.id}/disable`],
      ["POST", `/api/tools/${manifest.id}/enable`],
      ["POST", `/api/tools/${manifest.id}/rollback`, { version: 1 }],
      ["DELETE", `/api/tools/${manifest.id}`],
      ["GET", "/api/tools/tl_unknown"],
      ["POST", "/api/tools/tl_unknown/approve"],
      ["DELETE", "/api/tools/tl_unknown"],
    ];
    // The OWNER's own task token is refused too: 401, never 404 or 200.
    for (const headers of [{}, bearer("bogus"), bearer(owner.token), bearer(other.token)]) {
      for (const [method, url, payload] of routes) {
        const response = await app.inject({ method: method as "GET", url, headers, payload: payload as never });
        assert.equal(response.statusCode, 401, `${method} ${url} with ${JSON.stringify(headers)}`);
      }
    }
    // The tool is untouched by all those refused attempts.
    const index = new ToolRegistry(toolsDir(settings), {}).getIndex(manifest.id);
    assert.equal(index?.status, "active");
    // Admin via Bearer and via ?token= both work.
    assert.equal((await app.inject({ method: "GET", url: "/api/tools", headers: adminAuth })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/tools?token=${ADMIN}` })).statusCode, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/tools lists indexes + current manifests + provenance; scope/status filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  const b = await conversation(app, tokens);
  try {
    const conv = await author(app, a.token, "convtool");
    const pending = await author(app, b.token, "globaltool", { scope: "global" });
    const listed = await app.inject({ method: "GET", url: "/api/tools", headers: adminAuth });
    assert.equal(listed.statusCode, 200);
    const tools = listed.json().tools;
    assert.equal(tools.length, 2);
    for (const entry of tools) {
      assert.ok(entry.index && entry.manifest, "each entry carries index + manifest");
      assert.equal(entry.manifest.id, entry.index.id);
      assert.ok(entry.manifest.provenance.created_at);
      assert.ok(entry.manifest.provenance.sha256);
    }
    const convEntry = tools.find((entry: any) => entry.index.id === conv.id);
    assert.equal(convEntry.index.scope, "conversation");
    assert.equal(convEntry.index.owner_root_id, a.rootId);
    assert.equal(convEntry.manifest.provenance.root_id, a.rootId);
    assert.equal(convEntry.manifest.provenance.task_id, a.task.id);
    assert.equal(convEntry.manifest.provenance.origin, "web");
    const pendingEntry = tools.find((entry: any) => entry.index.id === pending.id);
    assert.equal(pendingEntry.index.status, "pending_approval");
    // Live state is overlaid onto the immutable manifest.
    assert.equal(pendingEntry.manifest.status, "pending_approval");

    const filtered = await app.inject({ method: "GET", url: "/api/tools?scope=global&status=pending_approval", headers: adminAuth });
    assert.deepEqual(filtered.json().tools.map((entry: any) => entry.index.id), [pending.id]);
    assert.equal((await app.inject({ method: "GET", url: "/api/tools?scope=bogus", headers: adminAuth })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/tools?status=bogus", headers: adminAuth })).statusCode, 400);

    // Single tool: current and explicit immutable versions.
    const one = await app.inject({ method: "GET", url: `/api/tools/${conv.id}`, headers: adminAuth });
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().manifest.version, 1);
    assert.equal(one.json().index.current_version, 1);
    assert.equal((await app.inject({ method: "GET", url: `/api/tools/${conv.id}?version=1`, headers: adminAuth })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/tools/${conv.id}?version=9`, headers: adminAuth })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/api/tools/${conv.id}?version=abc`, headers: adminAuth })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/tools/tl_nope", headers: adminAuth })).statusCode, 404);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve activates a promoted tool for NEW spawns, clears ownership and the reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  try {
    const manifest = await author(app, a.token, "promoted", { scope: "global" });
    await call(app, a.token, "tool_request_promotion", { id: manifest.id, reason: "useful everywhere" });
    // Pending: invisible to other conversations' spawns.
    const before = await makeTask(app, "before approval");
    assert.ok(!workerRequest(before).tools.some((tool: any) => tool.manifest.id === manifest.id));

    const approved = await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/approve`, headers: adminAuth });
    assert.equal(approved.statusCode, 200);
    const index = approved.json().index;
    assert.equal(index.status, "active");
    assert.equal(index.scope, "global");
    assert.equal(index.owner_root_id, null);
    assert.equal(index.owner_task_id, null);
    assert.equal(index.promotion_reason, undefined);
    assert.equal(approved.json().manifest.status, "active");
    assert.equal(approved.json().manifest.scope, "global");
    // The RAW on-disk index is ONE consistent record: active + global +
    // unowned together (atomic registry.approve, no crash window where an
    // active global is still owned by its creator conversation).
    const raw = JSON.parse(readFileSync(join(toolsDir(settings), manifest.id, "index.json"), "utf8"));
    assert.equal(raw.status, "active");
    assert.equal(raw.scope, "global");
    assert.equal(raw.owner_root_id, null);
    assert.equal(raw.owner_task_id, null);
    assert.equal(raw.promotion_reason, undefined);

    // A NEW spawn in an unrelated conversation resolves the approved tool,
    // with a read-only cache copy under its own root.
    const after = await makeTask(app, "after approval");
    const resolved = workerRequest(after).tools.find((tool: any) => tool.manifest.id === manifest.id);
    assert.ok(resolved, "approved tool missing from the new spawn's request");
    assert.equal(resolved.manifest.scope, "global");
    assert.equal(resolved.cachePath, join(toolCacheDir(settings), after.id, manifest.id, "1"));
    assert.ok(existsSync(join(resolved.cachePath, "run.sh")));
    // A fresh registry (restart) agrees.
    const fresh = new ToolRegistry(toolsDir(settings), {});
    assert.ok(fresh.resolveFor({ rootId: "t_unrelated", taskId: "t_unrelated" }).some((tool) => tool.manifest.id === manifest.id));

    // Ownership is gone: the creator sees it (active global) but can no
    // longer mutate it through the authoring MCP.
    const update = await call(app, a.token, "tool_update", { id: manifest.id, description: "mine again" });
    assert.equal(update.isError, true);
    assert.match(update.content[0].text!, /only a human admin/);

    // Approving again (now active) is refused.
    const again = await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/approve`, headers: adminAuth });
    assert.equal(again.statusCode, 409);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve re-checks name collisions: same name and -/_ normalization => 409", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  const b = await conversation(app, tokens);
  const c = await conversation(app, tokens);
  try {
    // Two conversations may hold same-name pending globals (no squatting)…
    const first = await author(app, a.token, "shared-name", { scope: "global" });
    const second = await author(app, b.token, "shared-name", { scope: "global" });
    // …and a -/_ variant that only collides after MCP namespace normalization.
    const variant = await author(app, c.token, "shared_name", { scope: "global" });

    const ok = await app.inject({ method: "POST", url: `/api/tools/${first.id}/approve`, headers: adminAuth });
    assert.equal(ok.statusCode, 200);
    const clash = await app.inject({ method: "POST", url: `/api/tools/${second.id}/approve`, headers: adminAuth });
    assert.equal(clash.statusCode, 409);
    assert.match(clash.json().error, /already exists/);
    const normalized = await app.inject({ method: "POST", url: `/api/tools/${variant.id}/approve`, headers: adminAuth });
    assert.equal(normalized.statusCode, 409);
    assert.match(normalized.json().error, /normalization/);
    // The refused tools stay pending and owned; nothing became global.
    const registry = new ToolRegistry(toolsDir(settings), {});
    for (const id of [second.id, variant.id]) {
      const index = registry.getIndex(id)!;
      assert.equal(index.status, "pending_approval");
      assert.equal(index.owner_root_id !== null, true);
    }

    // Builtin/reserved names are re-checked too. Seed a legacy record that
    // predates the authoring validation; a second app loads it from disk.
    const legacyDir = join(toolsDir(settings), "tl_legacy00000");
    mkdirSync(join(legacyDir, "1"), { recursive: true });
    writeFileSync(join(legacyDir, "index.json"), JSON.stringify({
      id: "tl_legacy00000", name: "browser", scope: "global", status: "pending_approval",
      owner_root_id: "t_legacy", owner_task_id: "t_legacy", current_version: 1, versions: [1],
    }));
    writeFileSync(join(legacyDir, "1", "manifest.json"), JSON.stringify({
      id: "tl_legacy00000", name: "browser", version: 1, kind: "mcp", description: "legacy",
      scope: "global", status: "pending_approval", mcp: { url: "http://127.0.0.1:9/mcp" },
      provenance: { task_id: "t_legacy", root_id: "t_legacy", origin: "task", created_at: "2025-01-01T00:00:00Z", sha256: "" },
    }));
    const loaded = new ToolRegistry(toolsDir(settings), {});
    const { app: app2 } = await createApp(settings);
    try {
      const builtinClash = await app2.inject({ method: "POST", url: "/api/tools/tl_legacy00000/approve", headers: adminAuth });
      assert.equal(builtinClash.statusCode, 409);
      assert.match(builtinClash.json().error, /reserved|builtin/);
    } finally {
      await app2.close();
    }
    assert.equal(loaded.getIndex("tl_legacy00000")?.status, "pending_approval");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reject disables a pending tool, keeps scope + owner; creator can re-promote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  try {
    // Promotion REQUEST on a conversation tool keeps conversation scope.
    const manifest = await author(app, a.token, "rejected");
    await call(app, a.token, "tool_request_promotion", { id: manifest.id, reason: "share it" });
    const rejected = await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/reject`, headers: adminAuth });
    assert.equal(rejected.statusCode, 200);
    const index = rejected.json().index;
    assert.equal(index.status, "disabled");
    assert.equal(index.scope, "conversation");
    assert.equal(index.owner_root_id, a.rootId);
    assert.equal(index.owner_task_id, a.task.id);
    assert.equal(index.promotion_reason, undefined);
    // Not resolved for anyone, including the creator.
    const registry = new ToolRegistry(toolsDir(settings), {});
    assert.ok(!registry.resolveFor({ rootId: a.rootId, taskId: a.task.id }).some((tool) => tool.manifest.id === manifest.id));
    // The creator still sees and manages it (owned, any status)…
    const listed = await call(app, a.token, "tool_list");
    assert.ok(listed.structuredContent.tools.some((tool: any) => tool.id === manifest.id && tool.status === "disabled"));
    // …and can request promotion again; approval then succeeds.
    await call(app, a.token, "tool_request_promotion", { id: manifest.id, reason: "revised, please share" });
    const approved = await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/approve`, headers: adminAuth });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().index.scope, "global");
    assert.equal(approved.json().index.owner_root_id, null);
    // Rejecting a non-pending tool is refused.
    const again = await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/reject`, headers: adminAuth });
    assert.equal(again.statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/api/tools/tl_nope/reject", headers: adminAuth })).statusCode, 404);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disable hides from new spawns; enable restores; enable never bypasses approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  try {
    const manifest = await author(app, a.token, "switchable");
    // New spawns WITHIN the conversation (lineage children pin the
    // conversation's active tools at spawn); other conversations never see it.
    const spawned = await makeTask(app, "with the tool", a.rootId);
    assert.ok(workerRequest(spawned).tools.some((tool: any) => tool.manifest.id === manifest.id));

    const disabled = await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/disable`, headers: adminAuth });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().index.status, "disabled");
    // New spawns no longer resolve it (running workers keep their copy).
    const without = await makeTask(app, "without the tool", a.rootId);
    assert.ok(!workerRequest(without).tools.some((tool: any) => tool.manifest.id === manifest.id));
    const registry = new ToolRegistry(toolsDir(settings), {});
    assert.ok(!registry.resolveFor({ rootId: a.rootId, taskId: a.task.id }).some((tool) => tool.manifest.id === manifest.id));
    // Disabling twice is a 409.
    assert.equal((await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/disable`, headers: adminAuth })).statusCode, 409);
    // A conversation-scoped tool enables back to active, scope unchanged.
    const enabled = await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/enable`, headers: adminAuth });
    assert.equal(enabled.statusCode, 200);
    assert.equal(enabled.json().index.status, "active");
    assert.equal(enabled.json().index.scope, "conversation");
    // …and new spawns in the conversation resolve it again.
    const restored = await makeTask(app, "restored", a.rootId);
    assert.ok(workerRequest(restored).tools.some((tool: any) => tool.manifest.id === manifest.id));

    // A PENDING tool cannot be enabled (it is not disabled)…
    const pending = await author(app, a.token, "pending-global", { scope: "global" });
    const pendingEnable = await app.inject({ method: "POST", url: `/api/tools/${pending.id}/enable`, headers: adminAuth });
    assert.equal(pendingEnable.statusCode, 409);
    // …and a REJECTED global (disabled but still owned, never approved)
    // cannot be enabled around the approval gate either.
    await app.inject({ method: "POST", url: `/api/tools/${pending.id}/reject`, headers: adminAuth });
    const rejectedEnable = await app.inject({ method: "POST", url: `/api/tools/${pending.id}/enable`, headers: adminAuth });
    assert.equal(rejectedEnable.statusCode, 409);
    assert.match(rejectedEnable.json().error, /never approved/);
    const stillDisabled = new ToolRegistry(toolsDir(settings), {}).getIndex(pending.id)!;
    assert.equal(stillDisabled.status, "disabled");
    assert.ok(stillDisabled.owner_root_id !== null); // ownership kept
    // The legit path still works: re-promote, approve, disable, enable.
    await call(app, a.token, "tool_request_promotion", { id: pending.id, reason: "again" });
    assert.equal((await app.inject({ method: "POST", url: `/api/tools/${pending.id}/approve`, headers: adminAuth })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `/api/tools/${pending.id}/disable`, headers: adminAuth })).statusCode, 200);
    const approvedEnable = await app.inject({ method: "POST", url: `/api/tools/${pending.id}/enable`, headers: adminAuth });
    assert.equal(approvedEnable.statusCode, 200);
    assert.equal(approvedEnable.json().index.status, "active");
    assert.equal(approvedEnable.json().index.scope, "global");
    assert.equal((await app.inject({ method: "POST", url: "/api/tools/tl_nope/enable", headers: adminAuth })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/tools/tl_nope/disable", headers: adminAuth })).statusCode, 404);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback resolves a prior immutable version for new spawns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  try {
    const v1 = await author(app, a.token, "rollbackable", { description: "version one" });
    const updated = await call(app, a.token, "tool_update", {
      id: v1.id,
      description: "version two",
      files: { "run.sh": "#!/bin/sh\necho v2\n" },
    });
    assert.equal(updated.structuredContent.manifest.version, 2);

    const rolled = await app.inject({ method: "POST", url: `/api/tools/${v1.id}/rollback`, headers: adminAuth, payload: { version: 1 } });
    assert.equal(rolled.statusCode, 200);
    assert.equal(rolled.json().index.current_version, 1);
    assert.deepEqual(rolled.json().index.versions, [1, 2]);
    assert.equal(rolled.json().manifest.description, "version one");
    // Version 2 stays immutable and readable.
    const v2 = await app.inject({ method: "GET", url: `/api/tools/${v1.id}?version=2`, headers: adminAuth });
    assert.equal(v2.json().manifest.description, "version two");
    // New spawns in the conversation resolve the rolled-back version (pinned
    // at spawn from current_version), from the child's own cache dir.
    const spawned = await makeTask(app, "after rollback", a.rootId);
    const resolved = workerRequest(spawned).tools.find((tool: any) => tool.manifest.id === v1.id);
    assert.equal(resolved.manifest.version, 1);
    assert.equal(resolved.manifest.description, "version one");
    assert.equal(resolved.cachePath, join(toolCacheDir(settings), spawned.id, v1.id, "1"));
    assert.match(readFileSync(join(resolved.cachePath, "run.sh"), "utf8"), /echo hi/);
    // Roll forward again works (any recorded version).
    assert.equal((await app.inject({ method: "POST", url: `/api/tools/${v1.id}/rollback`, headers: adminAuth, payload: { version: 2 } })).statusCode, 200);
    // Bad versions are refused; the current version is untouched.
    assert.equal((await app.inject({ method: "POST", url: `/api/tools/${v1.id}/rollback`, headers: adminAuth, payload: { version: 9 } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/tools/${v1.id}/rollback`, headers: adminAuth, payload: { version: "1" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/tools/${v1.id}/rollback`, headers: adminAuth, payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/tools/tl_nope/rollback", headers: adminAuth, payload: { version: 1 } })).statusCode, 404);
    assert.equal(new ToolRegistry(toolsDir(settings), {}).getIndex(v1.id)?.current_version, 2);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete removes the tool, its versions and EVERY cache copy across roots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  try {
    const manifest = await author(app, a.token, "deletable");
    const other = await author(app, a.token, "survivor");
    // Cache copies under two roots (a child may hold a pinned copy)…
    for (const root of [a.rootId, "t_child"]) {
      const copy = join(toolCacheDir(settings), root, manifest.id, "1");
      mkdirSync(copy, { recursive: true });
      writeFileSync(join(copy, "run.sh"), "#!/bin/sh\necho hi\n");
    }
    // …while another tool's copy must survive.
    const survivorCopy = join(toolCacheDir(settings), a.rootId, other.id, "1");
    mkdirSync(survivorCopy, { recursive: true });
    writeFileSync(join(survivorCopy, "run.sh"), "#!/bin/sh\necho hi\n");

    const deleted = await app.inject({ method: "DELETE", url: `/api/tools/${manifest.id}`, headers: adminAuth });
    assert.equal(deleted.statusCode, 204);
    assert.ok(!existsSync(join(toolsDir(settings), manifest.id)));
    assert.ok(!existsSync(join(toolCacheDir(settings), a.rootId, manifest.id)));
    assert.ok(!existsSync(join(toolCacheDir(settings), "t_child", manifest.id)));
    assert.ok(existsSync(join(survivorCopy, "run.sh")));
    assert.equal((await app.inject({ method: "GET", url: `/api/tools/${manifest.id}`, headers: adminAuth })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/tools/${manifest.id}`, headers: adminAuth })).statusCode, 404);
    const fresh = new ToolRegistry(toolsDir(settings), {});
    assert.equal(fresh.get(manifest.id), undefined);
    assert.ok(fresh.get(other.id));
    // New spawns in the conversation no longer see the deleted tool.
    const spawned = await makeTask(app, "after delete", a.rootId);
    assert.ok(!workerRequest(spawned).tools.some((tool: any) => tool.manifest.id === manifest.id));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve also promotes a pending CONVERSATION-scoped tool to global", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  const b = await conversation(app, tokens);
  try {
    const manifest = await author(app, a.token, "conv-promoted");
    await call(app, a.token, "tool_request_promotion", { id: manifest.id, reason: "everyone needs this" });
    const index = new ToolRegistry(toolsDir(settings), {}).getIndex(manifest.id)!;
    assert.equal(index.scope, "conversation");
    assert.equal(index.status, "pending_approval");
    const approved = await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/approve`, headers: adminAuth });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().index.scope, "global");
    assert.equal(approved.json().index.status, "active");
    assert.equal(approved.json().index.owner_root_id, null);
    // Visible to a completely unrelated conversation now.
    const fresh = new ToolRegistry(toolsDir(settings), {});
    assert.ok(fresh.resolveFor({ rootId: b.rootId, taskId: b.task.id }).some((tool) => tool.manifest.id === manifest.id));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REGRESSION: approved agent-global tools are REGISTERED by the worker extension, not just composed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  try {
    // (a) agent-authored globals: command + mcp, born pending_approval in
    // their IMMUTABLE manifests. Approval flips only the index.
    const cmd = await author(app, a.token, "regcmd", { scope: "global" });
    const mcpCreated = await call(app, a.token, "tool_create", {
      name: "regmcp", kind: "mcp", description: "a remote server", url: "http://127.0.0.1:9/mcp", scope: "global",
    });
    assert.ok(!mcpCreated.isError, JSON.stringify(mcpCreated));
    const mcp = mcpCreated.structuredContent.manifest;
    assert.equal(cmd.status, "pending_approval");
    assert.equal(mcp.status, "pending_approval");

    // Before approval: an unrelated spawn neither resolves nor registers them.
    const before = await makeTask(app, "before approval");
    const beforeProbe = registrationProbe();
    createRegistryExtension({ tools: workerRequest(before).tools, cwd: before.workspace })(beforeProbe.pi);
    assert.ok(!beforeProbe.toolNames.includes("regcmd"));
    assert.ok(!beforeProbe.serverNames.includes("regmcp"));

    for (const id of [cmd.id, mcp.id]) {
      const approved = await app.inject({ method: "POST", url: `/api/tools/${id}/approve`, headers: adminAuth });
      assert.equal(approved.statusCode, 200);
    }

    // After approval: the composed set carries the LIVE status/scope…
    const after = await makeTask(app, "after approval");
    const tools = workerRequest(after).tools;
    const resolvedCmd = tools.find((tool: any) => tool.manifest.id === cmd.id);
    const resolvedMcp = tools.find((tool: any) => tool.manifest.id === mcp.id);
    assert.ok(resolvedCmd && resolvedMcp, "approved globals missing from the spawn request");
    assert.equal(resolvedCmd.manifest.status, "active");
    assert.equal(resolvedCmd.manifest.scope, "global");
    assert.equal(resolvedMcp.manifest.status, "active");
    assert.equal(resolvedMcp.manifest.scope, "global");
    // …and the worker extension ACTUALLY REGISTERS them (the old bug: the
    // immutable manifest still said pending_approval, so registerManifest
    // silently skipped every approved tool).
    const probe = registrationProbe();
    createRegistryExtension({ tools, cwd: after.workspace })(probe.pi);
    assert.ok(probe.toolNames.includes("regcmd"), `registerTool not called for the approved command global: ${probe.toolNames}`);
    assert.ok(probe.serverNames.includes("regmcp"), `registerMcpServer not called for the approved mcp global: ${probe.serverNames}`);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REGRESSION: reject -> update -> re-promote -> approve registers the revised version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  try {
    // (b) A conversation tool whose v2 is written while DISABLED carries
    // status:"disabled" + stale scope:"conversation" in its immutable
    // manifest; after re-promotion + approval only the index is active+global.
    const manifest = await author(app, a.token, "regrevise");
    await call(app, a.token, "tool_request_promotion", { id: manifest.id, reason: "share" });
    assert.equal((await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/reject`, headers: adminAuth })).statusCode, 200);
    const updated = await call(app, a.token, "tool_update", {
      id: manifest.id, description: "revised", files: { "run.sh": "#!/bin/sh\necho v2\n" },
    });
    assert.ok(!updated.isError, JSON.stringify(updated));
    assert.equal(updated.structuredContent.manifest.version, 2);
    assert.equal(updated.structuredContent.manifest.status, "disabled");
    assert.equal(updated.structuredContent.manifest.scope, "conversation");
    // While disabled, not even the creator's lineage children resolve it.
    const disabledSpawn = await makeTask(app, "while disabled", a.rootId);
    assert.ok(!workerRequest(disabledSpawn).tools.some((tool: any) => tool.manifest.id === manifest.id));

    await call(app, a.token, "tool_request_promotion", { id: manifest.id, reason: "revised, share again" });
    const approved = await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/approve`, headers: adminAuth });
    assert.equal(approved.statusCode, 200);

    // An UNRELATED conversation's spawn resolves v2 with live active+global…
    const after = await makeTask(app, "after re-approval");
    const tools = workerRequest(after).tools;
    const resolved = tools.find((tool: any) => tool.manifest.id === manifest.id);
    assert.ok(resolved, "re-approved tool missing from the unrelated spawn");
    assert.equal(resolved.manifest.version, 2);
    assert.equal(resolved.manifest.status, "active");
    assert.equal(resolved.manifest.scope, "global");
    assert.equal(resolved.manifest.description, "revised");
    // …and the worker extension registers it (guard sees the overlaid status).
    const probe = registrationProbe();
    createRegistryExtension({ tools, cwd: after.workspace })(probe.pi);
    assert.ok(probe.toolNames.includes("regrevise"), `registerTool not called for the re-approved tool: ${probe.toolNames}`);
    // The immutable v2 manifest on disk STILL carries the authoring-time state.
    const onDisk = JSON.parse(readFileSync(join(toolsDir(settings), manifest.id, "2", "manifest.json"), "utf8"));
    assert.equal(onDisk.status, "disabled");
    assert.equal(onDisk.scope, "conversation");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve honors expected_version: a review-time update => 409, matching version => 200", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  try {
    const manifest = await author(app, a.token, "pinnedreview", { scope: "global" });
    await call(app, a.token, "tool_request_promotion", { id: manifest.id, reason: "review me" });
    // The creator sneaks an update in between human review and approval.
    const updated = await call(app, a.token, "tool_update", { id: manifest.id, description: "sneaky change" });
    assert.equal(updated.structuredContent.manifest.version, 2);
    const stale = await app.inject({
      method: "POST", url: `/api/tools/${manifest.id}/approve`, headers: adminAuth, payload: { expected_version: 1 },
    });
    assert.equal(stale.statusCode, 409);
    assert.match(stale.json().error, /version 2.*reviewed version 1|re-review/);
    // Nothing was activated.
    assert.equal(new ToolRegistry(toolsDir(settings), {}).getIndex(manifest.id)?.status, "pending_approval");
    // Malformed expected_version is a 400.
    for (const bad of ["1", 0, -1, 1.5]) {
      const response = await app.inject({
        method: "POST", url: `/api/tools/${manifest.id}/approve`, headers: adminAuth, payload: { expected_version: bad },
      });
      assert.equal(response.statusCode, 400, JSON.stringify(bad));
    }
    // The matching (re-reviewed) version approves.
    const ok = await app.inject({
      method: "POST", url: `/api/tools/${manifest.id}/approve`, headers: adminAuth, payload: { expected_version: 2 },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().index.status, "active");
    // Without expected_version the path still works (Telegram / legacy callers).
    const other = await author(app, a.token, "unpinned", { scope: "global" });
    const plain = await app.inject({ method: "POST", url: `/api/tools/${other.id}/approve`, headers: adminAuth });
    assert.equal(plain.statusCode, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/tools/:id?version=N returns the immutable historical manifest verbatim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  try {
    // Born pending_approval: the v1 manifest keeps that status forever.
    const manifest = await author(app, a.token, "histview", { scope: "global" });
    await app.inject({ method: "POST", url: `/api/tools/${manifest.id}/approve`, headers: adminAuth });
    const historical = await app.inject({ method: "GET", url: `/api/tools/${manifest.id}?version=1`, headers: adminAuth });
    assert.equal(historical.statusCode, 200);
    // Verbatim immutable record — NO live overlay…
    assert.equal(historical.json().manifest.status, "pending_approval");
    assert.equal(historical.json().manifest.scope, "global");
    // …while the response's index carries the live state.
    assert.equal(historical.json().index.status, "active");
    assert.equal(historical.json().index.scope, "global");
    // The current-version GET overlays the live state.
    const current = await app.inject({ method: "GET", url: `/api/tools/${manifest.id}`, headers: adminAuth });
    assert.equal(current.json().manifest.status, "active");
    const currentExplicit = await app.inject({ method: "GET", url: `/api/tools/${manifest.id}?version=1`, headers: adminAuth });
    assert.equal(currentExplicit.json().manifest.status, "pending_approval"); // explicit version: verbatim, even when current
    // After an update, ?version=1 stays verbatim and the new current overlays.
    const registry = new ToolRegistry(toolsDir(settings), {});
    registry.update(manifest.id, {
      name: "histview", kind: "command", description: "v2",
      input_schema: { type: "object", properties: {} },
      command: { argv: ["echo", "hi"], files: { "run.sh": "#!/bin/sh\necho hi\n" } },
    });
    const { app: app2 } = await createApp(settings);
    try {
      const v1 = await app2.inject({ method: "GET", url: `/api/tools/${manifest.id}?version=1`, headers: adminAuth });
      assert.equal(v1.json().manifest.status, "pending_approval");
      assert.equal(v1.json().manifest.version, 1);
      const v2 = await app2.inject({ method: "GET", url: `/api/tools/${manifest.id}?version=2`, headers: adminAuth });
      assert.equal(v2.json().manifest.status, "active"); // written while active: verbatim is already active
    } finally {
      await app2.close();
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin creates command + extension tools via POST /api/tools (human origin, active global)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-tools-api-"));
  const settings = settingsFor(dir);
  const { app, tokens } = await createApp(settings);
  const a = await conversation(app, tokens);
  try {
    // Human-authored command global: active immediately, unowned.
    const cmd = await app.inject({
      method: "POST", url: "/api/tools", headers: adminAuth,
      payload: {
        name: "admincmd", kind: "command", description: "human command tool",
        input_schema: { type: "object", properties: {} },
        argv: ["echo", "hi"], files: { "run.sh": "#!/bin/sh\necho hi\n" },
      },
    });
    assert.equal(cmd.statusCode, 201, cmd.body);
    assert.equal(cmd.json().index.status, "active");
    assert.equal(cmd.json().index.scope, "global");
    assert.equal(cmd.json().index.owner_root_id, null);
    assert.equal(cmd.json().index.owner_task_id, null);
    assert.equal(cmd.json().manifest.provenance.origin, "human");
    assert.equal(cmd.json().manifest.status, "active");
    assert.ok(existsSync(join(cmd.json().cachePath, "run.sh")), "command sources staged");

    // Human-authored EXTENSION global: the only authoring path for extensions.
    const ext = await app.inject({
      method: "POST", url: "/api/tools", headers: adminAuth,
      payload: {
        name: "adminext", kind: "extension", description: "human extension tool",
        entry: "ext.ts", files: { "ext.ts": "export default (pi) => {};\n", "lib/helper.ts": "export const x = 1;\n" },
      },
    });
    assert.equal(ext.statusCode, 201, ext.body);
    const extIndex = ext.json().index;
    assert.equal(extIndex.status, "active");
    assert.equal(extIndex.scope, "global");
    assert.equal(ext.json().manifest.provenance.origin, "human");
    assert.equal(ext.json().manifest.extension.entry, "ext.ts");
    // Extension files staged + entry exists in the cache copy.
    assert.equal(ext.json().cachePath, join(toolCacheDir(settings), "admin", extIndex.id, "1"));
    assert.ok(existsSync(join(ext.json().cachePath, "ext.ts")));
    assert.ok(existsSync(join(ext.json().cachePath, "lib", "helper.ts")));

    // New spawns resolve both; the extension meets every worker-load condition
    // (kind extension, live status active, origin human, entry present in cache).
    const spawned = await makeTask(app, "with human tools");
    const tools = workerRequest(spawned).tools;
    const resolvedCmd = tools.find((tool: any) => tool.manifest.id === cmd.json().index.id);
    const resolvedExt = tools.find((tool: any) => tool.manifest.id === extIndex.id);
    assert.ok(resolvedCmd && resolvedExt);
    assert.equal(resolvedExt.manifest.status, "active");
    assert.equal(resolvedExt.manifest.provenance.origin, "human");
    assert.equal(resolvedExt.cachePath, join(toolCacheDir(settings), spawned.id, extIndex.id, "1"));
    assert.ok(existsSync(join(resolvedExt.cachePath, resolvedExt.manifest.extension.entry)));
    // The command tool registers through the worker extension.
    const probe = registrationProbe();
    createRegistryExtension({ tools, cwd: spawned.workspace })(probe.pi);
    assert.ok(probe.toolNames.includes("admincmd"));

    // Validation and gate-keeping.
    assert.equal((await app.inject({ method: "POST", url: "/api/tools", headers: adminAuth, payload: { name: "admincmd", kind: "command", description: "dup", input_schema: { type: "object", properties: {} }, argv: ["echo"], files: {} } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/api/tools", headers: adminAuth, payload: { name: "browser", kind: "mcp", description: "reserved", url: "http://x/mcp" } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/api/tools", headers: adminAuth, payload: { name: "badscope", kind: "mcp", description: "d", url: "http://x/mcp", scope: "conversation" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/tools", headers: adminAuth, payload: { name: "noextfiles", kind: "extension", description: "d", entry: "e.ts" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/tools", headers: adminAuth, payload: { name: "badargv", kind: "command", description: "d", input_schema: { type: "object", properties: {} }, argv: ["/bin/sh"], files: {} } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/tools", headers: adminAuth, payload: { name: "smuggled", kind: "mcp", description: "d", url: "http://x/mcp", provenance: { origin: "task" } } })).statusCode, 400);
    // Task tokens (even the creator's) get 401 — covered exhaustively above,
    // spot-checked here with a valid payload.
    assert.equal((await app.inject({ method: "POST", url: "/api/tools", headers: bearer(a.token), payload: { name: "tasktry", kind: "command", description: "d", input_schema: { type: "object", properties: {} }, argv: ["echo"], files: {} } })).statusCode, 401);
    // The agent MCP still refuses extensions for everyone.
    const viaMcp = await call(app, a.token, "tool_create", { name: "extmcp", kind: "extension", description: "d" });
    assert.equal(viaMcp.isError, true);
    assert.match(viaMcp.content[0].text!, /POST \/api\/tools/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
