/**
 * Agent-published files ("artifacts") for the task view.
 *
 * A task can only write inside its own workspace, so it cannot hand a file to
 * the user directly. The files MCP (files-mcp.ts) calls publishArtifact(): the
 * service validates that the path resolves inside the caller's workspace,
 * copies the bytes into the service-only artifact store, and records the
 * metadata on the task. The task view then renders a download link backed by
 * GET /api/tasks/<id>/artifacts/<artifact-id>.
 *
 * Layout (service-only; Landlock never allow-lists it):
 *   <artifactsRoot>/<rootId>/<artifactId>   one immutable file per artifact
 *
 * The copy is read through an O_NOFOLLOW descriptor and bounded by the size
 * seen at fstat time, so a task cannot turn the service into a confused deputy
 * for files outside its workspace (including the admin token and other
 * conversations' data).
 */
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACTS_PER_TASK } from "./limits.ts";
import { newId, rootId, utcnow, type Artifact, type TaskStore } from "./store.ts";

export interface PublishArtifactOptions {
  store: TaskStore;
  artifactsRoot: string;
  /** Root of the per-conversation workspaces (config.workspacesDir). */
  workspaceRoot: string;
  /** Task that called send_file (from the capability token scope). */
  taskId: string;
  /** Conversation root from the capability token scope. */
  rootId: string;
  /** Workspace-relative or absolute path inside the workspace. */
  filePath: string;
  /** Optional download filename; defaults to the source basename. */
  name?: string;
  /** Optional one-line note shown next to the download link. */
  description?: string;
}

/** One artifact's file in the service-only store. */
export const artifactPath = (artifactsRoot: string, root: string, artifactId: string): string =>
  join(artifactsRoot, root, artifactId);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  log: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xml: "application/xml",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  jsx: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8",
  sh: "text/plain; charset=utf-8",
  sql: "text/plain; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export function guessContentType(name: string): string {
  const extension = extname(name).toLowerCase().replace(/^\./, "");
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/** Strip directories/control characters so the name is safe to persist and echo. */
export function sanitizeArtifactName(raw: string): string {
  const base = String(raw).replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, "_").trim();
  const safe = cleaned === "." || cleaned === ".." ? "" : cleaned;
  return (safe || "artifact").slice(0, 200);
}

/** RFC 6266/5987 attachment header: ASCII fallback plus UTF-8 filename*. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  let encoded: string;
  try {
    encoded = encodeURIComponent(name);
  } catch {
    // Lone surrogates cannot be percent-encoded; the ASCII fallback is safe.
    encoded = encodeURIComponent(ascii);
  }
  encoded = encoded.replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${label} is longer than ${max} characters`);
  return trimmed || null;
}

/** Copy one workspace file into the artifact store and attach it to the task. */
export function publishArtifact(options: PublishArtifactOptions): Artifact {
  const task = options.store.get(options.taskId);
  if (!task) throw new Error("task not found");
  const root = rootId(task);
  if (root !== options.rootId) throw new Error("task is not part of this conversation");

  const workspace = join(options.workspaceRoot, root);
  let workspaceReal: string;
  try {
    workspaceReal = realpathSync(workspace);
  } catch {
    throw new Error("task workspace not found");
  }

  if (typeof options.filePath !== "string" || !options.filePath.trim()) throw new Error("path is required");
  if (options.filePath.length > 4096) throw new Error("path is too long");
  if (options.filePath.includes("\0")) throw new Error("path contains a NUL byte");

  const candidate = isAbsolute(options.filePath) ? options.filePath : resolve(workspace, options.filePath);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    throw new Error(`file not found: ${options.filePath}`);
  }
  const inside = relative(workspaceReal, resolved);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error("path is outside the task workspace");
  }

  // Validate everything that does not need the bytes before reading them.
  const existing = Array.isArray(task.artifacts) ? task.artifacts : [];
  if (existing.length >= MAX_ARTIFACTS_PER_TASK) {
    throw new Error(`too many files for this task (max ${MAX_ARTIFACTS_PER_TASK})`);
  }
  const rawName: unknown = options.name;
  if (rawName !== undefined && rawName !== null && typeof rawName !== "string") {
    throw new Error("name must be a string");
  }
  const name = sanitizeArtifactName(
    typeof rawName === "string" && rawName.trim() ? rawName : basename(resolved),
  );
  const description = optionalText(options.description, "description", 500);

  // Reject non-regular files BEFORE open: opening a FIFO read-only blocks until
  // a writer appears, which a task could use to stall the service. O_NONBLOCK
  // covers the swap race between this stat and the open.
  let before;
  try {
    before = statSync(resolved);
  } catch {
    throw new Error(`file not found: ${options.filePath}`);
  }
  if (!before.isFile()) throw new Error(`not a regular file: ${options.filePath}`);
  if (before.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`file is larger than ${formatBytes(MAX_ARTIFACT_BYTES)}`);
  }

  // O_NOFOLLOW closes the final-component swap race after realpath: a path
  // replaced by a symlink fails the open instead of being followed. (The
  // worker cannot rename the workspace itself; intermediate-component races
  // inside it are out of scope for this low-impact path.)
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let content: Buffer;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`not a regular file: ${options.filePath}`);
    if (stats.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`file is larger than ${formatBytes(MAX_ARTIFACT_BYTES)}`);
    }
    // Bound the read to the fstat size so a growing file cannot allocate more.
    const buffer = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < stats.size) {
      const read = readSync(fd, buffer, offset, stats.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    content = offset === stats.size ? buffer : buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }

  const artifact: Artifact = {
    id: newId("a"),
    name,
    description,
    size: content.byteLength,
    content_type: guessContentType(name),
    created_at: utcnow(),
  };

  const dir = join(options.artifactsRoot, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const finalPath = artifactPath(options.artifactsRoot, root, artifact.id);
  const stage = join(dir, `.tmp-${artifact.id}`);
  try {
    writeFileSync(stage, content, { mode: 0o600 });
    renameSync(stage, finalPath);
  } catch (error) {
    rmSync(stage, { force: true });
    throw error;
  }

  task.artifacts = [...existing, artifact];
  options.store.update(task);
  return artifact;
}

/** Remove every artifact file of a deleted conversation. */
export function removeConversationArtifacts(artifactsRoot: string, root: string): void {
  rmSync(join(artifactsRoot, root), { recursive: true, force: true });
}
