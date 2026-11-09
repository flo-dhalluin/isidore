/**
 * isidore worker: run one Pi task in-process with the TypeScript SDK.
 *
 * The server spawns this script once per task, in the task's workspace, with
 * the task's isolated HOME/TMPDIR/PI_CODING_AGENT_SESSION_DIR. It reads a JSON
 * request from stdin, runs the task through the SDK, and always writes the same
 * JSONL event stream as `pi --mode json` to stdout. The server derives the
 * human-readable transcript (and the final answer for print mode) from it, so
 * tool calls are captured for every task.
 *
 * This replaces the `pi` CLI subprocess: the agent runs in this Node process,
 * not as a separate `pi` process. The server's event parser and the web UI are
 * unchanged.
 */

import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

interface WorkerRequest {
  prompt: string;
  model?: string | null;
  sessionId?: string | null;
  thinkingLevel?: string | null;
}

/** Mirror the CLI's JSON-mode transformation: strip cumulative snapshots. */
function toJsonEvent(event: AgentSessionEvent): unknown {
  if (event.type !== "message_update") return event;
  const message = event.message;
  if (message.role !== "assistant") {
    throw new Error("message_update message is not an assistant message");
  }
  const ame = event.assistantMessageEvent as {
    type: string;
    contentIndex?: number;
    partial?: { content?: Array<{ type?: string; id?: string; name?: string }> };
    [key: string]: unknown;
  };
  let jsonAme: unknown;
  if (ame.type === "toolcall_start") {
    const toolCall = ame.partial?.content?.[ame.contentIndex ?? 0];
    if (toolCall?.type !== "toolCall") {
      throw new Error(`toolcall_start content at index ${ame.contentIndex} is not a tool call`);
    }
    const { partial: _partial, ...deltaEvent } = ame;
    jsonAme = { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
  } else if (ame && "partial" in ame) {
    const { partial: _partial, ...deltaEvent } = ame;
    jsonAme = deltaEvent;
  } else {
    jsonAme = ame;
  }
  return { type: "message_update", usage: (message as { usage?: unknown }).usage, assistantMessageEvent: jsonAme };
}

async function readRequest(): Promise<WorkerRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("empty request on stdin");
  return JSON.parse(text) as WorkerRequest;
}

async function main(): Promise<number> {
  const request = await readRequest();
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });

  let model: ReturnType<typeof resolveCliModel>["model"];
  let thinkingLevel: ReturnType<typeof resolveCliModel>["thinkingLevel"];
  if (request.model) {
    const resolved = resolveCliModel({ cliModel: request.model, modelRuntime });
    if (resolved.error) throw new Error(resolved.error);
    model = resolved.model;
    thinkingLevel = resolved.thinkingLevel;
  }
  if (request.thinkingLevel) {
    thinkingLevel = request.thinkingLevel as typeof thinkingLevel;
  }

  // The CLI loads codemode, tool_search, and MCP as built-in extensions; the
  // SDK does not. Add them so MCP servers (browser + scheduler) still work.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()],
  });
  await resourceLoader.reload();

  const settingsManager = SettingsManager.create(cwd, agentDir);

  // A conversation keeps one session per workspace, keyed by the root task id.
  let sessionManager: SessionManager;
  if (request.sessionId) {
    const existing = SessionManager.findById(cwd, request.sessionId, sessionDir);
    sessionManager = existing
      ? SessionManager.open(existing, sessionDir)
      : SessionManager.create(cwd, sessionDir, { id: request.sessionId });
  } else {
    sessionManager = SessionManager.create(cwd, sessionDir);
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel,
    resourceLoader,
    settingsManager,
    sessionManager,
  });

  let unsubscribe: (() => void) | undefined;
  let exitCode = 0;

  try {
    const header = session.sessionManager.getHeader();
    if (header) process.stdout.write(`${JSON.stringify(header)}\n`);
    unsubscribe = session.subscribe((event) => {
      process.stdout.write(`${JSON.stringify(toJsonEvent(event))}\n`);
    });

    await session.bindExtensions({});
    await session.prompt(request.prompt);

    const messages = session.state.messages;
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      process.stderr.write(`${last.errorMessage || `Request ${last.stopReason}`}\n`);
      exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exitCode = 1;
  } finally {
    unsubscribe?.();
    try {
      session.dispose();
    } catch {
      // ignore disposal errors
    }
  }

  return exitCode;
}

// Diagnostics must not corrupt the JSONL stream on stdout.
console.log = (...args: unknown[]) => {
  console.error(...args);
};

process.on("uncaughtException", (error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
  process.exit(1);
});

const flush = (): Promise<void> => new Promise((resolve) => process.stdout.write("", () => resolve()));

main().then(
  async (code) => {
    await flush();
    process.exitCode = code;
    setTimeout(() => process.exit(code), 1000).unref();
  },
  async (error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    await flush();
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1000).unref();
  },
);
