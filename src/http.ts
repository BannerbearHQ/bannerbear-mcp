import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RateWindow } from "./client.js";
import { createServer, normalizeEmptyArguments } from "./server.js";

/**
 * Resolves the Bannerbear key a request acts as, or null to reject it.
 *
 * The entire auth surface, deliberately one function. Reading a bearer header
 * is enough to start; the destination is an OAuth 2.1 access token exchanged
 * for the workspace's key, which is what turns installation into a URL and a
 * login rather than "paste your API key into a config file". Nothing below
 * this depends on which it is.
 */
export type ResolveApiKey = (
  req: IncomingMessage
) => Promise<string | null> | string | null;

/** Treats `Authorization: Bearer <key>` as the Bannerbear key directly. */
export const bearerApiKey: ResolveApiKey = (req) => {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
};

/**
 * Scope lookups cached by key, so rebuilding per request doesn't spend a
 * /account round trip every time. Keyed by digest so the key itself is never
 * held in a map.
 *
 * Process-local and lost on restart, which is fine: a cold cache costs one
 * extra call and the filter fails open regardless.
 */
const SCOPE_TTL_MS = 5 * 60_000;
const scopeChecked = new Map<string, number>();

function shouldRefreshScopes(apiKey: string, now: number): boolean {
  const id = keyId(apiKey);
  const last = scopeChecked.get(id);
  if (last !== undefined && now - last < SCOPE_TTL_MS) return false;
  scopeChecked.set(id, now);
  return true;
}

const keyId = (apiKey: string) =>
  createHash("sha256").update(apiKey).digest("hex");

/**
 * One rate-limit window per key, shared by every request acting as that key.
 *
 * A server is built per request here, so without this each request would get a
 * fresh window, never fill it, and never throttle — the exact case the limiter
 * exists for, since one caller's batch can fan out across several concurrent
 * requests. The window is still per process, so with more than one instance the
 * client-side view under-counts; the server-side limit stays the real ceiling
 * and 429s are already retried with backoff.
 */
const rateWindows = new Map<string, RateWindow>();

function windowFor(apiKey: string): RateWindow {
  const id = keyId(apiKey);
  let window = rateWindows.get(id);
  if (!window) {
    window = new RateWindow();
    rateWindows.set(id, window);
  }
  // Drop windows for keys that have gone quiet, so the map tracks active
  // tenants rather than every key ever seen.
  if (rateWindows.size > 512) {
    for (const [otherId, other] of rateWindows) {
      if (otherId !== id && other.idle) rateWindows.delete(otherId);
    }
  }
  return window;
}

export interface HandlerOptions {
  resolveApiKey?: ResolveApiKey;
  /**
   * Hostnames this server answers to, for the DNS-rebinding check the MCP spec
   * asks for on HTTP transports. Defaults to MCP_PUBLIC_HOST.
   */
  allowedHosts?: string[];
}

export function createHandler(opts: HandlerOptions = {}) {
  const resolveApiKey = opts.resolveApiKey ?? bearerApiKey;
  const allowedHosts =
    opts.allowedHosts ??
    (process.env.MCP_PUBLIC_HOST ? [process.env.MCP_PUBLIC_HOST] : ["localhost"]);

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    let apiKey: string | null;
    try {
      apiKey = await resolveApiKey(req);
    } catch {
      apiKey = null;
    }
    if (!apiKey) {
      res
        .writeHead(401, {
          "WWW-Authenticate": "Bearer",
          "content-type": "application/json",
        })
        .end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const { server, applyScopes } = createServer({
      apiKey,
      // The caller is not on this machine, so a path argument would address
      // the server's disk rather than theirs.
      filesystemTools: false,
      // A hosted process may be recycled mid-job; the work continues at
      // Bannerbear either way, so hand back the uid and let them poll.
      pollMediaJobs: false,
      rateWindow: windowFor(apiKey),
    });

    const transport = new StreamableHTTPServerTransport({
      // Stateless. Routing by `mcp-session-id` needs affinity the platform
      // may not offer, and any in-process session map dies with the process.
      // Rebuilding per request removes both problems.
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    normalizeEmptyArguments(transport);
    if (shouldRefreshScopes(apiKey, Date.now())) void applyScopes();
    await transport.handleRequest(req, res);
  };
}
