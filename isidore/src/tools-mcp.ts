/**
 * Tools authoring MCP (Phase 3): a minimal STATELESS streamable-HTTP JSON-RPC
 * endpoint at POST /mcp/tools, hosted on the isidore Fastify app. No new npm
 * dependencies — just Fastify + node builtins.
 *
 * Spec choices (verified against the pinned @earendil-works/pi-mcp client):
 *  - initialize replies protocolVersion "2025-03-26" (in the client's
 *    SUPPORTED_PROTOCOL_VERSIONS), capabilities {tools:{}}, serverInfo.
 *  - Notifications (no "id") are acknowledged with 202 and an empty body;
 *    requests get application/json responses (the client accepts JSON or SSE).
 *  - No Mcp-Session-Id is issued; an incoming one is tolerated and ignored
 *    (every request is authenticated and self-contained). GET/DELETE -> 405,
 *    which the client treats as "no server-to-client stream" / no-op close.
 *  - Batch arrays are supported; an all-notification batch gets 202.
 *  - Tool execution errors are MCP results with isError:true (not JSON-RPC
 *    errors); protocol problems use JSON-RPC error codes.
 *
 * Auth: resolveAuth (admin Bearer or per-task Bearer). Every operation is
 * scoped to the caller's conversation; provenance comes from the token scope,
 * NEVER from arguments. Mutations return structuredContent so the worker's
 * same-turn tool_result hook can register/disable tools live.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { deny, resolveAuth, type Auth } from "./auth.ts";
import { removeToolCacheCopies, stageToolCache } from "./tool-cache.ts";
import type { TaskScope, TokenRegistry } from "./tokens.ts";
import type { ResolvedTool, ToolIndex, ToolInput, ToolKind, ToolManifest, ToolRegistry, ToolScope } from "./tools.ts";

export interface ToolsMcpOptions {
  registry: ToolRegistry;
  tokens: TokenRegistry;
  /** Effective admin token (createApp's generated fallback included). */
  adminToken: string;
  toolCacheRoot: string;
}

type Caller = NonNullable<Auth>;

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "isidore-tools", version: "0.1.0" };

/** Flat authoring args accepted by tool_create/tool_update (whitelist). */
const AUTHOR_ARGS: ReadonlySet<string> = new Set([
  "name",
  "kind",
  "description",
  "input_schema",
  "files",
  "url",
  "headers",
  "argv",
  "timeout_seconds",
  "scope",
  "exposure",
]);
const TOOL_SCOPES: ReadonlySet<string> = new Set(["task", "conversation", "global"]);

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function assertArgs(args: unknown, allowed: ReadonlySet<string>, required: string[] = []): Record<string, unknown> {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object");
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // Unknown keys are rejected outright: provenance/ownership fields can
    // never be smuggled in through arguments.
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
  }
  for (const key of required) {
    if (record[key] === undefined) throw new Error(`missing required argument: ${key}`);
  }
  return record;
}

/** Map flat authoring args onto a ToolInput; update falls back to the current manifest. */
function buildInput(args: Record<string, unknown>, current?: ToolManifest): ToolInput {
  const kind = (args.kind ?? current?.kind) as ToolKind;
  // Extension tools are inert through this MCP (sources are human-managed and
  // never staged), so they are rejected for ALL callers — including admin.
  // Humans author them through the admin API (Phase 4); the registry itself
  // keeps extension support.
  if (kind === "extension") {
    throw new Error("extension tools are human-authored via the admin API (Phase 4); the tools MCP only authors command and mcp tools");
  }
  const input: ToolInput = {
    name: (args.name ?? current?.name) as string,
    kind,
    description: (args.description ?? current?.description) as string,
  };
  const schema = args.input_schema ?? current?.input_schema;
  if (schema !== undefined) input.input_schema = schema as object;
  if (kind === "command") {
    const timeout = args.timeout_seconds ?? current?.command?.timeout_seconds;
    input.command = {
      argv: (args.argv ?? current?.command?.argv) as string[],
      files: (args.files ?? current?.command?.files ?? {}) as Record<string, string>,
      ...(timeout !== undefined ? { timeout_seconds: timeout as number } : {}),
    };
  } else if (kind === "mcp") {
    const headers = args.headers ?? current?.mcp?.headers;
    const exposure = args.exposure ?? current?.mcp?.exposure;
    const timeout = args.timeout_seconds ?? current?.mcp?.timeout;
    input.mcp = {
      url: (args.url ?? current?.mcp?.url) as string,
      ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
      ...(exposure !== undefined ? { exposure: exposure as "direct" | "codemode" | "deferred" } : {}),
      ...(timeout !== undefined ? { timeout: timeout as number } : {}),
    };
  }
  return input;
}

