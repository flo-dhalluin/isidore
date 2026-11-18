/**
 * Tool registry: immutable per-version tool manifests under <stateDir>/tools.
 *
 * Layout (service-only; workers never read this tree — Landlock denies it):
 *   <root>/<id>/index.json            the ONLY mutable record per tool
 *   <root>/<id>/<version>/manifest.json   immutable once written
 *   <root>/<id>/<version>/files/<name>    immutable command/extension sources
 *
 * Versions are staged in <root>/<id>/.tmp-<rand> and renamed into place; an
 * existing version directory is never overwritten. Builtins (browser,
 * scheduler, and the informational extension entries) are generated in code
 * from the environment and NEVER persisted.
 *
 * Phase 1: store + builtins only. Nothing here is wired into the runner or
 * worker yet; ResolvedTool.cachePath stays null until the Phase 2 cache copy.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MAX_COMMAND_TIMEOUT_S,
  MAX_MANIFEST_BYTES,
  MAX_SOURCE_BYTES,
  MAX_TOOL_FILES,
  MAX_TOOLS_PER_CONVERSATION,
} from "./limits.ts";
import { newId, utcnow } from "./store.ts";

export type ToolKind = "mcp" | "command" | "extension";
export type ToolScope = "task" | "conversation" | "global";
export type ToolStatus = "active" | "disabled" | "pending_approval";

export interface ToolManifest {
  /** "tl_"+12hex for stored tools; "builtin:browser" etc. for builtins. */
  id: string;
  /** ^[a-z][a-z0-9_-]{0,63}$, unique among the owner's tools + globals + builtins. */
  name: string;
  /** Incrementing int, 1-based; each version is immutable. */
  version: number;
  kind: ToolKind;
  description: string;
  scope: ToolScope;
  status: ToolStatus;
  /** command tools: JSON Schema with type:"object" (required). */
  input_schema?: object;
  mcp?: { url: string; headers?: Record<string, string>; exposure?: "direct" | "codemode" | "deferred"; timeout?: number };
  /** argv entries may carry {{param}} templates bound to input_schema properties. */
  command?: { argv: string[]; files: Record<string, string>; timeout_seconds?: number };
  /** Relative module path; human-only kind. */
  extension?: { entry: string };
  provenance: { task_id: string | null; root_id: string | null; origin: string; created_at: string; sha256: string };
}

/** <root>/<id>/index.json — the only mutable record. */
export interface ToolIndex {
  id: string;
  name: string;
  scope: ToolScope;
  status: ToolStatus;
  owner_root_id: string | null;
  owner_task_id: string | null;
  current_version: number;
  versions: number[];
}

export interface ResolvedTool {
  manifest: ToolManifest;
  /** Phase 2 fills this with the read-only tool-cache copy; null in Phase 1. */
  cachePath: string | null;
}

/** Authoring input for create/update (scope and ownership come from the caller). */
export interface ToolInput {
  name: string;
  kind: ToolKind;
  description: string;
  input_schema?: object;
  mcp?: { url: string; headers?: Record<string, string>; exposure?: "direct" | "codemode" | "deferred"; timeout?: number };
  command?: { argv: string[]; files: Record<string, string>; timeout_seconds?: number };
  extension?: { entry: string };
}

/** Who owns a created tool; provenance is derived from this, never from input. */
export interface ToolOwner {
  scope: ToolScope;
  rootId: string | null;
  taskId: string | null;
  origin: string;
}

export interface ToolFilter {
  scope?: ToolScope;
  status?: ToolStatus;
  owner_root_id?: string | null;
  owner_task_id?: string | null;
}

/**
 * Names that would shadow Pi's own tools. Verified against the pinned
 * @earendil-works/pi-coding-agent: core tools are bash/read/edit/write/find/
 * grep/ls/powershell (Pi uses "find", not "glob"); the built-in extensions
 * register codemode and tool_search; "mcp" guards the MCP tool namespace.
 */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "find",
  "grep",
  "ls",
  "powershell",
  "codemode",
  "tool_search",
  "mcp",
]);

