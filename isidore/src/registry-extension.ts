/**
 * Registry extension: composes a task's resolved tool set inside the worker.
 *
 * The runner resolves tools at spawn (registry.resolveFor) and passes them in
 * WorkerRequest.tools. This inline extension registers, per worker:
 *  - `mcp` manifests  -> pi.registerMcpServer(name, config). The built-in MCP
 *    extension (createMcpExtension) connects them; ${VAR} header templates are
 *    expanded by Pi from the worker env (ISIDORE_TASK_TOKEN / ISIDORE_TASK_ORIGIN).
 *    There is no shared mcp.json any more.
 *  - `command` manifests -> pi.registerTool with a spawn-based execute: literal
 *    argv ({{param}} whole-token substitution, NO shell), workspace cwd,
 *    scrubbed env, bounded timeout, capped output. Runs inside the worker's
 *    Landlock domain like any bash child.
 *  - `extension` manifests are human-only Pi modules; the worker loads them
 *    through DefaultResourceLoader.additionalExtensionPaths, not here. The
 *    informational builtin entries (no extension.entry) are skipped.
 *
 * registerCommandTool is exported for reuse by the Phase 3 same-turn hook.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult, ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { scrubEnv } from "./env-scrub.ts";
import { DEFAULT_COMMAND_TIMEOUT_S, MAX_COMMAND_TIMEOUT_S, MAX_EVENT_TEXT } from "./limits.ts";
import type { ResolvedTool, ToolManifest } from "./tools.ts";

export interface RegistryExtensionOptions {
  tools: ResolvedTool[];
  /** Workspace cwd for command tools (the conversation workspace). */
  cwd: string;
}

/** MCP config for a manifest, in the SDK's flat McpHttpServerConfig shape. */
function mcpConfig(manifest: ToolManifest): Parameters<ExtensionAPI["registerMcpServer"]>[1] {
  const mcp = manifest.mcp!;
  return {
    url: mcp.url,
    ...(mcp.headers ? { headers: mcp.headers } : {}),
    exposure: mcp.exposure ?? "direct",
    ...(mcp.timeout !== undefined ? { timeout: mcp.timeout } : {}),
    description: manifest.description,
  };
}

/** Whole-token {{param}} substitution; the result is passed to spawn literally (no shell). */
function renderArgv(argv: string[], params: Record<string, unknown>): string[] {
  return argv.map((token) => token.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(params[key] ?? "")));
}

interface CommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the child was killed by the timeout or the abort signal. */
  killedBy: "timeout" | "abort" | null;
  spawnError: string | null;
}

/**
 * Grace period after the child exits (or is killed) before the stdio streams
 * are destroyed and the call resolves. Normal completion hits 'close' (stdio
 * EOF) well inside it and keeps the full output; a grandchild holding the
 * pipes open can never delay resolution past exit + grace.
 */
const STDIO_GRACE_MS = 250;

function runCommand(
  manifest: ToolManifest,
  cachePath: string | null,
  cwd: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<CommandOutcome> {
  const command = manifest.command!;
  const argv = renderArgv(command.argv, params);
  // argv[0] naming a copied source file resolves under the tool-cache; anything
  // else is a bare program looked up on PATH. The Landlock cache rule is --rx,
  // so a cached shebang script can be exec'd directly as argv[0].
  let program = argv[0];
  if (cachePath) {
    const candidate = join(cachePath, argv[0]);
    if (existsSync(candidate)) program = candidate;
  }
  const timeoutS = Math.min(command.timeout_seconds ?? DEFAULT_COMMAND_TIMEOUT_S, MAX_COMMAND_TIMEOUT_S);

  return new Promise<CommandOutcome>((resolve) => {
    const outcome: CommandOutcome = { stdout: "", stderr: "", exitCode: null, signal: null, killedBy: null, spawnError: null };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, argv.slice(1), {
        cwd,
        // Same secret scrub as bash children: no OPENROUTER_API_KEY, no
        // ISIDORE_*/SCHEDULER_*/PI_SANDBOX_* (incl. the task token).
        env: scrubEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group (mirrors the runner's worker spawn): timeout/abort
        // kills the WHOLE tree, so a backgrounded grandchild cannot outlive
        // the deadline holding the stdio pipes open.
        detached: true,
      });
    } catch (error) {
      outcome.spawnError = error instanceof Error ? error.message : String(error);
      resolve(outcome);
      return;
    }

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    // StringDecoder per stream: a multi-byte UTF-8 char split across chunk
    // boundaries is buffered, not replaced with U+FFFD.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
      // Flush any bytes the decoders held back, then resolve.
      outcome.stdout = (outcome.stdout + stdoutDecoder.end()).slice(-MAX_EVENT_TEXT);
      outcome.stderr = (outcome.stderr + stderrDecoder.end()).slice(-MAX_EVENT_TEXT);
      resolve(outcome);
    };
    const destroyStdio = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const armGrace = (): void => {
      if (grace || settled) return;
      grace = setTimeout(() => {
        destroyStdio();
        finish();
      }, STDIO_GRACE_MS);
    };
    // Kill the whole process group (the child is detached, so pgid === pid);
    // ESRCH or an ungrouped child falls back to the direct kill (runner.ts).
    const killTree = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // group already gone: fall through to the direct child
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const onAbort = (): void => {
      if (settled) return;
      outcome.killedBy = "abort";
      killTree();
      armGrace();
    };
    timer = setTimeout(() => {
      if (settled) return;
      outcome.killedBy = "timeout";
      killTree();
      armGrace();
    }, timeoutS * 1000);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    // Rolling TAIL buffers: each stream keeps its LAST MAX_EVENT_TEXT chars,
    // so a noisy failing tool reports the useful end of its output.
    child.stdout?.on("data", (chunk: Buffer) => {
      outcome.stdout = (outcome.stdout + stdoutDecoder.write(chunk)).slice(-MAX_EVENT_TEXT);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      outcome.stderr = (outcome.stderr + stderrDecoder.write(chunk)).slice(-MAX_EVENT_TEXT);
    });
    child.on("error", (error) => {
      outcome.spawnError = error.message;
      destroyStdio();
      finish();
    });
    // Resolve bounded by 'exit' + grace, NOT 'close': a lingering grandchild
    // holding the pipes open must not hang the call. Normal completion hits
    // 'close' (stdio EOF) first and keeps the full drained output.
    child.on("exit", (code, sig) => {
      outcome.exitCode = code;
      outcome.signal = sig;
      armGrace();
    });
    child.on("close", () => finish());
  });
}

