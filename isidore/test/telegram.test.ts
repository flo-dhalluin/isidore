import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { TaskStore, createTask, type Task } from "../src/store.ts";
import { TelegramBot, deriveWebhookSecret } from "../src/telegram.ts";
import { ToolRegistry, type ToolInput } from "../src/tools.ts";

type Call = { method: string; body: any };

/** A fake Bot API recording every call; getUpdates returns nothing after a short wait. */
async function fakeApi(): Promise<{ server: Server; base: string; calls: Call[] }> {
  const calls: Call[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const method = (request.url ?? "").split("?")[0].split("/").pop() ?? "";
      let body: any = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw; // multipart form (sendPhoto)
        }
      }
      calls.push({ method, body });
      const result = method === "getUpdates" ? [] : method === "sendPhoto" ? { photo: [{ file_id: "logo-file" }] } : true;
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
  run: (ctx: { bot: TelegramBot; store: TaskStore; registry: ToolRegistry; api: Awaited<ReturnType<typeof fakeApi>>; secret: string }) => Promise<void>,
): Promise<void> {
  const api = await fakeApi();
  const dir = mkdtempSync(join(tmpdir(), "isidore-telegram-"));
  const store = new TaskStore(dir, 10_000);
  const registry = new ToolRegistry(join(dir, "tools"), {});
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
    registry,
  });
  try {
    await run({ bot, store, registry, api, secret: deriveWebhookSecret("123:abc") });
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
    assert.equal(sent()[0].body.parse_mode, "HTML");
    assert.match(sent()[0].body.text, /\[schedule s_1\]/);
    assert.match(sent()[1].body.text, new RegExp(`^${task.id} \\(2/2\\)`));

    const foreign = finish(store, createTask("q", { origin: "telegram:666" }));
    await bot.notify(foreign);
    assert.equal(sent().length, 2);
  });
});

test("/start sends the logo with the formatted help caption", async () => {
  await withBot(async ({ bot, api, secret }) => {
    const photos = () => api.calls.filter((c) => c.method === "sendPhoto");
    bot.handleWebhook(secret, message("/start"));
    await until(() => photos().length === 1);
    const form = String(photos()[0].body);
    assert.match(form, /name="caption"/);
    assert.match(form, /isidore - spawn isolated Pi tasks/);
    assert.match(form, /name="parse_mode"\r\n\r\nHTML/);
    assert.match(form, /filename="loutre-tete\.png"/);
    assert.ok(!api.calls.some((c) => c.method === "sendMessage"));

    // The uploaded logo's file_id is reused instead of uploading it again.
    bot.handleWebhook(secret, message("/start"));
    await until(() => photos().length === 2);
    const second = String(photos()[1].body);
    assert.match(second, /logo-file/);
    assert.doesNotMatch(second, /filename="loutre-tete\.png"/);
  });
});

