/**
 * Environment scrubbing for task subprocesses.
 *
 * A task's bash children (and any `command` tool / git subprocess) must never
 * inherit the service's credentials or the per-task capability token. This
 * removes every `ISIDORE_*`, `SCHEDULER_*` and `PI_SANDBOX_*` variable plus
 * `OPENROUTER_API_KEY`.
 *
 * Note: `ISIDORE_TASK_TOKEN` and `ISIDORE_TASK_ORIGIN` are stripped here too.
 * The worker keeps them in its *own* process.env (Pi expands them into the
 * scheduler MCP headers) but they must not reach bash children. The Runner
 * re-adds `ISIDORE_TASK_TOKEN` *after* scrubbing when it builds the worker env.
 */

const SCRUB_PREFIXES = ["ISIDORE_", "SCHEDULER_", "PI_SANDBOX_"];
const SCRUB_KEYS = ["OPENROUTER_API_KEY"];

/** Return a copy of `env` with secret/service variables removed. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (SCRUB_KEYS.includes(key)) continue;
    if (SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return out;
}
