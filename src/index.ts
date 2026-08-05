#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BannerbearClient } from "./client.js";
import { registerTemplateTools } from "./tools/templates.js";
import { registerGenerationTools } from "./tools/generate.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerPublicationTools } from "./tools/publications.js";

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

const client = new BannerbearClient({ apiKey });

const server = new McpServer({
  name: "bannerbear",
  version: "0.2.0",
});

registerWorkspaceTools(server, client);
registerTemplateTools(server, client);
registerGenerationTools(server, client);
registerAssetTools(server, client);
registerPublicationTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);

// `arguments` is optional in tools/call per the MCP spec, but the SDK parses it
// against the tool's schema, so omitting it fails every tool whose parameters
// are all optional (get_account, the paginated lists). Most clients send `{}`;
// normalise here so the ones that don't still work.
const deliver = transport.onmessage!.bind(transport);
transport.onmessage = (...args: Parameters<NonNullable<typeof transport.onmessage>>) => {
  const message = args[0] as { method?: string; params?: { arguments?: unknown } };
  if (message?.method === "tools/call" && message.params && message.params.arguments == null) {
    message.params.arguments = {};
  }
  deliver(...args);
};

// stdout is the MCP transport — anything logged there corrupts the protocol.
console.error("Bannerbear MCP server ready (stdio)");
