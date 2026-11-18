import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { generateAdminToken, tasksDir, workspacesDir, writeAdminToken, type Settings } from "./config.ts";
import { Runner } from "./runner.ts";
import { SchedulerClient } from "./scheduler.ts";
import { TelegramBot } from "./telegram.ts";
import { TaskStore, isDone, publicTask, rootId } from "./store.ts";
import { renderTemplate } from "./templates.ts";
import { TokenRegistry, type TaskScope } from "./tokens.ts";

const MAX_PROMPT = 100_000;

type Auth = { kind: "admin" } | { kind: "task"; scope: TaskScope } | null;

/** Constant-time string equality (length-guarded timingSafeEqual). */
function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Resolve the caller: the admin token (Bearer or `?token=`, the latter admin-only
 * for the UI) or a per-task capability token (Bearer only). No/invalid token =>
 * null (401). A task token is scoped to its conversation (rootId).
 */
function resolveAuth(request: FastifyRequest, adminToken: string, tokens: TokenRegistry): Auth {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const bearer = header.slice("Bearer ".length);
    if (secretEquals(bearer, adminToken)) return { kind: "admin" };
    const scope = tokens.resolve(bearer);
    if (scope) return { kind: "task", scope };
  }
  const queryToken = (request.query as { token?: string }).token;
  if (queryToken && secretEquals(queryToken, adminToken)) return { kind: "admin" };
  return null;
}

function deny(reply: FastifyReply): void {
  reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorised" });
}

function notFound(reply: FastifyReply): void {
  reply.code(404).send({ error: "not found" });
}

