/**
 * Registry extension tests (Phase 2).
 *
 * Two layers:
 *  1. Fake-pi unit tests: registration shapes (mcp config, command tool
 *     definition, skipped extension entries) and the command execute()
 *     behavior against REAL spawned subprocesses (scrubbed env, workspace
 *     cwd, literal argv, timeout kill, abort, truncation, exit-code errors,
 *     cache script resolution).
 *  2. Real Pi session tests (no API key: dummy model + empty credential
 *     store): the extension binds through DefaultResourceLoader +
 *     createAgentSession, command tools are live and executable, and mcp
 *     manifests connect through createMcpExtension with ${VAR} headers
 *     expanded from the worker env — against a local minimal MCP endpoint.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { MAX_EVENT_TEXT } from "../src/limits.ts";
import { createRegistryExtension, registerCommandTool } from "../src/registry-extension.ts";
import type { ResolvedTool, ToolManifest } from "../src/tools.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "isidore-regext-"));
}

function commandManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    id: "tl_0123456789ab",
    name: "echoer",
    version: 1,
    kind: "command",
    description: "echo text",
    scope: "conversation",
    status: "active",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    command: { argv: ["echo", "{{text}}"], files: {} },
    provenance: { task_id: "t_1", root_id: "t_1", origin: "task", created_at: "now", sha256: "x" },
    ...overrides,
  };
}

function mcpManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    id: "tl_abcdefabcdef",
    name: "remote",
    version: 1,
    kind: "mcp",
    description: "a remote server",
    scope: "conversation",
    status: "active",
    mcp: { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${ISIDORE_TASK_TOKEN}" }, exposure: "direct", timeout: 30 },
    provenance: { task_id: "t_1", root_id: "t_1", origin: "task", created_at: "now", sha256: "x" },
    ...overrides,
  };
}

const resolved = (manifest: ToolManifest, cachePath: string | null = null): ResolvedTool => ({ manifest, cachePath });

/** Minimal fake ExtensionAPI capturing registrations. */
function fakePi(): { pi: ExtensionAPI; tools: Map<string, ToolDefinition>; servers: Map<string, unknown> } {
  const tools = new Map<string, ToolDefinition>();
  const servers = new Map<string, unknown>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
    registerMcpServer: (name: string, config: unknown) => servers.set(name, config),
    unregisterMcpServer: (name: string) => servers.delete(name),
    on: () => () => {},
  } as unknown as ExtensionAPI;
  return { pi, tools, servers };
}

async function execute(
  def: ToolDefinition,
  params: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
  const result = await def.execute("call-1", params, signal, undefined, { cwd } as never);
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return { text, isError: result.isError === true };
}

// --- registration shapes (fake pi) ---

test("mcp manifests register with the SDK's flat config; exposure defaults to direct", () => {
  const { pi, servers, tools } = fakePi();
  const withDefaults = mcpManifest({ name: "bare", mcp: { url: "http://x/mcp" } });
  createRegistryExtension({ tools: [resolved(mcpManifest()), resolved(withDefaults, null)], cwd: "/ws" })(pi);
  assert.deepEqual(servers.get("remote"), {
    url: "http://127.0.0.1:9/mcp",
    headers: { Authorization: "Bearer ${ISIDORE_TASK_TOKEN}" },
    exposure: "direct",
    timeout: 30,
    description: "a remote server",
  });
  // ${VAR} templates stay verbatim — Pi expands them from the worker env.
  assert.deepEqual(servers.get("remote"), {
    url: "http://127.0.0.1:9/mcp",
    headers: { Authorization: "Bearer ${ISIDORE_TASK_TOKEN}" },
    exposure: "direct",
    timeout: 30,
    description: "a remote server",
  });
  const bare = servers.get("bare") as { exposure: string; headers?: unknown; timeout?: unknown };
  assert.equal(bare.exposure, "direct");
  assert.equal(bare.headers, undefined);
  assert.equal(bare.timeout, undefined);
  assert.equal(tools.size, 0);
});

test("command manifests register a tool whose parameters are the input_schema", () => {
  const { pi, tools, servers } = fakePi();
  const manifest = commandManifest();
  createRegistryExtension({ tools: [resolved(manifest, "/cache")], cwd: "/ws" })(pi);
  const def = tools.get("echoer");
  assert.ok(def);
  assert.equal(def.label, "echoer");
  assert.equal(def.description, "echo text");
  assert.equal(def.parameters, manifest.input_schema);
  assert.equal(servers.size, 0);
});

