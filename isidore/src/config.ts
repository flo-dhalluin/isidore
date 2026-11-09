import { join } from "node:path";

export interface Settings {
  stateDir: string;
  host: string;
  port: number;
  token: string | null;
  model: string | null;
  workerScript: string;
  workerBin: string;
  piMode: "print" | "json";
  maxWorkers: number;
  timeout: number | null;
  maxOutput: number;
  schedulerUrl: string | null;
  schedulerToken: string | null;
  telegramToken: string | null;
  telegramChats: Set<string>;
}

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number | null): number | null {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadSettings(): Settings {
  const stateDir = process.env.ISIDORE_STATE ?? "/state";
  // In dev the service runs from TypeScript sources (Node type stripping), so
  // the default worker is the .ts file; the compiled build uses .js.
  const workerFile = import.meta.url.endsWith(".ts") ? "worker.ts" : "worker.js";
  return {
    stateDir,
    host: process.env.ISIDORE_HOST ?? "0.0.0.0",
    port: envInt("ISIDORE_PORT", 8920),
    token: process.env.ISIDORE_TOKEN || null,
    model: process.env.ISIDORE_MODEL || null,
    workerScript: process.env.ISIDORE_WORKER_SCRIPT ?? join(import.meta.dirname, workerFile),
    workerBin: process.env.ISIDORE_WORKER_BIN ?? process.execPath,
    piMode: process.env.ISIDORE_PI_MODE === "json" ? "json" : "print",
    maxWorkers: Math.max(1, envInt("ISIDORE_MAX_WORKERS", 2)),
    timeout: envFloat("ISIDORE_TASK_TIMEOUT", null),
    maxOutput: envInt("ISIDORE_MAX_OUTPUT", 200_000),
    schedulerUrl: process.env.ISIDORE_SCHEDULER_URL || null,
    schedulerToken: process.env.ISIDORE_SCHEDULER_TOKEN || null,
    telegramToken: process.env.ISIDORE_TELEGRAM_TOKEN || null,
    telegramChats: new Set(
      (process.env.ISIDORE_TELEGRAM_CHATS ?? "")
        .split(",")
        .map((chat) => chat.trim())
        .filter(Boolean),
    ),
  };
}

export const tasksDir = (settings: Settings): string => join(settings.stateDir, "tasks");
export const workspacesDir = (settings: Settings): string => join(settings.stateDir, "workspaces");
