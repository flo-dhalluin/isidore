import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MAX_UPLOAD_BYTES } from "../src/limits.ts";
import { ModelCapabilities } from "../src/model-capabilities.ts";
import { TaskStore, createTask, type Task } from "../src/store.ts";
import { TelegramBot, deriveWebhookSecret } from "../src/telegram.ts";
import { ToolRegistry, type ToolInput } from "../src/tools.ts";
import { uploadPath } from "../src/uploads.ts";

type Call = { method: string; body: any };

/** A fake Bot API recording every call; getUpdates returns nothing after a short wait. */
async function fakeApi(files: Record<string, Buffer> = {}): Promise<{ server: Server; base: string; calls: Call[] }> {
  const calls: Call[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.includes("/file/bot")) {
      const idx = url.indexOf("/file/bot");
      const rest = url.slice(idx + "/file/bot".length);
      const slash = rest.indexOf("/");
      const filePath = slash === -1 ? "" : rest.slice(slash + 1);
      const data = files[filePath];
      if (!data) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-length", String(data.byteLength));
      response.end(data);
      return;
    }
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const method = url.split("?")[0].split("/").pop() ?? "";
      let body: any = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw; // multipart form (sendPhoto)
        }
      }
      calls.push({ method, body });
      if (method === "getFile") {
        const fileId = String(body?.file_id ?? "");
        const filePath = `photos/${fileId}.bin`;
        const fileData = files[filePath];
        response.end(
          JSON.stringify({
            ok: true,
            result: {
              file_id: fileId,
              file_path: filePath,
              ...(fileData ? { file_size: fileData.byteLength } : {}),
            },
          }),
        );
        return;
      }
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

    // /new <prompt> starts a new conversation even while another turn is running.
    bot.handleWebhook(secret, message("/new fresh", { fromId: 999, text: `${first.id}` }));
    await until(() => store.list(10).some((task) => task.prompt === "fresh"));
    assert.equal(store.list(10).find((task) => task.prompt === "fresh")!.thread_id, null);
  });
});

