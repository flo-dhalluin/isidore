import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_MANIFEST_BYTES, MAX_SOURCE_BYTES, MAX_TOOL_FILES, MAX_TOOLS_PER_CONVERSATION } from "../src/limits.ts";
import { stageToolCache } from "../src/tool-cache.ts";
import { builtinManifests, ToolRegistry, validateToolInput, type ResolvedTool, type ToolInput, type ToolOwner } from "../src/tools.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "isidore-tools-"));
}

function commandInput(name: string, overrides: Partial<ToolInput> = {}): ToolInput {
  return {
    name,
    kind: "command",
    description: `test tool ${name}`,
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    command: { argv: ["echo", "{{text}}"], files: { "run.sh": "#!/bin/sh\necho hello\n" } },
    ...overrides,
  };
}

const convOwner = (rootId: string, taskId = `${rootId}-task`): ToolOwner => ({
  scope: "conversation",
  rootId,
  taskId,
  origin: "task",
});

const taskOwner = (rootId: string, taskId: string): ToolOwner => ({ scope: "task", rootId, taskId, origin: "task" });

const humanOwner: ToolOwner = { scope: "global", rootId: null, taskId: null, origin: "human" };

const names = (resolved: Array<{ manifest: { name: string } }>): string[] => resolved.map((tool) => tool.manifest.name);

