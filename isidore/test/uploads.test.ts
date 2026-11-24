import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_TURN } from "../src/limits.ts";
import {
  UploadError,
  adoptUploads,
  removeConversationUploads,
  sniffImageMime,
  stageUpload,
  sweepUploadStaging,
  uploadPath,
  uploadStagingDir,
} from "../src/uploads.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF89 = Buffer.from("GIF89a\x01\x00\x01\x00", "ascii");
const GIF87 = Buffer.from("GIF87a\x01\x00\x01\x00", "ascii");
const WEBP = Buffer.from("RIFF\x24\x00\x00\x00WEBP", "ascii");

test("sniffImageMime recognizes PNG, JPEG, GIF, WebP and rejects SVG/text/empty", () => {
  assert.equal(sniffImageMime(PNG), "image/png");
  assert.equal(sniffImageMime(JPEG), "image/jpeg");
  assert.equal(sniffImageMime(GIF89), "image/gif");
  assert.equal(sniffImageMime(GIF87), "image/gif");
  assert.equal(sniffImageMime(WEBP), "image/webp");

  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  assert.equal(sniffImageMime(Buffer.from("hello world")), null);
  assert.equal(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImageMime(Buffer.from("RIFF\x00\x00\x00\x00WAVE")), null);
});

test("stageUpload validates empty, oversize, and disguised SVG", () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-uploads-"));
  try {
    assert.throws(() => stageUpload(dir, Buffer.alloc(0)), (e: unknown) => e instanceof UploadError && e.status === 400);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.throws(() => stageUpload(dir, svg, "evil.png"), (e: unknown) => e instanceof UploadError && e.status === 400);

    const tooBig = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES + 1 - PNG.length)]);
    assert.throws(() => stageUpload(dir, tooBig, "big.png"), (e: unknown) => e instanceof UploadError && e.status === 413);

    const staged = stageUpload(dir, PNG, "../dir/pic\x00.png");
    assert.match(staged.id, /^u_[0-9a-f]{12}$/);
    assert.equal(staged.name, "pic_.png");
    assert.equal(staged.content_type, "image/png");
    assert.equal(staged.size, PNG.byteLength);
    assert.ok(existsSync(join(uploadStagingDir(dir), staged.id)));
    assert.ok(existsSync(join(uploadStagingDir(dir), `${staged.id}.json`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adoptUploads enforces count, duplicates, scope, and atomic rollback", () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-uploads-"));
  try {
    const ids = Array.from({ length: MAX_UPLOADS_PER_TURN + 1 }, (_, i) => stageUpload(dir, PNG, `p${i}.png`).id);
    assert.throws(
      () => adoptUploads(dir, "t_aaaaaaaaaaaa", ids),
      (e: unknown) => e instanceof UploadError && e.status === 400 && /too many images/.test(e.message),
    );

    // Duplicate IDs refused before moving anything.
    assert.throws(
      () => adoptUploads(dir, "t_aaaaaaaaaaaa", [ids[0], ids[0]]),
      (e: unknown) => e instanceof UploadError && e.status === 400 && /duplicate/.test(e.message),
    );

    // Invalid second ID leaves first ID untouched in staging.
    assert.throws(
      () => adoptUploads(dir, "t_aaaaaaaaaaaa", [ids[0], "u_000000000000"]),
      (e: unknown) => e instanceof UploadError && e.status === 400,
    );
    assert.ok(existsSync(join(uploadStagingDir(dir), ids[0])));

    // Successful adoption into conversation A.
    const adopted = adoptUploads(dir, "t_aaaaaaaaaaaa", [ids[0], ids[1]]);
    assert.equal(adopted.length, 2);
    assert.ok(!existsSync(join(uploadStagingDir(dir), ids[0])));
    assert.ok(!existsSync(join(uploadStagingDir(dir), `${ids[0]}.json`)));
    assert.deepEqual(readFileSync(uploadPath(dir, "t_aaaaaaaaaaaa", ids[0])), PNG);

    // Cross-conversation reuse of A's upload ID is refused for B.
    assert.throws(
      () => adoptUploads(dir, "t_bbbbbbbbbbbb", [ids[0]]),
      (e: unknown) => e instanceof UploadError && e.status === 400,
    );

    // Same-conversation followup reuse is allowed when existing metadata is passed.
    const reused = adoptUploads(dir, "t_aaaaaaaaaaaa", [ids[0], ids[2]], adopted);
    assert.equal(reused.length, 2);
    assert.equal(reused[0].id, ids[0]);
    assert.equal(reused[1].id, ids[2]);

    // Deleting conversation removes only its uploads.
    adoptUploads(dir, "t_bbbbbbbbbbbb", [ids[3]]);
    removeConversationUploads(dir, "t_aaaaaaaaaaaa");
    assert.ok(!existsSync(join(dir, "t_aaaaaaaaaaaa")));
    assert.ok(existsSync(uploadPath(dir, "t_bbbbbbbbbbbb", ids[3])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepUploadStaging removes expired staged uploads and .tmp orphans, keeps fresh ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-uploads-"));
  try {
    const expired = stageUpload(dir, PNG, "old.png");
    const fresh = stageUpload(dir, JPEG, "new.jpg");
    const staging = uploadStagingDir(dir);

    const now = Date.now();
    const oldTime = new Date(now - 2 * 60 * 60 * 1000);
    utimesSync(join(staging, expired.id), oldTime, oldTime);
    utimesSync(join(staging, `${expired.id}.json`), oldTime, oldTime);

    // Orphaned .tmp-* and orphaned .json
    mkdirSync(join(staging, ".tmp-partial"), { recursive: true });
    writeFileSync(join(staging, "u_deadbeef1234.json"), "{}");

    const removed = sweepUploadStaging(dir, 60 * 60 * 1000, now);
    assert.ok(removed >= 3);
    assert.ok(!existsSync(join(staging, expired.id)));
    assert.ok(!existsSync(join(staging, `${expired.id}.json`)));
    assert.ok(!existsSync(join(staging, ".tmp-partial")));
    assert.ok(!existsSync(join(staging, "u_deadbeef1234.json")));
    assert.ok(existsSync(join(staging, fresh.id)));
    assert.ok(existsSync(join(staging, `${fresh.id}.json`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
