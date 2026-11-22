/**
 * Built-in model whitelist.
 *
 * This is intentionally NOT configurable via the environment: edit this list
 * (and DEFAULT_MODEL) in source to allow a different set of models. The web UI
 * renders it as a dropdown and the API rejects any model not listed here.
 */
export const MODEL_WHITELIST: readonly string[] = [
  "openrouter/deepseek/deepseek-flash-latest",
  "openrouter/google/gemma-4-26b-a4b-it",
  "openrouter/qwen/qwen4-max",
];

/** Built-in default model; must be one of MODEL_WHITELIST. */
export const DEFAULT_MODEL: string = MODEL_WHITELIST[0];
