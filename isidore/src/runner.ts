import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTask, isDone, rootId, type Task, type TaskStore, utcnow } from "./store.ts";

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
}

export interface WorkerRequest {
  prompt: string;
  model: string | null;
  sessionId: string;
}

export function buildWorkerRequest(task: Task, model: string | null): WorkerRequest {
  return { prompt: task.prompt, model: task.model ?? model, sessionId: rootId(task) };
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
    // Do not hand the service's own credentials to the agent.
    for (const key of Object.keys(env)) {
      if (key.startsWith("ISIDORE_") || key.startsWith("SCHEDULER_") || key.startsWith("PI_SANDBOX_")) {
        delete env[key];
      }
    }
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

    const request = buildWorkerRequest(task, this.model);
    // In dev the worker is TypeScript; Node runs it with type stripping.
    const workerArgs = this.workerScript.endsWith(".ts")
      ? ["--experimental-strip-types", this.workerScript]
      : [this.workerScript];
    const proc = spawn(this.workerBin, workerArgs, {
      cwd: workspace,
      // The task's origin, interpolated into the scheduler MCP headers
      // (X-Isidore-Origin) so schedules it creates can report back to it.
      env: { ...this.env(workspace), ISIDORE_TASK_ORIGIN: task.origin || "web" },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group: cancelling a task kills its whole tree.
      detached: true,
    });
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
