import type { Runner } from "./runner.ts";
import type { Task, TaskStore } from "./store.ts";

const MAX_MESSAGE = 3_800; // Telegram's hard limit is 4096; leave room for a header.

function chunks(text: string, size = MAX_MESSAGE): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length; i += size) result.push(text.slice(i, i + size));
  return result.length ? result : [""];
}

/** Optional Telegram front-end. Disabled unless a token is configured. */
export class TelegramBot {
  private readonly token: string;
  private readonly runner: Runner;
  private readonly store: TaskStore;
  private readonly allowedChats: Set<string>;
  private readonly apiBase: string;
  private readonly pollTimeout: number;
  private offset = 0;
  private stopped = false;

  constructor(
    token: string,
    runner: Runner,
    store: TaskStore,
    allowedChats: Set<string>,
    apiBase = "https://api.telegram.org",
    pollTimeout = 30,
  ) {
    this.token = token;
    this.runner = runner;
    this.store = store;
    this.allowedChats = allowedChats;
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.pollTimeout = pollTimeout;
  }

  async run(): Promise<void> {
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

  async send(chatId: string | number, text: string): Promise<void> {
    for (const chunk of chunks(text)) {
      try {
        await fetch(`${this.apiBase}/bot${this.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
        });
      } catch {
        return;
      }
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

    if (command === "/start" || command === "/help") await this.send(chatId, this.help());
    else if (command === "/new") {
      if (!rest) await this.send(chatId, "Usage: /new <prompt>");
      else await this.create(chatId, rest);
    } else if (command === "/list") await this.list(chatId);
    else if (command === "/status") await this.status(chatId, rest);
    else if (command === "/cancel") await this.cancel(chatId, rest);
    else if (command.startsWith("/")) await this.send(chatId, `Unknown command ${command}. Try /help.`);
    else await this.create(chatId, text);
  }

  private async create(chatId: string, prompt: string): Promise<void> {
    const task = this.runner.create(prompt, { origin: `telegram:${chatId}` });
    await this.send(chatId, `Queued ${task.id}\n${prompt.slice(0, 500)}`);
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
    await this.send(chatId, this.formatTask(task));
  }

  private async cancel(chatId: string, taskId: string): Promise<void> {
    if (!taskId) {
      await this.send(chatId, "Usage: /cancel <task-id>");
      return;
    }
    if (this.runner.cancel(taskId)) await this.send(chatId, `Cancelling ${taskId}.`);
    else await this.send(chatId, `${taskId} is unknown or already finished.`);
  }

  /** Called by the runner whenever a task changes state. */
  async notify(task: Task): Promise<void> {
    if (!task.origin.startsWith("telegram:")) return;
    const chatId = task.origin.split(":", 2)[1];
    if (task.status === "running" || task.status === "queued") return;
    await this.send(chatId, this.formatTask(task));
  }

  private formatTask(task: Task): string {
    let head = `${task.id}  ${task.status}`;
    if (task.exit_code !== null) head += `  (exit ${task.exit_code})`;
    let body = task.output.trim();
    if (task.error) body += `\n\nstderr:\n${task.error.trim()}`;
    return `${head}\n${task.prompt.slice(0, 300)}\n\n${body}`.trim();
  }

  private help(): string {
    return [
      "isidore - spawn isolated Pi tasks",
      "",
      "/new <prompt>   create a task (plain text also works)",
      "/list           recent tasks",
      "/status <id>    task details and output",
      "/cancel <id>    cancel a task",
      "/help           this message",
    ].join("\n");
  }
}