/**
 * Visibility: a task sees its OWN tools (owner_root_id/owner_task_id match,
 * ANY status — including its pending globals) plus globals ONLY when active.
 * Pending globals of other conversations are invisible (no manifest/source
 * leak, no existence leak). Admin sees everything.
 */
function canSee(index: ToolIndex, caller: Caller): boolean {
  if (caller.kind === "admin") return true;
  const scope: TaskScope = caller.scope;
  if (index.owner_root_id === scope.rootId || index.owner_task_id === scope.taskId) return true;
  return index.scope === "global" && index.status === "active";
}

/**
 * Mutations need ownership (admin bypasses). The creator may manage its own
 * tools in ANY status — including its pending globals (withdraw/update/
 * disable/remove). Active globals are unowned, hence admin-only.
 */
function canMutate(index: ToolIndex, caller: Caller): boolean {
  if (caller.kind === "admin") return true;
  const scope: TaskScope = caller.scope;
  return index.owner_root_id === scope.rootId || index.owner_task_id === scope.taskId;
}

function ownedIndex(registry: ToolRegistry, id: unknown, caller: Caller, mutate: boolean): ToolIndex {
  if (typeof id !== "string" || id === "") throw new Error("id is required");
  const index = registry.getIndex(id);
  // Same message for missing and invisible: no existence leak across conversations.
  if (!index || !canSee(index, caller)) throw new Error(`unknown tool: ${id}`);
  if (mutate && !canMutate(index, caller)) throw new Error(`tool ${id} is global; only a human admin may modify it`);
  return index;
}

/** Live status lives on the index; manifests are immutable per version. */
function withLiveStatus(manifest: ToolManifest, index: ToolIndex): ToolManifest {
  return { ...manifest, status: index.status };
}

/** Stage the caller's cache copy for a freshly authored command/extension version. */
function stageForCaller(
  registry: ToolRegistry,
  toolCacheRoot: string,
  manifest: ToolManifest,
  caller: Caller,
): string | null {
  if (caller.kind !== "task") return null; // admin globals are staged per-conversation at spawn
  // Only active tools are staged: disabled/pending_approval tools must not
  // get a fresh executable cache copy (pending globals are not runnable yet).
  if (manifest.status !== "active") return null;
  if (manifest.kind !== "command" && manifest.kind !== "extension") return null;
  const resolved: ResolvedTool[] = [{ manifest, cachePath: null }];
  stageToolCache(registry, toolCacheRoot, caller.scope.rootId, resolved);
  return resolved[0].cachePath;
}

// --- tools/call operations -------------------------------------------------

function toolCreate(registry: ToolRegistry, toolCacheRoot: string, args: Record<string, unknown>, caller: Caller): unknown {
  const scopeArg = (args.scope ?? (caller.kind === "admin" ? "global" : "conversation")) as string;
  if (!TOOL_SCOPES.has(scopeArg)) throw new Error("scope must be task, conversation or global");
  const scope = scopeArg as ToolScope;
  if (caller.kind === "admin" && scope !== "global") {
    throw new Error("conversation/task scope requires a task token (admin authors global tools)");
  }
  const input = buildInput(args);
  // Provenance and ownership come ONLY from the authenticated caller.
  const owner =
    caller.kind === "task"
      ? { scope, rootId: caller.scope.rootId, taskId: caller.scope.taskId, origin: caller.scope.origin }
      : { scope: "global" as ToolScope, rootId: null, taskId: null, origin: "human" };
  // A task token asking for global scope ALWAYS awaits human approval, even
  // if the task's origin string happens to be "human". forcePendingApproval
  // makes the registry write the FINAL status into the version manifest once
  // (no active-then-pending flip). Pending globals keep creator ownership;
  // Phase 4 approval clears it (registry.clearOwnership).
  const manifest = registry.create(input, owner, { forcePendingApproval: caller.kind === "task" && scope === "global" });
  const cachePath = stageForCaller(registry, toolCacheRoot, manifest, caller);
  return { manifest, cachePath };
}

function toolList(registry: ToolRegistry, caller: Caller): unknown {
  const tools: ToolManifest[] = [];
  for (const index of registry.list()) {
    if (!canSee(index, caller)) continue;
    const manifest = registry.get(index.id);
    if (manifest) tools.push(withLiveStatus(manifest, index));
  }
  return { tools };
}

