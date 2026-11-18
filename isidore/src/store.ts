import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timeout";

/** One tool invocation the agent made during a turn. */
export interface ToolCall {
  id: string;
  name: string;
  /** Short JSON of the call arguments, truncated for display. */
  args: string;
  status: "running" | "ok" | "error";
  duration_ms?: number;
}

export const TERMINAL_STATUSES: ReadonlySet<Status> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
]);

export interface Task {
  prompt: string;
  id: string;
  status: Status;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  output: string;
  error: string | null;
  origin: string;
  model: string | null;
  schedule_id: string | null;
  parent_id: string | null;
  thread_id: string | null;
  workspace: string | null;
  tool_calls: ToolCall[];
}

export type PublicTask = Task & { done: boolean };

/**
 * ISO-8601 with microsecond precision, UTC, matching the Python records.
 * Monotonic within the process, so records created in the same millisecond
 * still sort in creation order.
 */
let lastMicros = 0n;
export function utcnow(): string {
  const nowMicros = BigInt(Date.now()) * 1000n;
  const micros = nowMicros > lastMicros ? nowMicros : lastMicros + 1n;
  lastMicros = micros;
  const iso = new Date(Number(micros / 1000000n) * 1000).toISOString();
  const fraction = String(micros % 1000000n).padStart(6, "0");
  return `${iso.slice(0, 10)}T${iso.slice(11, 19)}.${fraction}+00:00`;
}

export const newId = (prefix = "t"): string => `${prefix}_${randomBytes(6).toString("hex")}`;
export const rootId = (task: Task): string => task.thread_id ?? task.id;
export const isDone = (task: Task): boolean => TERMINAL_STATUSES.has(task.status);
// Invariant: a Task (and therefore publicTask) must NEVER carry token material.
// Per-task capability tokens live only in the in-memory TokenRegistry (as a
// SHA-256 hash) and in the worker's ISIDORE_TASK_TOKEN env var — never in the
// persisted task JSON or any API response.
export const publicTask = (task: Task): PublicTask => ({ ...task, done: isDone(task) });

export function createTask(prompt: string, overrides: Partial<Task> = {}): Task {
  return {
    prompt,
    id: newId(),
    status: "queued",
    created_at: utcnow(),
    started_at: null,
    finished_at: null,
    exit_code: null,
    output: "",
    error: null,
    origin: "web",
    model: null,
    schedule_id: null,
    parent_id: null,
    thread_id: null,
    workspace: null,
    tool_calls: [],
    ...overrides,
  };
}

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "prompt",
  "id",
  "status",
  "created_at",
  "started_at",
  "finished_at",
  "exit_code",
  "output",
  "error",
  "origin",
  "model",
  "schedule_id",
  "parent_id",
  "thread_id",
  "workspace",
  "tool_calls",
]);

function fromDict(data: Record<string, unknown>): Task {
  const task = createTask(String(data.prompt ?? ""));
  const target = task as unknown as Record<string, unknown>;
  for (const key of KNOWN_FIELDS) {
    if (key in data) target[key] = data[key];
  }
  return task;
}

/** In-memory index over on-disk task records, one JSON file per task. */
export class TaskStore {
  private readonly root: string;
  private readonly maxOutput: number;
  private readonly tasks = new Map<string, Task>();

  constructor(root: string, maxOutput = 200_000) {
    this.root = root;
    this.maxOutput = maxOutput;
    mkdirSync(this.root, { recursive: true });
    this.load();
  }

  private path(id: string): string {
    return join(this.root, `${id}.json`);
  }

  private load(): void {
    for (const file of readdirSync(this.root).sort()) {
      if (!file.startsWith("t_") || !file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(this.root, file), "utf8")) as Record<string, unknown>;
        const task = fromDict(data);
        this.tasks.set(task.id, task);
      } catch {
        // unreadable/corrupt record: skip rather than fail startup
      }
    }
  }

  private write(task: Task): void {
    const path = this.path(task.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(task, null, 2));
    renameSync(tmp, path);
  }

  private clip(text: string): string {
    if (text.length <= this.maxOutput) return text;
    const half = Math.floor(this.maxOutput / 2);
    const dropped = text.length - this.maxOutput;
    return `${text.slice(0, half)}\n… (${dropped} chars truncated) …\n${text.slice(-half)}`;
  }

  add(task: Task): Task {
    this.tasks.set(task.id, task);
    this.write(task);
    return task;
  }

  update(task: Task): Task {
    task.output = this.clip(task.output);
    this.tasks.set(task.id, task);
    this.write(task);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  remove(id: string): boolean {
    if (!this.tasks.delete(id)) return false;
    try {
      unlinkSync(this.path(id));
    } catch {
      // already gone
    }
    return true;
  }

  list(limit = 100, status?: string | null): Task[] {
    let tasks = [...this.tasks.values()];
    if (status) tasks = tasks.filter((task) => task.status === status);
    tasks.sort((a, b) =>
      a.created_at === b.created_at ? b.id.localeCompare(a.id) : b.created_at.localeCompare(a.created_at),
    );
    return tasks.slice(0, limit);
  }

  thread(root: string): Task[] {
    return [...this.tasks.values()]
      .filter((task) => rootId(task) === root)
      .sort((a, b) =>
        a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at),
      );
  }

  count(): number {
    return this.tasks.size;
  }
}
