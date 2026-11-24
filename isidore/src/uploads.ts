/**
 * Service-only store for user-uploaded images ("uploads").
 *
 * Mirrors src/artifacts.ts:
 *   <uploadsRoot>/_staging/<uploadId>        staged binary (pre-task)
 *   <uploadsRoot>/_staging/<uploadId>.json   staged Upload metadata
 *   <uploadsRoot>/<rootId>/<uploadId>        adopted immutable image per conversation
 *
 * Landlock never allow-lists <uploadsRoot>. The runner reads adopted files and
 * passes them to the worker as base64 over stdin (WorkerRequest.images).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_TURN, UPLOAD_STAGING_TTL_MS } from "./limits.ts";
import { newId, utcnow, type Upload } from "./store.ts";

export const ALLOWED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

const MIME_EXT: Readonly<Record<AllowedImageMime, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const UPLOAD_ID_RE = /^u_[0-9a-f]{12}$/;

export class UploadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

export function isValidUploadId(id: string): boolean {
  return UPLOAD_ID_RE.test(id);
}

/**
 * Sniff raster image format by magic bytes only (never trusts declared MIME).
 * Allows PNG, JPEG, GIF, WebP; rejects everything else (including SVG).
 */
export function sniffImageMime(buffer: Buffer): AllowedImageMime | null {
  if (buffer.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return "image/png";
    }
  }
  if (buffer.length >= 3) {
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
  }
  if (buffer.length >= 6) {
    // GIF87a or GIF89a
    const head = buffer.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") {
      return "image/gif";
    }
  }
  if (buffer.length >= 12) {
    // RIFF....WEBP
    if (
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
  }
  return null;
}

export function sanitizeUploadName(raw: string | undefined, mime: AllowedImageMime): string {
  const base = String(raw ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, "_").trim();
  const safe = cleaned === "." || cleaned === ".." ? "" : cleaned;
  if (safe) return safe.slice(0, 200);
  return `image.${MIME_EXT[mime]}`;
}

export const uploadStagingDir = (uploadsRoot: string): string => join(uploadsRoot, "_staging");

export const uploadPath = (uploadsRoot: string, root: string, uploadId: string): string =>
  join(uploadsRoot, root, uploadId);

/** Validate, sniff and stage one image upload in <uploadsRoot>/_staging/. */
export function stageUpload(uploadsRoot: string, buffer: Buffer, name?: string): Upload {
  if (buffer.byteLength === 0) {
    throw new UploadError(400, "empty image upload");
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new UploadError(413, `image exceeds ${MAX_UPLOAD_BYTES} byte limit`);
  }
  const contentType = sniffImageMime(buffer);
  if (!contentType) {
    throw new UploadError(400, "unsupported image format (allowed: PNG, JPEG, GIF, WebP)");
  }

  const upload: Upload = {
    id: newId("u"),
    name: sanitizeUploadName(name, contentType),
    size: buffer.byteLength,
    content_type: contentType,
    created_at: utcnow(),
  };

  const staging = uploadStagingDir(uploadsRoot);
  mkdirSync(staging, { recursive: true, mode: 0o700 });

  const dataPath = join(staging, upload.id);
  const dataTmp = join(staging, `.tmp-${upload.id}`);
  const metaPath = join(staging, `${upload.id}.json`);
  const metaTmp = join(staging, `.tmp-${upload.id}.json`);
  try {
    writeFileSync(dataTmp, buffer, { mode: 0o600 });
    renameSync(dataTmp, dataPath);
    writeFileSync(metaTmp, JSON.stringify(upload), { mode: 0o600 });
    renameSync(metaTmp, metaPath);
  } catch (error) {
    rmSync(dataTmp, { force: true });
    rmSync(metaTmp, { force: true });
    rmSync(dataPath, { force: true });
    rmSync(metaPath, { force: true });
    throw error;
  }

  return upload;
}

/** Delete one staged upload (used to roll back on failed multi-image batch). */
export function removeStagedUpload(uploadsRoot: string, uploadId: string): void {
  if (!isValidUploadId(uploadId)) return;
  const staging = uploadStagingDir(uploadsRoot);
  rmSync(join(staging, uploadId), { force: true });
  rmSync(join(staging, `${uploadId}.json`), { force: true });
}

