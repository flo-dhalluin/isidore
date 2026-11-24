import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelCapabilities } from "../src/model-capabilities.ts";

const SAMPLE_CATALOG = {
  data: [
    { id: "qwen/qwen4-max", architecture: { input_modalities: ["text", "image", "video"] } },
    { id: "google/gemma-4-26b-a4b-it", architecture: { input_modalities: ["image", "text", "video"] } },
    { id: "~deepseek/deepseek-flash-latest", architecture: { input_modalities: ["text", "image"] } },
    { id: "meta/text-only-llama", architecture: { input_modalities: ["text"] } },
  ],
};

test("ModelCapabilities resolves exact and ~ alias ids and filters visionModels", async () => {
  const caps = new ModelCapabilities({
    fetchFn: (async () =>
      new Response(JSON.stringify(SAMPLE_CATALOG), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });

  // Never fetched -> fail closed (null).
  assert.equal(caps.hasCache(), false);
  assert.equal(caps.supportsVision("openrouter/qwen/qwen4-max"), null);
  assert.deepEqual(caps.visionModels(["openrouter/qwen/qwen4-max"]), []);

  assert.equal(await caps.refresh(), true);
  assert.equal(caps.hasCache(), true);

  assert.equal(caps.supportsVision("openrouter/qwen/qwen4-max"), true);
  assert.equal(caps.supportsVision("qwen/qwen4-max"), true);
  assert.equal(caps.supportsVision("openrouter/google/gemma-4-26b-a4b-it"), true);
  // Alias fallback (~ prefix)
  assert.equal(caps.supportsVision("openrouter/deepseek/deepseek-flash-latest"), true);
  assert.equal(caps.supportsVision("deepseek/deepseek-flash-latest"), true);
  // Known text-only
  assert.equal(caps.supportsVision("openrouter/meta/text-only-llama"), false);
  // Unknown model -> null
  assert.equal(caps.supportsVision("openrouter/unknown/model"), null);
  assert.equal(caps.supportsVision(null), null);

  assert.deepEqual(
    caps.visionModels([
      "openrouter/deepseek/deepseek-flash-latest",
      "openrouter/meta/text-only-llama",
      "openrouter/qwen/qwen4-max",
      "openrouter/unknown/model",
    ]),
    ["openrouter/deepseek/deepseek-flash-latest", "openrouter/qwen/qwen4-max"],
  );
});

test("ModelCapabilities serves stale cache on refresh error and refreshes lazily on TTL", async () => {
  let now = 1_000_000;
  let mode: "ok" | "fail" | "updated" = "ok";
  let fetches = 0;

  const caps = new ModelCapabilities({
    ttlMs: 1_000,
    retryCooldownMs: 0,
    nowFn: () => now,
    fetchFn: (async () => {
      fetches++;
      if (mode === "fail") return new Response("upstream down", { status: 503 });
      if (mode === "updated") {
        return new Response(
          JSON.stringify({ data: [{ id: "qwen/qwen4-max", architecture: { input_modalities: ["text"] } }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(SAMPLE_CATALOG), { status: 200 });
    }) as typeof fetch,
  });

  // Initial fetch fails -> remains unknown (fail closed).
  mode = "fail";
  assert.equal(await caps.ensureFresh(), false);
  assert.equal(caps.hasCache(), false);
  assert.equal(caps.supportsVision("openrouter/qwen/qwen4-max"), null);

  // Next fetch succeeds.
  mode = "ok";
  assert.equal(await caps.ensureFresh(), true);
  assert.equal(fetches, 2);
  assert.equal(caps.supportsVision("openrouter/qwen/qwen4-max"), true);

  // Within TTL -> does not fetch again.
  now += 500;
  assert.equal(await caps.ensureFresh(), true);
  assert.equal(fetches, 2);

  // Past TTL, fetch fails -> keeps serving stale cache.
  now += 1_000;
  mode = "fail";
  assert.equal(await caps.ensureFresh(), false);
  assert.equal(fetches, 3);
  assert.equal(caps.hasCache(), true);
  assert.equal(caps.supportsVision("openrouter/qwen/qwen4-max"), true);

  // Fetch recovers -> cache updates.
  mode = "updated";
  assert.equal(await caps.ensureFresh(), true);
  assert.equal(caps.supportsVision("openrouter/qwen/qwen4-max"), false);
});
