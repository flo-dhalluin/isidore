import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SchedulerClient, SchedulerError } from "../src/scheduler.ts";

/** Stub fetch capturing request headers; returns a fixed JSON response. */
function stubFetch(status = 200): { calls: { url: string; headers: Record<string, string> }[]; restore: () => void } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    if (status >= 400) return new Response("unauthorised", { status });
    return new Response(JSON.stringify({ schedules: [] }), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("reads the token file per-request when no explicit token is set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-schedclient-"));
  const tokenFile = join(dir, "scheduler-token");
  writeFileSync(tokenFile, "first-token\n");
  const stub = stubFetch();
  try {
    const client = new SchedulerClient("http://scheduler.test", null, 10_000, tokenFile);
    await client.list();
    assert.equal(stub.calls[0].headers.authorization, "Bearer first-token");
    // A scheduler-regenerated token is picked up without recreating the client.
    writeFileSync(tokenFile, "second-token\n");
    await client.list("t_root");
    assert.equal(stub.calls[1].headers.authorization, "Bearer second-token");
    assert.equal(stub.calls[1].headers["x-isidore-conversation-id"], "t_root");
  } finally {
    stub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit token wins over the token file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-schedclient-"));
  const tokenFile = join(dir, "scheduler-token");
  writeFileSync(tokenFile, "file-token\n");
  const stub = stubFetch();
  try {
    const client = new SchedulerClient("http://scheduler.test", "env-token", 10_000, tokenFile);
    await client.list();
    assert.equal(stub.calls[0].headers.authorization, "Bearer env-token");
  } finally {
    stub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing token file: no auth header, scheduler 401 propagates as SchedulerError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-schedclient-"));
  const stub = stubFetch(401);
  try {
    const client = new SchedulerClient("http://scheduler.test", null, 10_000, join(dir, "absent-token"));
    await assert.rejects(client.list(), SchedulerError);
    assert.equal(stub.calls[0].headers.authorization, undefined);
    assert.match(stub.calls[0].url, /\/api\/schedules$/);
  } finally {
    stub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no token and no file: requests go out unauthenticated (scheduler decides)", async () => {
  const stub = stubFetch();
  try {
    const client = new SchedulerClient("http://scheduler.test");
    await client.list();
    assert.equal(stub.calls[0].headers.authorization, undefined);
  } finally {
    stub.restore();
  }
});

test("create forwards reply_to only when set", async () => {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any = {}) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "s_1" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new SchedulerClient("http://scheduler.test", "tok");
    await client.create("p", { at: "+1h", reply_to: "telegram:42" });
    await client.create("q", { at: "+1h" });
    await client.create("r", { at: "+1h", reply_to: null });
    assert.equal(bodies[0].reply_to, "telegram:42");
    assert.equal(bodies[1].reply_to, undefined);
    assert.equal(bodies[2].reply_to, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
