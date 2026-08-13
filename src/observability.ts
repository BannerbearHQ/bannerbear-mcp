/**
 * Error reporting for the hosted server.
 *
 * A seam rather than a direct dependency. stdio runs on a user's laptop where
 * there is nothing to report to and no one to read it, and @sentry/node pulls
 * ~56MB through OpenTelemetry — which every `npx` user would download on first
 * run, making the startup-timeout problem the README warns about materially
 * worse. So the SDK is imported dynamically, only when a DSN is configured,
 * and its absence is survivable.
 */

export interface Reporter {
  /** Records an unexpected failure. Must never throw. */
  captureException(error: unknown, context?: Record<string, unknown>): void;
}

export const noopReporter: Reporter = { captureException: () => {} };

/** Anything key-shaped, wherever it turns up in a payload. */
const KEY_PATTERN = /bb_ak_v5_[A-Za-z0-9_-]+/g;

/**
 * Strips credentials before anything leaves the process.
 *
 * Every request to this server carries a live Bannerbear key in its
 * Authorization header, so request metadata is dropped wholesale rather than
 * filtered field by field, and the serialised event is swept for key-shaped
 * strings in case one reached an error message by another route.
 */
export function redact<T>(event: T): T {
  const stripped = event as { request?: Record<string, unknown> };
  if (stripped.request) {
    delete stripped.request.headers;
    delete stripped.request.cookies;
    delete stripped.request.data;
  }
  try {
    return JSON.parse(
      JSON.stringify(event).replace(KEY_PATTERN, "bb_ak_v5_[redacted]")
    ) as T;
  } catch {
    // An event that won't serialise can't be swept, so drop it rather than
    // risk sending something unexamined.
    return event;
  }
}

export interface ReporterOptions {
  dsn?: string;
  release?: string;
  environment?: string;
}

/**
 * Returns a Sentry-backed reporter when a DSN is set and the SDK resolves,
 * and a no-op otherwise. Never throws: error reporting failing to start is
 * not a reason for the server not to.
 */
export async function createReporter(opts: ReporterOptions): Promise<Reporter> {
  const dsn = opts.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) return noopReporter;

  let Sentry: any;
  try {
    Sentry = await import("@sentry/node");
  } catch {
    console.error(
      "SENTRY_DSN is set but @sentry/node could not be loaded — " +
        "error reporting is off. Install it to enable reporting."
    );
    return noopReporter;
  }

  try {
    Sentry.init({
      dsn,
      release: opts.release,
      environment:
        opts.environment ?? process.env.SENTRY_ENVIRONMENT ?? "production",
      // Request bodies and headers carry API keys; never collect them.
      sendDefaultPii: false,
      beforeSend: (event: unknown) => redact(event),
      beforeSendTransaction: (event: unknown) => redact(event),
    });
  } catch (err) {
    console.error(`Sentry failed to initialise: ${(err as Error).message}`);
    return noopReporter;
  }

  return {
    captureException(error, context) {
      try {
        Sentry.captureException(error, context ? { extra: context } : undefined);
      } catch {
        // Reporting must never take the request down with it.
      }
    },
  };
}