function toolGet(registry: ToolRegistry, args: Record<string, unknown>, caller: Caller): unknown {
  const index = ownedIndex(registry, args.id, caller, false);
  let version: number | undefined;
  if (args.version !== undefined) {
    if (typeof args.version !== "number" || !Number.isInteger(args.version)) throw new Error("version must be an integer");
    version = args.version;
  }
  const manifest = registry.get(index.id, version);
  if (!manifest) throw new Error(`unknown tool version: ${index.id}@${args.version}`);
  return { manifest: withLiveStatus(manifest, index) };
}

function toolUpdate(registry: ToolRegistry, toolCacheRoot: string, args: Record<string, unknown>, caller: Caller): unknown {
  // Scope is create-only: silently ignoring it would mislead the caller.
  if (args.scope !== undefined) throw new Error("scope is create-only; tool_update cannot change a tool's scope");
  const index = ownedIndex(registry, args.id, caller, true);
  const current = registry.get(index.id);
  if (!current) throw new Error(`missing manifest for ${index.id}`);
  const input = buildInput(args, current);
  const manifest = registry.update(index.id, input);
  const cachePath = stageForCaller(registry, toolCacheRoot, manifest, caller);
  return { manifest, cachePath };
}

function toolDisable(registry: ToolRegistry, args: Record<string, unknown>, caller: Caller): unknown {
  const index = ownedIndex(registry, args.id, caller, true);
  const manifest = registry.get(index.id);
  registry.setStatus(index.id, "disabled");
  return { id: index.id, name: index.name, kind: manifest?.kind ?? "command", status: "disabled" };
}

function toolRemove(registry: ToolRegistry, toolCacheRoot: string, args: Record<string, unknown>, caller: Caller): unknown {
  const index = ownedIndex(registry, args.id, caller, true);
  const manifest = registry.get(index.id);
  const kind = manifest?.kind ?? "command";
  registry.remove(index.id);
  // Sweep cache copies in EVERY conversation: a removed tool must not stay
  // executable anywhere (children may hold pinned copies).
  removeToolCacheCopies(toolCacheRoot, index.id);
  return { id: index.id, name: index.name, kind, removed: true };
}

function toolRequestPromotion(registry: ToolRegistry, args: Record<string, unknown>, caller: Caller): unknown {
  const index = ownedIndex(registry, args.id, caller, true);
  const manifest = registry.get(index.id);
  if (typeof args.reason !== "string" || args.reason.trim() === "") throw new Error("reason must be a non-empty string");
  registry.requestPromotion(index.id, args.reason);
  return { id: index.id, name: index.name, kind: manifest?.kind ?? "command", status: "pending_approval", reason: args.reason };
}

// --- tools/list definitions --------------------------------------------------

const STRING_MAP = { type: "object", additionalProperties: { type: "string" } } as const;

function authorProperties(withScope: boolean): Record<string, unknown> {
  return {
    name: { type: "string", description: "Tool name: ^[a-z][a-z0-9_-]{0,63}$, unique in your conversation; - and _ are equivalent (MCP namespace)" },
    kind: { type: "string", enum: ["mcp", "command"], description: "extension tools are human-authored via the admin API, not here" },
    description: { type: "string", description: "What the tool does (shown to the model)" },
    input_schema: { type: "object", description: 'command tools: JSON Schema with type:"object"; no $ref' },
    files: { ...STRING_MAP, description: "command sources: relative path -> text (copied to the read-only tool cache)" },
    argv: { type: "array", items: { type: "string" }, description: 'command argv; "{{param}}" whole-token templates; argv[0] a bare program or cached file' },
    url: { type: "string", description: "mcp tools: http(s) endpoint URL" },
    headers: { ...STRING_MAP, description: "mcp headers; ${VAR} templates expand from the worker env" },
    exposure: { type: "string", enum: ["direct", "codemode", "deferred"], description: "mcp exposure (default direct)" },
    timeout_seconds: { type: "integer", description: `command/mcp timeout in seconds (max 120)` },
    ...(withScope
      ? { scope: { type: "string", enum: ["task", "conversation", "global"], description: "default conversation; global from an agent awaits human approval" } }
      : {}),
  };
}

