import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tasksDir, workspacesDir, type Settings } from "./config.ts";
import { Runner } from "./runner.ts";
import { SchedulerClient } from "./scheduler.ts";
import { TelegramBot } from "./telegram.ts";
import { TaskStore, isDone, publicTask, rootId } from "./store.ts";
import { renderTemplate } from "./templates.ts";

const MAX_PROMPT = 100_000;

function authorised(request: FastifyRequest, token: string | null): boolean {
  if (!token) return true;
  if (request.headers.authorization === `Bearer ${token}`) return true;
  return (request.query as { token?: string }).token === token;
}

function deny(reply: FastifyReply): void {
  reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorised" });
}

export async function createApp(settings: Settings): Promise<{ app: FastifyInstance }> {
  const store = new TaskStore(tasksDir(settings), settings.maxOutput);
  const scheduler = new SchedulerClient(settings.schedulerUrl, settings.schedulerToken);
  let bot: TelegramBot | null = null;

  const runner = new Runner({
    store,
    workspaceRoot: workspacesDir(settings),
    workerScript: settings.workerScript,
    workerBin: settings.workerBin,
    maxWorkers: settings.maxWorkers,
    timeout: settings.timeout,
    model: settings.model,
    mode: settings.piMode,
    onChange: (task) => bot?.notify(task),
  });

  if (settings.telegramToken) {
    bot = new TelegramBot(settings.telegramToken, runner, store, settings.telegramChats);
    void bot.run();
  }

  const app = Fastify({ logger: true });

  app.get("/", async (request, reply) => {
    if (!authorised(request, settings.token)) return reply.code(401).type("text/plain").send("unauthorised");
    return reply.type("text/html").send(renderTemplate("index.html"));
  });

  app.get("/tasks/:taskId", async (request, reply) => {
    if (!authorised(request, settings.token)) return reply.code(401).type("text/plain").send("unauthorised");
    return reply.type("text/html").send(renderTemplate("task.html"));
  });

  app.get("/healthz", async () => ({ ok: true, tasks: store.count() }));

  app.get("/api/info", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    return {
      scheduler: scheduler.enabled,
      model: settings.model,
      max_workers: settings.maxWorkers,
      telegram: Boolean(settings.telegramToken),
    };
  });

  app.get("/api/tasks", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    const query = request.query as { limit?: string; status?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "100", 10) || 100, 1), 500);
    return store.list(limit, query.status).map(publicTask);
  });

  app.post("/api/tasks", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "expected a JSON object" });
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });
    if (prompt.length > MAX_PROMPT) {
      return reply.code(413).send({ error: `prompt is longer than ${MAX_PROMPT} characters` });
    }
    const task = runner.create(prompt, {
      model: body.model ? String(body.model) : null,
      origin: String(body.origin ?? "web"),
      schedule_id: body.schedule_id ? String(body.schedule_id) : null,
    });
    return reply.code(202).send(publicTask(task));
  });

  app.get("/api/tasks/:taskId", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    const task = store.get((request.params as { taskId: string }).taskId);
    if (!task) return reply.code(404).send({ error: "not found" });
    return publicTask(task);
  });

  app.delete("/api/tasks/:taskId", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    const task = store.get((request.params as { taskId: string }).taskId);
    if (!task) return reply.code(404).send({ error: "not found" });
    const turns = store.thread(rootId(task));
    if (turns.some((turn) => !isDone(turn))) {
      return reply.code(409).send({ error: "cannot delete a conversation while a turn is running" });
    }
    for (const turn of turns) store.remove(turn.id);
    rmSync(join(workspacesDir(settings), rootId(task)), { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.get("/api/tasks/:taskId/thread", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    const task = store.get((request.params as { taskId: string }).taskId);
    if (!task) return reply.code(404).send({ error: "not found" });
    const turns = store.thread(rootId(task));
    return { id: rootId(task), running: turns.some((turn) => !isDone(turn)), turns: turns.map(publicTask) };
  });

  app.post("/api/tasks/:taskId/followup", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    const parent = store.get((request.params as { taskId: string }).taskId);
    if (!parent) return reply.code(404).send({ error: "not found" });
    if (!isDone(parent)) return reply.code(409).send({ error: "the previous turn is still running" });
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "expected a JSON object" });
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });
    if (prompt.length > MAX_PROMPT) {
      return reply.code(413).send({ error: `prompt is longer than ${MAX_PROMPT} characters` });
    }
    const model = body.model ?? parent.model;
    const task = runner.create(prompt, {
      parent_id: parent.id,
      thread_id: rootId(parent),
      model: model ? String(model) : null,
      origin: parent.origin,
    });
    return reply.code(202).send(publicTask(task));
  });

  app.post("/api/tasks/:taskId/cancel", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    const id = (request.params as { taskId: string }).taskId;
    if (runner.cancel(id)) return { cancelled: id };
    const task = store.get(id);
    if (!task) return reply.code(404).send({ error: "not found" });
    return reply.code(409).send({ error: `task is already ${task.status}` });
  });

  app.get("/api/schedules", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    if (!scheduler.enabled) return reply.code(503).send({ error: "scheduler is not configured" });
    try {
      return { schedules: await scheduler.list() };
    } catch (error) {
      return reply.code(502).send({ error: String(error) });
    }
  });

  app.post("/api/schedules", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    if (!scheduler.enabled) return reply.code(503).send({ error: "scheduler is not configured" });
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "expected a JSON object" });
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });
    try {
      const schedule = await scheduler.create(prompt, {
        at: body.at ? String(body.at) : null,
        every: (body.every as string | number | undefined) ?? null,
        model: body.model ? String(body.model) : null,
      });
      return reply.code(201).send(schedule);
    } catch (error) {
      return reply.code(502).send({ error: String(error) });
    }
  });

  app.delete("/api/schedules/:scheduleId", async (request, reply) => {
    if (!authorised(request, settings.token)) return deny(reply);
    if (!scheduler.enabled) return reply.code(503).send({ error: "scheduler is not configured" });
    try {
      await scheduler.cancel((request.params as { scheduleId: string }).scheduleId);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(502).send({ error: String(error) });
    }
  });

  app.addHook("onClose", async () => {
    await bot?.stop();
    await runner.close();
    await scheduler.close();
  });

  return { app };
}