export async function createApp(settings: Settings): Promise<{ app: FastifyInstance; tokens: TokenRegistry }> {
  const tokens = new TokenRegistry();
  // Defense in depth: loadSettings always sets a token, but a programmatic/test
  // caller may pass null. Never run unauthenticated.
  let adminToken = settings.token;
  if (!adminToken) {
    adminToken = generateAdminToken();
    writeAdminToken(settings.stateDir, adminToken);
  }

  const store = new TaskStore(tasksDir(settings), settings.maxOutput);
  const scheduler = new SchedulerClient(settings.schedulerUrl, settings.schedulerToken, undefined, settings.schedulerTokenFile);
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
    tokens,
    sandboxBin: settings.sandboxBin,
    unsafeNoSandbox: settings.unsafeNoSandbox,
  });

  if (settings.telegramToken) {
    bot = new TelegramBot(settings.telegramToken, runner, store, settings.telegramChats, {
      webhookUrl: settings.telegramWebhookUrl,
      webhookSecret: settings.telegramWebhookSecret,
    });
    void bot.run();
  }

  const app = Fastify({ logger: true });

  // UI routes are admin-only; the token is never injected into the HTML (workers
  // share isidore's network namespace and could harvest it from loopback).
  app.get("/", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (auth?.kind !== "admin") return reply.code(401).type("text/plain").send("unauthorised");
    return reply.type("text/html").send(renderTemplate("index.html"));
  });

  app.get("/tasks/:taskId", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (auth?.kind !== "admin") return reply.code(401).type("text/plain").send("unauthorised");
    return reply.type("text/html").send(renderTemplate("task.html"));
  });

  // Telegram webhook: authenticated by the secret token Telegram echoes back,
  // not by ISIDORE_TOKEN, so a reverse proxy can expose just this path.
  app.post("/telegram/webhook", async (request, reply) => {
    if (!bot?.webhookUrl) return reply.code(404).send({ error: "not found" });
    const ok = bot.handleWebhook(request.headers["x-telegram-bot-api-secret-token"], request.body);
    if (!ok) return reply.code(401).send({ error: "unauthorised" });
    return reply.code(200).send({ ok: true });
  });

  app.get("/healthz", async () => ({ ok: true, tasks: store.count() }));

  app.get("/api/auth/whoami", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    if (auth.kind === "admin") return { admin: true };
    return { task_id: auth.scope.taskId, root_id: auth.scope.rootId, origin: auth.scope.origin };
  });

  app.get("/api/info", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    return {
      scheduler: scheduler.enabled,
      model: settings.model,
      max_workers: settings.maxWorkers,
      telegram: Boolean(settings.telegramToken),
      telegram_mode: bot?.mode ?? null,
    };
  });

  app.get("/api/tasks", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    const query = request.query as { limit?: string; status?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "100", 10) || 100, 1), 500);
    let tasks = store.list(limit, query.status);
    if (auth.kind === "task") tasks = tasks.filter((task) => rootId(task) === auth.scope.rootId);
    return tasks.map(publicTask);
  });

  app.post("/api/tasks", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "expected a JSON object" });
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });
    if (prompt.length > MAX_PROMPT) {
      return reply.code(413).send({ error: `prompt is longer than ${MAX_PROMPT} characters` });
    }
    const model = body.model ? String(body.model) : null;
    if (auth.kind === "task") {
      // A task can only spawn a follow-up turn of its own conversation; body
      // origin/schedule_id/parent fields are ignored.
      const task = runner.create(prompt, {
        parent_id: auth.scope.taskId,
        thread_id: auth.scope.rootId,
        origin: auth.scope.origin,
        model,
      });
      return reply.code(202).send(publicTask(task));
    }
    const task = runner.create(prompt, {
      model,
      origin: String(body.origin ?? "web"),
      schedule_id: body.schedule_id ? String(body.schedule_id) : null,
    });
    return reply.code(202).send(publicTask(task));
  });

  app.get("/api/tasks/:taskId", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    const task = store.get((request.params as { taskId: string }).taskId);
    if (!task) return notFound(reply);
    if (auth.kind === "task" && rootId(task) !== auth.scope.rootId) return notFound(reply);
    return publicTask(task);
  });

  app.delete("/api/tasks/:taskId", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    const task = store.get((request.params as { taskId: string }).taskId);
    if (!task) return notFound(reply);
    if (auth.kind === "task" && rootId(task) !== auth.scope.rootId) return notFound(reply);
    const turns = store.thread(rootId(task));
    if (turns.some((turn) => !isDone(turn))) {
      return reply.code(409).send({ error: "cannot delete a conversation while a turn is running" });
    }
    for (const turn of turns) store.remove(turn.id);
    rmSync(join(workspacesDir(settings), rootId(task)), { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.get("/api/tasks/:taskId/thread", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    const task = store.get((request.params as { taskId: string }).taskId);
    if (!task) return notFound(reply);
    if (auth.kind === "task" && rootId(task) !== auth.scope.rootId) return notFound(reply);
    const turns = store.thread(rootId(task));
    return { id: rootId(task), running: turns.some((turn) => !isDone(turn)), turns: turns.map(publicTask) };
  });

  app.post("/api/tasks/:taskId/followup", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    const parent = store.get((request.params as { taskId: string }).taskId);
    if (!parent) return notFound(reply);
    if (auth.kind === "task" && rootId(parent) !== auth.scope.rootId) return notFound(reply);
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
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    const id = (request.params as { taskId: string }).taskId;
    const task = store.get(id);
    if (!task) return notFound(reply);
    if (auth.kind === "task" && rootId(task) !== auth.scope.rootId) return notFound(reply);
    if (runner.cancel(id)) return { cancelled: id };
    return reply.code(409).send({ error: `task is already ${task.status}` });
  });

  app.get("/api/schedules", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    if (!scheduler.enabled) return reply.code(503).send({ error: "scheduler is not configured" });
    const conversationId = auth.kind === "task" ? auth.scope.rootId : null;
    try {
      return { schedules: await scheduler.list(conversationId) };
    } catch (error) {
      return reply.code(502).send({ error: String(error) });
    }
  });

  app.post("/api/schedules", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    if (!scheduler.enabled) return reply.code(503).send({ error: "scheduler is not configured" });
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "expected a JSON object" });
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });
    const conversationId = auth.kind === "task" ? auth.scope.rootId : null;
    try {
      const schedule = await scheduler.create(
        prompt,
        {
          at: body.at ? String(body.at) : null,
          every: (body.every as string | number | undefined) ?? null,
          model: body.model ? String(body.model) : null,
        },
        conversationId,
      );
      return reply.code(201).send(schedule);
    } catch (error) {
      return reply.code(502).send({ error: String(error) });
    }
  });

  app.delete("/api/schedules/:scheduleId", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    if (!scheduler.enabled) return reply.code(503).send({ error: "scheduler is not configured" });
    const conversationId = auth.kind === "task" ? auth.scope.rootId : null;
    try {
      await scheduler.cancel((request.params as { scheduleId: string }).scheduleId, conversationId);
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

  return { app, tokens };
}
