import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Settings {
  stateDir: string;
  host: string;
  port: number;
  /** Always set by loadSettings (generated when ISIDORE_TOKEN is unset); null only for programmatic/test callers, which createApp backs up with a generated token. */
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
  /** File holding the scheduler admin token, read per-request when schedulerToken is unset (compose: scheduler-auth volume). */
  schedulerTokenFile: string | null;
  telegramToken: string | null;
  telegramChats: Set<string>;
  telegramWebhookUrl: string | null;
  telegramWebhookSecret: string | null;
  /** Landlock launcher binary; null/missing => fail closed (unless unsafeNoSandbox). */
  sandboxBin: string | null;
  /** ISIDORE_UNSAFE_NO_SANDBOX=1: run workers without the launcher (logged loudly). */
  unsafeNoSandbox: boolean;
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

/** A secret from `NAME`, or else from the file named by `NAME_FILE` (compose secret). */
function envSecret(name: string): string | null {
  const value = process.env[name];
  if (value) return value;
  const file = process.env[`${name}_FILE`];
  if (!file) return null;
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** A fresh admin token: 64-char lowercase hex. */
export function generateAdminToken(): string {
  return randomBytes(32).toString("hex");
}

export const adminTokenPath = (stateDir: string): string => join(stateDir, "shared", "admin-token");

/**
 * Persist the effective admin token to `<stateDir>/shared/admin-token` (0600).
 * The scheduler reads this file (SCHEDULER_ISIDORE_TOKEN_FILE) to authenticate
 * to isidore when no token is shared via the environment. Kept separate from
 * loadSettings so pure/test paths that build Settings directly do no disk I/O.
 */
export function writeAdminToken(stateDir: string, token: string): string {
  const path = adminTokenPath(stateDir);
  mkdirSync(join(stateDir, "shared"), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function loadSettings(): Settings {
  const stateDir = process.env.ISIDORE_STATE ?? "/state";
  // In dev the service runs from TypeScript sources (Node type stripping), so
  // the default worker is the .ts file; the compiled build uses .js.
  const workerFile = import.meta.url.endsWith(".ts") ? "worker.ts" : "worker.js";
  const envToken = process.env.ISIDORE_TOKEN || null;
  const token = envToken ?? generateAdminToken();
  const settings: Settings = {
    stateDir,
    host: process.env.ISIDORE_HOST ?? "0.0.0.0",
    port: envInt("ISIDORE_PORT", 8920),
    token,
    model: process.env.ISIDORE_MODEL || null,
    workerScript: process.env.ISIDORE_WORKER_SCRIPT ?? join(import.meta.dirname, workerFile),
    workerBin: process.env.ISIDORE_WORKER_BIN ?? process.execPath,
    piMode: process.env.ISIDORE_PI_MODE === "json" ? "json" : "print",
    maxWorkers: Math.max(1, envInt("ISIDORE_MAX_WORKERS", 2)),
    timeout: envFloat("ISIDORE_TASK_TIMEOUT", null),
    maxOutput: envInt("ISIDORE_MAX_OUTPUT", 200_000),
    schedulerUrl: process.env.ISIDORE_SCHEDULER_URL || null,
    schedulerToken: process.env.ISIDORE_SCHEDULER_TOKEN || null,
    schedulerTokenFile: process.env.ISIDORE_SCHEDULER_TOKEN_FILE ?? "/state/scheduler-shared/scheduler-token",
    telegramToken: envSecret("ISIDORE_TELEGRAM_TOKEN"),
    telegramChats: new Set(
      (process.env.ISIDORE_TELEGRAM_CHATS ?? "")
        .split(",")
        .map((chat) => chat.trim())
        .filter(Boolean),
    ),
    telegramWebhookUrl: process.env.ISIDORE_TELEGRAM_WEBHOOK_URL || null,
    telegramWebhookSecret: envSecret("ISIDORE_TELEGRAM_WEBHOOK_SECRET"),
    sandboxBin: process.env.ISIDORE_SANDBOX_BIN ?? "/usr/local/bin/isidore-sandbox",
    unsafeNoSandbox: process.env.ISIDORE_UNSAFE_NO_SANDBOX === "1",
  };
  // Always publish the effective token (env-provided or generated) so the
  // scheduler can read it from the shared volume.
  const path = writeAdminToken(stateDir, token);
  if (!envToken) {
    // Loud, out-of-band retrieval: the token is NOT injected into the loopback
    // UI (workers share isidore's network namespace and could harvest it).
    console.error("======================================================================");
    console.error("isidore: ISIDORE_TOKEN was unset — generated a new admin token.");
    console.error(`isidore: admin token: ${token}`);
    console.error(`isidore: also written to ${path} (mode 0600).`);
    console.error(`isidore: open the UI at http://127.0.0.1:${settings.port}/?token=${token}`);
    console.error("======================================================================");
  }
  return settings;
}

export const tasksDir = (settings: Settings): string => join(settings.stateDir, "tasks");
export const workspacesDir = (settings: Settings): string => join(settings.stateDir, "workspaces");
export const toolsDir = (settings: Settings): string => join(settings.stateDir, "tools");
export const toolCacheDir = (settings: Settings): string => join(settings.stateDir, "tool-cache");
