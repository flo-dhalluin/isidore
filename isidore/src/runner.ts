import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTask, isDone, rootId, type Task, type TaskStore, utcnow } from "./store.ts";
import { TokenRegistry } from "./tokens.ts";

const MAX_EVENT_TEXT = 4_000;

export interface RunnerOptions {
  store: TaskStore;
  workspaceRoot: string;
  workerScript: string;
  workerBin: string;
  maxWorkers: number;
  timeout: number | null;
  model: string | null;
  mode: "print" | "json";
  baseEnv?: NodeJS.ProcessEnv;
  onChange?: (task: Task) => void | Promise<void>;
  /** Per-task capability tokens; minted at spawn, revoked at finalise (Worker A). */
  tokens?: TokenRegistry;
  /** Landlock launcher binary; missing => fail closed unless unsafeNoSandbox (Worker A). */
  sandboxBin?: string | null;
  /** Run workers without the launcher; logged loudly (Worker A). */
  unsafeNoSandbox?: boolean;
  /** Shared Pi agent dir; defaults to baseEnv.PI_CODING_AGENT_DIR ?? "/state/pi" (Worker A). */
  agentDir?: string;
}

export interface WorkerRequest {
  prompt: string;
  model: string | null;
  sessionId: string;
  /**
   * OpenRouter key, delivered via stdin instead of the exec environment:
   * /proc/self/environ reflects the EXEC-time env, so a key passed in env
   * would stay readable by in-worker tools even after the worker deletes it
   * from process.env. Additive field; the JSONL output contract is untouched.
   */
  apiKey?: string | null;
}

export function buildWorkerRequest(task: Task, model: string | null, apiKey: string | null = null): WorkerRequest {
  return { prompt: task.prompt, model: task.model ?? model, sessionId: rootId(task), apiKey };
}

/**
 * Landlock allow-list for a task worker (deny everything else).
 *
 * `agentDirTargets` are the resolved targets of the per-task `.pi` symlinks
 * (Landlock checks symlink targets, not the links themselves).
 *
 * /proc is deliberately NARROW, not a wholesale --ro /proc: Landlock has no
 * ptrace scope (the kernel only scopes abstract unix sockets and signals,
 * ABI 6), so a broad /proc rule would leave /proc/<other-pid>/environ and
 * /proc/<other-pid>/mem readable (same uid; Yama cannot be relied on in
 * containers, and tasks are descendants of the service, which Yama scope 1
 * would ALLOW to ptrace it). Landlock cannot deny single files under an
 * allowed hierarchy, and per-child /proc/<pid> rules cannot be added
 * statically. Instead we allow:
 *  - /proc/self: resolved to the launcher's pid dir BEFORE exec; execv keeps
 *    the pid, so the worker itself keeps full access to its own /proc files.
 *  - global, non-sensitive proc files that node/libuv/git need.
 * Cross-pid environ/mem reads are denied by Landlock itself (tested).
 *
 * DECISION (empirically verified on kernel 7.1 / ABI 9, see sandbox.test.ts
 * case 5): child processes have different pids, so their /proc/self resolves
 * outside the allow-list and reads fail. We ACCEPT this breakage because
 * real workloads still work: the node worker itself (exec keeps the pid)
 * reads /proc/self fine (memoryUsage, cmdline), git init/add/commit/status/
 * log all succeed, and bash runs normal commands (process substitution uses
 * pipe fds, not proc paths). Known residual: explicit /proc/self reads in
 * CHILDREN fail, and process.memoryUsage() in node CHILD processes throws
 * EACCES (uv_resident_set_memory). The alternative (--ro /proc wholesale)
 * would leak the service's environ to every task — unacceptable.
 */
export function buildSandboxArgs(workspace: string, agentDirTargets: string[]): string[] {
  const args: string[] = ["--rw", workspace];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt/isidore"]) {
    args.push("--rx", path);
  }
  for (const path of [
    "/proc/self",
    "/proc/meminfo",
    "/proc/cpuinfo",
    "/proc/stat",
    "/proc/version",
    "/proc/uptime",
    "/proc/loadavg",
    "/proc/filesystems",
    "/proc/mounts",
    "/proc/sys",
    "/sys",
  ]) {
    args.push("--ro", path);
  }
  for (const target of agentDirTargets) args.push("--ro", target);
  for (const path of ["/dev/null", "/dev/urandom", "/dev/zero", "/dev/tty"]) {
    args.push("--rw", path);
  }
  return args;
}

