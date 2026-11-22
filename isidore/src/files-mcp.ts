/**
 * Files MCP: lets a running task hand files from its workspace to the user.
 *
 * A minimal STATELESS streamable-HTTP JSON-RPC endpoint at POST /mcp/files,
 * hosted on the isidore Fastify app (same shape as the tools authoring MCP:
 * no Mcp-Session-Id, JSON responses, notifications -> 202, GET/DELETE -> 405).
 *
 * The single tool, `send_file`, copies a workspace file into the service-only
 * artifact store and records it on the calling task; the task view renders a
 * download link. Auth is the per-task capability token minted at spawn, so a
 * task can only publish files from its own conversation. Admin callers are
 * rejected: there is no task to attach the artifact to.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { formatBytes, publishArtifact } from "./artifacts.ts";
import { deny, resolveAuth, type Auth } from "./auth.ts";
import type { TaskStore } from "./store.ts";
import type { TokenRegistry } from "./tokens.ts";

export interface FilesMcpOptions {
  store: TaskStore;
  tokens: TokenRegistry;
  /** Effective admin token (createApp's generated fallback included). */
  adminToken: string;
  /** Root of the per-conversation workspaces (config.workspacesDir). */
  workspaceRoot: string;
  /** Root of the service-only artifact store (config.artifactsDir). */
  artifactsRoot: string;
}

type Caller = NonNullable<Auth>;

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "isidore-files", version: "0.1.0" };
const SEND_FILE_ARGS: ReadonlySet<string> = new Set(["path", "name", "description"]);

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
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
  }
  for (const key of required) {
    if (record[key] === undefined) throw new Error(`missing required argument: ${key}`);
  }
  return record;
}

const TOOL_DEFINITIONS = [
  {
    name: "send_file",
    description:
      "Share a file from this task's workspace with the user. Copies the file out of the sandbox and adds a download link to the task view. Use it for reports, data, images, archives, or any artifact the user should receive. Call it once per file.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File to share, relative to the task workspace (its cwd); an absolute path inside the workspace also works.",
        },
        name: {
          type: "string",
          description: "Optional download filename. Defaults to the source file's basename.",
        },
        description: {
          type: "string",
          description: "Optional one-line note shown next to the download link.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

function callTool(
  opts: FilesMcpOptions,
  name: unknown,
  rawArgs: unknown,
  caller: Caller,
): Record<string, unknown> {
  if (name !== "send_file") {
    return rpcError(null, -32602, `unknown tool: ${String(name)}`);
  }
  if (caller.kind !== "task") {
    throw new Error("send_file requires a task token: it attaches the file to the calling task");
  }
  const args = assertArgs(rawArgs, SEND_FILE_ARGS, ["path"]);
  const artifact = publishArtifact({
    store: opts.store,
    artifactsRoot: opts.artifactsRoot,
    workspaceRoot: opts.workspaceRoot,
    taskId: caller.scope.taskId,
    rootId: caller.scope.rootId,
    filePath: args.path as string,
    name: args.name as string | undefined,
    description: args.description as string | undefined,
  });
  const payload = { artifact };
  return {
    content: [
      {
        type: "text",
        text: `Shared "${artifact.name}" (${formatBytes(artifact.size)}) with the user. A download link is now shown in the task view (artifact ${artifact.id}).`,
      },
    ],
    structuredContent: payload,
  };
}

/** Handle one JSON-RPC message; null means "notification, acknowledge with 202". */
function handleMessage(opts: FilesMcpOptions, message: unknown, caller: Caller): Record<string, unknown> | null {
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
        if ("error" in result) return { ...result, id };
        return rpcResult(id, result);
      } catch (error) {
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
 * Register the stateless files MCP on the isidore app. Workers reach it through
 * the builtin:files manifest with their ISIDORE_TASK_TOKEN as the Bearer.
 */
export function registerFilesMcp(app: FastifyInstance, opts: FilesMcpOptions): void {
  const methodNotAllowed = (_request: unknown, reply: FastifyReply): void => {
    reply.code(405).header("Allow", "POST").send({ error: "method not allowed; use POST (stateless streamable HTTP)" });
  };
  app.get("/mcp/files", methodNotAllowed);
  app.delete("/mcp/files", methodNotAllowed);

  app.post("/mcp/files", async (request, reply) => {
    const auth = resolveAuth(request, opts.adminToken, opts.tokens);
    if (!auth) return deny(reply);
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
