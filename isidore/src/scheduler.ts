import { readFileSync } from "node:fs";

export class SchedulerError extends Error {}

/** Small HTTP client for the scheduler service. */
export class SchedulerClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly tokenFile: string | null;
  private readonly timeout: number;

  constructor(baseUrl: string | null, token: string | null = null, timeout = 10_000, tokenFile: string | null = null) {
    this.baseUrl = (baseUrl ?? "").replace(/\/+$/, "");
    this.token = token;
    this.tokenFile = tokenFile;
    this.timeout = timeout;
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  /**
   * The admin Bearer to send: the explicit token, else the token file read
   * per-request (mirrors scheduler/client.py's token_file pattern), so a
   * scheduler-regenerated token is picked up without a restart. A missing /
   * unreadable file yields no auth header; the scheduler's 401 then propagates
   * as a SchedulerError like any other failure.
   */
  private effectiveToken(): string | null {
    if (this.token) return this.token;
    if (this.tokenFile) {
      try {
        return readFileSync(this.tokenFile, "utf8").trim() || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async request(method: string, path: string, body?: unknown, conversationId?: string | null): Promise<unknown> {
    if (!this.enabled) throw new SchedulerError("scheduler is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const token = this.effectiveToken();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          // Scopes the scheduler's REST view to one conversation; honored only
          // alongside the admin Bearer (contract #6).
          ...(conversationId ? { "x-isidore-conversation-id": conversationId } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (response.status >= 400) {
        const detail = (await response.text()).trim() || response.statusText;
        throw new SchedulerError(`scheduler returned ${response.status}: ${detail}`);
      }
      if (response.status === 204) return null;
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (error instanceof SchedulerError) throw error;
      throw new SchedulerError(`scheduler unreachable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async create(
    prompt: string,
    options: { at?: string | null; every?: string | number | null; model?: string | null; origin?: string } = {},
    conversationId?: string | null,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { prompt, origin: options.origin ?? "isidore" };
    if (options.at) payload.at = options.at;
    if (options.every) payload.every = options.every;
    if (options.model) payload.model = options.model;
    return (await this.request("POST", "/api/schedules", payload, conversationId)) as Record<string, unknown>;
  }

  async list(conversationId?: string | null): Promise<unknown[]> {
    const data = await this.request("GET", "/api/schedules", undefined, conversationId);
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object" && Array.isArray((data as { schedules?: unknown[] }).schedules)) {
      return (data as { schedules: unknown[] }).schedules;
    }
    return [];
  }

  async cancel(id: string, conversationId?: string | null): Promise<void> {
    await this.request("DELETE", `/api/schedules/${encodeURIComponent(id)}`, undefined, conversationId);
  }

  async close(): Promise<void> {
    // fetch keeps no persistent client
  }
}