/** Builtin names are reserved even when the corresponding URL is unset. */
const BUILTIN_NAMES: ReadonlySet<string> = new Set(["browser", "scheduler", "tools", "codemode", "tool_search", "mcp"]);

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const TOOL_KINDS: ReadonlySet<string> = new Set(["mcp", "command", "extension"]);
const TOOL_STATUSES: ReadonlySet<string> = new Set(["active", "disabled", "pending_approval"]);
const MCP_EXPOSURES: ReadonlySet<string> = new Set(["direct", "codemode", "deferred"]);
/** Shell metacharacters (and whitespace) forbidden in a bare program name. */
const SHELL_METACHARS = /[|&;<>()$`\\"'*?[\]{}!#~=%\s]/;
const INPUT_KEYS: ReadonlySet<string> = new Set(["name", "kind", "description", "input_schema", "mcp", "command", "extension"]);
const MCP_KEYS: ReadonlySet<string> = new Set(["url", "headers", "exposure", "timeout"]);
/** RFC 7230 token: the only chars legal in an HTTP header name. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** JSON with recursively sorted object keys — stable provenance hashes. */
function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const record = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

/**
 * provenance.sha256: canonical JSON of {files:{name:sha256(content)}} for
 * command/extension (extension also pins its entry path), {url,headers} for mcp.
 */
function provenanceHash(input: ToolInput): string {
  if (input.kind === "mcp") {
    return sha256(canonicalJson({ url: input.mcp?.url ?? "", headers: input.mcp?.headers ?? {} }));
  }
  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(input.command?.files ?? {})) files[name] = sha256(content);
  if (input.kind === "extension") {
    return sha256(canonicalJson({ entry: input.extension?.entry ?? "", files }));
  }
  return sha256(canonicalJson({ files }));
}

/** Relative path only: no absolute paths, no ".."/"." segments, no backslashes. */
function assertRelativePath(name: string, label: string): void {
  if (typeof name !== "string" || name === "" || name.includes("\0")) {
    throw new Error(`${label}: empty or invalid path`);
  }
  if (name.startsWith("/") || name.includes("\\") || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`${label}: path must be relative (${name})`);
  }
  if (name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label}: path must not contain empty, "." or ".." segments (${name})`);
  }
}

function assertTimeout(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_COMMAND_TIMEOUT_S) {
    throw new Error(`${label}: timeout must be an integer in 1..${MAX_COMMAND_TIMEOUT_S} seconds`);
  }
}

/**
 * Reject $ref/$dynamicRef KEYS anywhere in the schema (Pi's registerTool cast
 * cannot resolve references). A recursive key walk, not a string search, so
 * description text merely mentioning "$ref" is accepted.
 */
function assertNoSchemaRefs(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSchemaRefs(item, where);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" || key === "$dynamicRef") {
      throw new Error(`input_schema must not contain ${key} (at ${where})`);
    }
    assertNoSchemaRefs(child, `${where}.${key}`);
  }
}

/**
 * Validate authoring input. Throws on any violation. Agent-supplied auth/oauth
 * fields are rejected (unknown keys anywhere in the mcp block or at the top
 * level); ${VAR} header templates are kept verbatim for Pi to expand.
 */
