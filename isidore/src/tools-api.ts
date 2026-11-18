/**
 * Human admin surface for the tool registry (Phase 4): /api/tools REST routes
 * plus the shared approvePromotion() used by both the API and Telegram.
 *
 * EVERY route is ADMIN-ONLY: a task token (even the creator's own) gets 401,
 * never 404 — this surface is not part of the conversation-scoped API. Human
 * approval is the ONLY path that makes an agent-authored tool active+global:
 *
 *  - create:   ADMIN-ONLY human authoring (POST /api/tools). Accepts command,
 *    mcp AND extension tools (extension is human-only). Origin "human",
 *    scope global, status active immediately — no approval needed because a
 *    human is the author. Command/extension sources are staged into the
 *    tool-cache; per-conversation copies are staged at spawn.
 *  - approve:  pending_approval -> active AND scope global. Re-checks name
 *    collisions (incl. mcpNamespaceKey -/_ normalization) against ACTIVE
 *    globals + builtins (409 on collision), then activates + globalizes +
 *    clears creator ownership in ONE atomic index write (registry.approve).
 *    An optional expected_version guards review-time TOCTOU: if the creator
 *    updated the tool since the human reviewed it, approve returns 409.
 *  - reject:   pending_approval -> disabled. Scope and creator ownership are
 *    KEPT: the creator still sees/manages the tool and can update it and
 *    request promotion again; nothing becomes global without approval.
 *  - disable:  any status -> disabled (new spawns no longer resolve it).
 *  - enable:   disabled -> active, but a GLOBAL tool that still has creator
 *    ownership was never human-approved (approval clears ownership), so it
 *    cannot be enabled around the approval gate — it must be re-promoted
 *    (tool_request_promotion) and approved. Conversation/task-scoped tools
 *    enable normally.
 *  - rollback: current_version -> any recorded immutable version.
 *  - delete:   registry records + every tool-cache copy across ALL roots.
 *
 * Live state (scope/status/ownership) lives on the index; version manifests
 * are immutable. Responses overlay the live index state onto the CURRENT
 * manifest so clients see the effective scope/status; an explicit ?version=N
 * returns the immutable record verbatim (the index alongside carries live
 * state). Composition (registry.resolveFor) applies the same overlay, so the
 * worker registers approved tools whose manifests were born pending.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deny, resolveAuth } from "./auth.ts";
import { removeToolCacheCopies, stageToolCache } from "./tool-cache.ts";
import type { TokenRegistry } from "./tokens.ts";
import { withLiveState, type ResolvedTool, type ToolIndex, type ToolInput, type ToolKind, type ToolManifest, type ToolRegistry, type ToolScope, type ToolStatus } from "./tools.ts";

export interface ToolsApiOptions {
  registry: ToolRegistry;
  tokens: TokenRegistry;
  /** Effective admin token (createApp's generated fallback included). */
  adminToken: string;
  toolCacheRoot: string;
}

const SCOPES: ReadonlySet<string> = new Set(["task", "conversation", "global"]);
const STATUSES: ReadonlySet<string> = new Set(["active", "disabled", "pending_approval"]);

export type ApproveOutcome =
  | { ok: true; index: ToolIndex; manifest: ToolManifest | null }
  | { ok: false; status: number; error: string };

/**
 * The single human-gated promotion path, shared by POST /api/tools/:id/approve
 * and Telegram /approve. pending_approval -> active + global, ownership
 * cleared, name collisions re-checked against active globals + builtins.
 * expectedVersion (optional) pins the review: if the creator tool_update'd
 * the tool between human review and approval, current_version moved and the
 * approval is refused with 409 instead of activating unreviewed sources.
 */
export function approvePromotion(registry: ToolRegistry, id: string, expectedVersion?: number): ApproveOutcome {
  const index = registry.getIndex(id);
  if (!index) return { ok: false, status: 404, error: `unknown tool: ${id}` };
  if (index.status !== "pending_approval") {
    return { ok: false, status: 409, error: `tool ${id} is ${index.status}, not pending_approval` };
  }
  if (expectedVersion !== undefined && expectedVersion !== index.current_version) {
    return {
      ok: false,
      status: 409,
      error: `tool ${id} is now at version ${index.current_version}, not the reviewed version ${expectedVersion}; re-review before approving`,
    };
  }
  try {
    // Authoring allowed same-name pending globals in different conversations;
    // activation must not introduce a clash (exact or MCP-namespace -/_).
    registry.assertGlobalNameAvailable(index.name, id);
  } catch (error) {
    return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
  }
  // ONE atomic index write: active + global + unowned + reason cleared. A
  // crash can never leave an active global still owned by its creator.
  registry.approve(id);
  const updated = registry.getIndex(id)!;
  const manifest = registry.get(id);
  return { ok: true, index: updated, manifest: manifest ? withLiveState(manifest, updated) : null };
}