test("create writes immutable version dir and index", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    const manifest = registry.create(commandInput("echoer"), convOwner("t_a"));
    assert.match(manifest.id, /^tl_[0-9a-f]{12}$/);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.status, "active");
    assert.match(manifest.provenance.sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.provenance.task_id, "t_a-task");
    assert.equal(manifest.provenance.root_id, "t_a");
    const versionDir = join(dir, manifest.id, "1");
    assert.ok(existsSync(join(versionDir, "manifest.json")));
    assert.equal(readFileSync(join(versionDir, "files", "run.sh"), "utf8"), "#!/bin/sh\necho hello\n");
    const index = JSON.parse(readFileSync(join(dir, manifest.id, "index.json"), "utf8"));
    assert.deepEqual(index.versions, [1]);
    assert.equal(index.current_version, 1);
    assert.equal(index.owner_root_id, "t_a");
    // A fresh registry reloads the index from disk.
    const reloaded = new ToolRegistry(dir, {});
    assert.equal(reloaded.get(manifest.id)?.name, "echoer");
    assert.deepEqual(reloaded.get(manifest.id), manifest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update bumps the version and preserves prior bytes", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    const first = registry.create(commandInput("echoer"), convOwner("t_a"));
    const before = readFileSync(join(dir, first.id, "1", "files", "run.sh"), "utf8");
    const second = registry.update(first.id, commandInput("echoer", { command: { argv: ["echo", "{{text}}"], files: { "run.sh": "#!/bin/sh\necho v2\n" } } }));
    assert.equal(second.version, 2);
    assert.notEqual(second.provenance.sha256, first.provenance.sha256);
    assert.equal(readFileSync(join(dir, first.id, "1", "files", "run.sh"), "utf8"), before);
    assert.equal(readFileSync(join(dir, first.id, "2", "files", "run.sh"), "utf8"), "#!/bin/sh\necho v2\n");
    assert.deepEqual(registry.getIndex(first.id)?.versions, [1, 2]);
    assert.equal(registry.get(first.id)?.version, 2);
    assert.equal(registry.get(first.id, 1)?.version, 1);
    assert.equal(registry.get(first.id, 1)?.command?.files["run.sh"], "#!/bin/sh\necho hello\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback resolves the old immutable version", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    const first = registry.create(commandInput("echoer"), convOwner("t_a"));
    registry.update(first.id, commandInput("echoer", { description: "v2" }));
    assert.equal(registry.setCurrentVersion(first.id, 1), true);
    const resolved = registry.resolveFor({ rootId: "t_a", taskId: "t_a-task" });
    const echoer = resolved.find((tool) => tool.manifest.id === first.id);
    assert.equal(echoer?.manifest.version, 1);
    assert.equal(echoer?.manifest.description, "test tool echoer");
    assert.equal(echoer?.cachePath, null);
    assert.throws(() => registry.setCurrentVersion(first.id, 99), /not recorded/);
    assert.equal(registry.setCurrentVersion("tl_missing", 1), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFor unions scopes and excludes other conversations", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    registry.create(commandInput("globaltool"), humanOwner);
    registry.create(commandInput("convtool"), convOwner("t_a"));
    registry.create(commandInput("tasktool"), taskOwner("t_a", "t_a-1"));
    registry.create(commandInput("othertask"), taskOwner("t_a", "t_a-2"));
    registry.create(commandInput("otherconv"), convOwner("t_b"));
    const resolved = registry.resolveFor({ rootId: "t_a", taskId: "t_a-1" });
    const stored = resolved.filter((tool) => !tool.manifest.id.startsWith("builtin:")).map((tool) => tool.manifest.name);
    assert.deepEqual(stored.sort(), ["convtool", "globaltool", "tasktool"]);
    // Builtins are appended last.
    assert.deepEqual(names(resolved).slice(-3), ["codemode", "tool_search", "mcp"]);
    // Another task in the same conversation sees its own task tool, not t_a-1's.
    const other = names(registry.resolveFor({ rootId: "t_a", taskId: "t_a-2" }));
    assert.ok(other.includes("othertask"));
    assert.ok(!other.includes("tasktool"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFor honors pinned inherited versions after update", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    const parent = registry.create(commandInput("heirloom"), convOwner("t_a"));
    registry.update(parent.id, commandInput("heirloom", { description: "v2" }));
    const warnings: string[] = [];
    const child = registry.resolveFor({ rootId: "t_child", taskId: "t_child-1", inherited: [{ id: parent.id, version: 1 }] }, warnings);
    const pinned = child.find((tool) => tool.manifest.id === parent.id);
    assert.equal(pinned?.manifest.version, 1);
    assert.equal(pinned?.manifest.description, "test tool heirloom");
    assert.deepEqual(warnings, []);
    // The parent conversation still resolves the current version.
    const home = registry.resolveFor({ rootId: "t_a", taskId: "t_a-task" });
    assert.equal(home.find((tool) => tool.manifest.id === parent.id)?.manifest.version, 2);
    // Missing pins are skipped with a warning.
    const missing: string[] = [];
    const result = registry.resolveFor(
      { rootId: "t_child", taskId: "t_child-1", inherited: [{ id: "tl_000000000000", version: 1 }, { id: parent.id, version: 99 }] },
      missing,
    );
    assert.ok(!result.some((tool) => tool.manifest.id === "tl_000000000000"));
    assert.equal(result.filter((tool) => tool.manifest.id === parent.id).length, 0);
    assert.equal(missing.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabled and pending_approval tools are not resolved", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    const disabled = registry.create(commandInput("offtool"), convOwner("t_a"));
    const pending = registry.create(commandInput("waittool"), convOwner("t_a"));
    registry.setStatus(disabled.id, "disabled");
    registry.setStatus(pending.id, "pending_approval");
    const resolved = names(registry.resolveFor({ rootId: "t_a", taskId: "t_a-task" }));
    assert.ok(!resolved.includes("offtool"));
    assert.ok(!resolved.includes("waittool"));
    // Pinned inherited tools that were disabled are excluded too.
    const pinned = registry.resolveFor({ rootId: "t_b", taskId: "t_b-1", inherited: [{ id: disabled.id, version: 1 }] });
    assert.ok(!pinned.some((tool) => tool.manifest.id === disabled.id));
    registry.setStatus(disabled.id, "active");
    assert.ok(names(registry.resolveFor({ rootId: "t_a", taskId: "t_a-task" })).includes("offtool"));
    // Agent-authored globals start pending; human-authored globals are active.
    const agentGlobal = registry.create(commandInput("agentglobal"), { scope: "global", rootId: null, taskId: "t_a-task", origin: "task" });
    assert.equal(agentGlobal.status, "pending_approval");
    assert.ok(!names(registry.resolveFor({ rootId: "t_a", taskId: "t_a-task" })).includes("agentglobal"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotConversation pins current versions of active conversation tools", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    const first = registry.create(commandInput("one"), convOwner("t_a"));
    registry.update(first.id, commandInput("one", { description: "v2" }));
    const second = registry.create(commandInput("two"), convOwner("t_a"));
    registry.setStatus(second.id, "disabled");
    registry.create(commandInput("taskscoped"), taskOwner("t_a", "t_a-1"));
    registry.create(commandInput("elsewhere"), convOwner("t_b"));
    assert.deepEqual(registry.snapshotConversation("t_a"), [{ id: first.id, version: 2 }]);
    assert.deepEqual(registry.snapshotConversation("t_missing"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("limits: too many tools, oversized manifest/source, too many files", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    for (let i = 0; i < MAX_TOOLS_PER_CONVERSATION; i++) {
      registry.create(commandInput(`tool${i}`), convOwner("t_a"));
    }
    assert.throws(() => registry.create(commandInput("onetoomany"), convOwner("t_a")), /32 tools/);
    // Other conversations are unaffected; task tools count toward the limit.
    registry.create(commandInput("fresh"), convOwner("t_b"));
    assert.throws(() => registry.create(commandInput("taskextra"), taskOwner("t_a", "t_a-9")), /32 tools/);
    assert.throws(
      () => registry.create(commandInput("bigmanifest", { description: "x".repeat(MAX_MANIFEST_BYTES) }), convOwner("t_c")),
      /manifest exceeds/,
    );
    assert.throws(
      () => registry.create(commandInput("bigsource", { command: { argv: ["echo"], files: { "big.txt": "x".repeat(MAX_SOURCE_BYTES + 1) } } }), convOwner("t_c")),
      /sources exceed/,
    );
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_TOOL_FILES; i++) files[`f${i}.txt`] = "x";
    assert.throws(
      () => registry.create(commandInput("manyfiles", { command: { argv: ["echo"], files } }), convOwner("t_c")),
      /too many tool files/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path traversal and absolute file names are rejected", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    for (const name of ["../evil.sh", "/etc/passwd", "a/../../evil.sh", "./run.sh", "a//b.sh", "a\\b.sh", ""]) {
      assert.throws(
        () => registry.create(commandInput("traversal", { command: { argv: ["echo"], files: { [name]: "x" } } }), convOwner("t_a")),
        /path/,
      );
    }
    // Nested relative paths are fine.
    const ok = registry.create(commandInput("nested", { command: { argv: ["echo"], files: { "lib/util.sh": "x" } } }), convOwner("t_a"));
    assert.ok(existsSync(join(dir, ok.id, "1", "files", "lib", "util.sh")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("name collisions with builtins, reserved names and the same owner are rejected", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    for (const name of ["browser", "scheduler", "tools", "bash", "read", "edit", "write", "find", "grep", "ls", "codemode", "tool_search", "mcp"]) {
      assert.throws(() => registry.create(commandInput(name), convOwner("t_a")), /reserved/);
    }
    registry.create(commandInput("dup"), convOwner("t_a"));
    assert.throws(() => registry.create(commandInput("dup"), convOwner("t_a")), /already exists/);
    // Globals collide across owners; a different conversation may reuse a name.
    registry.create(commandInput("shared"), humanOwner);
    assert.throws(() => registry.create(commandInput("shared"), convOwner("t_b")), /already exists/);
    registry.create(commandInput("dup"), convOwner("t_b"));
    // Invalid names are rejected outright.
    for (const name of ["Upper", "1digit", "-dash", "a".repeat(65), "has space", ""]) {
      assert.throws(() => registry.create(commandInput(name), convOwner("t_c")), /name must match/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateToolInput: argv, placeholders, schema, mcp and extension rules", () => {
  const opts = { allowExtension: false };
  const schema = { type: "object", properties: { text: { type: "string" } } };
  const base = commandInput("valid");
  validateToolInput(base, opts); // sanity: the helper input is valid
  // argv[0] must be a bare program name.
  for (const program of ["/bin/sh", "sh;rm", "a|b", "a&&b", "a b", "$(x)", "`x`", "a>b", "", "{{text}}"]) {
    assert.throws(() => validateToolInput(commandInput("bad", { command: { argv: [program], files: {} } }), opts), /argv/);
  }
  // Placeholders must reference schema properties.
  assert.throws(
    () => validateToolInput(commandInput("bad", { input_schema: schema, command: { argv: ["echo", "{{missing}}"], files: {} } }), opts),
    /placeholder/,
  );
  assert.throws(
    () => validateToolInput(commandInput("bad", { input_schema: schema, command: { argv: ["echo", "{{text"], files: {} } }), opts),
    /placeholder/,
  );
  // command requires a type:"object" schema; $ref is rejected.
  assert.throws(() => validateToolInput(commandInput("bad", { input_schema: undefined }), opts), /input_schema/);
  assert.throws(() => validateToolInput(commandInput("bad", { input_schema: { type: "string" } }), opts), /type:"object"/);
  assert.throws(
    () => validateToolInput(commandInput("bad", { input_schema: { type: "object", properties: { a: { $ref: "#/x" } } } }), opts),
    /\$ref/,
  );
  // mcp: http(s) only, no credentials, no auth/oauth fields.
  const mcp = (extra: Record<string, unknown>): ToolInput => ({ name: "remote", kind: "mcp", description: "d", mcp: { url: "http://x/mcp", ...extra } as ToolInput["mcp"] });
  validateToolInput(mcp({ headers: { Authorization: "Bearer ${ISIDORE_TASK_TOKEN}" } }), opts);
  assert.throws(() => validateToolInput(mcp({ url: "ftp://x/mcp" }), opts), /http\(s\)/);
  assert.throws(() => validateToolInput(mcp({ url: "http://user:pass@x/mcp" }), opts), /credentials/);
  assert.throws(() => validateToolInput(mcp({ auth: { token: "x" } }), opts), /unknown mcp field/);
  assert.throws(() => validateToolInput(mcp({ oauth: {} }), opts), /unknown mcp field/);
  assert.throws(() => validateToolInput({ ...base, oauth: {} } as ToolInput, opts), /unknown tool field/);
  assert.throws(() => validateToolInput(mcp({ timeout: 121 }), opts), /timeout/);
  // extension is human-only.
  const ext: ToolInput = { name: "ext", kind: "extension", description: "d", extension: { entry: "ext.ts" } };
  assert.throws(() => validateToolInput(ext, opts), /human-only/);
  validateToolInput(ext, { allowExtension: true });
  assert.throws(() => validateToolInput({ ...ext, extension: { entry: "../ext.ts" } }, { allowExtension: true }), /path/);
  // command timeout cap.
  assert.throws(
    () => validateToolInput(commandInput("bad", { command: { argv: ["echo"], files: {}, timeout_seconds: 121 } }), opts),
    /timeout/,
  );
});

test("builtin:tools uses ISIDORE_TOOLS_URL or the port fallback; absent with neither", () => {
  // Env URL wins (compose sets http://isidore:8920/mcp/tools).
  const envUrl = builtinManifests({ ISIDORE_TOOLS_URL: "http://isidore:8920/mcp/tools" }, 9999);
  const tools = envUrl.find((m) => m.id === "builtin:tools");
  assert.ok(tools);
  assert.equal(tools.name, "tools");
  assert.equal(tools.kind, "mcp");
  assert.deepEqual(tools.mcp, {
    url: "http://isidore:8920/mcp/tools",
    headers: { Authorization: "Bearer ${ISIDORE_TASK_TOKEN}" },
    exposure: "direct",
    timeout: 30,
  });
  assert.equal(tools.scope, "global");
  assert.equal(tools.status, "active");
  assert.equal(tools.provenance.origin, "builtin");
  assert.match(tools.provenance.sha256, /^[0-9a-f]{64}$/);
  // Port fallback when no env URL is set.
  const fallback = builtinManifests({}, 8920).find((m) => m.id === "builtin:tools");
  assert.equal(fallback?.mcp?.url, "http://127.0.0.1:8920/mcp/tools");
  // Neither env URL nor port: no entry (bare dev/test environments).
  assert.ok(!builtinManifests({}).some((m) => m.id === "builtin:tools"));
  // resolveFor appends it; builtins are never persisted.
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, { ISIDORE_TOOLS_URL: "http://isidore:8920/mcp/tools" }, 8920);
    const resolved = registry.resolveFor({ rootId: "t_a", taskId: "t_a-1" });
    assert.ok(resolved.some((tool) => tool.manifest.id === "builtin:tools"));
    assert.deepEqual(new ToolRegistry(dir, {}).list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("builtinManifests match the legacy jq block and vanish when URLs are unset", () => {
  const env = { PI_SANDBOX_BROWSER_URL: "http://browser:8931/mcp", PI_SANDBOX_SCHEDULER_URL: "http://scheduler:8930/mcp" };
  const manifests = builtinManifests(env);
  const browser = manifests.find((m) => m.id === "builtin:browser");
  const scheduler = manifests.find((m) => m.id === "builtin:scheduler");
  assert.ok(browser && scheduler);
  // Byte-equivalent to entrypoint.sh's jq output (description lives on the manifest).
  assert.deepEqual(browser.mcp, { url: env.PI_SANDBOX_BROWSER_URL, exposure: "direct", timeout: 120 });
  assert.equal(browser.description, "Headless Firefox: open pages, read and interact with them, fill forms, take screenshots");
  assert.deepEqual(scheduler.mcp, {
    url: env.PI_SANDBOX_SCHEDULER_URL,
    headers: { "X-Isidore-Task-Token": "${ISIDORE_TASK_TOKEN}", "X-Isidore-Origin": "${ISIDORE_TASK_ORIGIN}" },
    exposure: "direct",
    timeout: 30,
  });
  assert.equal(scheduler.description, "Schedule one-shot or recurring tasks that spawn isolated Pi agents");
  for (const m of [browser, scheduler]) {
    assert.equal(m.version, 1);
    assert.equal(m.scope, "global");
    assert.equal(m.status, "active");
    assert.equal(m.provenance.task_id, null);
    assert.equal(m.provenance.origin, "builtin");
  }
  // Informational extension entries are always present.
  for (const name of ["codemode", "tool_search", "mcp"]) {
    const entry = manifests.find((m) => m.id === `builtin:${name}`);
    assert.equal(entry?.kind, "extension");
    assert.equal(entry?.scope, "global");
    assert.equal(entry?.status, "active");
  }
  // Unset URLs remove the entries entirely.
  assert.deepEqual(builtinManifests({}).map((m) => `builtin:${m.name}`), ["builtin:codemode", "builtin:tool_search", "builtin:mcp"]);
  assert.deepEqual(builtinManifests({ PI_SANDBOX_BROWSER_URL: env.PI_SANDBOX_BROWSER_URL }).filter((m) => m.kind === "mcp").map((m) => m.name), ["browser"]);
});

test("builtins are never persisted and are appended by resolveFor", () => {
  const dir = tempDir();
  try {
    const env = { PI_SANDBOX_BROWSER_URL: "http://browser:8931/mcp" };
    const registry = new ToolRegistry(dir, env);
    registry.resolveFor({ rootId: "t_a", taskId: "t_a-1" });
    assert.deepEqual(new ToolRegistry(dir, env).list(), []);
    const resolved = registry.resolveFor({ rootId: "t_a", taskId: "t_a-1" });
    assert.ok(resolved.some((tool) => tool.manifest.id === "builtin:browser"));
    assert.ok(resolved.every((tool) => tool.cachePath === null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeConversation deletes indexes and version dirs", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    const first = registry.create(commandInput("one"), convOwner("t_a"));
    const second = registry.create(commandInput("two"), taskOwner("t_a", "t_a-1"));
    const global = registry.create(commandInput("globaltool"), humanOwner);
    const other = registry.create(commandInput("other"), convOwner("t_b"));
    const removed = registry.removeConversation("t_a");
    assert.deepEqual(removed.sort(), [first.id, second.id].sort());
    assert.ok(!existsSync(join(dir, first.id)));
    assert.ok(!existsSync(join(dir, second.id)));
    assert.ok(existsSync(join(dir, global.id, "index.json")));
    assert.ok(existsSync(join(dir, other.id, "index.json")));
    assert.equal(registry.get(first.id), undefined);
    assert.deepEqual(new ToolRegistry(dir, {}).list().map((index) => index.id).sort(), [global.id, other.id].sort());
    // remove() of a single tool and of a missing id.
    assert.equal(registry.remove(other.id), true);
    assert.equal(registry.remove(other.id), false);
    assert.ok(!existsSync(join(dir, other.id)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update adopts orphaned version dirs (crash between rename and writeIndex)", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    const manifest = registry.create(commandInput("echoer"), convOwner("t_a"));
    // Simulate the crash window: <id>/2/ was renamed into place but the index
    // never recorded it (index.versions is still [1] on disk and in memory).
    const orphan = join(dir, manifest.id, "2");
    mkdirSync(join(orphan, "files"), { recursive: true });
    writeFileSync(join(orphan, "manifest.json"), JSON.stringify({ ...manifest, version: 2, description: "orphaned v2" }));
    writeFileSync(join(orphan, "files", "run.sh"), "#!/bin/sh\necho orphan\n");
    assert.deepEqual(registry.getIndex(manifest.id)?.versions, [1]);
    // The next update reconciles instead of throwing "already exists" forever.
    const third = registry.update(manifest.id, commandInput("echoer", { description: "v3" }));
    assert.equal(third.version, 3);
    assert.deepEqual(registry.getIndex(manifest.id)?.versions, [1, 2, 3]);
    assert.equal(registry.getIndex(manifest.id)?.current_version, 3);
    // No data lost: the orphaned version is adopted and readable, v1 intact.
    assert.equal(registry.get(manifest.id, 2)?.description, "orphaned v2");
    assert.equal(readFileSync(join(orphan, "files", "run.sh"), "utf8"), "#!/bin/sh\necho orphan\n");
    assert.equal(readFileSync(join(dir, manifest.id, "1", "files", "run.sh"), "utf8"), "#!/bin/sh\necho hello\n");
    // The reconciled index is persisted; a fresh registry sees all versions.
    const reloaded = new ToolRegistry(dir, {});
    assert.deepEqual(reloaded.getIndex(manifest.id)?.versions, [1, 2, 3]);
    assert.equal(reloaded.get(manifest.id)?.version, 3);
    // Immutability still holds: a recorded version dir is never rewritten.
    const before = readFileSync(join(orphan, "manifest.json"), "utf8");
    registry.update(manifest.id, commandInput("echoer", { description: "v4" }));
    assert.equal(readFileSync(join(orphan, "manifest.json"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFor dedups duplicate names by precedence (own > inherited > global)", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    // Name uniqueness is per-owner: a parent conversation and a child can
    // both own "heirloom"; the child's pin and own tool then collide.
    const parent = registry.create(commandInput("heirloom"), convOwner("t_parent"));
    const own = registry.create(commandInput("heirloom"), convOwner("t_child"));
    const parentDup = registry.create(commandInput("taskdup"), convOwner("t_parent2"));
    const taskTool = registry.create(commandInput("taskdup"), taskOwner("t_child", "t_child-1"));
    const warnings: string[] = [];
    const resolved = registry.resolveFor(
      {
        rootId: "t_child",
        taskId: "t_child-1",
        inherited: [
          { id: parent.id, version: 1 },
          { id: parentDup.id, version: 1 },
        ],
      },
      warnings,
    );
    const heirlooms = resolved.filter((tool) => tool.manifest.name === "heirloom");
    assert.equal(heirlooms.length, 1);
    assert.equal(heirlooms[0].manifest.id, own.id); // own conversation beats the inherited pin
    const taskdups = resolved.filter((tool) => tool.manifest.name === "taskdup");
    assert.equal(taskdups.length, 1);
    assert.equal(taskdups[0].manifest.id, taskTool.id); // own task beats the inherited pin
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((warning) => /duplicate tool name/.test(warning)));
    // A global created AFTER a same-named conversation tool loses to it…
    const conv = registry.create(commandInput("sharedname"), convOwner("t_child"));
    const global = registry.create(commandInput("sharedname"), humanOwner);
    const globalWarnings: string[] = [];
    const home = registry.resolveFor({ rootId: "t_child", taskId: "t_child-1" }, globalWarnings);
    const shared = home.filter((tool) => tool.manifest.name === "sharedname");
    assert.equal(shared.length, 1);
    assert.equal(shared[0].manifest.id, conv.id);
    assert.equal(globalWarnings.length, 1);
    // …but other conversations still resolve the global.
    const elsewhere = registry.resolveFor({ rootId: "t_else", taskId: "t_else-1" });
    assert.equal(elsewhere.find((tool) => tool.manifest.name === "sharedname")?.manifest.id, global.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load logs skipped corrupt indexes and filters non-integer versions", () => {
  const dir = tempDir();
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.join(" "));
  };
  try {
    mkdirSync(join(dir, "tl_corrupt"), { recursive: true });
    writeFileSync(join(dir, "tl_corrupt", "index.json"), "{not json");
    mkdirSync(join(dir, "tl_badshape"), { recursive: true });
    writeFileSync(join(dir, "tl_badshape", "index.json"), JSON.stringify({ id: "tl_badshape", versions: "nope" }));
    mkdirSync(join(dir, "tl_mixed"), { recursive: true });
    writeFileSync(
      join(dir, "tl_mixed", "index.json"),
      JSON.stringify({ id: "tl_mixed", name: "mixed", versions: [1, "2", null, 3, 2.5] }),
    );
    const registry = new ToolRegistry(dir, {});
    assert.equal(registry.getIndex("tl_corrupt"), undefined);
    assert.equal(registry.getIndex("tl_badshape"), undefined);
    // Only integer version numbers survive (hardens the path joins).
    assert.deepEqual(registry.getIndex("tl_mixed")?.versions, [1, 3]);
    assert.ok(logged.some((line) => line.includes("tl_corrupt")), "corrupt index skipped silently");
    assert.ok(logged.some((line) => line.includes("tl_badshape")), "bad-shape index skipped silently");
  } finally {
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateToolInput: $ref keys rejected, mention-in-text accepted; header hygiene", () => {
  const opts = { allowExtension: false };
  // Description text merely mentioning the keywords is fine (key walk, not
  // a string search over the serialized schema).
  validateToolInput(
    commandInput("ok", {
      input_schema: { type: "object", properties: { text: { type: "string", description: 'mentions "$ref" and "$dynamicRef" in text' } } },
    }),
    opts,
  );
  // Actual keys anywhere in the schema are rejected.
  assert.throws(
    () => validateToolInput(commandInput("bad", { input_schema: { type: "object", properties: { a: { type: "object", properties: { b: { $ref: "#/x" } } } } } }), opts),
    /\$ref/,
  );
  assert.throws(
    () => validateToolInput(commandInput("bad", { input_schema: { type: "object", properties: { a: { $dynamicRef: "#x" } } } }), opts),
    /\$dynamicRef/,
  );
  assert.throws(
    () => validateToolInput(commandInput("bad", { input_schema: { type: "object", $defs: { x: { $ref: "#/y" } } } }), opts),
    /\$ref/,
  );
  // Header names must be HTTP tokens; values must not carry CR/LF/NUL.
  // ${VAR} placeholders stay verbatim.
  const mcp = (headers: Record<string, string>): ToolInput => ({ name: "remote", kind: "mcp", description: "d", mcp: { url: "http://x/mcp", headers } });
  validateToolInput(mcp({ "X-Template": "${VAR}", Authorization: "Bearer ${ISIDORE_TASK_TOKEN}" }), opts);
  for (const name of ["Bad Name", "X-Bad\r\nInjected", "X:Colon", "Héllo"]) {
    assert.throws(() => validateToolInput(mcp({ [name]: "x" }), opts), /header name/);
  }
  for (const value of ["a\r\nEvil: b", "a\nb", "a\rb", "a\0b"]) {
    assert.throws(() => validateToolInput(mcp({ "X-Ok": value }), opts), /CR\/LF/);
  }
});

test("pending globals keep creator ownership: quota counted, names reusable elsewhere, clearOwnership releases", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    const globalOwner = (rootId: string): ToolOwner => ({ scope: "global", rootId, taskId: `${rootId}-task`, origin: "task" });
    const pending = registry.create(commandInput("pendingname"), globalOwner("t_a"));
    assert.equal(pending.status, "pending_approval");
    // Ownership is KEPT on the index until human approval (Phase 4).
    const index = registry.getIndex(pending.id);
    assert.equal(index?.owner_root_id, "t_a");
    assert.equal(index?.owner_task_id, "t_a-task");
    // The immutable version manifest carries the FINAL status (written once).
    const onDisk = JSON.parse(readFileSync(join(dir, pending.id, "1", "manifest.json"), "utf8"));
    assert.equal(onDisk.status, "pending_approval");
    // The same owner's names stay blocked (any status)…
    assert.throws(() => registry.create(commandInput("pendingname"), convOwner("t_a")), /already exists/);
    // …but another conversation neither sees nor is blocked by the pending global.
    const bCopy = registry.create(commandInput("pendingname"), convOwner("t_b"));
    assert.notEqual(bCopy.id, pending.id);
    assert.ok(!registry.resolveFor({ rootId: "t_b", taskId: "t_b-task" }).some((tool) => tool.manifest.id === pending.id));
    assert.ok(!registry.resolveFor({ rootId: "t_a", taskId: "t_a-task" }).some((tool) => tool.manifest.id === pending.id));
    // Quota counts pending globals: fill t_a to the limit with them.
    for (let i = 0; i < MAX_TOOLS_PER_CONVERSATION - 1; i++) {
      registry.create(commandInput(`pg${i}`), globalOwner("t_a"));
    }
    assert.throws(() => registry.create(commandInput("onetoomany"), convOwner("t_a")), /32 tools/);
    assert.throws(() => registry.create(commandInput("pgextra"), globalOwner("t_a")), /32 tools/);
    // Other conversations are unaffected (and may reuse the pending names).
    registry.create(commandInput("fresh"), convOwner("t_b"));
    // clearOwnership (the Phase 4 approval step) releases the quota slot.
    assert.equal(registry.clearOwnership(pending.id), true);
    assert.equal(registry.getIndex(pending.id)?.owner_root_id, null);
    assert.equal(registry.getIndex(pending.id)?.owner_task_id, null);
    assert.equal(registry.clearOwnership("tl_missing"), false);
    registry.create(commandInput("freed"), convOwner("t_a"));
    // Disabled globals no longer block names either: uniqueness is among
    // ACTIVE globals only.
    const retired = registry.create(commandInput("retired"), humanOwner);
    registry.setStatus(retired.id, "disabled");
    registry.create(commandInput("retired"), convOwner("t_c"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP namespace collisions (- vs _) are rejected at authoring time", () => {
  const dir = tempDir();
  try {
    const registry = new ToolRegistry(dir, {});
    const mcpInput = (name: string): ToolInput => ({ name, kind: "mcp", description: "d", mcp: { url: "http://x/mcp" } });
    registry.create(mcpInput("my-server"), convOwner("t_a"));
    // pi's mcpNamespace maps - to _: my-server and my_server would clash at
    // pi.registerMcpServer. Rejected for the same owner, whatever the kind.
    assert.throws(() => registry.create(mcpInput("my_server"), convOwner("t_a")), /normalization/);
    assert.throws(() => registry.create(commandInput("my_server"), convOwner("t_a")), /normalization/);
    // Other conversations don't see the tool: either variant is free there.
    registry.create(mcpInput("my_server"), convOwner("t_b"));
    // Active globals block normalized variants everywhere.
    registry.create(mcpInput("global-srv"), humanOwner);
    assert.throws(() => registry.create(mcpInput("global_srv"), convOwner("t_c")), /normalization/);
    // Builtins too: tool-search normalizes onto builtin tool_search.
    assert.throws(() => registry.create(commandInput("tool-search"), convOwner("t_c")), /normalization/);
    // A pending global of ANOTHER conversation does not block the normalized
    // variant (it is invisible there); its OWN owner is still blocked.
    registry.create(mcpInput("awaiting-x"), { scope: "global", rootId: "t_d", taskId: "t_d-task", origin: "task" });
    assert.throws(() => registry.create(mcpInput("awaiting_x"), convOwner("t_d")), /normalization/);
    registry.create(mcpInput("awaiting_x"), convOwner("t_e"));
    // Rename on update is checked as well.
    const renameable = registry.create(commandInput("rename-me"), convOwner("t_f"));
    registry.create(mcpInput("keep_name"), convOwner("t_f"));
    assert.throws(() => registry.update(renameable.id, commandInput("keep-name")), /normalization/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stageToolCache drops the copy when the tool was removed/disabled between resolve and staging", () => {
  const dir = tempDir();
  try {
    const cache = join(dir, "cache");
    const registry = new ToolRegistry(join(dir, "tools"), {});
    // Removed after resolveFor, before staging: the just-staged copy is
    // dropped best-effort and cachePath stays null.
    const removed = registry.create(commandInput("racy"), convOwner("t_a"));
    const resolved: ResolvedTool[] = [{ manifest: removed, cachePath: null }];
    registry.remove(removed.id);
    stageToolCache(registry, cache, "t_a", resolved);
    assert.equal(resolved[0].cachePath, null);
    assert.ok(!existsSync(join(cache, "t_a", removed.id, "1")));
    // Disabled between resolve and staging: same treatment.
    const disabled = registry.create(commandInput("racy2"), convOwner("t_a"));
    const resolved2: ResolvedTool[] = [{ manifest: disabled, cachePath: null }];
    registry.setStatus(disabled.id, "disabled");
    stageToolCache(registry, cache, "t_a", resolved2);
    assert.equal(resolved2[0].cachePath, null);
    assert.ok(!existsSync(join(cache, "t_a", disabled.id, "1")));
    // Active tools still stage normally.
    const fine = registry.create(commandInput("fine"), convOwner("t_a"));
    const resolved3: ResolvedTool[] = [{ manifest: fine, cachePath: null }];
    stageToolCache(registry, cache, "t_a", resolved3);
    assert.equal(resolved3[0].cachePath, join(cache, "t_a", fine.id, "1"));
    assert.ok(existsSync(join(resolved3[0].cachePath!, "run.sh")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