export function validateToolInput(input: ToolInput, opts: { allowExtension: boolean }): void {
  if (!input || typeof input !== "object") throw new Error("tool input must be an object");
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) throw new Error(`unknown tool field: ${key}`);
  }
  if (typeof input.name !== "string" || !NAME_RE.test(input.name)) {
    throw new Error("tool name must match ^[a-z][a-z0-9_-]{0,63}$");
  }
  if (typeof input.kind !== "string" || !TOOL_KINDS.has(input.kind)) {
    throw new Error(`tool kind must be one of mcp, command, extension`);
  }
  if (input.kind === "extension" && !opts.allowExtension) {
    throw new Error("extension tools are human-only");
  }
  if (typeof input.description !== "string" || input.description.trim() === "") {
    throw new Error("tool description must be a non-empty string");
  }

  if (input.input_schema !== undefined) {
    const schema = input.input_schema as Record<string, unknown>;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error("input_schema must be a JSON Schema object");
    }
    if (schema.type !== "object") throw new Error('input_schema must have type:"object"');
    if (schema.properties !== undefined && (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties))) {
      throw new Error("input_schema.properties must be an object");
    }
    // Plain schemas only: Pi's registerTool cast cannot resolve references.
    assertNoSchemaRefs(schema, "input_schema");
  }

  if (input.kind === "command") {
    if (!input.input_schema) throw new Error("command tools require an input_schema");
    const command = input.command;
    if (!command || typeof command !== "object") throw new Error("command tools require a command block");
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((a) => typeof a !== "string")) {
      throw new Error("command.argv must be a non-empty array of strings");
    }
    const program = command.argv[0];
    if (program === "" || program === "." || program === ".." || program.includes("/") || program.includes("{{") || SHELL_METACHARS.test(program)) {
      throw new Error("command.argv[0] must be a bare program name (no path, no shell metacharacters)");
    }
    const properties = ((input.input_schema as Record<string, unknown>).properties ?? {}) as Record<string, unknown>;
    for (const token of command.argv) {
      for (const match of token.matchAll(/\{\{([^{}]*)\}\}/g)) {
        if (!/^\w+$/.test(match[1]) || !(match[1] in properties)) {
          throw new Error(`argv placeholder {{${match[1]}}} must reference an input_schema property`);
        }
      }
      const stripped = token.replace(/\{\{[^{}]*\}\}/g, "");
      if (stripped.includes("{{") || stripped.includes("}}")) {
        throw new Error(`malformed argv placeholder in: ${token}`);
      }
    }
    const files = command.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      throw new Error("command.files must be an object mapping relative paths to source text");
    }
    const names = Object.keys(files);
    if (names.length > MAX_TOOL_FILES) throw new Error(`too many tool files (max ${MAX_TOOL_FILES})`);
    let total = 0;
    for (const [name, content] of Object.entries(files)) {
      assertRelativePath(name, "command.files");
      if (typeof content !== "string") throw new Error(`command.files[${name}] must be a string`);
      total += Buffer.byteLength(content, "utf8");
    }
    if (total > MAX_SOURCE_BYTES) throw new Error(`tool sources exceed ${MAX_SOURCE_BYTES} bytes`);
    if (command.timeout_seconds !== undefined) assertTimeout(command.timeout_seconds, "command.timeout_seconds");
  } else if (input.command !== undefined) {
    throw new Error("command block is only valid for command tools");
  }

  if (input.kind === "mcp") {
    const mcp = input.mcp;
    if (!mcp || typeof mcp !== "object") throw new Error("mcp tools require an mcp block");
    for (const key of Object.keys(mcp)) {
      // Rejects agent-supplied auth/oauth fields along with any other extras.
      if (!MCP_KEYS.has(key)) throw new Error(`unknown mcp field: ${key}`);
    }
    let url: URL;
    try {
      url = new URL(mcp.url);
    } catch {
      throw new Error("mcp.url must be a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("mcp.url must be http(s)");
    if (url.username || url.password) throw new Error("mcp.url must not embed credentials");
    if (mcp.headers !== undefined) {
      if (!mcp.headers || typeof mcp.headers !== "object" || Array.isArray(mcp.headers)) {
        throw new Error("mcp.headers must be an object");
      }
      for (const [name, value] of Object.entries(mcp.headers)) {
        if (!name || typeof value !== "string") throw new Error("mcp.headers must map names to string values");
        // Early authoring errors: header injection (CR/LF) and malformed names
        // are rejected here, not at connect time. ${VAR} placeholders in values
        // stay verbatim (Pi expands them); only control chars are forbidden.
        if (!HEADER_NAME_RE.test(name)) {
          throw new Error(`mcp.headers: "${name}" is not a valid HTTP header name (token chars only, no CR/LF)`);
        }
        if (/[\r\n\0]/.test(value)) {
          throw new Error(`mcp.headers[${name}]: value must not contain CR/LF or NUL`);
        }
      }
    }
    if (mcp.exposure !== undefined && !MCP_EXPOSURES.has(mcp.exposure)) {
      throw new Error("mcp.exposure must be direct, codemode or deferred");
    }
    if (mcp.timeout !== undefined) assertTimeout(mcp.timeout, "mcp.timeout");
  } else if (input.mcp !== undefined) {
    throw new Error("mcp block is only valid for mcp tools");
  }

  if (input.kind === "extension") {
    if (!input.extension || typeof input.extension !== "object") throw new Error("extension tools require an extension block");
    assertRelativePath(input.extension.entry, "extension.entry");
  } else if (input.extension !== undefined) {
    throw new Error("extension block is only valid for extension tools");
  }
}

const BROWSER_DESCRIPTION = "Headless Firefox: open pages, read and interact with them, fill forms, take screenshots";
const SCHEDULER_DESCRIPTION = "Schedule one-shot or recurring tasks that spawn isolated Pi agents";

function builtinProvenance(): ToolManifest["provenance"] {
  return { task_id: null, root_id: null, origin: "builtin", created_at: utcnow(), sha256: "" };
}

/**
 * Builtin manifests, generated in code and never persisted. browser/scheduler
 * are byte-equivalent to the legacy entrypoint.sh jq block: exposure direct,
 * timeouts 120/30, scheduler task-token + origin headers (Pi expands ${VAR}
 * from the worker env), browser without auth headers. Entries vanish when the
 * corresponding PI_SANDBOX_*_URL is unset. `port` is reserved for builtin:tools
 * (Phase 3); the codemode/tool_search/mcp entries are informational — the
 * worker already loads those extensions through the SDK factories.
 */
export function builtinManifests(env: NodeJS.ProcessEnv, port?: number): ToolManifest[] {
  void port;
  const manifests: ToolManifest[] = [];
  const browserUrl = env.PI_SANDBOX_BROWSER_URL;
  if (browserUrl) {
    manifests.push({
      id: "builtin:browser",
      name: "browser",
      version: 1,
      kind: "mcp",
      description: BROWSER_DESCRIPTION,
      scope: "global",
      status: "active",
      mcp: { url: browserUrl, exposure: "direct", timeout: 120 },
      provenance: { ...builtinProvenance(), sha256: sha256(canonicalJson({ url: browserUrl, headers: {} })) },
    });
  }
  const schedulerUrl = env.PI_SANDBOX_SCHEDULER_URL;
  if (schedulerUrl) {
    const headers = { "X-Isidore-Task-Token": "${ISIDORE_TASK_TOKEN}", "X-Isidore-Origin": "${ISIDORE_TASK_ORIGIN}" };
    manifests.push({
      id: "builtin:scheduler",
      name: "scheduler",
      version: 1,
      kind: "mcp",
      description: SCHEDULER_DESCRIPTION,
      scope: "global",
      status: "active",
      mcp: { url: schedulerUrl, headers, exposure: "direct", timeout: 30 },
      provenance: { ...builtinProvenance(), sha256: sha256(canonicalJson({ url: schedulerUrl, headers })) },
    });
  }
  const extensions: Array<[string, string]> = [
    ["codemode", "Built into the worker (createCodemodeExtension): run TypeScript against the tool API"],
    ["tool_search", "Built into the worker (createToolSearchExtension): search and load deferred tools"],
    ["mcp", "Built into the worker (createMcpExtension): connects the registered MCP servers"],
  ];
  for (const [name, description] of extensions) {
    manifests.push({
      id: `builtin:${name}`,
      name,
      version: 1,
      kind: "extension",
      description,
      scope: "global",
      status: "active",
      provenance: { ...builtinProvenance(), sha256: sha256(canonicalJson({ entry: "", files: {} })) },
    });
  }
  return manifests;
}

/**
 * In-memory index over the on-disk tool records, one directory per tool.
 * Sync fs, single process — same atomic-write pattern as TaskStore.
 */
export class ToolRegistry {
  private readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly port?: number;
  private readonly indexes = new Map<string, ToolIndex>();

  constructor(root: string, env: NodeJS.ProcessEnv = process.env, port?: number) {
    this.root = root;
    this.env = env;
    this.port = port;
    mkdirSync(this.root, { recursive: true });
    this.load();
  }

  private load(): void {
    for (const entry of readdirSync(this.root).sort()) {
      if (!entry.startsWith("tl_")) continue;
      const path = join(this.root, entry, "index.json");
      try {
        const index = JSON.parse(readFileSync(path, "utf8")) as ToolIndex;
        if (index && typeof index.id === "string" && Array.isArray(index.versions)) {
          // Harden path joins: only integer version numbers are usable.
          index.versions = index.versions.filter((version) => Number.isInteger(version));
          this.indexes.set(index.id, index);
        } else {
          console.error(`isidore: tool registry: skipping ${path}: invalid index shape`);
        }
      } catch (error) {
        // Unreadable/corrupt index: skip rather than fail startup, but say so.
        console.error(`isidore: tool registry: skipping ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private writeIndex(index: ToolIndex): void {
    const path = join(this.root, index.id, "index.json");
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(index, null, 2));
    renameSync(tmp, path);
  }

  /** Stage the whole version dir, then rename; refuse to overwrite (immutability). */
  private writeVersion(manifest: ToolManifest, files: Record<string, string>): void {
    const toolDir = join(this.root, manifest.id);
    mkdirSync(toolDir, { recursive: true });
    const final = join(toolDir, String(manifest.version));
    if (existsSync(final)) throw new Error(`version ${manifest.version} of ${manifest.id} already exists`);
    const stage = join(toolDir, `.tmp-${randomBytes(6).toString("hex")}`);
    mkdirSync(stage);
    try {
      writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
      for (const [name, content] of Object.entries(files)) {
        const path = join(stage, "files", name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      renameSync(stage, final);
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  }

  private assertManifestSize(manifest: ToolManifest): void {
    if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > MAX_MANIFEST_BYTES) {
      throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
  }

  private assertNameAvailable(name: string, owner: ToolOwner, excludeId: string | null): void {
    if (RESERVED_TOOL_NAMES.has(name) || BUILTIN_NAMES.has(name)) {
      throw new Error(`tool name "${name}" is reserved`);
    }
    for (const index of this.indexes.values()) {
      if (index.id === excludeId || index.name !== name) continue;
      const sameOwner =
        (owner.rootId !== null && index.owner_root_id === owner.rootId) ||
        (owner.taskId !== null && index.owner_task_id === owner.taskId);
      if (index.scope === "global" || sameOwner) {
        throw new Error(`tool name "${name}" already exists`);
      }
    }
  }

  create(input: ToolInput, owner: ToolOwner, opts: { allowExtension?: boolean } = {}): ToolManifest {
    validateToolInput(input, { allowExtension: opts.allowExtension ?? false });
    if (owner.scope === "conversation" && !owner.rootId) throw new Error("conversation scope requires a rootId");
    if (owner.scope === "task" && (!owner.rootId || !owner.taskId)) throw new Error("task scope requires rootId and taskId");
    this.assertNameAvailable(input.name, owner, null);
    if (owner.rootId) {
      const count = [...this.indexes.values()].filter((index) => index.owner_root_id === owner.rootId).length;
      if (count >= MAX_TOOLS_PER_CONVERSATION) {
        throw new Error(`conversation already has ${MAX_TOOLS_PER_CONVERSATION} tools`);
      }
    }
    const id = newId("tl");
    // Globals authored by agents await human approval; humans activate directly.
    const status: ToolStatus = owner.scope === "global" && owner.origin !== "human" ? "pending_approval" : "active";
    const manifest: ToolManifest = {
      id,
      name: input.name,
      version: 1,
      kind: input.kind,
      description: input.description,
      scope: owner.scope,
      status,
      ...(input.input_schema !== undefined ? { input_schema: input.input_schema } : {}),
      ...(input.mcp !== undefined ? { mcp: input.mcp } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.extension !== undefined ? { extension: input.extension } : {}),
      provenance: {
        task_id: owner.taskId,
        root_id: owner.rootId,
        origin: owner.origin,
        created_at: utcnow(),
        sha256: provenanceHash(input),
      },
    };
    this.assertManifestSize(manifest);
    this.writeVersion(manifest, input.command?.files ?? {});
    const index: ToolIndex = {
      id,
      name: input.name,
      scope: owner.scope,
      status,
      owner_root_id: owner.scope === "global" ? null : owner.rootId,
      owner_task_id: owner.scope === "task" ? owner.taskId : null,
      current_version: 1,
      versions: [1],
    };
    this.indexes.set(id, index);
    this.writeIndex(index);
    return manifest;
  }

  /** New immutable version; prior version dirs are never touched. */
  update(id: string, input: ToolInput, opts: { allowExtension?: boolean } = {}): ToolManifest {
    const index = this.indexes.get(id);
    if (!index) throw new Error(`unknown tool: ${id}`);
    const current = this.get(id);
    if (!current) throw new Error(`missing manifest for ${id}`);
    if (input.kind !== current.kind) throw new Error("tool kind cannot change between versions");
    validateToolInput(input, { allowExtension: opts.allowExtension ?? current.kind === "extension" });
    const owner: ToolOwner = {
      scope: index.scope,
      rootId: index.owner_root_id,
      taskId: index.owner_task_id,
      origin: current.provenance.origin,
    };
    if (input.name !== index.name) this.assertNameAvailable(input.name, owner, id);
    // Crash-window reconciliation: writeVersion renames the staged dir into
    // place BEFORE writeIndex records it, so a crash in between leaves an
    // orphaned <v>/ absent from index.versions. Adopt the on-disk numeric
    // version dirs and bump past their max instead of colliding forever.
    // Immutability holds: existing dirs are never rewritten (writeVersion
    // still refuses an existing final path as a backstop).
    let onDisk: number[] = [];
    try {
      onDisk = readdirSync(join(this.root, id)).filter((entry) => /^\d+$/.test(entry)).map(Number);
    } catch {
      // tool dir absent: nothing to reconcile (writeVersion recreates it)
    }
    for (const version of onDisk) {
      if (!index.versions.includes(version)) index.versions.push(version);
    }
    index.versions.sort((a, b) => a - b);
    const version = Math.max(0, ...index.versions) + 1;
    const manifest: ToolManifest = {
      ...current,
      name: input.name,
      version,
      scope: index.scope,
      status: index.status,
      description: input.description,
      input_schema: input.input_schema,
      mcp: input.mcp,
      command: input.command,
      extension: input.extension,
      provenance: { ...current.provenance, created_at: utcnow(), sha256: provenanceHash(input) },
    };
    // Drop keys the new version no longer carries (spread keeps undefined otherwise).
    for (const key of ["input_schema", "mcp", "command", "extension"] as const) {
      if (manifest[key] === undefined) delete manifest[key];
    }
    this.assertManifestSize(manifest);
    this.writeVersion(manifest, input.command?.files ?? {});
    index.name = input.name;
    index.current_version = version;
    index.versions.push(version);
    this.writeIndex(index);
    return manifest;
  }

  list(filter: ToolFilter = {}): ToolIndex[] {
    const indexes = [...this.indexes.values()].filter((index) =>
      (Object.keys(filter) as Array<keyof ToolFilter>).every((key) => filter[key] === undefined || index[key] === filter[key]),
    );
    indexes.sort((a, b) => (a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name)));
    return indexes;
  }

  /** Read an immutable manifest; defaults to the current version. */
  get(id: string, version?: number): ToolManifest | undefined {
    const index = this.indexes.get(id);
    if (!index) return undefined;
    const v = version ?? index.current_version;
    if (!index.versions.includes(v)) return undefined;
    try {
      return JSON.parse(readFileSync(join(this.root, id, String(v), "manifest.json"), "utf8")) as ToolManifest;
    } catch {
      return undefined;
    }
  }

  getIndex(id: string): ToolIndex | undefined {
    return this.indexes.get(id);
  }

  /**
   * Absolute path of a version's immutable source dir (<root>/<id>/<v>/files),
   * or null when the tool/version is unknown. Service-side only: the runner
   * copies from here into the per-conversation tool-cache at spawn (Phase 2).
   */
  filesDir(id: string, version?: number): string | null {
    const index = this.indexes.get(id);
    if (!index) return null;
    const v = version ?? index.current_version;
    if (!index.versions.includes(v)) return null;
    return join(this.root, id, String(v), "files");
  }

  setStatus(id: string, status: ToolStatus): boolean {
    if (!TOOL_STATUSES.has(status)) throw new Error(`invalid tool status: ${status}`);
    const index = this.indexes.get(id);
    if (!index) return false;
    index.status = status;
    this.writeIndex(index);
    return true;
  }

  /** Rollback (or roll-forward) to any recorded immutable version. */
  setCurrentVersion(id: string, version: number): boolean {
    const index = this.indexes.get(id);
    if (!index) return false;
    if (!index.versions.includes(version)) throw new Error(`version ${version} not recorded for ${id}`);
    index.current_version = version;
    this.writeIndex(index);
    return true;
  }

  remove(id: string): boolean {
    if (!this.indexes.delete(id)) return false;
    rmSync(join(this.root, id), { recursive: true, force: true });
    return true;
  }

  /** Conversation deletion cascade: indexes AND version dirs. */
  removeConversation(rootId: string): string[] {
    const removed: string[] = [];
    for (const index of this.list({ owner_root_id: rootId })) {
      if (this.remove(index.id)) removed.push(index.id);
    }
    return removed;
  }

  /**
   * Active globals + conversation-owned + task-owned tools, then pinned
   * inherited versions (exact immutable version, even if current_version moved
   * on), then builtins. disabled/pending_approval are excluded. Missing pins
   * are skipped and reported via the optional warnings array.
   *
   * Name uniqueness is per-owner, so duplicates can reach resolution (an
   * inherited pin, or a global created after a conversation tool of the same
   * name). Duplicate names are deduped by precedence — own-task >
   * own-conversation > inherited > global > builtin — keeping the first and
   * skipping later ones with a warning.
   */
  resolveFor(
    opts: { rootId: string | null; taskId: string | null; inherited?: Array<{ id: string; version: number }> },
    warnings: string[] = [],
  ): ResolvedTool[] {
    const resolved: ResolvedTool[] = [];
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    const rank = (index: ToolIndex): number => (index.scope === "task" ? 0 : index.scope === "conversation" ? 1 : 3);
    const active = this.list().filter(
      (index) =>
        index.status === "active" &&
        (index.scope === "global" ||
          (index.scope === "conversation" && opts.rootId !== null && index.owner_root_id === opts.rootId) ||
          (index.scope === "task" && opts.taskId !== null && index.owner_task_id === opts.taskId)),
    );
    // Stable sort: list() order (name, id) is kept within each precedence rank.
    active.sort((a, b) => rank(a) - rank(b));
    const push = (manifest: ToolManifest): void => {
      if (seenNames.has(manifest.name)) {
        warnings.push(`duplicate tool name "${manifest.name}": ${manifest.id} skipped in favour of a higher-precedence tool`);
        return;
      }
      seenNames.add(manifest.name);
      resolved.push({ manifest, cachePath: null });
    };
    for (const index of active) {
      const manifest = this.get(index.id);
      if (!manifest) {
        warnings.push(`tool ${index.id} has no readable manifest`);
        continue;
      }
      push(manifest);
      seenIds.add(index.id);
    }
    for (const pin of opts.inherited ?? []) {
      if (seenIds.has(pin.id)) continue;
      const index = this.indexes.get(pin.id);
      if (!index) {
        warnings.push(`pinned tool ${pin.id} no longer exists`);
        continue;
      }
      if (index.status !== "active") {
        warnings.push(`pinned tool ${pin.id} is ${index.status}`);
        continue;
      }
      const manifest = this.get(pin.id, pin.version);
      if (!manifest) {
        warnings.push(`pinned tool ${pin.id} version ${pin.version} is missing`);
        continue;
      }
      push(manifest);
      seenIds.add(pin.id);
    }
    for (const manifest of builtinManifests(this.env, this.port)) {
      push(manifest);
    }
    return resolved;
  }

  /** Current versions of a conversation's active tools, for pinning at spawn. */
  snapshotConversation(rootId: string): Array<{ id: string; version: number }> {
    return this.list({ owner_root_id: rootId, scope: "conversation", status: "active" }).map((index) => ({
      id: index.id,
      version: index.current_version,
    }));
  }
}
