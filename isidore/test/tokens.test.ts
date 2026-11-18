import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createTask } from "../src/store.ts";
import { TokenRegistry, type TaskScope } from "../src/tokens.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

test("issue returns a 64-char lowercase hex token bound to the conversation", () => {
  const registry = new TokenRegistry();
  const root = createTask("root", { origin: "telegram:42" });
  const token = registry.issue(root);
  assert.match(token, /^[0-9a-f]{64}$/);
  const scope = registry.resolve(token);
  assert.deepEqual(scope, { taskId: root.id, rootId: root.id, origin: "telegram:42" });
});

test("a follow-up token resolves to the root conversation, not its own id", () => {
  const registry = new TokenRegistry();
  const root = createTask("root");
  const follow = createTask("follow", { parent_id: root.id, thread_id: root.id, origin: "web" });
  const token = registry.issue(follow);
  const scope = registry.resolve(token) as TaskScope;
  assert.equal(scope.taskId, follow.id);
  assert.equal(scope.rootId, root.id);
});

test("resolve returns undefined for unknown or malformed tokens", () => {
  const registry = new TokenRegistry();
  registry.issue(createTask("x"));
  assert.equal(registry.resolve("not-a-token"), undefined);
  assert.equal(registry.resolve(""), undefined);
  assert.equal(registry.resolve("0".repeat(64)), undefined);
});

test("revoke drops the token; re-issue replaces the previous one", () => {
  const registry = new TokenRegistry();
  const task = createTask("x");
  const first = registry.issue(task);
  assert.ok(registry.resolve(first));
  registry.revoke(task.id);
  assert.equal(registry.resolve(first), undefined);
  // revoking again is a no-op
  registry.revoke(task.id);

  const second = registry.issue(task);
  const third = registry.issue(task);
  assert.notEqual(second, third);
  assert.equal(registry.resolve(second), undefined, "previous token replaced");
  assert.ok(registry.resolve(third));
});

test("tokens are unique across tasks", () => {
  const registry = new TokenRegistry();
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const token = registry.issue(createTask(`task ${i}`));
    assert.ok(!seen.has(token), "token collision");
    seen.add(token);
  }
  assert.equal(seen.size, 200);
});

test("only the sha256 hash is stored, never the plaintext token", () => {
  const registry = new TokenRegistry();
  const task = createTask("secret-task", { origin: "web" });
  const token = registry.issue(task);
  // White-box check of the storage invariant (contract #2).
  const scopes = (registry as unknown as { scopes: Map<string, TaskScope> }).scopes;
  assert.ok(scopes.has(sha256(token)), "keyed by sha256(token)");
  for (const [key, scope] of scopes) {
    assert.notEqual(key, token);
    assert.equal(key, sha256(token));
    assert.ok(!JSON.stringify(scope).includes(token), "scope must not contain the token");
  }
  // Resolving the hash itself does not work (resolve hashes its input once).
  assert.equal(registry.resolve(sha256(token)), undefined);
});
