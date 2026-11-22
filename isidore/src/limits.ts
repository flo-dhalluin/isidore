/**
 * Shared size/quantity limits for the service and the tool registry.
 * MAX_EVENT_TEXT moved here from runner.ts (value unchanged) so command-tool
 * output truncation can reuse it.
 */

/** Cap for a single event's text (stderr tails, command-tool output). */
export const MAX_EVENT_TEXT = 4_000;

/** Maximum non-removed tools owned by one conversation (task tools count too). */
export const MAX_TOOLS_PER_CONVERSATION = 32;

/** Maximum serialized manifest.json size in bytes, per version. */
export const MAX_MANIFEST_BYTES = 16_000;

/** Maximum total source-file bytes per tool version. */
export const MAX_SOURCE_BYTES = 64_000;

/** Maximum number of source files per tool version. */
export const MAX_TOOL_FILES = 16;

/** Hard cap for a command tool's (or MCP server's) timeout, in seconds. */
export const MAX_COMMAND_TIMEOUT_S = 120;

/** Timeout applied to command tools that do not specify one, in seconds. */
export const DEFAULT_COMMAND_TIMEOUT_S = 30;

/** Maximum size of a file an agent may publish to the task view, in bytes. */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

/** Maximum files one task turn may publish to the task view. */
export const MAX_ARTIFACTS_PER_TASK = 32;
