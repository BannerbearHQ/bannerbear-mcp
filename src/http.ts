import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BannerbearError, RateWindow, type BannerbearClient } from "./client.js";
import { logError } from "./observability.js";
import { filterToolsByScopes, scopesFromAccount } from "./scopes.js";
import { VERSION, createServer, normalizeEmptyArguments } from "./server.js";

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

/** Parses MCP_PUBLIC_HOST, which may name several hosts. */
export function hostsFromEnv(value = process.env.MCP_PUBLIC_HOST): string[] {
  const hosts = (value ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return hosts.length ? hosts : ["localhost"];
}

const keyId = (apiKey: string) =>
  createHash("sha256").update(apiKey).digest("hex");

/**
 * What /account said about a key, cached so rebuilding per request doesn't
 * spend a round trip every time. Keyed by digest so the key itself is never
 * held in a map.
 *
 * Process-local and lost on restart, which is fine: a cold cache costs one
 * extra call. A revoked key keeps connecting until its entry ages out, but
 * every call it makes still fails at the API, so the window buys nothing.
 */
const AUTH_TTL_MS = 5 * 60_000;
const checkedKeys = new Map<string, { at: number; scopes: string[] | null }>();

export interface AuthResult {
  /** False only when the API positively rejected the key. */
  ok: boolean;
  /** Scopes to narrow the tool list to, or null to leave it whole. */
  scopes: string[] | null;
}

/**
 * Confirms a key is real before anything is served with it.
 *
 * /account is reachable on any valid key regardless of scope, so a 401 from it
 * means the key itself is bad — reject, rather than connecting a client that
 * lists 46 tools and then fails every one of them.
 *
 * Any other failure is not proof of anything: a network blip or a 5xx leaves
 * the key unproven, so the request is allowed through unfiltered. Refusing
 * service because Bannerbear had a bad minute would be the worse error.
 */
export async function authenticateKey(
  client: Pick<BannerbearClient, "request">,
  apiKey: string,
  now = Date.now()
): Promise<AuthResult> {
  const id = keyId(apiKey);
  const cached = checkedKeys.get(id);
  if (cached && now - cached.at < AUTH_TTL_MS) {
    return { ok: true, scopes: cached.scopes };
  }

  try {
    const account = await client.request("GET", "/account");
    const scopes = scopesFromAccount(account);
    checkedKeys.set(id, { at: now, scopes });
    return { ok: true, scopes };
  } catch (err) {
    if (err instanceof BannerbearError && err.status === 401) {
      checkedKeys.delete(id);
      return { ok: false, scopes: null };
    }
    return { ok: true, scopes: null };
  }
}

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
   * asks for on HTTP transports. Defaults to MCP_PUBLIC_HOST, which accepts a
   * comma-separated list — a deployment is commonly reachable by more than one
   * name at once, and comparing them is the way to tell a proxy problem from an
   * origin one.
   */
  allowedHosts?: string[];
}

export function createHandler(opts: HandlerOptions = {}) {
  const resolveApiKey = opts.resolveApiKey ?? bearerApiKey;
  const allowedHosts = opts.allowedHosts ?? hostsFromEnv();

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      await route(req, res);
    } catch (err) {
      // Node does not await this handler, so an escaping rejection would be an
      // unhandled rejection rather than a failed request — on some configs
      // that takes the process down and every in-flight session with it.
      logError("request failed", err, { url: req.url, method: req.method });
      if (!res.headersSent) {
        res
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "Internal error" }));
      } else {
        res.end();
      }
    }
  };

  async function route(req: IncomingMessage, res: ServerResponse) {
    // Unauthenticated liveness check. Deliberately bare: it exists so a
    // deployment can be told apart from an outage, and says nothing a caller
    // could not learn from the package.
    if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, name: "bannerbear-mcp", version: VERSION }));
      return;
    }

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

    const { server, client, handles } = createServer({
      apiKey,
      // The caller is not on this machine, so a path argument would address
      // the server's disk rather than theirs.
      filesystemTools: false,
      // Media jobs finish in seconds in practice — the 900s ceiling is a
      // worst case, not a norm — so polling saves the caller a round trip on
      // essentially every run. A job that does outlast the poll is not lost:
      // it keeps running at Bannerbear and comes back with its uid to collect
      // via get_tool_job.
      pollMediaJobs: true,
      rateWindow: windowFor(apiKey),
    });

    // Prove the key before serving anything with it. Construction above is
    // pure, so nothing has been connected yet and this costs only the object.
    const auth = await authenticateKey(client, apiKey);
    if (!auth.ok) {
      await server.close();
      res
        .writeHead(401, {
          "WWW-Authenticate": "Bearer",
          "content-type": "application/json",
        })
        .end(JSON.stringify({ error: "Invalid API key" }));
      return;
    }
    // Narrow before connecting, so the first tools/list is already correct
    // rather than being corrected afterwards by listChanged.
    if (auth.scopes) filterToolsByScopes(auth.scopes, handles);

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
    await transport.handleRequest(req, res);
  }
}