/**
 * Register one command tool on a live ExtensionAPI. Exported so the Phase 3
 * same-turn tool_result hook can register freshly authored tools identically.
 */
export function registerCommandTool(pi: ExtensionAPI, manifest: ToolManifest, cachePath: string | null, cwd: string = process.cwd()): void {
  if (manifest.kind !== "command" || !manifest.command) return;
  pi.registerTool({
    name: manifest.name,
    label: manifest.name,
    description: manifest.description,
    // Plain JSON Schema is a valid TypeBox TSchema at runtime (cast verified
    // against the pinned SDK; $ref is rejected at authoring time).
    parameters: (manifest.input_schema ?? { type: "object", properties: {} }) as ToolDefinition["parameters"],
    execute: async (_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult> => {
      const runCwd = ctx?.cwd ?? cwd;
      const outcome = await runCommand(manifest, cachePath, runCwd, (params ?? {}) as Record<string, unknown>, signal);
      // Already the rolling tail (last MAX_EVENT_TEXT chars) from runCommand.
      const stderrTail = outcome.stderr;
      if (outcome.spawnError) {
        return {
          content: [{ type: "text", text: `failed to start ${manifest.name}: ${outcome.spawnError}` }],
          details: undefined,
          isError: true,
        };
      }
      if (outcome.killedBy === "timeout") {
        const timeoutS = Math.min(manifest.command!.timeout_seconds ?? DEFAULT_COMMAND_TIMEOUT_S, MAX_COMMAND_TIMEOUT_S);
        return {
          content: [{ type: "text", text: `${manifest.name} timed out after ${timeoutS}s (killed)${stderrTail ? `\n${stderrTail}` : ""}` }],
          details: undefined,
          isError: true,
        };
      }
      if (outcome.killedBy === "abort") {
        return {
          content: [{ type: "text", text: `${manifest.name} aborted${stderrTail ? `\n${stderrTail}` : ""}` }],
          details: undefined,
          isError: true,
        };
      }
      if (outcome.exitCode !== 0) {
        const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`;
        return {
          content: [{ type: "text", text: `${manifest.name} failed (${how})${stderrTail ? `\n${stderrTail}` : ""}` }],
          details: undefined,
          isError: true,
        };
      }
      return { content: [{ type: "text", text: outcome.stdout || "(no output)" }], details: undefined };
    },
  });
}

/**
 * Build the inline extension that registers a task's resolved tools.
 * `cwd` is the conversation workspace; command tools run there.
 */
export function createRegistryExtension(options: RegistryExtensionOptions): ExtensionFactory {
  return (pi) => {
    for (const tool of options.tools) {
      const manifest = tool.manifest;
      if (manifest.status !== "active") continue;
      if (manifest.kind === "mcp") {
        if (!manifest.mcp) continue;
        pi.registerMcpServer(manifest.name, mcpConfig(manifest));
      } else if (manifest.kind === "command") {
        registerCommandTool(pi, manifest, tool.cachePath, options.cwd);
      }
      // extension kind: human-only modules loaded via additionalExtensionPaths
      // in the worker; informational builtins (no extension.entry) are skipped.
    }
  };
}