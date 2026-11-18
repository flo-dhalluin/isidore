import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubEnv } from "../src/env-scrub.ts";

test("strips service prefixes and the OpenRouter key", () => {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/state/workspaces/t_1",
    GIT_AUTHOR_NAME: "pi-sandbox",
    GIT_AUTHOR_EMAIL: "pi-sandbox@localhost",
    GIT_COMMITTER_NAME: "pi-sandbox",
    LANG: "C.UTF-8",
    OPENROUTER_API_KEY: "sk-or-secret",
    ISIDORE_TOKEN: "admin-secret",
    ISIDORE_TASK_TOKEN: "a".repeat(64),
    ISIDORE_TASK_ORIGIN: "telegram:42",
    ISIDORE_SCHEDULER_TOKEN: "sched-secret",
    SCHEDULER_TOKEN: "sched-secret",
    SCHEDULER_ISIDORE_URL: "http://isidore:8920",
    PI_SANDBOX_BROWSER_URL: "http://browser:8931/mcp",
    PI_SANDBOX_SCHEDULER_URL: "http://scheduler:8940/mcp",
  };
  const scrubbed = scrubEnv(env);
  assert.deepEqual(scrubbed, {
    PATH: "/usr/bin:/bin",
    HOME: "/state/workspaces/t_1",
    GIT_AUTHOR_NAME: "pi-sandbox",
    GIT_AUTHOR_EMAIL: "pi-sandbox@localhost",
    GIT_COMMITTER_NAME: "pi-sandbox",
    LANG: "C.UTF-8",
  });
});

test("keeps PATH, HOME and GIT_*; does not mutate the input", () => {
  const env = { PATH: "/bin", HOME: "/ws", GIT_DIR: "/ws/.git", ISIDORE_TASK_TOKEN: "x" };
  const scrubbed = scrubEnv(env);
  assert.equal(scrubbed.PATH, "/bin");
  assert.equal(scrubbed.HOME, "/ws");
  assert.equal(scrubbed.GIT_DIR, "/ws/.git");
  assert.equal(scrubbed.ISIDORE_TASK_TOKEN, undefined);
  assert.equal(env.ISIDORE_TASK_TOKEN, "x", "input untouched");
});

test("empty env yields empty env", () => {
  assert.deepEqual(scrubEnv({}), {});
});
