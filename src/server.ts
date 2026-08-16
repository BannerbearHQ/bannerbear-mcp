import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BannerbearClient, type RateWindow } from "./client.js";
import { applyScopeFilter } from "./scopes.js";
import { registerTemplateTools } from "./tools/templates.js";
import { registerGenerationTools } from "./tools/generate.js";
import {
  registerAccountTools,
  registerWebhookTools,
  registerInstantUrlTools,
} from "./tools/workspace.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerPublicationTools } from "./tools/publications.js";
import { registerToolkitTools } from "./tools/toolkit.js";
import { registerWorkflowTools } from "./tools/workflows.js";
import { registerAnimationTools } from "./tools/animations.js";

export const VERSION = "0.9.0";

/**
 * Tool groups, so a deployment can register only what it needs.
 *
 * Tool definitions are ~12k tokens across 46 tools, and every one is spent on
 * every conversation whether or not it gets used. The media family alone is 45%
 * of that. A caller who never touches video shouldn't pay for seventeen video
 * tools, and this is the cheap way to say so — no dispatcher, no schemas
 * fetched on demand, just not registering what wasn't asked for.
 */
const GROUPS: Record<
  string,
  (server: McpServer, client: BannerbearClient, opts: ServerOptions) => void
> = {
  account: (s, c) => registerAccountTools(s, c),
  webhooks: (s, c) => registerWebhookTools(s, c),
  instant_urls: (s, c) => registerInstantUrlTools(s, c),
  templates: (s, c) => registerTemplateTools(s, c),
  generation: (s, c) => registerGenerationTools(s, c),
  assets: (s, c, o) => registerAssetTools(s, c, { filesystem: o.filesystemTools }),
  publications: (s, c) => registerPublicationTools(s, c),
  media: (s, c, o) => registerToolkitTools(s, c, { pollByDefault: o.pollMediaJobs }),
  animations: (s, c) => registerAnimationTools(s, c),
  workflows: (s, c) => registerWorkflowTools(s, c),
};

export const TOOL_GROUPS = Object.keys(GROUPS);

/**
 * Named shorthands, kept deliberately few.
 *
 * A profile earns its place by describing a way of working, not by being a
 * convenient subset — a name like "core" invites an argument about what belongs
 * in it that a group list settles precisely. Anything not named here is still
 * reachable as a comma-separated list of groups.
 *
 * A profile name shadows a group of the same name, so `workflows` here means
 * the pair. The group alone is reachable as `workflows_only` — see
 * resolveGroups.
 */
const PROFILES: Record<string, string[]> = {
  // What an unqualified connection gets: the classic working surface — design a
  // template, render from it — plus workflows, plus the credential check.
  // Deliberately not everything. The full set is a mouthful of tools to hand
  // someone who asked for none, and most of it is either composed by workflows
  // or configured once in the dashboard.
  default: ["account", "templates", "generation", "workflows"],
  // Workflows compose the rest server-side, so a caller working through them
  // needs the workflow tools and a way to prove their credential, nothing more.
  workflows: ["account", "workflows"],
  // Nothing is unreachable — this is the escape hatch, and it stays honest
  // about being the whole surface rather than a recommendation.
  all: TOOL_GROUPS,
};

/**
 * Turns a group spec into the groups to register.
 *
 * Accepts a profile name (`all`, `core`, `media`) or a comma-separated list of
 * group names. Throws on anything unrecognised rather than silently serving a
 * different surface — a typo that quietly removes half the tools is far worse
 * to debug than one that refuses to start.
 */
export function resolveGroups(spec?: string | string[]): string[] {
  const names = (Array.isArray(spec) ? spec : (spec ?? "").split(","))
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);

  if (names.length === 0) return PROFILES.default;
  if (names.length === 1 && names[0] in PROFILES) return PROFILES[names[0]];
  // A profile shadows the group it is named after, so give the bare group an
  // unambiguous spelling rather than leaving it unreachable.
  if (names.length === 1 && names[0].endsWith("_only")) {
    const bare = names[0].slice(0, -"_only".length);
    if (TOOL_GROUPS.includes(bare)) return [bare];
  }

  const unknown = names.filter((n) => !TOOL_GROUPS.includes(n));
  if (unknown.length) {
    throw new Error(
      `Unknown tool group(s): ${unknown.join(", ")}. ` +
        `Expected a profile (${Object.keys(PROFILES).join(", ")}), ` +
        `any of: ${TOOL_GROUPS.join(", ")}, ` +
        `or <group>_only to select a single group a profile shadows.`
    );
  }
  // Registration order follows GROUPS, not the order they were asked for.
  return TOOL_GROUPS.filter((g) => names.includes(g));
}

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
  /**
   * Which tool groups to register. Defaults to all of them; see resolveGroups
   * for the accepted spellings.
   */
  groups?: string[];
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

  for (const group of opts.groups ?? PROFILES.default) {
    GROUPS[group]?.(server, client, opts);
  }

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
