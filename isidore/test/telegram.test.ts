import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { TaskStore, createTask, type Task } from "../src/store.ts";
import { TelegramBot, deriveWebhookSecret } from "../src/telegram.ts";

type Call = { method: string; body: any };

/** A fake Bot API recording every call; getUpdates returns nothing after a short wait. */
async function fakeApi(): Promise<{ server: Server; base: string; calls: Call[] }> {
  const calls: Call[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const method = (request.url ?? "").split("?")[0].split("/").pop() ?? "";
      calls.push({ method, body: raw ? JSON.parse(raw) : null });
      const result = method === "getUpdates" ? [] : true;
      setTimeout(() => response.end(JSON.stringify({ ok: true, result })), method === "getUpdates" ? 20 : 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, calls };
}

function stubs() {
  const created: string[] = [];
  const runner = {
    create: (prompt: string) => {
      created.push(prompt);
      return { id: `t_${created.length}` };
    },
    cancel: () => false,
  };
  return { created, runner: runner as any, store: { list: () => [], get: () => null } as any };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition not reached");
};

test("webhook mode registers the webhook and handles authenticated updates", async () => {
  const api = await fakeApi();
  const { created, runner, store } = stubs();
  const bot = new TelegramBot("123:abc", runner, store, new Set(["42"]), {
    apiBase: api.base,
    webhookUrl: "https://example.com/telegram/webhook",
  });
  try {
    assert.equal(bot.mode, "webhook");
    await bot.run();
    const secret = deriveWebhookSecret("123:abc");
    assert.match(secret, /^[A-Za-z0-9_-]{1,256}$/);
    assert.deepEqual(api.calls.map((c) => c.method), ["setWebhook"]);
    assert.equal(api.calls[0].body.url, "https://example.com/telegram/webhook");
    assert.equal(api.calls[0].body.secret_token, secret);

    const update = { update_id: 7, message: { chat: { id: 42 }, text: "hello" } };
    assert.equal(bot.handleWebhook("wrong", update), false);
    assert.equal(bot.handleWebhook(undefined, update), false);
    assert.equal(created.length, 0);

    assert.equal(bot.handleWebhook(secret, update), true);
    await until(() => created.length === 1);
    assert.equal(created[0], "hello");
    await until(() => api.calls.some((c) => c.method === "sendMessage"));

    // A redelivered update is acknowledged but not run twice.
    assert.equal(bot.handleWebhook(secret, update), true);
    // A chat outside the allow-list is ignored.
    assert.equal(bot.handleWebhook(secret, { update_id: 8, message: { chat: { id: 9 }, text: "x" } }), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(created.length, 1);
  } finally {
    await bot.stop();
    api.server.close();
  }
});

test("polling mode clears any webhook, then long-polls", async () => {
  const api = await fakeApi();
  const { runner, store } = stubs();
  const bot = new TelegramBot("123:abc", runner, store, new Set(), { apiBase: api.base, pollTimeout: 0 });
  try {
    assert.equal(bot.mode, "polling");
    const running = bot.run();
    await until(() => api.calls.some((c) => c.method === "getUpdates"));
    assert.equal(api.calls[0].method, "deleteWebhook");
    await bot.stop();
    await running;
  } finally {
    api.server.close();
  }
});

async function withBot(
  run: (ctx: { bot: TelegramBot; store: TaskStore; api: Awaited<ReturnType<typeof fakeApi>>; secret: string }) => Promise<void>,
): Promise<void> {
  const api = await fakeApi();
  const dir = mkdtempSync(join(tmpdir(), "isidore-telegram-"));
  const store = new TaskStore(dir, 10_000);
  const runner = {
    create: (prompt: string, overrides: Partial<Task> = {}) => {
      const task = createTask(prompt, overrides);
      store.add(task);
      return task;
    },
    cancel: () => false,
  };
  const bot = new TelegramBot("123:abc", runner as any, store, new Set(["42"]), {
    apiBase: api.base,
    webhookUrl: "https://example.com/telegram/webhook",
  });
  try {
    await run({ bot, store, api, secret: deriveWebhookSecret("123:abc") });
  } finally {
    await bot.stop();
    api.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const finish = (store: TaskStore, task: Task, output = "done"): Task => {
  task.status = "succeeded";
  task.exit_code = 0;
  task.output = output;
  store.update(task);
  return task;
};

let updateId = 100;
const message = (text: string, replyTo?: { fromId: number; text: string }) => ({
  update_id: updateId++,
  message: {
    chat: { id: 42 },
    text,
    ...(replyTo ? { reply_to_message: { from: { id: replyTo.fromId, is_bot: true }, text: replyTo.text } } : {}),
  },
});

test("a reply to a task message becomes a follow-up of its conversation", async () => {
  await withBot(async ({ bot, store, api, secret }) => {
    const first = finish(store, createTask("first", { origin: "telegram:42" }));
    const second = finish(store, createTask("second", { origin: "telegram:42", parent_id: first.id, thread_id: first.id }));

    // Replying to the first turn still continues after the latest one.
    bot.handleWebhook(secret, message("and then?", { fromId: 123, text: `${first.id}  succeeded\nfirst` }));
    await until(() => store.list(10).length === 3);
    const next = store.list(10).find((task) => task.prompt === "and then?")!;
    assert.equal(next.thread_id, first.id);
    assert.equal(next.parent_id, second.id);
    assert.equal(next.origin, "telegram:42");
    await until(() => api.calls.some((c) => c.method === "sendMessage" && /follow-up of/.test(c.body.text)));

    // While a turn runs, a reply is refused instead of queued.
    bot.handleWebhook(secret, message("more", { fromId: 123, text: `Queued ${next.id}` }));
    await until(() => api.calls.some((c) => c.method === "sendMessage" && /still running/.test(c.body.text)));
    assert.equal(store.list(10).length, 3);

    // A reply to someone else's message is a new task.
    bot.handleWebhook(secret, message("fresh", { fromId: 999, text: `${first.id}` }));
    await until(() => store.list(10).some((task) => task.prompt === "fresh"));
    assert.equal(store.list(10).find((task) => task.prompt === "fresh")!.thread_id, null);
  });
});

test("notify posts each finished task once, only to allowed chats", async () => {
  await withBot(async ({ bot, store, api }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");
    const task = createTask("p", { origin: "telegram:42", schedule_id: "s_1" });
    store.add(task);
    await bot.notify(task);
    assert.equal(sent().length, 0);

    finish(store, task, "x".repeat(5_000));
    await bot.notify(task);
    await bot.notify(task);
    assert.equal(sent().length, 2); // one result, split in two parts
    assert.match(sent()[0].body.text, /\[schedule s_1\]/);
    assert.match(sent()[1].body.text, new RegExp(`^${task.id} \\(2/2\\)`));

    const foreign = finish(store, createTask("q", { origin: "telegram:666" }));
    await bot.notify(foreign);
    assert.equal(sent().length, 2);
  });
});