test("task output is rendered with Telegram HTML formatting", async () => {
  await withBot(async ({ bot, store, api }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");
    const output = [
      "# Report",
      "",
      "Some **bold** and _italic_ and ~~gone~~ text with [a link](https://example.com/a?b=1&c=2).",
      "",
      "`inline <code>` stays escaped.",
      "",
      "```ts",
      "const x = a < b && b > c;",
      "```",
      "",
      "> quoted",
      "",
      "- first",
    ].join("\n");
    const task = finish(store, createTask("markdown", { origin: "telegram:42" }), output);
    store.add(task);
    await bot.notify(task);
    await until(() => sent().length === 1);
    const body = sent()[0].body;
    assert.equal(body.parse_mode, "HTML");
    assert.match(body.text, /<b>Report<\/b>/);
    assert.match(body.text, /<b>bold<\/b>/);
    assert.match(body.text, /<i>italic<\/i>/);
    assert.match(body.text, /<s>gone<\/s>/);
    assert.match(body.text, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2">a link<\/a>/);
    assert.match(body.text, /<code>inline &lt;code&gt;<\/code>/);
    assert.match(body.text, /<pre><code class="language-ts">\nconst x = a &lt; b &amp;&amp; b &gt; c;\n<\/code><\/pre>/);
    assert.match(body.text, /<blockquote>quoted<\/blockquote>/);
    assert.match(body.text, /• first/);
  });
});

test("a long fenced code block splits into balanced code messages", async () => {
  await withBot(async ({ bot, store, api }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");
    const output = ["```ts", ...Array(2_000).fill("let x = 1;"), "```"].join("\n");
    const task = finish(store, createTask("code", { origin: "telegram:42" }), output);
    store.add(task);
    await bot.notify(task);
    const bodies = sent().map((call) => call.body.text);
    assert.ok(bodies.length > 1, "expected the result to be split");
    for (const text of bodies) {
      assert.match(text, /<pre><code class="language-ts">/);
      assert.match(text, /<\/code><\/pre>/);
    }
    assert.match(bodies[1], new RegExp(`^${task.id} \\(2/`));
  });
});

const toolInput = (name: string): ToolInput => ({
  name,
  kind: "command",
  description: `telegram test tool ${name}`,
  input_schema: { type: "object", properties: {} },
  command: { argv: ["echo", "hi"], files: { "run.sh": "#!/bin/sh\necho hi\n" } },
});

test("/tools lists pending promotions + active globals; /approve uses the shared approval path", async () => {
  await withBot(async ({ bot, registry, api, secret }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");
    // A pending global (agent-authored), an active global (human-authored),
    // and an active conversation tool that must NOT be listed.
    const pending = registry.create(toolInput("pendingtool"), { scope: "global", rootId: "t_a", taskId: "t_a", origin: "task" });
    registry.requestPromotion(pending.id, "useful for every conversation");
    const global = registry.create(toolInput("globaltool"), { scope: "global", rootId: null, taskId: null, origin: "human" });
    const conv = registry.create(toolInput("convtool"), { scope: "conversation", rootId: "t_a", taskId: "t_a", origin: "task" });
    assert.equal(pending.status, "pending_approval");

    bot.handleWebhook(secret, message("/tools"));
    await until(() => sent().length === 1);
    const listing = sent()[0].body.text;
    assert.match(listing, /Pending approval/);
    assert.ok(listing.includes(pending.id));
    assert.ok(listing.includes("pendingtool"));
    assert.match(listing, /useful for every conversation/);
    assert.ok(listing.includes(global.id));
    assert.ok(listing.includes("globaltool"));
    assert.ok(!listing.includes(conv.id));
    assert.match(listing, /\/approve &lt;id&gt;/);

    // /approve without an id shows usage; unknown ids are refused.
    bot.handleWebhook(secret, message("/approve"));
    await until(() => sent().length === 2);
    assert.match(sent()[1].body.text, /Usage: \/approve &lt;tool-id&gt;/);
    bot.handleWebhook(secret, message("/approve tl_nope"));
    await until(() => sent().length === 3);
    assert.match(sent()[2].body.text, /Not approved: unknown tool/);

    // The real approval: name + version echoed BEFORE applying, then the
    // active + global result with ownership cleared.
    bot.handleWebhook(secret, message(`/approve ${pending.id}`));
    await until(() => sent().length === 5);
    assert.match(sent()[3].body.text, new RegExp(`Approving pendingtool v1 \\(${pending.id}\\)`));
    assert.match(sent()[4].body.text, new RegExp(`Approved ${pending.id} \\(pendingtool v1\\)`));
    const index = registry.getIndex(pending.id)!;
    assert.equal(index.status, "active");
    assert.equal(index.scope, "global");
    assert.equal(index.owner_root_id, null);
    assert.equal(index.owner_task_id, null);
    assert.equal(index.promotion_reason, undefined);
    // Approving a non-pending tool is refused (after the same echo).
    bot.handleWebhook(secret, message(`/approve ${global.id}`));
    await until(() => sent().length === 7);
    assert.match(sent()[5].body.text, /Approving globaltool v1/);
    assert.match(sent()[6].body.text, /Not approved.*not pending_approval/);
  });
});

test("/tools and /approve are gated to allowed chats", async () => {
  await withBot(async ({ bot, registry, api, secret }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");
    const pending = registry.create(toolInput("gatedtool"), { scope: "global", rootId: "t_a", taskId: "t_a", origin: "task" });
    // A chat outside the allow-list is silently ignored…
    const foreign = (text: string) => ({ update_id: updateId++, message: { chat: { id: 9 }, text } });
    assert.equal(bot.handleWebhook(secret, foreign("/tools")), true);
    assert.equal(bot.handleWebhook(secret, foreign(`/approve ${pending.id}`)), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent().length, 0);
    // …and the tool is still pending.
    assert.equal(registry.getIndex(pending.id)?.status, "pending_approval");
    // The allowed chat works.
    bot.handleWebhook(secret, message("/tools"));
    await until(() => sent().length === 1);
    assert.ok(sent()[0].body.text.includes(pending.id));
  });
});
