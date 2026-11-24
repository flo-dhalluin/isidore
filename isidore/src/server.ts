import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { createReadStream, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { artifactPath, contentDisposition, removeConversationArtifacts } from "./artifacts.ts";
import { deny, resolveAuth } from "./auth.ts";
import { artifactsDir, generateAdminToken, tasksDir, toolCacheDir, toolsDir, uploadsDir, workspacesDir, writeAdminToken, type Settings } from "./config.ts";
import { MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_TURN } from "./limits.ts";
import { ModelCapabilities } from "./model-capabilities.ts";
import { Runner } from "./runner.ts";
import { SchedulerClient } from "./scheduler.ts";
import { TelegramBot } from "./telegram.ts";
import { TaskStore, isDone, newId, publicTask, rootId, type Upload } from "./store.ts";
import { readTemplateAsset, renderTemplate } from "./templates.ts";
import { TokenRegistry } from "./tokens.ts";
import { ToolRegistry } from "./tools.ts";
import { removeToolCacheCopies } from "./tool-cache.ts";
import { registerToolsApi } from "./tools-api.ts";
import { registerToolsMcp } from "./tools-mcp.ts";
import { registerFilesMcp } from "./files-mcp.ts";
import {
  ALLOWED_IMAGE_MIMES,
  UploadError,
  adoptUploads,
  isValidUploadId,
  removeConversationUploads,
  stageUpload,
  sweepUploadStaging,
  uploadPath,
} from "./uploads.ts";

const MAX_PROMPT = 100_000;

function notFound(reply: FastifyReply): void {
  reply.code(404).send({ error: "not found" });
}

function parseUploadIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new UploadError(400, "uploads must be an array of upload ids");
  if (raw.length > MAX_UPLOADS_PER_TURN) {
    throw new UploadError(400, `too many images (max ${MAX_UPLOADS_PER_TURN} per turn)`);
  }
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !isValidUploadId(item)) {
      throw new UploadError(400, `invalid upload id: ${String(item)}`);
    }
    ids.push(item);
  }
  if (new Set(ids).size !== ids.length) {
    throw new UploadError(400, "duplicate upload id");
  }
  return ids;
}

export interface CreateAppOptions {
  capabilities?: ModelCapabilities;
}

