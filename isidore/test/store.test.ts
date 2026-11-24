import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskStore, createTask, publicTask, rootId } from "../src/store.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "isidore-store-"));
}

test("add, get, list and reload", () => {
  const dir = tempDir();
  try {
    const store = new TaskStore(dir);
    const first = store.add(createTask("one"));
    const second = store.add(createTask("two"));
    assert.equal(store.get(first.id)?.prompt, "one");
    assert.deepEqual(
      store.list().map((task) => task.id),
      [second.id, first.id],
    );
    const reloaded = new TaskStore(dir);
    assert.equal(reloaded.count(), 2);
    assert.equal(reloaded.get(first.id)?.prompt, "one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update persists and clips output", () => {
  const dir = tempDir();
  try {
    const store = new TaskStore(dir, 20);
    const task = store.add(createTask("x"));
    task.status = "succeeded";
    task.output = "a".repeat(100);
    store.update(task);
    assert.ok(task.output.length < 100);
    assert.match(task.output, /truncated/);
    assert.equal(new TaskStore(dir).get(task.id)?.status, "succeeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt record is skipped", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "t_broken.json"), "{not json");
    assert.equal(new TaskStore(dir).count(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove deletes the record", () => {
  const dir = tempDir();
  try {
    const store = new TaskStore(dir);
    const task = store.add(createTask("x"));
    assert.equal(store.remove(task.id), true);
    assert.equal(store.get(task.id), undefined);
    assert.equal(store.remove(task.id), false);
    assert.equal(new TaskStore(dir).count(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("thread is ordered and shared", () => {
  const dir = tempDir();
  try {
    const store = new TaskStore(dir);
    const root = store.add(createTask("first"));
    const follow = store.add(createTask("second", { parent_id: root.id, thread_id: root.id }));
    assert.equal(rootId(root), root.id);
    assert.equal(rootId(follow), root.id);
    assert.deepEqual(
      store.thread(root.id).map((task) => task.id),
      [root.id, follow.id],
    );
    assert.deepEqual(store.thread("t_missing"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public task exposes done", () => {
  const task = createTask("x");
  assert.equal(publicTask(task).done, false);
  task.status = "succeeded";
  assert.equal(publicTask(task).done, true);
});

test("uploads persist and reload from disk", () => {
  const dir = tempDir();
  try {
    const store = new TaskStore(dir);
    const upload = {
      id: "u_0123456789ab",
      name: "cat.png",
      size: 123,
      content_type: "image/png",
      created_at: "2026-01-01T00:00:00.000000+00:00",
    };
    const task = store.add(createTask("describe", { uploads: [upload] }));
    assert.deepEqual(publicTask(task).uploads, [upload]);

    const reloaded = new TaskStore(dir);
    assert.deepEqual(reloaded.get(task.id)?.uploads, [upload]);

    // Corrupt non-array uploads field is normalized to [].
    writeFileSync(join(dir, "t_corruptup00.json"), JSON.stringify({ id: "t_corruptup00", prompt: "x", uploads: "bad" }));
    assert.deepEqual(new TaskStore(dir).get("t_corruptup00")?.uploads, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
