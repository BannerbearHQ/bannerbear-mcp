const ASYNC_BASE = "https://api.bannerbear.com/v5";
const SYNC_BASE = "https://sync.api.bannerbear.com/v5";

/** Documented limit is 30 requests / 10s. Stay just under it. */
const RATE_LIMIT = 28;
const RATE_WINDOW_MS = 10_000;

export class BannerbearError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "BannerbearError";
  }
}

/** Signals a sync request hit the 10s ceiling; the caller should fall back to async. */
export class SyncTimeoutError extends Error {
  constructor() {
    super("Synchronous request exceeded the 10s limit");
    this.name = "SyncTimeoutError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClientOptions {
  apiKey: string;
  /** Overall ceiling for polled operations. */
  pollTimeoutMs?: number;
}

export class BannerbearClient {
  private readonly apiKey: string;
  private readonly pollTimeoutMs: number;
  /** Timestamps of recent requests, used as a sliding-window limiter. */
  private recent: number[] = [];

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 120_000;
  }

  /**
   * Blocks until sending another request stays within the documented window.
   * Batches can queue up to 100 items, so this is load-bearing, not defensive.
   */
  private async throttle(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.recent = this.recent.filter((t) => now - t < RATE_WINDOW_MS);
      if (this.recent.length < RATE_LIMIT) {
        this.recent.push(now);
        return;
      }
      await sleep(RATE_WINDOW_MS - (now - this.recent[0]) + 50);
    }
  }

  async request<T = any>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, unknown>; sync?: boolean } = {}
  ): Promise<T> {
    const base = opts.sync ? SYNC_BASE : ASYNC_BASE;
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const maxAttempts = 4;
    for (let attempt = 1; ; attempt++) {
      await this.throttle();

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (cause) {
        if (attempt >= maxAttempts) {
          throw new BannerbearError(
            `Network error calling ${method} ${path}: ${(cause as Error).message}`,
            0
          );
        }
        await sleep(2 ** attempt * 250);
        continue;
      }

      // The sync host uses 408 to mean "took longer than 10s" — a routing
      // signal, not a failure. Never retry it; the caller switches to async.
      if (res.status === 408 && opts.sync) throw new SyncTimeoutError();

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxAttempts) {
          throw new BannerbearError(
            res.status === 429
              ? "Rate limited by Bannerbear (30 requests / 10s) after retries"
              : `Bannerbear returned ${res.status} after retries`,
            res.status,
            await safeBody(res)
          );
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2 ** attempt * 500
        );
        continue;
      }

      if (!res.ok) {
        const body = await safeBody(res);
        throw new BannerbearError(
          `${method} ${path} failed (${res.status}): ${describe(body)}`,
          res.status,
          body
        );
      }

      if (res.status === 204) return undefined as T;
      return (await safeBody(res)) as T;
    }
  }

  /**
   * Polls a resource until it leaves `pending`. Backs off from 1s to 5s so a
   * fast render returns promptly without hammering a slow one.
   */
  async pollUntilDone<T extends { status?: string; uid?: string }>(
    path: string,
    timeoutMs = this.pollTimeoutMs
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let delay = 1000;
    for (;;) {
      const result = await this.request<T>("GET", path);
      if (result.status && result.status !== "pending") return result;
      if (Date.now() >= deadline) {
        throw new BannerbearError(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${path}. ` +
            `The job is still running — retrieve it later by uid.`,
          504,
          result
        );
      }
      await sleep(delay);
      delay = Math.min(delay * 1.5, 5000);
    }
  }
}

async function safeBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describe(body: unknown): string {
  if (!body) return "no response body";
  if (typeof body === "string") return body.slice(0, 500);
  const b = body as Record<string, unknown>;
  const msg = b.message ?? b.error ?? b.errors;
  return typeof msg === "string" ? msg : JSON.stringify(body).slice(0, 500);
}
