import { createHmac, timingSafeEqual } from "node:crypto";
import type { Runner } from "./runner.ts";
import { isDone, rootId, type Task, type TaskStore } from "./store.ts";
import { readTemplateAsset } from "./templates.ts";
import { approvePromotion } from "./tools-api.ts";
import type { ToolRegistry } from "./tools.ts";

const TASK_ID = /\bt_[0-9a-f]{12}\b/;
const MAX_MESSAGE = 3_800; // Telegram's hard limit is 4096; leave room for a header.

/** Escape the characters Telegram's HTML parse mode treats as markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/** Markdown inline spans that map onto Telegram's supported HTML tags. */
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\|\|[^|\n]+\|\|)|(\[[^\]\n]*\]\([^()\s]+\))|((?<![\w*])\*(?!\s)[^*\n]+?(?<!\s)\*(?![\w*]))|((?<![\w_])_(?!\s)[^_\n]+?(?<!\s)_(?![\w_]))/g;

function formatInline(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    out += escapeHtml(text.slice(last, match.index));
    if (token.startsWith("`")) out += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    else if (token.startsWith("**") || token.startsWith("__")) out += `<b>${formatInline(token.slice(2, -2))}</b>`;
    else if (token.startsWith("~~")) out += `<s>${formatInline(token.slice(2, -2))}</s>`;
    else if (token.startsWith("||")) out += `<span class="tg-spoiler">${formatInline(token.slice(2, -2))}</span>`;
    else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      out += `<a href="${escapeAttribute(token.slice(split + 2, -1))}">${formatInline(token.slice(1, split))}</a>`;
    } else out += `<i>${formatInline(token.slice(1, -1))}</i>`;
    last = match.index + token.length;
  }
  return out + escapeHtml(text.slice(last));
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

interface Fence {
  /** Opening line, used to reopen the block when a chunk is split. */
  open: string;
  /** Closing delimiter for the HTML block. */
  close: string;
  char: string;
  length: number;
}

function fenceAt(line: string): { marker: string; char: string; length: number; info: string } | null {
  const match = FENCE.exec(line);
  if (!match) return null;
  return { marker: match[1], char: match[1][0], length: match[1].length, info: match[2].trim() };
}

