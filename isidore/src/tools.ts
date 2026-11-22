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
 * The runner composes each spawn from resolveFor() and copies command sources
 * into the read-only per-conversation tool-cache (tool-cache.ts). Live state
 * (scope/status/ownership/current version) lives ONLY on the index; version
 * manifests are immutable. Human approval (tools-api.ts) is the only path
 * that makes an agent-authored tool active+global.
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
  /** extension sources: relative path -> module text (command sources live in command.files). */
  files?: Record<string, string>;
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
  /** Agent's stated reason when it requested promotion (Phase 3); cleared on other status changes. */
  promotion_reason?: string;
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
  /** extension-only source files (relative path -> text); must include the entry. */
  files?: Record<string, string>;
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
const BUILTIN_NAMES: ReadonlySet<string> = new Set(["browser", "scheduler", "tools", "files", "codemode", "tool_search", "mcp"]);

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const TOOL_KINDS: ReadonlySet<string> = new Set(["mcp", "command", "extension"]);
const TOOL_SCOPES: ReadonlySet<string> = new Set(["task", "conversation", "global"]);
const TOOL_STATUSES: ReadonlySet<string> = new Set(["active", "disabled", "pending_approval"]);
const MCP_EXPOSURES: ReadonlySet<string> = new Set(["direct", "codemode", "deferred"]);
/** Shell metacharacters (and whitespace) forbidden in a bare program name. */
const SHELL_METACHARS = /[|&;<>()$`\\"'*?[\]{}!#~=%\s]/;
const INPUT_KEYS: ReadonlySet<string> = new Set(["name", "kind", "description", "input_schema", "mcp", "command", "extension", "files"]);
const MCP_KEYS: ReadonlySet<string> = new Set(["url", "headers", "exposure", "timeout"]);
/** RFC 7230 token: the only chars legal in an HTTP header name. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Pi's MCP namespace key, verified against the pinned SDK
 * (dist/core/mcp-servers.js: mcpNamespace = `mcp__${name.replace(/-/g, "_")}`).
 * Names are already lowercase (NAME_RE), so `-` -> `_` is the whole
 * normalization: "my-server" and "my_server" would share mcp__my_server and
 * pi.registerMcpServer throws on the clash. Used for authoring-time collision
 * checks so a clash can never reach spawn-time registration.
 */
export function mcpNamespaceKey(name: string): string {
  return name.replace(/-/g, "_");
}

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
  const sources = input.kind === "extension" ? (input.files ?? input.command?.files ?? {}) : (input.command?.files ?? {});
  for (const [name, content] of Object.entries(sources)) files[name] = sha256(content);
  if (input.kind === "extension") {
    return sha256(canonicalJson({ entry: input.extension?.entry ?? "", files }));
  }
  return sha256(canonicalJson({ files }));
}

/** Source-file map validation shared by command.files and extension files. */
function assertSourceFiles(files: unknown, label: string): Record<string, string> {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error(`${label} must be an object mapping relative paths to source text`);
  }
  const record = files as Record<string, unknown>;
  const names = Object.keys(record);
  if (names.length > MAX_TOOL_FILES) throw new Error(`too many tool files (max ${MAX_TOOL_FILES})`);
  let total = 0;
  for (const [name, content] of Object.entries(record)) {
    assertRelativePath(name, label);
    if (typeof content !== "string") throw new Error(`${label}[${name}] must be a string`);
    total += Buffer.byteLength(content, "utf8");
  }
  if (total > MAX_SOURCE_BYTES) throw new Error(`tool sources exceed ${MAX_SOURCE_BYTES} bytes`);
  return record as Record<string, string>;
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
    assertSourceFiles(command.files, "command.files");
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
    if (input.files !== undefined) {
      const files = assertSourceFiles(input.files, "files");
      // An extension whose entry is not among its sources could never load.
      if (!(input.extension.entry in files)) {
        throw new Error(`files must include the extension entry (${input.extension.entry})`);
      }
    }
  } else {
    if (input.extension !== undefined) throw new Error("extension block is only valid for extension tools");
    if (input.files !== undefined) throw new Error("files is only valid for extension tools (command sources live in command.files)");
  }
}

/**
 * Manifest with the LIVE index state overlaid. Version manifests are
 * immutable: they carry the scope/status as written at authoring time, which
 * goes stale as soon as the index changes (approval flips a pending global to
 * active+global; a version written while disabled carries status:"disabled").
 * Composition (resolveFor) and the admin API therefore overlay the index's
 * scope/status; provenance, version and everything else stay immutable.
 */
export function withLiveState(manifest: ToolManifest, index: ToolIndex): ToolManifest {
  return { ...manifest, scope: index.scope, status: index.status };
}

const BROWSER_DESCRIPTION = "Headless Firefox: open pages, read and interact with them, fill forms, take screenshots";
const SCHEDULER_DESCRIPTION = "Schedule one-shot or recurring tasks that spawn isolated Pi agents";
const TOOLS_DESCRIPTION =
  "Author and manage this conversation's tools: tool_create, tool_list, tool_get, tool_update, tool_disable, tool_remove, tool_request_promotion. New command/mcp tools are live in the same turn";
const FILES_DESCRIPTION =
  "Send files from this task's workspace to the user: send_file copies a file and adds a download link to the task view";

function builtinProvenance(): ToolManifest["provenance"] {
  return { task_id: null, root_id: null, origin: "builtin", created_at: utcnow(), sha256: "" };
}

/**
 * Builtin manifests, generated in code and never persisted. browser/scheduler
 * are byte-equivalent to the legacy entrypoint.sh jq block: exposure direct,
 * timeouts 120/30, scheduler task-token + origin headers (Pi expands ${VAR}
 * from the worker env), browser without auth headers. Entries vanish when the
 * corresponding PI_SANDBOX_*_URL is unset. builtin:tools (Phase 3) uses
 * ISIDORE_TOOLS_URL when set, else http://127.0.0.1:<port>/mcp/tools when a
 * port is given; builtin:files uses ISIDORE_FILES_URL, else the same host at
 * /mcp/files. With neither URL nor port those entries are omitted (bare
 * dev/test environments).
 * The codemode/tool_search/mcp entries are informational — the worker already
 * loads those extensions through the SDK factories.
 */
export function builtinManifests(env: NodeJS.ProcessEnv, port?: number): ToolManifest[] {
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
  const toolsUrl = env.ISIDORE_TOOLS_URL || (port !== undefined ? `http://127.0.0.1:${port}/mcp/tools` : undefined);
  if (toolsUrl) {
    const headers = { Authorization: "Bearer ${ISIDORE_TASK_TOKEN}" };
    manifests.push({
      id: "builtin:tools",
      name: "tools",
      version: 1,
      kind: "mcp",
      description: TOOLS_DESCRIPTION,
      scope: "global",
      status: "active",
      mcp: { url: toolsUrl, headers, exposure: "direct", timeout: 30 },
      provenance: { ...builtinProvenance(), sha256: sha256(canonicalJson({ url: toolsUrl, headers })) },
    });
  }
  const filesUrl = env.ISIDORE_FILES_URL || (port !== undefined ? `http://127.0.0.1:${port}/mcp/files` : undefined);
  if (filesUrl) {
    const headers = { Authorization: "Bearer ${ISIDORE_TASK_TOKEN}" };
    manifests.push({
      id: "builtin:files",
      name: "files",
      version: 1,
      kind: "mcp",
      description: FILES_DESCRIPTION,
      scope: "global",
      status: "active",
      mcp: { url: filesUrl, headers, exposure: "direct", timeout: 30 },
      provenance: { ...builtinProvenance(), sha256: sha256(canonicalJson({ url: filesUrl, headers })) },
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

  /**
   * Uniqueness among the names the owner will actually see at spawn: ACTIVE
   * globals + builtins + the same owner's tools (any status). A PENDING global
   * of another conversation is invisible to this owner and must not block its
   * names (no cross-conversation name squatting). Two conversations may hold
   * same-name pending globals; Phase 4 human approval MUST re-check name
   * collisions before activating a global.
   *
   * Also rejects MCP-namespace collisions (names differing only in `-`/`_`,
   * see mcpNamespaceKey): pi.registerMcpServer throws on those, which would
   * otherwise surface only at spawn time.
   */
  private assertNameAvailable(name: string, owner: ToolOwner, excludeId: string | null): void {
    if (RESERVED_TOOL_NAMES.has(name) || BUILTIN_NAMES.has(name)) {
      throw new Error(`tool name "${name}" is reserved`);
    }
    const normalized = mcpNamespaceKey(name);
    for (const builtin of BUILTIN_NAMES) {
      if (mcpNamespaceKey(builtin) === normalized) {
        throw new Error(`tool name "${name}" collides with builtin "${builtin}" after MCP namespace normalization (- and _ are equivalent)`);
      }
    }
    for (const index of this.indexes.values()) {
      if (index.id === excludeId) continue;
      const sameOwner =
        (owner.rootId !== null && index.owner_root_id === owner.rootId) ||
        (owner.taskId !== null && index.owner_task_id === owner.taskId);
      const visible = sameOwner || (index.scope === "global" && index.status === "active");
      if (!visible) continue;
      if (index.name === name) {
        throw new Error(`tool name "${name}" already exists`);
      }
      if (mcpNamespaceKey(index.name) === normalized) {
        throw new Error(`tool name "${name}" collides with "${index.name}" after MCP namespace normalization (- and _ are equivalent)`);
      }
    }
  }

  /**
   * Phase 4 approval re-check: the name must be free among ACTIVE globals +
   * builtins (with MCP-namespace normalization) right before a pending tool
   * becomes active+global. Two conversations may hold same-name pending
   * globals (no cross-conversation squatting at authoring time), so the
   * authoring-time check alone is not enough — approval re-checks and the
   * second approval of a colliding name is refused with 409.
   */
  assertGlobalNameAvailable(name: string, excludeId: string | null): void {
    if (RESERVED_TOOL_NAMES.has(name) || BUILTIN_NAMES.has(name)) {
      throw new Error(`tool name "${name}" is reserved`);
    }
    const normalized = mcpNamespaceKey(name);
    for (const builtin of BUILTIN_NAMES) {
      if (mcpNamespaceKey(builtin) === normalized) {
        throw new Error(`tool name "${name}" collides with builtin "${builtin}" after MCP namespace normalization (- and _ are equivalent)`);
      }
    }
    for (const index of this.indexes.values()) {
      if (index.id === excludeId) continue;
      if (!(index.scope === "global" && index.status === "active")) continue;
      if (index.name === name) {
        throw new Error(`tool name "${name}" already exists as an active global tool`);
      }
      if (mcpNamespaceKey(index.name) === normalized) {
        throw new Error(`tool name "${name}" collides with active global "${index.name}" after MCP namespace normalization (- and _ are equivalent)`);
      }
    }
  }

  create(
    input: ToolInput,
    owner: ToolOwner,
    opts: { allowExtension?: boolean; forcePendingApproval?: boolean } = {},
  ): ToolManifest {
    validateToolInput(input, { allowExtension: opts.allowExtension ?? false });
    if (owner.scope === "conversation" && !owner.rootId) throw new Error("conversation scope requires a rootId");
    if (owner.scope === "task" && (!owner.rootId || !owner.taskId)) throw new Error("task scope requires rootId and taskId");
    // Defense in depth: a global born pending_approval MUST keep creator
    // ownership. An unowned pending global, once rejected, would be a
    // disabled UNOWNED global that enable() could activate without approval.
    const bornPending = owner.scope === "global" && (owner.origin !== "human" || opts.forcePendingApproval);
    if (bornPending && (!owner.rootId || !owner.taskId)) {
      throw new Error("a pending global tool requires creator rootId and taskId (ownership is kept until human approval)");
    }
    this.assertNameAvailable(input.name, owner, null);
    // Quota counts ALL indexes owned by the conversation — including its
    // pending globals (ownership is kept until human approval), so pending
    // globals cannot be used to bypass the per-conversation limit.
    if (owner.rootId) {
      const count = [...this.indexes.values()].filter((index) => index.owner_root_id === owner.rootId).length;
      if (count >= MAX_TOOLS_PER_CONVERSATION) {
        throw new Error(`conversation already has ${MAX_TOOLS_PER_CONVERSATION} tools`);
      }
    }
    const id = newId("tl");
    // Globals authored by agents await human approval; humans activate
    // directly. forcePendingApproval lets the tools MCP force approval for
    // task callers even when their origin string happens to be "human" —
    // the FINAL status is written into the immutable version manifest once.
    const status: ToolStatus =
      owner.scope === "global" && (owner.origin !== "human" || opts.forcePendingApproval) ? "pending_approval" : "active";
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
    this.writeVersion(manifest, input.command?.files ?? input.files ?? {});
    // PENDING globals KEEP creator ownership: the creator can still see and
    // manage them (withdraw/update/disable/remove), they count against its
    // quota, and they stay invisible to every other conversation. Ownership
    // is cleared ONLY when a human approval makes the tool active+global
    // (registry.approve() does it atomically with activation). Active globals
    // are unowned.
    const pendingGlobal = owner.scope === "global" && status === "pending_approval";
    const index: ToolIndex = {
      id,
      name: input.name,
      scope: owner.scope,
      status,
      owner_root_id: owner.scope === "global" && !pendingGlobal ? null : owner.rootId,
      // Every OWNED tool (task, conversation, pending global) records the
      // authoring task, so reject/disable keep full ownership and the creator
      // can revise + re-promote. Only unowned active globals carry null.
      owner_task_id: owner.scope === "global" && !pendingGlobal ? null : owner.taskId,
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
    this.writeVersion(manifest, input.command?.files ?? input.files ?? {});
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
    // A promotion reason only makes sense while the tool awaits approval.
    if (status !== "pending_approval") delete index.promotion_reason;
    this.writeIndex(index);
    return true;
  }

  /**
   * Change the live scope (index only; version manifests stay immutable).
   * Phase 4's human approval uses this to make a pending tool global.
   */
  setScope(id: string, scope: ToolScope): boolean {
    if (!TOOL_SCOPES.has(scope)) throw new Error(`invalid tool scope: ${scope}`);
    const index = this.indexes.get(id);
    if (!index) return false;
    index.scope = scope;
    this.writeIndex(index);
    return true;
  }

  /**
   * Human approval (Phase 4): pending_approval -> active AND scope global AND
   * creator ownership cleared AND promotion reason dropped — in ONE atomic
   * index write. A multi-write sequence (setStatus -> setScope ->
   * clearOwnership) could crash mid-way and leave an active+global tool still
   * owned by its creator conversation (which would keep canMutate over a live
   * global). The caller (approvePromotion) re-checks name collisions first.
   */
  approve(id: string): boolean {
    const index = this.indexes.get(id);
    if (!index) return false;
    index.status = "active";
    index.scope = "global";
    index.owner_root_id = null;
    index.owner_task_id = null;
    delete index.promotion_reason;
    this.writeIndex(index);
    return true;
  }

  /**
   * Clear creator ownership on its own (tests/repair). Human approval uses
   * approve() instead, which clears ownership atomically with activation.
   */
  clearOwnership(id: string): boolean {
    const index = this.indexes.get(id);
    if (!index) return false;
    index.owner_root_id = null;
    index.owner_task_id = null;
    this.writeIndex(index);
    return true;
  }

  /**
   * Agent-requested promotion (Phase 3): pending_approval + the stated reason
   * recorded on the index for the human approval surface (Phase 4).
   */
  requestPromotion(id: string, reason: string): boolean {
    const index = this.indexes.get(id);
    if (!index) return false;
    index.status = "pending_approval";
    index.promotion_reason = reason;
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
      // Overlay the LIVE scope/status: the immutable manifest may carry a
      // stale authoring-time status (e.g. "pending_approval" for an approved
      // global, or "disabled" for a version written while rejected). The
      // worker's registration guards key off manifest.status, so without
      // this overlay approved tools would be composed but never registered.
      push(withLiveState(manifest, index));
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
      push(withLiveState(manifest, index));
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
