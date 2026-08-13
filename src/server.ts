import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BannerbearClient, type RateWindow } from "./client.js";
import { applyScopeFilter } from "./scopes.js";
import { registerTemplateTools } from "./tools/templates.js";
import { registerGenerationTools } from "./tools/generate.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerPublicationTools } from "./tools/publications.js";
import { registerToolkitTools } from "./tools/toolkit.js";

export const VERSION = "0.8.0";

export interface ServerOptions {
  /** The key this instance acts as. One key per instance, never process-wide. */
  apiKey: string;
  /**
   * Register the tools that read this machine's filesystem — `upload_asset`
   * and `check_assets`.
   *
   * True only when the machine running the server is the caller's own, which
   * means stdio. Over HTTP the caller is elsewhere, so a path argument would
   * read *this* machine's disk on their behalf: `upload_asset` would copy any
   * readable file into their workspace and hand back a CDN URL for it, and
   * `check_assets` would still confirm a path's existence and contents by
   * hash. Neither is registered when this is false.
   */
  filesystemTools: boolean;
  /**
   * Whether the media tools poll to completion by default.
   *
   * True everywhere today: these jobs finish in seconds in practice, so
   * polling saves a round trip on nearly every run, and one that outlasts the
   * poll returns its uid rather than erroring. Set false for a deployment
   * whose process is too short-lived to wait — the work continues at
   * Bannerbear regardless, so only the poll is lost.
   */
  pollMediaJobs: boolean;
  /**
   * Rate-limit window to count against. The API counts per key, so callers
   * that build a server per request must pass the same window for the same
   * key — otherwise every request starts with an empty window and the throttle
   * never engages. Omit when the process serves one key for its lifetime.
   */
  rateWindow?: RateWindow;
}

export interface BannerbearServer {
  server: McpServer;
  client: BannerbearClient;
  /** Registered tools by name. Exposed for scope filtering and for tests. */
  handles: Record<string, RegisteredTool>;
  /**
   * Narrow the tool list to the key's scopes. Kept separate from construction:
   * it wants the transport connected first, so the full list is already
   * serving and the client learns of the narrowing via `listChanged`.
   */
  applyScopes: () => Promise<void>;
}

/**
 * Builds one fully-wired server bound to one API key.
 *
 * Everything per-user lives inside the returned instance — the client's
 * rate-limit window, and the tool registry `applyScopes` mutates. Sharing one
 * across users would let a single scoped key disable tools for everyone, and a
 * single caller's burst throttle everyone else, so hosted callers build one of
 * these per request rather than per process.
 */
export function createServer(opts: ServerOptions): BannerbearServer {
  const client = new BannerbearClient({
    apiKey: opts.apiKey,
    rateWindow: opts.rateWindow,
  });
  const server = new McpServer({ name: "bannerbear", version: VERSION });

  // Capture each tool handle as it registers. The SDK keeps its registry
  // private and the tool modules have no reason to know scopes exist, so
  // intercept here and restore straight after.
  const handles: Record<string, RegisteredTool> = {};
  const registerTool = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, ...rest: unknown[]) => {
    const tool = (registerTool as any)(name, ...rest);
    handles[name] = tool;
    return tool;
  };

  registerWorkspaceTools(server, client);
  registerTemplateTools(server, client);
  registerGenerationTools(server, client);
  registerAssetTools(server, client, { filesystem: opts.filesystemTools });
  registerPublicationTools(server, client);
  registerToolkitTools(server, client, { pollByDefault: opts.pollMediaJobs });

  (server as any).registerTool = registerTool;

  return {
    server,
    client,
    handles,
    applyScopes: () => applyScopeFilter(client, handles),
  };
}

/**
 * `arguments` is optional in tools/call per the MCP spec, but the SDK parses it
 * against the tool's schema, so omitting it fails every tool whose parameters
 * are all optional (get_account, the paginated lists). Most clients send `{}`;
 * normalise here so the ones that don't still work.
 *
 * Must run *after* connect() — that call is what assigns `transport.onmessage`.
 */
export function normalizeEmptyArguments(transport: Transport): void {
  const deliver = transport.onmessage!.bind(transport);
  transport.onmessage = (
    ...args: Parameters<NonNullable<typeof transport.onmessage>>
  ) => {
    const message = args[0] as {
      method?: string;
      params?: { arguments?: unknown };
    };
    if (
      message?.method === "tools/call" &&
      message.params &&
      message.params.arguments == null
    ) {
      message.params.arguments = {};
    }
    deliver(...args);
  };
}
