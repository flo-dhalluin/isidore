/**
 * Dynamic vision capability detection via OpenRouter's public /api/v1/models
 * endpoint (no API key required).
 *
 * Fetches the bulk model catalog once at startup and refreshes lazily with a
 * ~1 h TTL. On refresh failure, the stale cache continues to be served; if the
 * catalog has never been fetched (or a model ID cannot be resolved), vision
 * support is unknown (null) and image uploads fail closed (503).
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const CAPABILITIES_TTL_MS = 60 * 60 * 1000;
const DEFAULT_RETRY_COOLDOWN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ModelCapabilitiesOptions {
  url?: string;
  ttlMs?: number;
  retryCooldownMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof globalThis.fetch;
  nowFn?: () => number;
}

interface CapabilitiesCache {
  fetchedAt: number;
  modalities: Map<string, string[]>;
}

export class ModelCapabilities {
  private readonly url: string;
  private readonly ttlMs: number;
  private readonly retryCooldownMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly nowFn: () => number;
  private cache: CapabilitiesCache | null = null;
  private lastAttemptAt = 0;
  private inflight: Promise<boolean> | null = null;
  private activeAbort: AbortController | null = null;
  private closed = false;

  constructor(options: ModelCapabilitiesOptions = {}) {
    this.url = options.url ?? OPENROUTER_MODELS_URL;
    this.ttlMs = options.ttlMs ?? CAPABILITIES_TTL_MS;
    this.retryCooldownMs = options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.nowFn = options.nowFn ?? Date.now;
  }

  hasCache(): boolean {
    return this.cache !== null;
  }

  /** Trigger a refresh if the cache is absent or older than ttlMs. */
  async ensureFresh(): Promise<boolean> {
    if (this.closed) return false;
    const now = this.nowFn();
    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) {
      return true;
    }
    if (this.inflight) {
      return this.inflight;
    }
    if (this.lastAttemptAt > 0 && now - this.lastAttemptAt < this.retryCooldownMs) {
      return this.cache !== null;
    }
    return this.refresh();
  }

  /** Fetch the OpenRouter catalog now; keeps stale cache on failure. */
  async refresh(): Promise<boolean> {
    if (this.closed) return false;
    if (this.inflight) return this.inflight;

    this.lastAttemptAt = this.nowFn();
    const run = (async (): Promise<boolean> => {
      const controller = new AbortController();
      this.activeAbort = controller;
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      try {
        const response = await this.fetchFn(this.url, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) return false;
        const payload = (await response.json()) as { data?: unknown };
        if (!payload || !Array.isArray(payload.data)) return false;
        const modalities = new Map<string, string[]>();
        for (const entry of payload.data) {
          if (!entry || typeof entry !== "object") continue;
          const record = entry as { id?: unknown; architecture?: { input_modalities?: unknown } };
          if (typeof record.id !== "string" || !record.id) continue;
          const raw = record.architecture?.input_modalities;
          if (!Array.isArray(raw)) continue;
          modalities.set(
            record.id,
            raw.filter((item): item is string => typeof item === "string"),
          );
        }
        this.cache = { fetchedAt: this.nowFn(), modalities };
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
        if (this.activeAbort === controller) this.activeAbort = null;
        this.inflight = null;
      }
    })();

    this.inflight = run;
    return run;
  }

  /**
   * Check whether a model accepts image inputs:
   * - true: catalog entry includes "image" in input_modalities
   * - false: catalog entry exists and lacks "image"
   * - null: catalog unavailable or model id unknown (fail closed)
   */
  supportsVision(modelId: string | null | undefined): boolean | null {
    if (!this.cache || !modelId) return null;
    const stripped = modelId.startsWith("openrouter/") ? modelId.slice("openrouter/".length) : modelId;
    if (!stripped) return null;
    const mods = this.cache.modalities.get(stripped) ?? this.cache.modalities.get(`~${stripped}`);
    if (!mods) return null;
    return mods.includes("image");
  }

  /** Filter a list of model IDs down to those known to support vision. */
  visionModels(models: readonly string[]): string[] {
    return models.filter((model) => this.supportsVision(model) === true);
  }

  /** Abort any in-flight fetch on shutdown. */
  close(): void {
    this.closed = true;
    this.activeAbort?.abort();
    this.activeAbort = null;
  }
}