/** Shared agent-dir entries a task must never see (secrets, other sessions, state). */
const AGENT_DIR_DENYLIST = new Set(["auth.json", "sessions", "web-search-cache", ".seed", "tmp"]);
/**
 * Small config files copied per task (writable); everything else is symlinked
 * read-only.
 *
 * models-store.json must be a copy, not a symlink: Pi >= 1.5.2 locks the
 * resolved store file (proper-lockfile no longer gets `realpath: false`), so a
 * symlink makes the runtime create `<shared>/models-store.json.lock` next to
 * the read-only target. Landlock denies that, which aborts setRuntimeApiKey.
 */
const AGENT_DIR_COPIES = new Set(["models.json", "models-store.json", "mcp.json", "settings.json"]);

/**
 * Build the per-task agent dir `<workspace>/.pi` from the shared Pi dir.
 * Returns the symlink TARGETS (under the shared dir) for the Landlock --ro
 * rules. Idempotent: copies are refreshed and symlinks re-pointed on every
 * call, so followups pick up shared-config changes.
 */
export function prepareAgentDir(workspace: string, sharedAgentDir: string): string[] {
  const dir = join(workspace, ".pi");
  mkdirSync(dir, { recursive: true });
  // Pi writes search results here at runtime; give each task its own.
  mkdirSync(join(dir, "web-search-cache"), { recursive: true });
  const targets: string[] = [];
  let entries;
  try {
    entries = readdirSync(sharedAgentDir, { withFileTypes: true });
  } catch {
    return targets; // no shared dir (bare dev setup): nothing to link
  }
  for (const entry of entries) {
    const name = entry.name;
    if (AGENT_DIR_DENYLIST.has(name) || name.endsWith(".lock")) continue;
    const source = join(sharedAgentDir, name);
    const dest = join(dir, name);
    if (AGENT_DIR_COPIES.has(name)) {
      if (entry.isFile()) {
        // Replace any previous entry, including a symlink left by an older
        // workspace, so a copy never writes through a link into the shared dir.
        rmSync(dest, { recursive: true, force: true });
        copyFileSync(source, dest);
      }
      continue;
    }
    // Symlink everything else (npm/, extensions/, themes/, ...). Refresh on
    // followups: replace whatever is there (except a correct existing link).
    // The target always needs a --ro rule, even when the link already exists.
    targets.push(source);
    try {
      if (realpathSync(dest) === realpathSync(source)) continue;
    } catch {
      // dest or source missing: fall through and (re)create the link
    }
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(source, dest);
  }
  return targets;
}

/** Flatten a Pi message `content` value into plain text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: string }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

function short(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Extract streamed assistant text from a JSON-mode record. */
export function summariseEvent(record: Record<string, unknown>): string | null {
  if (record.type !== "message_update") return null;
  const event = (record.assistantMessageEvent ?? {}) as Record<string, unknown>;
  return event.type === "text_delta" ? ((event.delta as string) ?? null) : null;
}