test("plain messages continue the current conversation unless /new is issued", async () => {
  await withBot(async ({ bot, store, api, secret }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");

    // 1. First plain message in an empty chat starts a new conversation.
    bot.handleWebhook(secret, message("hello"));
    await until(() => store.list(10).length === 1);
    const t1 = store.list(10).find((t) => t.prompt === "hello")!;
    assert.equal(t1.thread_id, null);
    assert.equal(t1.parent_id, null);
    finish(store, t1, "hi there");

    // A scheduled task in the same chat does not hijack the user's conversation.
    const sched = finish(store, createTask("cron", { origin: "telegram:42", schedule_id: "s_1" }), "cron out");

    // 2. Second plain message (no reply_to_message) is a follow-up of t1, not sched.
    bot.handleWebhook(secret, message("how are you?"));
    await until(() => store.list(10).some((t) => t.prompt === "how are you?"));
    const t2 = store.list(10).find((t) => t.prompt === "how are you?")!;
    assert.equal(t2.thread_id, t1.id);
    assert.equal(t2.parent_id, t1.id);
    assert.notEqual(t2.parent_id, sched.id);
    finish(store, t2, "good");

    // 3. Third plain message continues the same thread after t2.
    bot.handleWebhook(secret, message("great"));
    await until(() => store.list(10).some((t) => t.prompt === "great"));
    const t3 = store.list(10).find((t) => t.prompt === "great")!;
    assert.equal(t3.thread_id, t1.id);
    assert.equal(t3.parent_id, t2.id);
    finish(store, t3, "yep");

    // 4. /new without a prompt resets the conversation; the next message starts fresh.
    bot.handleWebhook(secret, message("/new"));
    await until(() => sent().some((c) => /Started a new conversation/.test(c.body.text)));
    bot.handleWebhook(secret, message("topic two"));
    await until(() => store.list(10).some((t) => t.prompt === "topic two"));
    const t4 = store.list(10).find((t) => t.prompt === "topic two")!;
    assert.equal(t4.thread_id, null);
    assert.equal(t4.parent_id, null);
    finish(store, t4, "ok");

    // 5. Next plain message follows up on topic two.
    bot.handleWebhook(secret, message("more on topic two"));
    await until(() => store.list(10).some((t) => t.prompt === "more on topic two"));
    const t5 = store.list(10).find((t) => t.prompt === "more on topic two")!;
    assert.equal(t5.thread_id, t4.id);
    assert.equal(t5.parent_id, t4.id);
    finish(store, t5, "done");

    // 6. /new <prompt> immediately starts another new conversation.
    bot.handleWebhook(secret, message("/new topic three"));
    await until(() => store.list(10).some((t) => t.prompt === "topic three"));
    const t6 = store.list(10).find((t) => t.prompt === "topic three")!;
    assert.equal(t6.thread_id, null);
    assert.equal(t6.parent_id, null);
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

const TG_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const TG_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function visionCaps(modalities: Record<string, string[]> | "fail"): ModelCapabilities {
  return new ModelCapabilities({
    retryCooldownMs: 0,
    fetchFn: (async () => {
      if (modalities === "fail") return new Response("down", { status: 503 });
      return new Response(
        JSON.stringify({
          data: Object.entries(modalities).map(([id, m]) => ({ id, architecture: { input_modalities: m } })),
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
}

async function withPhotoBot(
  files: Record<string, Buffer>,
  caps: ModelCapabilities,
  defaultModel: string,
  run: (ctx: {
    bot: TelegramBot;
    store: TaskStore;
    uploadsRoot: string;
    api: Awaited<ReturnType<typeof fakeApi>>;
    secret: string;
  }) => Promise<void>,
): Promise<void> {
  const api = await fakeApi(files);
  const dir = mkdtempSync(join(tmpdir(), "isidore-tg-photo-"));
  const store = new TaskStore(join(dir, "tasks"), 10_000);
  const uploadsRoot = join(dir, "uploads");
  const runner = {
    create: (prompt: string, overrides: Partial<Task> = {}) => {
      const task = createTask(prompt, overrides);
      store.add(task);
      return task;
    },
    cancel: () => false,
  };
  const bot = new TelegramBot("123:secret-token", runner as any, store, new Set(["42"]), {
    apiBase: api.base,
    webhookUrl: "https://example.com/telegram/webhook",
    uploadsRoot,
    capabilities: caps,
    defaultModel,
    albumDebounceMs: 40,
  });
  try {
    await run({ bot, store, uploadsRoot, api, secret: deriveWebhookSecret("123:secret-token") });
  } finally {
    await bot.stop();
    api.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Telegram handles photo, image document, and photo reply follow-ups", async () => {
  const files: Record<string, Buffer> = {
    "photos/small.bin": TG_PNG,
    "photos/large.bin": TG_JPEG,
    "photos/doc1.bin": TG_PNG,
  };
  const caps = visionCaps({ "vision/m": ["text", "image"] });
  await caps.refresh();

  await withPhotoBot(files, caps, "openrouter/vision/m", async ({ bot, store, uploadsRoot, api, secret }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");

    // 1. Photo selects largest PhotoSize under MAX_UPLOAD_BYTES and uses caption as prompt.
    bot.handleWebhook(secret, {
      update_id: updateId++,
      message: {
        chat: { id: 42 },
        caption: "what is this?",
        photo: [
          { file_id: "small", width: 100, height: 100, file_size: 100 },
          { file_id: "large", width: 800, height: 600, file_size: 200 },
          { file_id: "huge", width: 4000, height: 4000, file_size: MAX_UPLOAD_BYTES + 10 },
        ],
      },
    });
    await until(() => store.list(10).length === 1);
    const task1 = store.list(10)[0];
    assert.equal(task1.prompt, "what is this?");
    assert.equal(task1.uploads.length, 1);
    assert.equal(task1.uploads[0].content_type, "image/jpeg");
    assert.deepEqual(readFileSync(uploadPath(uploadsRoot, task1.id, task1.uploads[0].id)), TG_JPEG);
    await until(() => sent().length === 1);
    assert.match(sent()[0].body.text, /1 image/);

    // 2. Photo-reply to bot task message continues the conversation.
    finish(store, task1, "it is a jpeg");
    bot.handleWebhook(secret, {
      update_id: updateId++,
      message: {
        chat: { id: 42 },
        caption: "now check this document",
        document: { file_id: "doc1", file_name: "scan.png", mime_type: "image/png", file_size: TG_PNG.byteLength },
        reply_to_message: { from: { id: 123, is_bot: true }, text: `${task1.id}  succeeded\nit is a jpeg` },
      },
    });
    await until(() => store.list(10).length === 2);
    const follow = store.list(10).find((t) => t.prompt === "now check this document")!;
    assert.equal(follow.thread_id, task1.id);
    assert.equal(follow.parent_id, task1.id);
    assert.equal(follow.uploads.length, 1);
    assert.equal(follow.uploads[0].name, "scan.png");
    assert.ok(existsSync(uploadPath(uploadsRoot, task1.id, follow.uploads[0].id)));
    await until(() => sent().length === 2);
    assert.match(sent()[1].body.text, /follow-up of/);

    // 3. Photo without reply_to_message also continues the current conversation.
    finish(store, follow, "looks good");
    bot.handleWebhook(secret, {
      update_id: updateId++,
      message: {
        chat: { id: 42 },
        caption: "another angle",
        photo: [{ file_id: "small", width: 100, height: 100, file_size: 100 }],
      },
    });
    await until(() => store.list(10).length === 3);
    const follow2 = store.list(10).find((t) => t.prompt === "another angle")!;
    assert.equal(follow2.thread_id, task1.id);
    assert.equal(follow2.parent_id, follow.id);

    // 4. Photo with /new caption starts a new conversation even while follow2 is queued.
    bot.handleWebhook(secret, {
      update_id: updateId++,
      message: {
        chat: { id: 42 },
        caption: "/new fresh photo",
        photo: [{ file_id: "small", width: 100, height: 100, file_size: 100 }],
      },
    });
    await until(() => store.list(10).length === 4);
    const freshPhoto = store.list(10).find((t) => t.prompt === "fresh photo")!;
    assert.equal(freshPhoto.thread_id, null);
    assert.equal(freshPhoto.parent_id, null);
  });
});

test("Telegram debounces media_group_id albums into one turn (max 4 images)", async () => {
  const files: Record<string, Buffer> = {
    "photos/a1.bin": TG_PNG,
    "photos/a2.bin": TG_JPEG,
    "photos/a3.bin": TG_PNG,
  };
  const caps = visionCaps({ "vision/m": ["text", "image"] });
  await caps.refresh();

  await withPhotoBot(files, caps, "openrouter/vision/m", async ({ bot, store, api, secret }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");

    for (const [idx, fid] of ["a1", "a2", "a3"].entries()) {
      bot.handleWebhook(secret, {
        update_id: updateId++,
        message: {
          chat: { id: 42 },
          media_group_id: "grp-1",
          ...(idx === 0 ? { caption: "compare these three" } : {}),
          photo: [{ file_id: fid, width: 400, height: 400, file_size: 100 }],
        },
      });
    }
    await until(() => store.list(10).length === 1);
    const task = store.list(10)[0];
    assert.equal(task.prompt, "compare these three");
    assert.equal(task.uploads.length, 3);
    await until(() => sent().length === 1);
    assert.match(sent()[0].body.text, /3 images/);
  });
});

test("Telegram photo handling gates on vision capability, rejects disguised SVG, and never leaks token URLs", async () => {
  const files: Record<string, Buffer> = {
    "photos/svg.bin": Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    "photos/missing.bin": TG_PNG,
  };
  const textCaps = visionCaps({ "text/m": ["text"] });
  await textCaps.refresh();

  // Text-only model rejects photos with a helpful error.
  await withPhotoBot(files, textCaps, "openrouter/text/m", async ({ bot, store, api, secret }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");
    bot.handleWebhook(secret, {
      update_id: updateId++,
      message: { chat: { id: 42 }, photo: [{ file_id: "svg", width: 100, height: 100 }] },
    });
    await until(() => sent().length === 1);
    assert.match(sent()[0].body.text, /does not support images/);
    assert.equal(store.list(10).length, 0);
  });

  // Disguised SVG & missing file download fail cleanly without leaking bot token.
  const okCaps = visionCaps({ "vision/m": ["text", "image"] });
  await okCaps.refresh();
  await withPhotoBot(files, okCaps, "openrouter/vision/m", async ({ bot, store, api, secret }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");
    bot.handleWebhook(secret, {
      update_id: updateId++,
      message: {
        chat: { id: 42 },
        document: { file_id: "svg", file_name: "fake.png", mime_type: "image/png" },
      },
    });
    await until(() => sent().length === 1);
    assert.match(sent()[0].body.text, /unsupported image format/i);
    assert.ok(!sent()[0].body.text.includes("secret-token"));

    bot.handleWebhook(secret, {
      update_id: updateId++,
      message: { chat: { id: 42 }, photo: [{ file_id: "nope", width: 100, height: 100 }] },
    });
    await until(() => sent().length === 2);
    assert.match(sent()[1].body.text, /Failed to download image/);
    assert.ok(!sent()[1].body.text.includes("secret-token"));
    assert.equal(store.list(10).length, 0);
  });

  // Unavailable capabilities fail closed.
  const failedCaps = visionCaps("fail");
  await withPhotoBot(files, failedCaps, "openrouter/vision/m", async ({ bot, store, api, secret }) => {
    const sent = () => api.calls.filter((c) => c.method === "sendMessage");
    bot.handleWebhook(secret, {
      update_id: updateId++,
      message: { chat: { id: 42 }, photo: [{ file_id: "missing", width: 100, height: 100 }] },
    });
    await until(() => sent().length === 1);
    assert.match(sent()[0].body.text, /capabilities unavailable/);
    assert.equal(store.list(10).length, 0);
  });
});
