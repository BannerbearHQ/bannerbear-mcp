/**
 * Error logging for the hosted server.
 *
 * Everything goes to stderr, which the platform captures and a log drain can
 * forward on. There is no reporting SDK: the one worth using pulls ~56MB
 * through OpenTelemetry, which every `npx` user would download on first run to
 * support something only the hosted server uses.
 */

/** Anything key-shaped, wherever it turns up. */
const KEY_PATTERN = /bb_ak_v5_[A-Za-z0-9_-]+/g;

/**
 * Sweeps a value for credentials.
 *
 * Every request to this server carries a live Bannerbear key in its
 * Authorization header, and logs leave the process — to the platform's log
 * store, and onward to any drain. A key reaching a log line is a key handed to
 * a third party, so redact before writing rather than trusting callers to.
 */
export function redact<T>(value: T): T {
  try {
    return JSON.parse(
      JSON.stringify(value).replace(KEY_PATTERN, "bb_ak_v5_[redacted]")
    ) as T;
  } catch {
    // Unserialisable input can't be swept, so say nothing about it rather than
    // write something unexamined.
    return "[unserialisable]" as unknown as T;
  }
}

/**
 * Writes one redacted JSON line per failure.
 *
 * One line matters: platforms split multi-line output into separate records,
 * which scatters a stack trace across entries that no longer sort together.
 */
export function logError(
  what: string,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  const detail =
    error instanceof Error
      ? { error: error.message, stack: error.stack }
      : { error: String(error) };

  console.error(
    JSON.stringify(redact({ level: "error", what, ...context, ...detail }))
  );
}