function kill(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  try {
    // The worker is a process-group leader (detached), so this kills its tree.
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Queue, run and cancel isolated worker tasks. */
export class Runner {
  private readonly store: TaskStore;
  private readonly workspaceRoot: string;
  private readonly workerScript: string;
  private readonly workerBin: string;
  private readonly maxWorkers: number;
  private readonly timeout: number | null;
  private readonly model: string | null;
  private readonly mode: "print" | "json";
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly onChange?: (task: Task) => void | Promise<void>;
  private readonly tokens: TokenRegistry;
  private readonly sandboxBin: string | null;
  private readonly unsafeNoSandbox: boolean;
  private readonly agentDir: string;
  private readonly procs = new Map<string, ChildProcess>();
  private readonly jobs = new Set<Promise<void>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private closing = false;

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.workspaceRoot = options.workspaceRoot;
    this.workerScript = options.workerScript;
    this.workerBin = options.workerBin;
    this.maxWorkers = Math.max(1, options.maxWorkers);
    this.timeout = options.timeout;
    this.model = options.model;
    this.mode = options.mode;
    this.baseEnv = options.baseEnv ?? process.env;
    this.onChange = options.onChange;
    this.tokens = options.tokens ?? new TokenRegistry();
    this.sandboxBin = options.sandboxBin ?? null;
    this.unsafeNoSandbox = options.unsafeNoSandbox ?? false;
    this.agentDir = options.agentDir ?? this.baseEnv.PI_CODING_AGENT_DIR ?? "/state/pi";
    if (this.unsafeNoSandbox) {
      console.error("======================================================================");
      console.error("isidore: ISIDORE_UNSAFE_NO_SANDBOX=1 — workers run WITHOUT the");
      console.error("isidore: Landlock launcher. Tasks can read/write the whole state");
      console.error("isidore: dir, secrets and other tasks' data. NEVER use in production.");
      console.error("======================================================================");
    } else if (!this.sandboxBin || !existsSync(this.sandboxBin)) {
      console.error(
        `isidore: sandbox binary ${this.sandboxBin ?? "(unset)"} not found — tasks will FAIL CLOSED until it exists (or ISIDORE_UNSAFE_NO_SANDBOX=1).`,
      );
    }
  }

  submit(task: Task): Task {
    this.store.add(task);
    this.notify(task);
    const job = this.run(task);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
    return task;
  }

  create(prompt: string, overrides: Partial<Task> = {}): Task {
    return this.submit(createTask(prompt, overrides));
  }

  cancel(id: string): boolean {
    const task = this.store.get(id);
    if (!task || isDone(task)) return false;
    task.status = "cancelled";
    task.finished_at = utcnow();
    this.store.update(task);
    this.notify(task);
    const proc = this.procs.get(id);
    if (proc && proc.exitCode === null && proc.signalCode === null) kill(proc);
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const id of [...this.procs.keys()]) this.cancel(id);
    await Promise.allSettled([...this.jobs]);
  }

  workspaceFor(task: Task): string {
    return join(this.workspaceRoot, rootId(task));
  }

  private notify(task: Task): void {
    if (!this.onChange) return;
    try {
      const result = this.onChange(task);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // a notifier must never break a task
    }
  }

  private env(workspace: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.baseEnv };
    // Keep Pi's config/credentials, but isolate the process home and cwd.
    env.HOME = workspace;
    env.TMPDIR = join(workspace, "tmp");
    mkdirSync(env.TMPDIR, { recursive: true });
    // Keep this conversation's Pi session inside its workspace.
    env.PI_CODING_AGENT_SESSION_DIR = join(workspace, "sessions");
    mkdirSync(env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
    // Do not hand the service's own credentials to the agent. OPENROUTER_API_KEY
    // is removed here too: /proc/self/environ reflects the EXEC-time env, so
    // deleting it inside the worker would be too late — the key travels to the
    // worker via the stdin JSON request (WorkerRequest.apiKey) instead.
    for (const key of Object.keys(env)) {
      if (key.startsWith("ISIDORE_") || key.startsWith("SCHEDULER_") || key.startsWith("PI_SANDBOX_")) {
        delete env[key];
      }
    }
    delete env.OPENROUTER_API_KEY;
    // Per-task agent dir (copies of models/mcp/settings, symlinks to the rest).
    env.PI_CODING_AGENT_DIR = join(workspace, ".pi");
    // The per-task HOME has no git config; mirror the author identity.
    for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"]) {
      if (env[key]) env[key.replace("AUTHOR", "COMMITTER")] ??= env[key];
    }
    return env;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxWorkers) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  private async run(task: Task): Promise<void> {
    try {
      await this.acquire();
      try {
        if (task.status === "cancelled" || this.closing) return;
        await this.execute(task);
      } finally {
        this.release();
      }
    } catch (error) {
      if (!isDone(task)) {
        task.status = "failed";
        task.error = `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`;
        task.finished_at = utcnow();
        this.store.update(task);
        this.notify(task);
      }
    }
  }

  private async execute(task: Task): Promise<void> {
    const workspace = this.workspaceFor(task);
    mkdirSync(join(workspace, "tmp"), { recursive: true });
    mkdirSync(join(workspace, "sessions"), { recursive: true });
    task.workspace = workspace;
    task.status = "running";
    task.started_at = utcnow();
    this.store.update(task);
    this.notify(task);

    const request = buildWorkerRequest(task, this.model, this.baseEnv.OPENROUTER_API_KEY ?? null);
    // In dev the worker is TypeScript; Node runs it with type stripping.
    const workerArgs = this.workerScript.endsWith(".ts")
      ? ["--experimental-strip-types", this.workerScript]
      : [this.workerScript];
    // Per-task capability token: minted at spawn, revoked in finalise() — or
    // immediately below if anything before/including spawn throws, so a
    // fail-closed task never leaks a live token into the registry.
    // Set AFTER the prefix scrub so it survives into the worker env (Pi
    // expands it into the scheduler MCP headers); bash children never see it.
    const token = this.tokens.issue(task);
    let proc: ChildProcess;
    try {
      const env: NodeJS.ProcessEnv = {
        ...this.env(workspace),
        ISIDORE_TASK_ORIGIN: task.origin || "web",
        ISIDORE_TASK_TOKEN: token,
      };
      let bin = this.workerBin;
      let args = workerArgs;
      if (!this.unsafeNoSandbox) {
        if (!this.sandboxBin || !existsSync(this.sandboxBin)) {
          throw new Error(
            `sandbox binary not found: ${this.sandboxBin ?? "(unset)"} — refusing to run unsandboxed (set ISIDORE_SANDBOX_BIN, or ISIDORE_UNSAFE_NO_SANDBOX=1 to override)`,
          );
        }
        const targets = prepareAgentDir(workspace, this.agentDir);
        bin = this.sandboxBin;
        args = [
          ...buildSandboxArgs(workspace, targets),
          // The worker script itself must be readable/executable (in production
          // this is /opt/isidore/dist, already covered; in tests it is a tmpdir).
          // NOTE: this grants read to the WHOLE script directory, so never
          // co-locate secrets with the worker script in dev/test layouts.
          "--rx",
          dirname(this.workerScript),
          "--",
          this.workerBin,
          ...workerArgs,
        ];
      }
      proc = spawn(bin, args, {
        cwd: workspace,
        // The task's origin, interpolated into the scheduler MCP headers
        // (X-Isidore-Origin) so schedules it creates can report back to it.
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group: cancelling a task kills its whole tree.
        detached: true,
      });
    } catch (error) {
      this.tokens.revoke(task.id);
      throw error;
    }
    this.procs.set(task.id, proc);
    proc.stdin?.on("error", () => undefined);
    proc.stdin?.end(JSON.stringify(request));

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (this.timeout !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        task.error = `timed out after ${this.timeout}s`;
        kill(proc);
      }, this.timeout * 1000);
    }

    try {
      await this.consumeJson(task, proc);
    } finally {
      if (timer) clearTimeout(timer);
      this.procs.delete(task.id);
      this.finalise(task, proc.exitCode, timedOut);
    }
  }

  /**
   * Parse the worker's JSONL event stream. Tool calls are collected as
   * structured records; the transcript is built from streamed text. In print
   * mode the transcript is replaced by the final assistant answer.
   */
  private consumeJson(task: Task, proc: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      let buffer = "";
      let lastSave = 0;
      let sawTextDelta = false;
      let lastAssistantText = "";
      const err: Buffer[] = [];

      const persist = (force: boolean): void => {
        const now = Date.now();
        if (!force && now - lastSave < 500) return;
        this.store.update(task);
        this.notify(task);
        lastSave = now;
      };

      const handle = (record: Record<string, unknown>): void => {
        const kind = record.type;
        if (kind === "tool_execution_start") {
          task.tool_calls.push({
            id: String(record.toolCallId ?? ""),
            name: String(record.toolName ?? "tool"),
            args: short(record.args),
            status: "running",
          });
          persist(true);
          return;
        }
        if (kind === "tool_execution_end") {
          const call = task.tool_calls.find((entry) => entry.id === String(record.toolCallId ?? ""));
          if (call) {
            call.status = record.isError ? "error" : "ok";
            if (typeof record.durationMs === "number") call.duration_ms = record.durationMs;
          }
          persist(true);
          return;
        }
        if (kind === "message_start") {
          sawTextDelta = false;
          return;
        }
        if (kind === "message_end") {
          const message = (record.message ?? {}) as Record<string, unknown>;
          if (message.role !== "assistant") return;
          const text = textOf(message.content);
          if (text) lastAssistantText = text;
          // The streamed deltas already produced this text; keep only a separator.
          task.output += sawTextDelta ? "\n" : text ? `\n${text}\n` : "";
          persist(true);
          return;
        }
        const text = summariseEvent(record);
        if (!text) return;
        if (kind === "message_update") sawTextDelta = true;
        task.output += text;
        persist(kind !== "message_update");
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let index: number;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(line) as Record<string, unknown>;
          } catch {
            task.output += `${line}\n`;
            persist(false);
            continue;
          }
          handle(record);
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

      proc.on("close", () => {
        if (buffer.trim()) {
          try {
            handle(JSON.parse(buffer.trim()) as Record<string, unknown>);
          } catch {
            task.output += `${buffer.trim()}\n`;
          }
        }
        if (this.mode === "print" && lastAssistantText) task.output = lastAssistantText;
        const stderr = Buffer.concat(err).toString("utf8").trim();
        if (stderr) task.error = stderr.slice(-MAX_EVENT_TEXT);
        resolve();
      });
    });
  }

  private finalise(task: Task, exitCode: number | null, timedOut: boolean): void {
    this.tokens.revoke(task.id);
    task.exit_code = exitCode;
    if (!task.finished_at) task.finished_at = utcnow();
    if (task.status === "cancelled") {
      // keep
    } else if (timedOut) {
      task.status = "timeout";
    } else if (exitCode === 0) {
      task.status = "succeeded";
    } else {
      task.status = "failed";
    }
    this.store.update(task);
    this.notify(task);
  }
}
