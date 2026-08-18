#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, normalizeEmptyArguments, resolveGroups } from "./server.js";

const apiKey = process.env.BANNERBEAR_API_KEY;
if (!apiKey) {
  console.error(
    "BANNERBEAR_API_KEY is not set.\n\n" +
      "Add it to your MCP client config, e.g.:\n" +
      '  "bannerbear": {\n' +
      '    "command": "npx",\n' +
      '    "args": ["-y", "@bannerbear/mcp"],\n' +
      '    "env": { "BANNERBEAR_API_KEY": "bb_ak_v5_..." }\n' +
      "  }"
  );
  process.exit(1);
}

// This server targets V5 only. A key from an earlier Bannerbear API reaches the
// v5 hosts and comes back 401, which reads as "bad key" and gives no hint that
// the API version is the actual problem — so say it here, at launch, rather
// than leaving it to the first tool call. Warn instead of exiting: the prefix is
// an observed convention, not a documented contract, and a future key format
// must not be able to stop the server from starting.
const V5_KEY_PREFIX = "bb_ak_v5_";
if (!apiKey.startsWith(V5_KEY_PREFIX)) {
  console.error(
    `Warning: BANNERBEAR_API_KEY does not start with "${V5_KEY_PREFIX}".\n` +
      "This server supports the Bannerbear V5 API only; keys from earlier " +
      "versions will be rejected with a 401.\n" +
      "Get a V5 key from your Bannerbear workspace settings.\n" +
      "Continuing in case the key format has changed."
  );
}

// One process, one user, one key: the filesystem tools are addressing the
// caller's own disk, and the process lives as long as their session does.
// Tool definitions cost tokens on every conversation whether used or not, so
// a caller who never touches video can leave those seventeen unregistered.
// Refuses to start on an unrecognised name rather than quietly serving a
// different surface.
let groups: string[];
try {
  groups = resolveGroups(process.env.MCP_TOOL_GROUPS);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const { server, applyScopes } = createServer({
  apiKey,
  filesystemTools: true,
  pollMediaJobs: true,
  groups,
  // Same fail-safe reading as the hosted flag: set means off.
  allowGenerative: !["1", "true", "yes"].includes(
    (process.env.MCP_DISABLE_GENERATIVE ?? "").toLowerCase()
  ),
});

const transport = new StdioServerTransport();
await server.connect(transport);
normalizeEmptyArguments(transport);

// stdout is the MCP transport — anything logged there corrupts the protocol.
console.error("Bannerbear MCP server ready (stdio)");

// Deliberately not awaited: the tool list is already serving, and narrowing it
// to the key's scopes is a refinement the client picks up via listChanged.
// Blocking on it here would put an API round trip in front of every launch.
void applyScopes();
