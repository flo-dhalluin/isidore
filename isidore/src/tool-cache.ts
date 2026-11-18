/**
 * Per-conversation read-only tool cache: <toolCacheRoot>/<rootId>/<id>/<v>/.
 *
 * Shared by the runner (staging at spawn, Phase 2) and the tools authoring
 * MCP (staging at create/update so a freshly authored command tool is live in
 * the SAME turn, Phase 3). Workers never read /state/tools — only these
 * service-written copies, granted read+execute (--rx) by the Landlock launcher.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedTool, ToolRegistry } from "./tools.ts";

/**
 * Copy command/extension sources from the service-only registry into the
 * per-conversation read-only tool-cache. Only if absent — versions are
 * immutable, so an existing copy is never rewritten (staging dir + rename,
 * same pattern as the registry itself). Sets ResolvedTool.cachePath. Files
 * are chmod'd executable; the Landlock cache rule is --rx (read + execute,
 * no write), so a cached shebang script can be exec'd directly as argv[0]
 * while the copies stay tamper-resistant.
 */
export function stageToolCache(
  registry: ToolRegistry | null,
  toolCacheRoot: string,
  rootId: string,
  resolved: ResolvedTool[],
): void {
  for (const tool of resolved) {
    const manifest = tool.manifest;
    if (manifest.kind !== "command" && manifest.kind !== "extension") continue;
    if (manifest.id.startsWith("builtin:")) continue; // builtins carry no sources
    const dest = join(toolCacheRoot, rootId, manifest.id, String(manifest.version));
    tool.cachePath = dest;
    if (!existsSync(dest)) {
      const parent = dirname(dest);
      mkdirSync(parent, { recursive: true });
      const stage = join(parent, `.tmp-${randomBytes(6).toString("hex")}`);
      mkdirSync(stage, { recursive: true });
      try {
        const source = registry?.filesDir(manifest.id, manifest.version);
        if (source && existsSync(source)) {
          cpSync(source, stage, { recursive: true });
          for (const entry of readdirSync(stage, { recursive: true, withFileTypes: true })) {
            if (entry.isFile()) chmodSync(join(entry.parentPath ?? stage, entry.name), 0o755);
          }
        }
        renameSync(stage, dest);
      } catch (error) {
        rmSync(stage, { recursive: true, force: true });
        // A concurrent spawn may have won the race; an existing copy is fine.
        if (!existsSync(dest)) throw error;
      }
    }
    // Removal/disable race: the tool may have been removed or disabled
    // between resolveFor and staging. Re-check the live index and drop the
    // copy (best-effort) when it is gone or no longer active, so a removed
    // tool cannot stay executable. A tiny window remains between this check
    // and the worker's exec — accepted; removeToolCacheCopies sweeps again on
    // remove, and the next spawn re-resolves without the tool.
    if (registry) {
      const index = registry.getIndex(manifest.id);
      if (!index || index.status !== "active") {
        try {
          rmSync(dest, { recursive: true, force: true });
        } catch {
          // best-effort cleanup only
        }
        tool.cachePath = null;
      }
    }
  }
}

/**
 * Remove every cache copy of a tool across ALL conversations (a removed tool
 * must not stay executable anywhere). Version dirs are immutable, so removing
 * the whole <id> dir per conversation is safe. Missing dirs are ignored.
 */
export function removeToolCacheCopies(toolCacheRoot: string, id: string): void {
  let conversations: string[];
  try {
    conversations = readdirSync(toolCacheRoot);
  } catch {
    return; // no cache root yet
  }
  for (const conversation of conversations) {
    rmSync(join(toolCacheRoot, conversation, id), { recursive: true, force: true });
  }
}
