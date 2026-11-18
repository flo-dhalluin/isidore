/**
 * Real-binary tests for the Landlock launcher (isidore/sandbox).
 * The binary is built by `pretest` (make -C sandbox); these tests fail loudly
 * if it is absent — no skipping. Requires a kernel with Landlock ABI >= 4
 * (the launcher itself fails closed below that, which case 4 exercises).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildSandboxArgs } from "../src/runner.ts";

const BIN = join(import.meta.dirname, "..", "sandbox", "isidore-sandbox");
const RX = ["--rx", "/usr", "--rx", "/bin", "--rx", "/lib", "--rx", "/lib64", "--rx", "/etc"];

function sandbox(args: string[]): ReturnType<typeof spawnSync> {
  assert.ok(existsSync(BIN), `missing ${BIN} — run: make -C sandbox (npm pretest does this)`);
  return spawnSync(BIN, args, { encoding: "utf8", timeout: 20_000 });
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("1: allows exec and workspace writes", () => {
  const ws = tempDir("isidore-sb-ws-");
  try {
    const result = sandbox(["--rw", ws, ...RX, "--", "/bin/sh", "-c", `echo hi > ${join(ws, "ok")}`]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(ws, "ok"), "utf8"), "hi\n");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("2: denies reads and writes outside the allow-list", () => {
  const ws = tempDir("isidore-sb-ws-");
  const outside = tempDir("isidore-sb-out-");
  try {
    writeFileSync(join(outside, "secret.txt"), "top-secret");
    const script = [
      `if cat ${join(outside, "secret.txt")} 2>/dev/null; then echo read-leak; else echo read-denied; fi`,
      `if echo x > ${join(outside, "new.txt")} 2>/dev/null; then echo write-leak; else echo write-denied; fi`,
      // Sanity: allowed system paths still work.
      "cat /etc/hostname >/dev/null && echo etc-ok",
    ].join("\n");
    // The script redirects stderr to /dev/null, so it must be writable.
    const result = sandbox(["--rw", ws, ...RX, "--rw", "/dev/null", "--", "/bin/sh", "-c", script]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /read-denied/);
    assert.match(result.stdout, /write-denied/);
    assert.match(result.stdout, /etc-ok/);
    assert.ok(!result.stdout.includes("leak"));
    assert.ok(!existsSync(join(outside, "new.txt")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("3: denies symlink escapes out of the workspace", () => {
  const ws = tempDir("isidore-sb-ws-");
  const outside = tempDir("isidore-sb-out-");
  try {
    writeFileSync(join(outside, "secret.txt"), "top-secret");
    symlinkSync(outside, join(ws, "dirlink"));
    symlinkSync(join(outside, "secret.txt"), join(ws, "filelink"));
    const script = [
      `if cat ${join(ws, "dirlink", "secret.txt")} 2>/dev/null; then echo dir-leak; else echo dir-denied; fi`,
      `if cat ${join(ws, "filelink")} 2>/dev/null; then echo file-leak; else echo file-denied; fi`,
      `if echo x > ${join(ws, "dirlink", "new.txt")} 2>/dev/null; then echo write-leak; else echo write-denied; fi`,
    ].join("\n");
    // Same as case 2: the 2>/dev/null redirects need /dev/null writable.
    // (Without it dash still passes — redirection errors inside `if`
    // conditions are non-fatal — but the redirects silently fail.)
    const result = sandbox(["--rw", ws, ...RX, "--rw", "/dev/null", "--", "/bin/sh", "-c", script]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dir-denied/);
    assert.match(result.stdout, /file-denied/);
    assert.match(result.stdout, /write-denied/);
    assert.ok(!result.stdout.includes("leak"));
    assert.ok(!existsSync(join(outside, "new.txt")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("4: fails closed below the required ABI (--min-abi 99)", () => {
  const ws = tempDir("isidore-sb-ws-");
  try {
    const result = sandbox([
      "--rw", ws,
      ...RX,
      "--min-abi", "99",
      "--", "/bin/sh", "-c", `echo ran > ${join(ws, "marker")}`,
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(result.status, 126);
    assert.match(result.stderr, /isidore-sandbox:/);
    assert.match(result.stderr, /ABI/i);
    assert.ok(!existsSync(join(ws, "marker")), "command must never exec");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("5: cross-pid /proc environ is denied; own /proc/self works", () => {
  const ws = tempDir("isidore-sb-ws-");
  try {
    // buildSandboxArgs gives /proc a narrow allow-list: /proc/self (resolved
    // to the launcher pid, preserved across execv) plus global proc files.
    // The test runner pid is outside the sandbox domain, same uid.
    const base = buildSandboxArgs(ws, []);
    const denied = sandbox([...base, "--", "/bin/cat", `/proc/${process.pid}/environ`]);
    assert.notEqual(denied.status, 0, "cross-pid environ read must fail");
    assert.match(denied.stderr, /Permission denied/);
    const deniedMem = sandbox([...base, "--", "/bin/cat", `/proc/${process.pid}/mem`]);
    assert.notEqual(deniedMem.status, 0, "cross-pid mem read must fail");
    // Direct exec keeps the launcher pid, so /proc/self still resolves to the
    // rule added before exec.
    const own = sandbox([...base, "--", "/bin/cat", "/proc/self/cmdline"]);
    assert.equal(own.status, 0, own.stderr);
    assert.ok(own.stdout.length > 0);
    const meminfo = sandbox([...base, "--", "/bin/cat", "/proc/meminfo"]);
    assert.equal(meminfo.status, 0, meminfo.stderr);
    assert.match(meminfo.stdout, /MemTotal/);
    // Documented limitation (see buildSandboxArgs): a CHILD process (sh
    // forks+execs cat => new pid) cannot read its own /proc/self, because
    // the rule covers only the launcher's pid dir. Accepted trade-off: a
    // wholesale --ro /proc would expose /proc/<service-pid>/environ.
    // Two commands so dash cannot tail-exec-optimize into keeping the pid.
    const child = sandbox([...base, "--", "/bin/sh", "-c", "/bin/cat /proc/self/cmdline; echo rc=$?"]);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /rc=1/, "child /proc/self read is expected to fail (documented)");
    assert.match(child.stderr, /Permission denied/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("6: --connect-port allows the listed TCP port and denies others", async () => {
  const ws = tempDir("isidore-sb-ws-");
  const allowed: Server = createServer();
  const denied: Server = createServer();
  try {
    const listen = (server: Server): Promise<number> =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
      });
    const allowedPort = await listen(allowed);
    const deniedPort = await listen(denied);
    // Node lives outside /usr on dev hosts (fnm/nvm); allow its real dir.
    const nodeDir = dirname(realpathSync(process.execPath));
    const script = `
      const net = require("net");
      const tryConnect = (port) => new Promise((resolve) => {
        const s = net.connect(port, "127.0.0.1");
        s.on("connect", () => { s.end(); resolve("ok"); });
        s.on("error", (e) => resolve(e.code));
      });
      Promise.all([tryConnect(${allowedPort}), tryConnect(${deniedPort})]).then(([a, b]) => {
        console.log(JSON.stringify({ allowed: a, denied: b }));
        process.exit(a === "ok" && b === "EACCES" ? 0 : 1);
      });
    `;
    const result = sandbox([
      ...buildSandboxArgs(ws, []),
      "--rx", nodeDir,
      "--connect-port", String(allowedPort),
      "--", process.execPath, "-e", script,
    ]);
    assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { allowed: "ok", denied: "EACCES" });
  } finally {
    allowed.close();
    denied.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("launcher edge cases: missing workspace, missing command, unknown flag, optional paths", () => {
  const ws = tempDir("isidore-sb-ws-");
  try {
    const missingWs = sandbox(["--rw", join(ws, "does-not-exist"), "--", "/bin/true"]);
    assert.equal(missingWs.status, 126);
    assert.match(missingWs.stderr, /workspace/);

    const noCmd = sandbox(["--rw", ws]);
    assert.equal(noCmd.status, 126);

    const badFlag = sandbox(["--rw", ws, "--bogus", "--", "/bin/true"]);
    assert.equal(badFlag.status, 126);
    assert.match(badFlag.stderr, /unknown argument/);

    // Missing optional paths warn but do not fail; the command still runs.
    const optional = sandbox(["--rw", ws, "--rx", join(ws, "absent"), ...RX, "--", "/bin/sh", "-c", "echo optional-ok"]);
    assert.equal(optional.status, 0, optional.stderr);
    assert.match(optional.stdout, /optional-ok/);
    assert.match(optional.stderr, /warning: skipping/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
