import { createHash, randomBytes } from "node:crypto";
import { rootId, type Task } from "./store.ts";

/** The conversation a task token is bound to. */
export interface TaskScope {
  taskId: string;
  rootId: string;
  origin: string;
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * In-memory registry of per-task capability tokens.
 *
 * Only the SHA-256 hash of each token is stored, bound to the task's
 * conversation scope (`{taskId, rootId, origin}`). The plaintext token lives
 * only in the worker's environment (`ISIDORE_TASK_TOKEN`) and is never
 * persisted to the task store. Tokens die on restart — acceptable, because
 * in-flight tasks die too and follow-ups mint fresh tokens.
 */
export class TokenRegistry {
  /** sha256hex(token) -> scope. The plaintext token is never a key or value. */
  private readonly scopes = new Map<string, TaskScope>();
  /** taskId -> sha256hex(token), so revoke(taskId) can find the entry. */
  private readonly byTask = new Map<string, string>();

  /** Number of live (issued, not yet revoked) tokens. */
  get size(): number {
    return this.byTask.size;
  }

  /** Mint a fresh 64-char lowercase-hex token for `task`, replacing any prior one. */
  issue(task: Task): string {
    const token = randomBytes(32).toString("hex");
    const key = hashToken(token);
    const previous = this.byTask.get(task.id);
    if (previous !== undefined) this.scopes.delete(previous);
    this.scopes.set(key, { taskId: task.id, rootId: rootId(task), origin: task.origin });
    this.byTask.set(task.id, key);
    return token;
  }

  /** Resolve a plaintext token to its scope, or undefined when unknown/revoked. */
  resolve(token: string): TaskScope | undefined {
    return this.scopes.get(hashToken(token));
  }

  /** Drop the token minted for `taskId` (called when the task finalises). */
  revoke(taskId: string): void {
    const key = this.byTask.get(taskId);
    if (key === undefined) return;
    this.scopes.delete(key);
    this.byTask.delete(taskId);
  }
}