/** Convert agent Markdown to the subset of HTML Telegram renders. */
function formatHtml(markdown: string): string {
  const out: string[] = [];
  let fence: Fence | null = null;
  for (const line of markdown.split("\n")) {
    const marker = fenceAt(line);
    if (fence) {
      if (marker && marker.char === fence.char && marker.length >= fence.length) {
        out.push(fence.close);
        fence = null;
      } else {
        out.push(escapeHtml(line));
      }
      continue;
    }
    if (marker) {
      const language = marker.info.replace(/[^\w.+-]/g, "");
      fence = { open: line, close: language ? "</code></pre>" : "</pre>", char: marker.char, length: marker.length };
      out.push(language ? `<pre><code class="language-${language}">` : "<pre>");
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${formatInline(heading[1])}</b>`);
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`<blockquote>${formatInline(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${formatInline(bullet[2])}`);
      continue;
    }
    out.push(formatInline(line));
  }
  if (fence) out.push(fence.close);
  return out.join("\n");
}

/**
 * Split Markdown into chunks below Telegram's message limit, cutting at line
 * boundaries and closing/reopening a fenced code block when a split lands
 * inside one, so every chunk formats cleanly on its own.
 */
function chunks(text: string, limit = MAX_MESSAGE): string[] {
  const result: string[] = [];
  let current: string[] = [];
  let length = 0;
  let fence: Fence | null = null;

  const add = (line: string): void => {
    if (current.length) length += 1;
    current.push(line);
    length += line.length;
  };
  const flush = (): void => {
    if (!current.length) return;
    if (fence) {
      current.push(fence.close);
      length += 1 + fence.close.length;
    }
    result.push(current.join("\n"));
    // Reopen the fence in the next chunk, unless its opening line alone is too long.
    const reopen = fence !== null && fence.open.length + 2 < limit;
    current = reopen ? [fence!.open] : [];
    length = current.length ? current[0].length : 0;
    if (!reopen) fence = null;
  };

  for (const line of text.split("\n")) {
    const marker = fenceAt(line);
    const closing = !!(fence && marker && marker.char === fence.char && marker.length >= fence.length);
    let content = line;
    for (;;) {
      const capacity = limit - length - (current.length ? 1 : 0);
      if (content.length <= capacity) {
        add(content);
        break;
      }
      if (capacity > 0) {
        add(content.slice(0, capacity));
        content = content.slice(capacity);
      }
      flush();
    }
    if (closing) fence = null;
    else if (!fence && marker) fence = { open: line.replace(/^\s+/, ""), close: marker.marker, char: marker.char, length: marker.length };
  }
  flush();
  return result.length ? result : [""];
}

export interface TelegramOptions {
  apiBase?: string;
  /** Long-poll timeout in seconds (polling mode). */
  pollTimeout?: number;
  /** Public HTTPS URL Telegram posts updates to; null = long polling. */
  webhookUrl?: string | null;
  /** Value Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`. */
  webhookSecret?: string | null;
  /** Tool registry for /tools and /approve (Phase 4); unset disables them. */
  registry?: ToolRegistry;
}

/** Derive a webhook secret from the bot token: [A-Za-z0-9_-], stable across restarts. */
export function deriveWebhookSecret(token: string): string {
  return createHmac("sha256", token).update("isidore-telegram-webhook").digest("hex");
}

/**
 * Optional Telegram front-end. Disabled unless a token is configured.
 * Receives updates by long polling (default) or, when a webhook URL is set,
 * through `handleWebhook` (wired to `POST /telegram/webhook` by the server).
 */
export class TelegramBot {
  private readonly token: string;
  private readonly runner: Runner;
  private readonly store: TaskStore;
  private readonly allowedChats: Set<string>;
  private readonly registry: ToolRegistry | null;
  private readonly apiBase: string;
  private readonly pollTimeout: number;
  readonly webhookUrl: string | null;
  private readonly webhookSecret: string;
  private readonly botId: string;
  /** Tasks whose final state was already posted (cancel reports twice). */
  private readonly notified = new Set<string>();
  /** Telegram file_id of the logo, so it is uploaded only once per process. */
  private logoFileId: string | null = null;
  private offset = 0;
  private stopped = false;

  constructor(token: string, runner: Runner, store: TaskStore, allowedChats: Set<string>, options: TelegramOptions = {}) {
    this.token = token;
    this.botId = token.split(":", 1)[0];
    this.runner = runner;
    this.store = store;
    this.allowedChats = allowedChats;
    this.registry = options.registry ?? null;
    this.apiBase = (options.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.pollTimeout = options.pollTimeout ?? 30;
    this.webhookUrl = options.webhookUrl || null;
    this.webhookSecret = options.webhookSecret || deriveWebhookSecret(token);
  }

  get mode(): "webhook" | "polling" {
    return this.webhookUrl ? "webhook" : "polling";
  }

  /** Register the webhook, or clear it and long-poll. Retries until it succeeds or the bot stops. */
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (this.webhookUrl) {
          await this.call("setWebhook", {
            url: this.webhookUrl,
            secret_token: this.webhookSecret,
            allowed_updates: ["message"],
          });
          return;
        }
        // getUpdates is refused while a webhook is set (e.g. from a previous run).
        await this.call("deleteWebhook", {});
        break;
      } catch (error) {
        console.error(`telegram: ${this.mode} setup failed: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    await this.poll();
  }

  /** Handle a webhook request. Returns false when the secret header does not match. */
  handleWebhook(secretHeader: string | string[] | undefined, update: unknown): boolean {
    const given = Buffer.from(typeof secretHeader === "string" ? secretHeader : "");
    const expected = Buffer.from(this.webhookSecret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    if (!update || typeof update !== "object") return true;
    const record = update as Record<string, unknown>;
    const id = Number(record.update_id ?? 0);
    // Telegram retries deliveries it considers failed; skip ones already seen.
    if (id && id < this.offset) return true;
    if (id) this.offset = id + 1;
    void this.handle(record).catch(() => {});
    return true;
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        for (const update of await this.getUpdates()) {
          try {
            await this.handle(update);
          } catch {
            // keep polling through handler failures
          }
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as { ok?: boolean; description?: string; result?: unknown };
    if (!data.ok) throw new Error(`${method}: ${data.description ?? response.status}`);
    return data.result;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private async getUpdates(): Promise<Array<Record<string, unknown>>> {
    const response = await fetch(
      `${this.apiBase}/bot${this.token}/getUpdates?offset=${this.offset}&timeout=${this.pollTimeout}&allowed_updates=${encodeURIComponent('["message"]')}`,
    );
    const data = (await response.json()) as { ok?: boolean; description?: string; result?: Array<Record<string, unknown>> };
    if (!data.ok) throw new Error(data.description ?? "getUpdates failed");
    const updates = data.result ?? [];
    for (const update of updates) {
      this.offset = Math.max(this.offset, Number(update.update_id ?? 0) + 1);
    }
    return updates;
  }

  /**
   * Send `text`, split into several messages; `tag` prefixes every part after
   * the first. Task output is Markdown, rendered with Telegram's HTML parse
   * mode; if Telegram rejects the markup, the plain text is sent instead.
   */
  async send(chatId: string | number, text: string, tag?: string): Promise<void> {
    const parts = chunks(text);
    for (const [index, part] of parts.entries()) {
      const header = tag && index > 0 ? `${tag} (${index + 1}/${parts.length})\n` : "";
      if (!(await this.post(chatId, header + formatHtml(part), "HTML"))) {
        if (!(await this.post(chatId, header + part))) return;
      }
    }
  }

  /** Send the bot logo with an HTML caption; false when Telegram rejects it. */
  private async sendLogo(chatId: string | number, caption: string): Promise<boolean> {
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
      if (this.logoFileId) {
        form.append("photo", this.logoFileId);
      } else {
        const source = readTemplateAsset("loutre-tete.png");
        const png = new Uint8Array(source.length);
        png.set(source);
        form.append("photo", new Blob([png], { type: "image/png" }), "loutre-tete.png");
      }
      const response = await fetch(`${this.apiBase}/bot${this.token}/sendPhoto`, { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: { photo?: Array<{ file_id?: string }> };
      };
      if (!response.ok || data.ok === false) return false;
      const photos = data.result?.photo ?? [];
      this.logoFileId = photos[photos.length - 1]?.file_id ?? null;
      return true;
    } catch {
      return false;
    }
  }

  private async post(chatId: string | number, text: string, parseMode?: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBase}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          ...(parseMode ? { parse_mode: parseMode } : {}),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean };
      return response.ok && data.ok !== false;
    } catch {
      return false;
    }
  }

  private async handle(update: Record<string, unknown>): Promise<void> {
    const message = (update.message ?? {}) as Record<string, unknown>;
    const chat = (message.chat ?? {}) as Record<string, unknown>;
    const chatId = String(chat.id ?? "");
    const text = String(message.text ?? "").trim();
    if (!chatId || !text) return;
    if (!this.allowedChats.has(chatId)) return;

    const [rawCommand, ...restParts] = text.split(" ");
    const command = rawCommand.split("@")[0].toLowerCase();
    const rest = restParts.join(" ").trim();

    // A reply to one of this bot's task messages continues that conversation.
    const replyTo = (message.reply_to_message ?? null) as Record<string, unknown> | null;
    if (replyTo && !command.startsWith("/")) {
      const from = (replyTo.from ?? {}) as Record<string, unknown>;
      const taskId = String(replyTo.text ?? "").match(TASK_ID)?.[0];
      const task = taskId && String(from.id ?? "") === this.botId ? this.store.get(taskId) : null;
      if (task) {
        await this.followup(chatId, task, text);
        return;
      }
    }

    if (command === "/start") {
      // Brand the first contact with the logo; fall back to the plain help text.
      if (!(await this.sendLogo(chatId, formatHtml(this.help())))) await this.send(chatId, this.help());
    } else if (command === "/help") await this.send(chatId, this.help());
    else if (command === "/new") {
      if (!rest) await this.send(chatId, "Usage: /new <prompt>");
      else await this.create(chatId, rest);
    } else if (command === "/list") await this.list(chatId);
    else if (command === "/status") await this.status(chatId, rest);
    else if (command === "/cancel") await this.cancel(chatId, rest);
    else if (command === "/tools") await this.tools(chatId);
    else if (command === "/approve") await this.approve(chatId, rest);
    else if (command.startsWith("/")) await this.send(chatId, `Unknown command ${command}. Try /help.`);
    else await this.create(chatId, text);
  }

  private async create(chatId: string, prompt: string): Promise<void> {
    const task = this.runner.create(prompt, { origin: `telegram:${chatId}` });
    await this.send(chatId, `Queued ${task.id}\n${prompt.slice(0, 500)}`);
  }

  /** Continue `task`'s conversation: the prompt becomes the next turn of its thread. */
  private async followup(chatId: string, task: Task, prompt: string): Promise<void> {
    const root = rootId(task);
    const turns = this.store.thread(root);
    const running = turns.find((turn) => !isDone(turn));
    if (running) {
      await this.send(chatId, `${running.id} is still running; wait for it or /cancel ${running.id}.`);
      return;
    }
    const parent = turns[turns.length - 1] ?? task;
    const next = this.runner.create(prompt, {
      parent_id: parent.id,
      thread_id: root,
      model: parent.model,
      origin: `telegram:${chatId}`,
    });
    await this.send(chatId, `Queued ${next.id} (follow-up of ${root})\n${prompt.slice(0, 500)}`);
  }

  private async list(chatId: string): Promise<void> {
    const tasks = this.store.list(15);
    if (!tasks.length) {
      await this.send(chatId, "No tasks yet.");
      return;
    }
    await this.send(
      chatId,
      tasks.map((task) => `${task.id}  ${task.status.padEnd(9)}  ${task.prompt.slice(0, 60)}`).join("\n"),
    );
  }

  private async status(chatId: string, taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) {
      await this.send(chatId, `No task ${JSON.stringify(taskId)}.`);
      return;
    }
    await this.send(chatId, this.formatTask(task), task.id);
  }

  private async cancel(chatId: string, taskId: string): Promise<void> {
    if (!taskId) {
      await this.send(chatId, "Usage: /cancel <task-id>");
      return;
    }
    if (this.runner.cancel(taskId)) await this.send(chatId, `Cancelling ${taskId}.`);
    else await this.send(chatId, `${taskId} is unknown or already finished.`);
  }

  /** /tools: pending promotions + active global tools, concise (allowed chats only). */
  private async tools(chatId: string): Promise<void> {
    if (!this.registry) {
      await this.send(chatId, "Tool registry is not configured.");
      return;
    }
    const line = (id: string, name: string, extra: string): string => {
      const manifest = this.registry!.get(id);
      return `${id}  ${name}  ${manifest?.kind ?? "?"} v${manifest?.version ?? "?"}${extra}`;
    };
    const pending = this.registry.list({ status: "pending_approval" });
    const globals = this.registry.list({ scope: "global", status: "active" });
    const parts: string[] = [];
    parts.push(
      pending.length
        ? `Pending approval:\n${pending.map((index) => line(index.id, index.name, `\n  reason: ${index.promotion_reason ?? "(none)"}`)).join("\n")}`
        : "No tools pending approval.",
    );
    parts.push(
      globals.length
        ? `Active global tools:\n${globals.map((index) => line(index.id, index.name, "")).join("\n")}`
        : "No active global tools.",
    );
    parts.push("Approve with /approve <id> (or the /tools web page).");
    await this.send(chatId, parts.join("\n\n"));
  }

  /** /approve <id>: the same human-gated promotion path as POST /api/tools/:id/approve. */
  private async approve(chatId: string, id: string): Promise<void> {
    if (!this.registry) {
      await this.send(chatId, "Tool registry is not configured.");
      return;
    }
    if (!id) {
      await this.send(chatId, "Usage: /approve <tool-id>");
      return;
    }
    // Echo name + version BEFORE applying so the human sees exactly what is
    // being approved (the web UI sends expected_version for the same reason).
    const pending = this.registry.getIndex(id);
    if (pending) {
      await this.send(chatId, `Approving ${pending.name} v${pending.current_version} (${id})…`);
    }
    const outcome = approvePromotion(this.registry, id);
    if (!outcome.ok) {
      await this.send(chatId, `Not approved: ${outcome.error}`);
      return;
    }
    await this.send(chatId, `Approved ${id} (${outcome.index.name} v${outcome.index.current_version}): now active and global for new tasks.`);
  }

  /** Called by the runner whenever a task changes state. */
  async notify(task: Task): Promise<void> {
    if (!task.origin.startsWith("telegram:")) return;
    const chatId = task.origin.split(":", 2)[1];
    // The origin can come from the API or a schedule: only post to allowed chats.
    if (!this.allowedChats.has(chatId)) return;
    if (!isDone(task) || this.notified.has(task.id)) return;
    this.notified.add(task.id);
    await this.send(chatId, this.formatTask(task), task.id);
  }

  private formatTask(task: Task): string {
    let head = `${task.id}  ${task.status}`;
    if (task.exit_code !== null) head += `  (exit ${task.exit_code})`;
    if (task.schedule_id) head += `  [schedule ${task.schedule_id}]`;
    if (task.thread_id) head += `  [follow-up of ${task.thread_id}]`;
    let body = task.output.trim();
    if (task.error) body += `\n\nstderr:\n${task.error.trim()}`;
    return `${head}\n${task.prompt.slice(0, 300)}\n\n${body}`.trim();
  }

  private help(): string {
    return [
      "isidore - spawn isolated Pi tasks",
      "",
      "/new <prompt>   create a task (plain text also works)",
      "reply to a task message to continue that conversation",
      "/list           recent tasks",
      "/status <id>    task details and output",
      "/cancel <id>    cancel a task",
      "/tools          pending tool promotions + active global tools",
      "/approve <id>   approve a pending tool promotion (global scope)",
      "/help           this message",
    ].join("\n");
  }
}