const TOOL_DEFINITIONS = [
  {
    name: "tool_create",
    description:
      "Create a command or mcp tool owned by your conversation. It is live in the SAME turn. Global scope awaits human approval.",
    inputSchema: { type: "object", properties: authorProperties(true), required: ["name", "kind", "description"] },
  },
  {
    name: "tool_list",
    description: "List your conversation's tools (all statuses) plus ACTIVE global tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tool_get",
    description: "Read one of your conversation's tools (or an active global tool), optionally at a specific immutable version.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, version: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "tool_update",
    description: "Update one of your conversation's tools: writes a NEW immutable version and re-copies the cache. Live in the same turn.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, ...authorProperties(false) },
      required: ["id"],
    },
  },
  {
    name: "tool_disable",
    description:
      "Disable one of your tools: the calling session gets an error stub and new spawns no longer include it. Other live sessions keep the tool until their next spawn.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "tool_remove",
    description: "Remove one of your conversation's tools: registry records and every cache copy.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "tool_request_promotion",
    description: "Ask a human to promote one of your tools to global scope: sets pending_approval and records your reason.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, reason: { type: "string" } },
      required: ["id", "reason"],
    },
  },
];

// --- JSON-RPC dispatch -------------------------------------------------------

function callTool(
  opts: ToolsMcpOptions,
  name: unknown,
  rawArgs: unknown,
  caller: Caller,
): Record<string, unknown> {
  const { registry, toolCacheRoot } = opts;
  let payload: unknown;
  switch (name) {
    case "tool_create":
      payload = toolCreate(registry, toolCacheRoot, assertArgs(rawArgs, AUTHOR_ARGS, ["name", "kind", "description"]), caller);
      break;
    case "tool_list":
      payload = toolList(registry, caller);
      break;
    case "tool_get":
      payload = toolGet(registry, assertArgs(rawArgs, new Set(["id", "version"]), ["id"]), caller);
      break;
    case "tool_update":
      payload = toolUpdate(registry, toolCacheRoot, assertArgs(rawArgs, new Set(["id", ...AUTHOR_ARGS]), ["id"]), caller);
      break;
    case "tool_disable":
      payload = toolDisable(registry, assertArgs(rawArgs, new Set(["id"]), ["id"]), caller);
      break;
    case "tool_remove":
      payload = toolRemove(registry, toolCacheRoot, assertArgs(rawArgs, new Set(["id"]), ["id"]), caller);
      break;
    case "tool_request_promotion":
      payload = toolRequestPromotion(registry, assertArgs(rawArgs, new Set(["id", "reason"]), ["id", "reason"]), caller);
      break;
    default:
      // Unknown tool name is a protocol error per the MCP spec.
      return rpcError(null, -32602, `unknown tool: ${String(name)}`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** Handle one JSON-RPC message; null means "notification, acknowledge with 202". */
function handleMessage(opts: ToolsMcpOptions, message: unknown, caller: Caller): Record<string, unknown> | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "invalid request");
  }
  const msg = message as JsonRpcMessage;
  const isRequest = "id" in msg;
  const id = (msg.id ?? null) as string | number | null;
  if (typeof msg.method !== "string") {
    return isRequest ? rpcError(id, -32600, "invalid request") : null;
  }
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, ...
  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOL_DEFINITIONS });
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params !== "object" || params === null) return rpcError(id, -32602, "invalid params");
      try {
        const result = callTool(opts, params.name, params.arguments, caller);
        // callTool returns a JSON-RPC error object for unknown names.
        if ("error" in result) return { ...result, id };
        return rpcResult(id, result);
      } catch (error) {
        // Execution errors are MCP results with isError, not protocol errors.
        return rpcResult(id, {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

/**
 * Register the stateless tools MCP on the isidore app. Called by createApp
 * after the registry/token plumbing exists; workers reach it through the
 * builtin:tools manifest with their ISIDORE_TASK_TOKEN as the Bearer.
 */
export function registerToolsMcp(app: FastifyInstance, opts: ToolsMcpOptions): void {
  const methodNotAllowed = (_request: unknown, reply: FastifyReply): void => {
    reply.code(405).header("Allow", "POST").send({ error: "method not allowed; use POST (stateless streamable HTTP)" });
  };
  app.get("/mcp/tools", methodNotAllowed);
  app.delete("/mcp/tools", methodNotAllowed);

  app.post("/mcp/tools", async (request, reply) => {
    const auth = resolveAuth(request, opts.adminToken, opts.tokens);
    if (!auth) return deny(reply);
    // Mcp-Session-Id (if any) is deliberately ignored: the endpoint is stateless.
    const body = request.body;
    reply.type("application/json");
    if (Array.isArray(body)) {
      if (body.length === 0) return rpcError(null, -32600, "invalid request: empty batch");
      const responses: Record<string, unknown>[] = [];
      for (const message of body) {
        const response = handleMessage(opts, message, auth);
        if (response) responses.push(response);
      }
      if (responses.length === 0) return reply.code(202).send();
      return responses;
    }
    const response = handleMessage(opts, body, auth);
    if (!response) return reply.code(202).send();
    return response;
  });
}