export async function createApp(
  settings: Settings,
  options: CreateAppOptions = {},
): Promise<{ app: FastifyInstance; tokens: TokenRegistry; capabilities: ModelCapabilities }> {
  const tokens = new TokenRegistry();
  // Defense in depth: loadSettings always sets a token, but a programmatic/test
  // caller may pass null. Never run unauthenticated.
  let adminToken = settings.token;
  if (!adminToken) {
    adminToken = generateAdminToken();
    writeAdminToken(settings.stateDir, adminToken);
  }

  const store = new TaskStore(tasksDir(settings), settings.maxOutput);
  // Model whitelist (built-in MODEL_WHITELIST): empty means no restriction.
  // The default model is always part of the whitelist.
  const allowedModels = new Set(settings.models);
  const modelAllowed = (model: string): boolean => allowedModels.size === 0 || allowedModels.has(model);
  // Tool registry (Phase 2): the runner composes each task's tools at spawn
  // and copies command sources into the read-only per-conversation tool-cache.
  // env + port feed builtinManifests (builtin:tools URL fallback, Phase 3).
  const registry = new ToolRegistry(toolsDir(settings), process.env, settings.port);
  const toolCacheRoot = toolCacheDir(settings);
  const uploadsRoot = uploadsDir(settings);
  sweepUploadStaging(uploadsRoot);
  const capabilities = options.capabilities ?? new ModelCapabilities();
  if (!options.capabilities) {
    void capabilities.refresh();
  }
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
    registry,
    toolCacheRoot,
    toolsUrl: settings.toolsUrl,
    uploadsRoot,
  });

  if (settings.telegramToken) {
    bot = new TelegramBot(settings.telegramToken, runner, store, settings.telegramChats, {
      webhookUrl: settings.telegramWebhookUrl,
      webhookSecret: settings.telegramWebhookSecret,
      registry,
      uploadsRoot,
      capabilities,
      defaultModel: settings.model,
    });
    void bot.run();
  }

  const app = Fastify({ logger: true });

  for (const mime of [...ALLOWED_IMAGE_MIMES, "application/octet-stream"]) {
    app.addContentTypeParser(mime, { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
  }

  // Tools authoring MCP (Phase 3): stateless streamable-HTTP JSON-RPC, scoped
  // to the caller's conversation via the same resolveAuth as the REST API.
  registerToolsMcp(app, { registry, tokens, adminToken, toolCacheRoot });

  // Files MCP: send_file copies a workspace file into the service-only
  // artifact store and attaches a download link to the calling task.
  registerFilesMcp(app, {
    store,
    tokens,
    adminToken,
    workspaceRoot: workspacesDir(settings),
    artifactsRoot: artifactsDir(settings),
  });

  // Human admin surface (Phase 4): /api/tools is ADMIN-ONLY (task tokens get
  // 401). Approval here is the only path that makes a tool active+global.
  registerToolsApi(app, { registry, tokens, adminToken, toolCacheRoot });

  // Logo/favicon: public static assets (no secrets), so the browser can fetch
  // them without the admin token. Served from templates/ next to the pages.
  const logos = [
    ["loutre-tete.svg", "image/svg+xml"],
    ["loutre-tete.png", "image/png"],
  ] as const;
  for (const [name, type] of logos) {
    app.get(`/${name}`, async (_request, reply) => {
      return reply.type(type).header("cache-control", "public, max-age=86400").send(readTemplateAsset(name));
    });
  }

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

  app.get("/tools", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (auth?.kind !== "admin") return reply.code(401).type("text/plain").send("unauthorised");
    return reply.type("text/html").send(renderTemplate("tools.html"));
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
    void capabilities.ensureFresh();
    return {
      scheduler: scheduler.enabled,
      model: settings.model,
      default_model: settings.model,
      models: settings.models,
      vision_models: capabilities.visionModels(settings.models),
      max_workers: settings.maxWorkers,
      telegram: Boolean(settings.telegramToken),
      telegram_mode: bot?.mode ?? null,
    };
  });

  // Binary image upload (admin-only); sniffs magic bytes and stages into
  // <uploadsRoot>/_staging/<uploadId> before a turn references it.
  app.post(
    "/api/uploads",
    {
      bodyLimit: MAX_UPLOAD_BYTES,
      onRequest: async (request, reply) => {
        const auth = resolveAuth(request, adminToken, tokens);
        if (auth?.kind !== "admin") {
          deny(reply);
          return reply;
        }
      },
    },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ error: "expected a binary image body" });
      }
      const query = request.query as { name?: string };
      try {
        const upload = stageUpload(uploadsRoot, request.body, query.name);
        return reply.code(201).send(upload);
      } catch (error) {
        if (error instanceof UploadError) {
          return reply.code(error.status).send({ error: error.message });
        }
        throw error;
      }
    },
  );

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
    if (model && !modelAllowed(model)) {
      return reply.code(400).send({ error: `model not allowed: ${model}` });
    }
    let uploadIds: string[];
    try {
      uploadIds = parseUploadIds(body.uploads);
    } catch (error) {
      if (error instanceof UploadError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
    if (uploadIds.length > 0) {
      await capabilities.ensureFresh();
      const effectiveModel = model ?? settings.model;
      const vision = capabilities.supportsVision(effectiveModel);
      if (vision === false) {
        return reply.code(400).send({ error: `model does not support image inputs: ${effectiveModel}` });
      }
      if (vision === null) {
        return reply.code(503).send({ error: "model vision capabilities unavailable; cannot verify vision support" });
      }
    }
    if (auth.kind === "task") {
      // A task can only spawn a follow-up turn of its own conversation; body
      // origin/schedule_id/parent fields are ignored.
      let uploads: Upload[] = [];
      if (uploadIds.length > 0) {
        const existing = store.thread(auth.scope.rootId).flatMap((t) => (Array.isArray(t.uploads) ? t.uploads : []));
        try {
          uploads = adoptUploads(uploadsRoot, auth.scope.rootId, uploadIds, existing);
        } catch (error) {
          if (error instanceof UploadError) return reply.code(error.status).send({ error: error.message });
          throw error;
        }
      }
      const task = runner.create(prompt, {
        parent_id: auth.scope.taskId,
        thread_id: auth.scope.rootId,
        origin: auth.scope.origin,
        model,
        uploads,
      });
      return reply.code(202).send(publicTask(task));
    }
    // Lineage (Phase 3, admin/scheduler path ONLY): conversation_id spawns a
    // child that inherits the parent conversation's tools pinned at spawn.
    // The child is a NEW root with its OWN workspace (parent_id/thread_id
    // stay null); the task-token branch above never reads body.conversation_id.
    let conversationId: string | null = null;
    if (body.conversation_id !== undefined && body.conversation_id !== null && body.conversation_id !== "") {
      conversationId = String(body.conversation_id);
      if (store.thread(conversationId).length === 0) {
        return reply.code(404).send({ error: `unknown conversation: ${conversationId}` });
      }
    }
    const taskId = newId();
    let uploads: Upload[] = [];
    if (uploadIds.length > 0) {
      try {
        uploads = adoptUploads(uploadsRoot, taskId, uploadIds);
      } catch (error) {
        if (error instanceof UploadError) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    }
    const task = runner.create(prompt, {
      id: taskId,
      model,
      origin: String(body.origin ?? "web"),
      schedule_id: body.schedule_id ? String(body.schedule_id) : null,
      uploads,
      ...(conversationId !== null
        ? { inherited_from: conversationId, inherited_tools: registry.snapshotConversation(conversationId) }
        : {}),
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

  // Download one artifact published with send_file. Auth is the same as the
  // rest of the API; the task token scope keeps conversations isolated. The
  // response is always an attachment with nosniff, so agent-authored HTML/SVG
  // can never execute in the UI's origin.
  app.get("/api/tasks/:taskId/artifacts/:artifactId", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    const { taskId, artifactId } = request.params as { taskId: string; artifactId: string };
    const task = store.get(taskId);
    if (!task) return notFound(reply);
    if (auth.kind === "task" && rootId(task) !== auth.scope.rootId) return notFound(reply);
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
    const artifact = artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) return notFound(reply);
    const path = artifactPath(artifactsDir(settings), rootId(task), artifact.id);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return notFound(reply);
    }
    return reply
      .header("Content-Type", artifact.content_type || "application/octet-stream")
      .header("Content-Length", String(size))
      .header("Content-Disposition", contentDisposition(artifact.name))
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, max-age=3600")
      .send(createReadStream(path));
  });

  // Serve one user-uploaded image for a task turn. Auth and headers mirror the
  // artifact route (conversation-scoped, nosniff, attachment, private cache).
  app.get("/api/tasks/:taskId/uploads/:uploadId", async (request, reply) => {
    const auth = resolveAuth(request, adminToken, tokens);
    if (!auth) return deny(reply);
    const { taskId, uploadId } = request.params as { taskId: string; uploadId: string };
    const task = store.get(taskId);
    if (!task) return notFound(reply);
    if (auth.kind === "task" && rootId(task) !== auth.scope.rootId) return notFound(reply);
    const uploads = Array.isArray(task.uploads) ? task.uploads : [];
    const upload = uploads.find((entry) => entry.id === uploadId);
    if (!upload) return notFound(reply);
    const path = uploadPath(uploadsRoot, rootId(task), upload.id);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return notFound(reply);
    }
    return reply
      .header("Content-Type", upload.content_type || "application/octet-stream")
      .header("Content-Length", String(size))
      .header("Content-Disposition", contentDisposition(upload.name))
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, max-age=3600")
      .send(createReadStream(path));
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
    const root = rootId(task);
    for (const turn of turns) store.remove(turn.id);
    rmSync(join(workspacesDir(settings), root), { recursive: true, force: true });
    try {
      removeConversationArtifacts(artifactsDir(settings), root);
    } catch (error) {
      console.error(`isidore: artifact cleanup for ${root} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      removeConversationUploads(uploadsRoot, root);
    } catch (error) {
      console.error(`isidore: upload cleanup for ${root} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Cascade the conversation's tools: registry records (indexes + version
    // dirs) and its read-only tool-cache copies. Children may hold PINNED
    // cache copies of this conversation's tools under their own roots, so
    // sweep every removed tool across ALL roots (same as tools-mcp
    // tool_remove). Cleanup failures are logged but must never fail the
    // delete itself.
    try {
      const removed = registry.removeConversation(root);
      for (const id of removed) removeToolCacheCopies(toolCacheRoot, id);
    } catch (error) {
      console.error(`isidore: tool registry cleanup for ${root} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      rmSync(join(toolCacheRoot, root), { recursive: true, force: true });
    } catch (error) {
      console.error(`isidore: tool-cache cleanup for ${root} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    let model = body.model ?? parent.model;
    if (model && !modelAllowed(String(model))) {
      if (body.model) return reply.code(400).send({ error: `model not allowed: ${String(model)}` });
      // An inherited model that is no longer whitelisted falls back to the default.
      model = null;
    }
    const chosenModel = model ? String(model) : null;
    let uploadIds: string[];
    try {
      uploadIds = parseUploadIds(body.uploads);
    } catch (error) {
      if (error instanceof UploadError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
    let uploads: Upload[] = [];
    if (uploadIds.length > 0) {
      await capabilities.ensureFresh();
      const effectiveModel = chosenModel ?? settings.model;
      const vision = capabilities.supportsVision(effectiveModel);
      if (vision === false) {
        return reply.code(400).send({ error: `model does not support image inputs: ${effectiveModel}` });
      }
      if (vision === null) {
        return reply.code(503).send({ error: "model vision capabilities unavailable; cannot verify vision support" });
      }
      const existing = store.thread(rootId(parent)).flatMap((t) => (Array.isArray(t.uploads) ? t.uploads : []));
      try {
        uploads = adoptUploads(uploadsRoot, rootId(parent), uploadIds, existing);
      } catch (error) {
        if (error instanceof UploadError) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    }
    const task = runner.create(prompt, {
      parent_id: parent.id,
      thread_id: rootId(parent),
      model: chosenModel,
      origin: parent.origin,
      uploads,
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
    const model = body.model ? String(body.model) : null;
    if (model && !modelAllowed(model)) {
      return reply.code(400).send({ error: `model not allowed: ${model}` });
    }
    const conversationId = auth.kind === "task" ? auth.scope.rootId : null;
    try {
      const schedule = await scheduler.create(
        prompt,
        {
          at: body.at ? String(body.at) : null,
          every: (body.every as string | number | undefined) ?? null,
          model,
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
    if (!options.capabilities) capabilities.close();
    await bot?.stop();
    await runner.close();
    await scheduler.close();
  });

  return { app, tokens, capabilities };
}