/** Admin gate: task tokens and missing/invalid tokens alike get 401. */
function adminOnly(request: FastifyRequest, reply: FastifyReply, opts: ToolsApiOptions): boolean {
  const auth = resolveAuth(request, opts.adminToken, opts.tokens);
  if (auth?.kind !== "admin") {
    deny(reply);
    return false;
  }
  return true;
}

function parseVersion(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const version = Number.parseInt(raw, 10);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

/** Flat authoring fields accepted by POST /api/tools (whitelist). */
const CREATE_ARGS: ReadonlySet<string> = new Set([
  "name",
  "kind",
  "description",
  "input_schema",
  "files",
  "url",
  "headers",
  "argv",
  "timeout_seconds",
  "scope",
  "exposure",
  "entry",
]);

export function registerToolsApi(app: FastifyInstance, opts: ToolsApiOptions): void {
  const { registry, toolCacheRoot } = opts;

  // Admin-only human authoring. This is the ONLY place extension tools can
  // be created (the agent MCP rejects them for every caller); humans also
  // author command/mcp globals here, active immediately (origin "human").
  app.post("/api/tools", async (request, reply) => {
    if (!adminOnly(request, reply, opts)) return;
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "body must be a JSON object" });
    }
    const args = body as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      if (!CREATE_ARGS.has(key)) return reply.code(400).send({ error: `unknown field: ${key}` });
    }
    const scope = args.scope ?? "global";
    if (scope !== "global") {
      return reply.code(400).send({ error: "admin creates global tools; conversation/task scope requires a task token" });
    }
    const kind = args.kind;
    if (kind !== "mcp" && kind !== "command" && kind !== "extension") {
      return reply.code(400).send({ error: "kind must be mcp, command or extension" });
    }
    const input: ToolInput = { name: args.name as string, kind: kind as ToolKind, description: args.description as string };
    if (args.input_schema !== undefined) input.input_schema = args.input_schema as object;
    if (kind === "command") {
      input.command = {
        argv: args.argv as string[],
        files: (args.files ?? {}) as Record<string, string>,
        ...(args.timeout_seconds !== undefined ? { timeout_seconds: args.timeout_seconds as number } : {}),
      };
    } else if (kind === "mcp") {
      input.mcp = {
        url: args.url as string,
        ...(args.headers !== undefined ? { headers: args.headers as Record<string, string> } : {}),
        ...(args.exposure !== undefined ? { exposure: args.exposure as "direct" | "codemode" | "deferred" } : {}),
        ...(args.timeout_seconds !== undefined ? { timeout: args.timeout_seconds as number } : {}),
      };
    } else {
      if (args.files === undefined) {
        return reply.code(400).send({ error: "extension tools require files (source modules) and entry" });
      }
      input.extension = { entry: args.entry as string };
      input.files = args.files as Record<string, string>;
    }
    let manifest: ToolManifest;
    try {
      // validateToolInput(allowExtension:true) runs inside create; provenance
      // and ownership come from the authenticated admin, never the body.
      manifest = registry.create(input, { scope: "global", rootId: null, taskId: null, origin: "human" }, { allowExtension: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /already exists|reserved|collides/.test(message) ? 409 : 400;
      return reply.code(status).send({ error: message });
    }
    // Stage a service-side cache copy for command/extension sources (under a
    // pseudo "admin" root); every conversation gets its own read-only copy at
    // spawn via the runner. Workers never read the admin copy.
    let cachePath: string | null = null;
    if (manifest.kind === "command" || manifest.kind === "extension") {
      const resolved: ResolvedTool[] = [{ manifest, cachePath: null }];
      stageToolCache(registry, toolCacheRoot, "admin", resolved);
      cachePath = resolved[0].cachePath;
    }
    const index = registry.getIndex(manifest.id)!;
    return reply.code(201).send({ index, manifest: withLiveState(manifest, index), cachePath });
  });

  app.get("/api/tools", async (request, reply) => {
    if (!adminOnly(request, reply, opts)) return;
    const query = request.query as { scope?: string; status?: string };
    if (query.scope !== undefined && !SCOPES.has(query.scope)) {
      return reply.code(400).send({ error: "scope must be task, conversation or global" });
    }
    if (query.status !== undefined && !STATUSES.has(query.status)) {
      return reply.code(400).send({ error: "status must be active, disabled or pending_approval" });
    }
    const filter: { scope?: ToolScope; status?: ToolStatus } = {};
    if (query.scope !== undefined) filter.scope = query.scope as ToolScope;
    if (query.status !== undefined) filter.status = query.status as ToolStatus;
    const tools = registry.list(filter).map((index) => {
      const manifest = registry.get(index.id);
      return { index, manifest: manifest ? withLiveState(manifest, index) : null };
    });
    return { tools };
  });

  app.get("/api/tools/:id", async (request, reply) => {
    if (!adminOnly(request, reply, opts)) return;
    const id = (request.params as { id: string }).id;
    const index = registry.getIndex(id);
    if (!index) return reply.code(404).send({ error: `unknown tool: ${id}` });
    const rawVersion = (request.query as { version?: string }).version;
    let version: number | undefined;
    if (rawVersion !== undefined) {
      const parsed = parseVersion(rawVersion);
      if (parsed === null) return reply.code(400).send({ error: "version must be a positive integer" });
      version = parsed;
    }
    const manifest = registry.get(id, version);
    if (!manifest) return reply.code(404).send({ error: `unknown tool version: ${id}@${version}` });
    // An explicit ?version=N is returned verbatim (the immutable record, even
    // when N is the current version); the response's index carries the live
    // state. Without the parameter the current manifest overlays live state.
    const historical = version !== undefined;
    return { index, manifest: historical ? manifest : withLiveState(manifest, index) };
  });

  app.post("/api/tools/:id/approve", async (request, reply) => {
    if (!adminOnly(request, reply, opts)) return;
    const body = (request.body ?? {}) as { expected_version?: unknown };
    let expectedVersion: number | undefined;
    if (body.expected_version !== undefined) {
      const raw = body.expected_version;
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
        return reply.code(400).send({ error: "expected_version must be a positive integer" });
      }
      expectedVersion = raw;
    }
    const outcome = approvePromotion(registry, (request.params as { id: string }).id, expectedVersion);
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    return { index: outcome.index, manifest: outcome.manifest };
  });

  app.post("/api/tools/:id/reject", async (request, reply) => {
    if (!adminOnly(request, reply, opts)) return;
    const id = (request.params as { id: string }).id;
    const index = registry.getIndex(id);
    if (!index) return reply.code(404).send({ error: `unknown tool: ${id}` });
    if (index.status !== "pending_approval") {
      return reply.code(409).send({ error: `tool ${id} is ${index.status}, not pending_approval` });
    }
    // Keep scope + creator ownership: the creator can revise and re-request
    // promotion; a rejected tool never becomes global on its own.
    registry.setStatus(id, "disabled");
    return { index: registry.getIndex(id) };
  });

  app.post("/api/tools/:id/disable", async (request, reply) => {
    if (!adminOnly(request, reply, opts)) return;
    const id = (request.params as { id: string }).id;
    const index = registry.getIndex(id);
    if (!index) return reply.code(404).send({ error: `unknown tool: ${id}` });
    if (index.status === "disabled") return reply.code(409).send({ error: `tool ${id} is already disabled` });
    registry.setStatus(id, "disabled");
    return { index: registry.getIndex(id) };
  });

  app.post("/api/tools/:id/enable", async (request, reply) => {
    if (!adminOnly(request, reply, opts)) return;
    const id = (request.params as { id: string }).id;
    const index = registry.getIndex(id);
    if (!index) return reply.code(404).send({ error: `unknown tool: ${id}` });
    if (index.status !== "disabled") {
      return reply.code(409).send({ error: `tool ${id} is ${index.status}, not disabled` });
    }
    // Approval gate: an active global is ALWAYS unowned (create/approve clear
    // ownership). A disabled global that still has an owner was never
    // human-approved (e.g. a rejected promotion) — enabling it would bypass
    // approval, so it must go through tool_request_promotion + approve.
    if (index.scope === "global" && (index.owner_root_id !== null || index.owner_task_id !== null)) {
      return reply.code(409).send({
        error: `tool ${id} is a global tool that was never approved; request promotion again and use approve`,
      });
    }
    registry.setStatus(id, "active");
    return { index: registry.getIndex(id) };
  });

  app.post("/api/tools/:id/rollback", async (request, reply) => {
    if (!adminOnly(request, reply, opts)) return;
    const id = (request.params as { id: string }).id;
    const index = registry.getIndex(id);
    if (!index) return reply.code(404).send({ error: `unknown tool: ${id}` });
    const body = request.body as { version?: unknown } | undefined;
    const version = body?.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
      return reply.code(400).send({ error: "version must be a positive integer" });
    }
    if (!index.versions.includes(version)) {
      return reply.code(400).send({ error: `version ${version} not recorded for ${id}` });
    }
    registry.setCurrentVersion(id, version);
    const updated = registry.getIndex(id)!;
    const manifest = registry.get(id);
    return { index: updated, manifest: manifest ? withLiveState(manifest, updated) : null };
  });

  app.delete("/api/tools/:id", async (request, reply) => {
    if (!adminOnly(request, reply, opts)) return;
    const id = (request.params as { id: string }).id;
    if (!registry.getIndex(id)) return reply.code(404).send({ error: `unknown tool: ${id}` });
    registry.remove(id);
    // Sweep EVERY conversation's cache copies (children may hold pinned ones).
    removeToolCacheCopies(toolCacheRoot, id);
    return reply.code(204).send();
  });
}
