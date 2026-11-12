import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
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