/**
 * Move staged uploads into <uploadsRoot>/<root>/ (or reuse uploads already in
 * the same conversation when `existingInConversation` is passed for followups).
 * Validates ALL ids before moving any file.
 */
export function adoptUploads(
  uploadsRoot: string,
  root: string,
  ids: readonly string[],
  existingInConversation: readonly Upload[] = [],
): Upload[] {
  if (ids.length > MAX_UPLOADS_PER_TURN) {
    throw new UploadError(400, `too many images (max ${MAX_UPLOADS_PER_TURN} per turn)`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new UploadError(400, "duplicate upload id");
  }
  if (ids.length === 0) return [];

  const staging = uploadStagingDir(uploadsRoot);
  const existingMap = new Map(existingInConversation.map((u) => [u.id, u]));

  const plan: Array<
    | { kind: "staged"; upload: Upload; dataPath: string; metaPath: string }
    | { kind: "existing"; upload: Upload }
  > = [];

  for (const id of ids) {
    if (!isValidUploadId(id)) {
      throw new UploadError(400, `invalid upload id: ${id}`);
    }
    const dataPath = join(staging, id);
    const metaPath = join(staging, `${id}.json`);
    if (existsSync(dataPath) && existsSync(metaPath)) {
      let parsed: Upload;
      try {
        parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Upload;
      } catch {
        throw new UploadError(400, `corrupt staged upload metadata: ${id}`);
      }
      if (!parsed || parsed.id !== id) {
        throw new UploadError(400, `corrupt staged upload metadata: ${id}`);
      }
      plan.push({ kind: "staged", upload: parsed, dataPath, metaPath });
      continue;
    }

    const existing = existingMap.get(id);
    if (existing && existsSync(uploadPath(uploadsRoot, root, id))) {
      plan.push({ kind: "existing", upload: existing });
      continue;
    }

    throw new UploadError(400, `upload not found or out of scope: ${id}`);
  }

  const destDir = join(uploadsRoot, root);
  mkdirSync(destDir, { recursive: true, mode: 0o700 });

  for (const item of plan) {
    if (item.kind === "staged") {
      renameSync(item.dataPath, uploadPath(uploadsRoot, root, item.upload.id));
      rmSync(item.metaPath, { force: true });
    }
  }

  return plan.map((item) => item.upload);
}

/** Remove every uploaded image of a deleted conversation. */
export function removeConversationUploads(uploadsRoot: string, root: string): void {
  rmSync(join(uploadsRoot, root), { recursive: true, force: true });
}

/** Sweep expired staged uploads and orphaned .tmp-* files from _staging/. */
export function sweepUploadStaging(
  uploadsRoot: string,
  ttlMs = UPLOAD_STAGING_TTL_MS,
  now = Date.now(),
): number {
  const staging = uploadStagingDir(uploadsRoot);
  let entries: string[];
  try {
    entries = readdirSync(staging);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    const full = join(staging, entry);
    if (entry.startsWith(".tmp-")) {
      rmSync(full, { recursive: true, force: true });
      removed++;
      continue;
    }
    if (entry.endsWith(".json")) {
      const id = entry.slice(0, -".json".length);
      const dataPath = join(staging, id);
      let remove = !isValidUploadId(id) || !existsSync(dataPath);
      if (!remove) {
        try {
          if (now - statSync(full).mtimeMs > ttlMs) remove = true;
        } catch {
          remove = true;
        }
      }
      if (remove) {
        rmSync(full, { force: true });
        rmSync(dataPath, { force: true });
        removed++;
      }
      continue;
    }
    if (isValidUploadId(entry)) {
      const metaPath = join(staging, `${entry}.json`);
      let remove = !existsSync(metaPath);
      if (!remove) {
        try {
          if (now - statSync(full).mtimeMs > ttlMs) remove = true;
        } catch {
          remove = true;
        }
      }
      if (remove) {
        rmSync(full, { force: true });
        rmSync(metaPath, { force: true });
        removed++;
      }
    }
  }
  return removed;
}
