export class SchedulerError extends Error {}

/** Small HTTP client for the scheduler service. */
export class SchedulerClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeout: number;

  constructor(baseUrl: string | null, token: string | null = null, timeout = 10_000) {
    this.baseUrl = (baseUrl ?? "").replace(/\/+$/, "");
    this.token = token;
    this.timeout = timeout;
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.enabled) throw new SchedulerError("scheduler is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
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
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { prompt, origin: options.origin ?? "isidore" };
    if (options.at) payload.at = options.at;
    if (options.every) payload.every = options.every;
    if (options.model) payload.model = options.model;
    return (await this.request("POST", "/api/schedules", payload)) as Record<string, unknown>;
  }

  async list(): Promise<unknown[]> {
    const data = await this.request("GET", "/api/schedules");
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object" && Array.isArray((data as { schedules?: unknown[] }).schedules)) {
      return (data as { schedules: unknown[] }).schedules;
    }
    return [];
  }

  async cancel(id: string): Promise<void> {
    await this.request("DELETE", `/api/schedules/${encodeURIComponent(id)}`);
  }

  async close(): Promise<void> {
    // fetch keeps no persistent client
  }
}