test("extension entries are skipped: informational builtins and human modules alike", () => {
  const { pi, tools, servers } = fakePi();
  const informational: ToolManifest = {
    ...commandManifest(),
    id: "builtin:codemode",
    name: "codemode",
    kind: "extension",
    command: undefined,
    input_schema: undefined,
  };
  const human: ToolManifest = {
    ...commandManifest(),
    id: "tl_eeeeeeeeeeee",
    name: "human-ext",
    kind: "extension",
    command: undefined,
    input_schema: undefined,
    extension: { entry: "ext.ts" },
  };
  const disabled = commandManifest({ id: "tl_dddddddddddd", name: "disabled-tool", status: "disabled" });
  createRegistryExtension({
    tools: [resolved(informational), resolved(human, "/cache"), resolved(disabled)],
    cwd: "/ws",
  })(pi);
  assert.equal(tools.size, 0);
  assert.equal(servers.size, 0);
});

test("registerCommandTool is reusable standalone (Phase 3 same-turn hook)", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    registerCommandTool(pi, commandManifest(), null, dir);
    const def = tools.get("echoer");
    assert.ok(def);
    const { text, isError } = await execute(def, { text: "standalone" }, dir);
    assert.equal(isError, false);
    assert.equal(text, "standalone\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- command execute() behavior (real subprocesses, fake pi) ---

test("argv substitution is whole-token and literal: no shell interpretation", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    createRegistryExtension({ tools: [resolved(commandManifest())], cwd: dir })(pi);
    const def = tools.get("echoer")!;
    const marker = join(dir, "pwned");
    const injected = `"; touch ${marker}; echo $(echo hacked); \`id\``;
    const { text, isError } = await execute(def, { text: injected }, dir);
    assert.equal(isError, false);
    assert.equal(text, `${injected}\n`);
    assert.ok(!text.includes("hacked\n"));
    // Missing params render as the empty string, never "undefined".
    const missing = await execute(def, {}, dir);
    assert.equal(missing.text, "\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command tools run in the workspace cwd with a scrubbed env", async () => {
  const dir = tempDir();
  const saved = { ...process.env };
  try {
    process.env.OPENROUTER_API_KEY = "sk-or-regext-test";
    process.env.ISIDORE_TASK_TOKEN = "task-token-secret";
    process.env.ISIDORE_SCHEDULER_TOKEN = "svc-secret";
    process.env.PI_SANDBOX_BROWSER_URL = "http://browser";
    const { pi, tools } = fakePi();
    const manifest = commandManifest({ command: { argv: ["sh", "-c", "pwd; env"], files: {} } });
    createRegistryExtension({ tools: [resolved(manifest)], cwd: dir })(pi);
    const { text, isError } = await execute(tools.get("echoer")!, {}, dir);
    assert.equal(isError, false);
    const [cwdLine, ...envLines] = text.split("\n");
    assert.equal(cwdLine, dir);
    const env = envLines.join("\n");
    assert.ok(!env.includes("OPENROUTER_API_KEY"));
    assert.ok(!env.includes("sk-or-regext-test"));
    assert.ok(!env.includes("ISIDORE_"));
    assert.ok(!env.includes("task-token-secret"));
    assert.ok(!env.includes("SCHEDULER_"));
    assert.ok(!env.includes("PI_SANDBOX_"));
    // Non-secret env still passes through (PATH etc.).
    assert.match(env, /^PATH=/m);
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout kills the child and reports an error", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    const manifest = commandManifest({ command: { argv: ["sleep", "30"], files: {}, timeout_seconds: 1 } });
    createRegistryExtension({ tools: [resolved(manifest)], cwd: dir })(pi);
    const start = Date.now();
    const { text, isError } = await execute(tools.get("echoer")!, {}, dir);
    const elapsed = Date.now() - start;
    assert.equal(isError, true);
    assert.match(text, /timed out after 1s/);
    assert.ok(elapsed < 10_000, `timeout took ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout kills the whole process group: a backgrounded grandchild cannot delay resolution", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    // sh backgrounds a grandchild that inherits the stdio pipes, then waits.
    // Killing only the direct child would leave the grandchild holding the
    // pipes open, delaying 'close' past the deadline (or hanging forever).
    const marker = join(dir, "grandchild-survived");
    const manifest = commandManifest({
      command: { argv: ["sh", "-c", `(sleep 2; touch ${marker}) & wait`], files: {}, timeout_seconds: 1 },
    });
    createRegistryExtension({ tools: [resolved(manifest)], cwd: dir })(pi);
    const start = Date.now();
    const { text, isError } = await execute(tools.get("echoer")!, {}, dir);
    const elapsed = Date.now() - start;
    assert.equal(isError, true);
    assert.match(text, /timed out after 1s/);
    assert.ok(elapsed < 2500, `group-kill timeout took ${elapsed}ms`);
    // The grandchild died with the group: it never wakes up to touch the marker.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(!existsSync(marker), "grandchild survived the process-group kill");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a daemonized grandchild holding the pipes cannot hang a normal completion", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    // sh exits 0 immediately but the backgrounded sleep keeps the stdio pipes
    // open: resolution must come from exit + stdio grace, not 'close'.
    const manifest = commandManifest({
      command: { argv: ["sh", "-c", "sleep 2 & echo ok"], files: {} },
    });
    createRegistryExtension({ tools: [resolved(manifest)], cwd: dir })(pi);
    const start = Date.now();
    const { text, isError } = await execute(tools.get("echoer")!, {}, dir);
    const elapsed = Date.now() - start;
    assert.equal(isError, false);
    assert.equal(text, "ok\n");
    assert.ok(elapsed < 2500, `lingering grandchild delayed resolution by ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the abort signal kills the child", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    const manifest = commandManifest({ command: { argv: ["sleep", "30"], files: {} } });
    createRegistryExtension({ tools: [resolved(manifest)], cwd: dir })(pi);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    const { text, isError } = await execute(tools.get("echoer")!, {}, dir, controller.signal);
    const elapsed = Date.now() - start;
    assert.equal(isError, true);
    assert.match(text, /aborted/);
    assert.ok(elapsed < 10_000, `abort took ${elapsed}ms`);
    // An already-aborted signal kills immediately.
    const pre = new AbortController();
    pre.abort();
    const again = await execute(tools.get("echoer")!, {}, dir, pre.signal);
    assert.equal(again.isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdout and stderr are capped at MAX_EVENT_TEXT chars", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    const outManifest = commandManifest({
      name: "bigout",
      command: { argv: ["sh", "-c", "head -c 6000 /dev/zero | tr '\\0' 'X'"], files: {} },
    });
    const errManifest = commandManifest({
      name: "bigerr",
      command: { argv: ["sh", "-c", "head -c 6000 /dev/zero | tr '\\0' 'E' >&2; exit 3"], files: {} },
    });
    createRegistryExtension({ tools: [resolved(outManifest), resolved(errManifest)], cwd: dir })(pi);
    const out = await execute(tools.get("bigout")!, {}, dir);
    assert.equal(out.isError, false);
    assert.equal(out.text.length, MAX_EVENT_TEXT);
    assert.equal(out.text, "X".repeat(MAX_EVENT_TEXT));
    const err = await execute(tools.get("bigerr")!, {}, dir);
    assert.equal(err.isError, true);
    assert.match(err.text, /exit code 3/);
    assert.ok(err.text.length <= MAX_EVENT_TEXT + 100);
    assert.ok(err.text.includes("E".repeat(100)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stderr keeps the rolling tail, not the head", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    const manifest = commandManifest({
      name: "noisy",
      command: {
        argv: ["sh", "-c", "{ printf HEAD; head -c 5000 /dev/zero | tr '\\0' 'X'; printf TAIL; } >&2; exit 3"],
        files: {},
      },
    });
    createRegistryExtension({ tools: [resolved(manifest)], cwd: dir })(pi);
    const err = await execute(tools.get("noisy")!, {}, dir);
    assert.equal(err.isError, true);
    assert.match(err.text, /exit code 3/);
    // 5008 stderr chars: the last MAX_EVENT_TEXT survive, the head is dropped.
    assert.ok(err.text.includes("TAIL"), "stderr tail missing");
    assert.ok(!err.text.includes("HEAD"), "stderr head should have been dropped");
    assert.ok(err.text.length <= MAX_EVENT_TEXT + 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-byte UTF-8 split across chunks decodes correctly", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    // € = e2 82 ac and é = c3 a9, each written as two chunks 50ms apart so the
    // split lands on a chunk boundary (StringDecoder buffers the partial char).
    const outManifest = commandManifest({
      name: "splitout",
      command: {
        argv: ["node", "-e", "process.stdout.write(Buffer.from([0xe2,0x82]));setTimeout(()=>process.stdout.write(Buffer.from([0xac])),50)"],
        files: {},
      },
    });
    const errManifest = commandManifest({
      name: "spliterr",
      command: {
        argv: ["node", "-e", "process.stderr.write(Buffer.from([0xc3]));setTimeout(()=>{process.stderr.write(Buffer.from([0xa9]));process.exit(3)},50)"],
        files: {},
      },
    });
    createRegistryExtension({ tools: [resolved(outManifest), resolved(errManifest)], cwd: dir })(pi);
    const out = await execute(tools.get("splitout")!, {}, dir);
    assert.equal(out.isError, false);
    assert.equal(out.text, "€");
    const err = await execute(tools.get("spliterr")!, {}, dir);
    assert.equal(err.isError, true);
    assert.match(err.text, /exit code 3/);
    assert.ok(err.text.includes("é"), "split stderr char mangled");
    assert.ok(!err.text.includes("\uFFFD"), "replacement char in output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nonzero exit is an error with the exit code and stderr tail; empty stdout is '(no output)'", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    const failManifest = commandManifest({
      name: "failer",
      command: { argv: ["sh", "-c", "echo oops >&2; exit 7"], files: {} },
    });
    const quietManifest = commandManifest({ name: "quiet", command: { argv: ["true"], files: {} } });
    createRegistryExtension({ tools: [resolved(failManifest), resolved(quietManifest)], cwd: dir })(pi);
    const fail = await execute(tools.get("failer")!, {}, dir);
    assert.equal(fail.isError, true);
    assert.match(fail.text, /exit code 7/);
    assert.match(fail.text, /oops/);
    const quiet = await execute(tools.get("quiet")!, {}, dir);
    assert.equal(quiet.isError, false);
    assert.equal(quiet.text, "(no output)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing program is a clean error, not a throw", async () => {
  const dir = tempDir();
  try {
    const { pi, tools } = fakePi();
    const manifest = commandManifest({ command: { argv: ["no-such-program-xyz"], files: {} } });
    createRegistryExtension({ tools: [resolved(manifest)], cwd: dir })(pi);
    const { text, isError } = await execute(tools.get("echoer")!, {}, dir);
    assert.equal(isError, true);
    assert.match(text, /failed to start/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("argv[0] naming a cached file resolves under cachePath; other programs come from PATH", async () => {
  const dir = tempDir();
  const cache = join(dir, "cache");
  mkdirSync(cache, { recursive: true });
  const script = join(cache, "run.sh");
  writeFileSync(script, "#!/bin/sh\necho from-cache\n");
  chmodSync(script, 0o755);
  try {
    const { pi, tools } = fakePi();
    const scriptManifest = commandManifest({ name: "scripted", command: { argv: ["run.sh"], files: {} } });
    const pathManifest = commandManifest(); // echo is NOT a cached file
    createRegistryExtension({ tools: [resolved(scriptManifest, cache), resolved(pathManifest, cache)], cwd: dir })(pi);
    const fromCache = await execute(tools.get("scripted")!, {}, dir);
    assert.equal(fromCache.isError, false);
    assert.equal(fromCache.text, "from-cache\n");
    const fromPath = await execute(tools.get("echoer")!, { text: "path" }, dir);
    assert.equal(fromPath.text, "path\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- real Pi session (no API key: dummy model + empty credential store) ---

interface RealSession {
  session: AgentSession;
  dispose: () => void;
}

async function realSession(cwd: string, factories: ExtensionFactory[]): Promise<RealSession> {
  const root = mkdtempSync(join(tmpdir(), "isidore-regext-session-"));
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
  // A dummy model: no request is ever made (tools are executed directly), so
  // no API key or reachable provider is needed.
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

test("real session: a command tool is live and runs scrubbed in the workspace", async () => {
  const dir = tempDir();
  const saved = { ...process.env };
  let real: RealSession | undefined;
  try {
    process.env.OPENROUTER_API_KEY = "sk-or-real-session";
    process.env.ISIDORE_TASK_TOKEN = "real-session-token";
    const manifest = commandManifest({ command: { argv: ["sh", "-c", "pwd; env"], files: {} } });
    real = await realSession(dir, [createRegistryExtension({ tools: [resolved(manifest)], cwd: dir })]);
    assert.ok(real.session.getActiveToolNames().includes("echoer"));
    const def = real.session.getToolDefinition("echoer");
    assert.ok(def, "command tool not registered in the real session");
    const { text, isError } = await execute(def, {}, dir);
    assert.equal(isError, false);
    const [cwdLine, ...envLines] = text.split("\n");
    assert.equal(cwdLine, dir);
    const env = envLines.join("\n");
    assert.ok(!env.includes("OPENROUTER_API_KEY"));
    assert.ok(!env.includes("sk-or-real-session"));
    assert.ok(!env.includes("ISIDORE_"));
  } finally {
    process.env = saved;
    real?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real session: mcp manifests connect with expanded ${VAR} headers; project mcp.json cannot shadow", async () => {
  const dir = tempDir();
  const saved = { ...process.env };
  let real: RealSession | undefined;
  const seenHeaders: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seenHeaders.push({ ...req.headers });
      const msg = body ? JSON.parse(body) : {};
      const reply = (result: unknown): void => {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "test-session" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      if (msg.method === "initialize") {
        reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } });
      } else if (msg.method === "tools/list") {
        reply({ tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] });
      } else if (msg.method === "tools/call") {
        reply({ content: [{ type: "text", text: "pong" }] });
      } else {
        res.writeHead(202);
        res.end();
      }
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    process.env.ISIDORE_TASK_TOKEN = "expanded-token";
    process.env.ISIDORE_TASK_ORIGIN = "telegram";
    // A task-written project mcp.json trying to shadow the registered server.
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { scheduler: { url: "http://127.0.0.1:1/shadow", exposure: "direct" } } }),
    );
    const manifest = mcpManifest({
      id: "builtin:scheduler",
      name: "scheduler",
      scope: "global",
      mcp: {
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { "X-Isidore-Task-Token": "${ISIDORE_TASK_TOKEN}", "X-Isidore-Origin": "${ISIDORE_TASK_ORIGIN}" },
        exposure: "direct",
        timeout: 30,
      },
    });
    real = await realSession(dir, [
      // Same wiring as the worker: loadConfig override closes mcp.json entirely.
      createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) }),
      createRegistryExtension({ tools: [resolved(manifest)], cwd: dir }),
    ]);
    // Connections run in the background; wait for the direct tool to appear.
    let toolName: string | undefined;
    for (let i = 0; i < 200 && !toolName; i++) {
      toolName = real.session.getAllTools().find((tool) => tool.name.startsWith("mcp__scheduler__"))?.name;
      if (!toolName) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(toolName, "mcp__scheduler__ping");
    assert.ok(real.session.getActiveToolNames().includes(toolName));
    // Pi expanded the ${VAR} header templates from the worker env.
    const tokens = seenHeaders.map((headers) => headers["x-isidore-task-token"]).filter(Boolean);
    const origins = seenHeaders.map((headers) => headers["x-isidore-origin"]).filter(Boolean);
    assert.ok(tokens.includes("expanded-token"), `token header not expanded: ${JSON.stringify(seenHeaders)}`);
    assert.ok(origins.includes("telegram"), "origin header not expanded");
    // The shadow entry never connected: every request hit the test server.
    assert.ok(seenHeaders.length > 0);
    // The tool is callable end-to-end through Pi's MCP pipeline.
    const def = real.session.getToolDefinition(toolName);
    assert.ok(def);
    const result = await def.execute("call-mcp", {}, undefined, undefined, { cwd: dir } as never);
    assert.ok(!result.isError);
    assert.deepEqual(result.content, [{ type: "text", text: "pong" }]);
  } finally {
    process.env = saved;
    real?.dispose();
    server.close();
    server.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
  }
});