import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSettings } from "../src/config.ts";
import { DEFAULT_MODEL, MODEL_WHITELIST } from "../src/models.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadSettings uses the built-in model whitelist and default", () => {
  const dir = mkdtempSync(join(tmpdir(), "isidore-config-"));
  try {
    // The whitelist is built in: ISIDORE_MODELS is ignored.
    withEnv(
      { ISIDORE_STATE: dir, ISIDORE_TOKEN: "t", ISIDORE_MODELS: "x,y", ISIDORE_MODEL: undefined },
      () => {
        const settings = loadSettings();
        assert.deepEqual(settings.models, [...MODEL_WHITELIST]);
        assert.equal(settings.model, DEFAULT_MODEL);
      },
    );

    // ISIDORE_MODEL may pick the default, but only from the whitelist.
    withEnv(
      { ISIDORE_STATE: dir, ISIDORE_TOKEN: "t", ISIDORE_MODEL: MODEL_WHITELIST[1] },
      () => {
        const settings = loadSettings();
        assert.equal(settings.model, MODEL_WHITELIST[1]);
      },
    );

    // A default outside the whitelist is ignored.
    withEnv({ ISIDORE_STATE: dir, ISIDORE_TOKEN: "t", ISIDORE_MODEL: "not-a-model" }, () => {
      const settings = loadSettings();
      assert.equal(settings.model, DEFAULT_MODEL);
      assert.deepEqual(settings.models, [...MODEL_WHITELIST]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
