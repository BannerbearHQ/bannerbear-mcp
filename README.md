# Bannerbear MCP

Model Context Protocol server for the [Bannerbear V5 API](https://developers.bannerbear.com/v5/).
Lets Claude and other MCP clients generate images, and design and edit
templates, in your Bannerbear workspace.

> **V5 only.** This server talks to the V5 API and no earlier version. V5 keys
> look like `bb_ak_v5_…` — a key from an older Bannerbear API is rejected with
> a `401`, which reads as a bad key rather than a version mismatch. Get a V5
> key from your Bannerbear workspace settings.

## Install

```json
{
  "mcpServers": {
    "bannerbear": {
      "command": "npx",
      "args": ["-y", "@bannerbear/mcp"],
      "env": { "BANNERBEAR_API_KEY": "bb_ak_v5_..." }
    }
  }
}
```

Add that to `claude_desktop_config.json` (Claude Desktop), or for Claude Code:

```sh
claude mcp add bannerbear -s user \
  -e BANNERBEAR_API_KEY=bb_ak_v5_... \
  -- npx -y @bannerbear/mcp
```

Get an API key from your Bannerbear workspace settings. Prefer passing it from
your environment (`-e BANNERBEAR_API_KEY="$BANNERBEAR_API_KEY"`) so the key
doesn't end up in your shell history.

> **If the first connection fails, retry.** The initial `npx` run downloads the
> package from the registry, which can take longer than the MCP client's
> startup timeout — you may see `Failed to connect` once. Every run after that
> starts in about a second.

Unpinned, npx picks up new releases automatically and checks the registry on
each launch. Append a version (`@bannerbear/mcp@0.2.0`) to freeze the tool
surface and skip that check.

## Tools

28 tools covering all 28 V5 endpoints.

| Group | Tools |
| --- | --- |
| Workspace | `get_account` |
| Schema | `get_layer_schema` |
| Templates | `list_templates`, `get_template`, `upsert_image_template`, `delete_template` |
| Generation | `generate_image`, `get_image`, `list_images` |
| Batches | `create_batch`, `get_batch`, `list_batches` |
| Assets | `upload_asset`, `get_asset`, `list_assets` |
| Publications | `list_publications`, `get_publication`, `install_publication` |
| Webhooks | `list_webhooks`, `get_webhook`, `create_webhook`, `update_webhook`, `delete_webhook` |
| Instant URLs | `list_instant_urls`, `get_instant_url`, `create_instant_url`, `update_instant_url`, `delete_instant_url` |

Video support in V5 is planned for an upcoming release.

### Design notes

**Sync-first image generation.** `generate_image` posts to
`sync.api.bannerbear.com` and returns the finished file in a single call. That
host has a 10-second ceiling and answers `408` beyond it, so the tool
transparently re-submits to the async endpoint and polls.

**Asset upload reads local disk.** `upload_asset` exists for the one case a URL
can't cover: a file that only exists on the machine running the server. It reads
the path you give it and sends the raw bytes with the file's own mime type —
the single request in the client that isn't JSON. Anything already reachable at
a public URL should be referenced directly instead. Existence, file-ness,
emptiness, the 5MB cap and the mime type are all checked locally, so the
failures the API would return as `400`/`413` arrive naming the file and its
size instead.

**Two layer shapes, deliberately kept apart.** Template *authoring* uses 11
typed layer schemas (`text`, `rectangle`, `rectangle_image_container`, `circle`,
`circle_image_container`, `image`, `svg_shape`, `qr_code`, `bar_code`, `rating`,
`group`) discriminated by `type`, each with its own attributes on top of 30
shared ones. *Modifications* at generation time are a single flat bag of 103
attributes, because a modification targets a layer that already has a type.

**Layer schema is pulled, not pushed.** Inlining the authoring `oneOf` would put
~45KB of largely duplicate attributes into every conversation. `get_layer_schema`
serves it in slices instead — an overview, one layer type, or the modification
bag — so a conversation pays only for the types it actually uses:

| Call | Size |
| --- | --- |
| overview of all 11 types | 2.8 KB |
| `layer_type: "text"` | 4.6 KB |
| `section: "modifications"` | 8.9 KB |

Tool definitions total ~5.4k tokens.

**Layers are validated locally before the request goes out.** The tool schema
carries the `type` enum, so a bad type is caught by the MCP layer. The handler
then checks each layer against its per-type schema and reports the offending
index — `config.objects[1]` — with a pointer to the right `get_layer_schema`
call. Attributes belonging to a *different* layer type are rejected by name
(`"qr-target" is not valid on a "text" layer — it
belongs to "qr_code"`), while attributes the spec doesn't know about are passed
through, so the server doesn't block on a spec that trails the API.

**Rate limiting.** The client holds a sliding window just under the documented
30 requests / 10s, and retries `429` and `5xx` with backoff, honouring
`Retry-After`. This matters for batches, which take up to 100 items.

**Upserts.** Create and update are one tool — omit `uid` to create, pass it to
update. Requests and responses both use `config.objects`, so what
`get_template` returns can be sent straight back. `config` replaces wholesale,
so send the complete list when editing.

Top-level `objects` is accepted as a convenience alias and lifted into `config`;
passing the same thing both ways is an error rather than a silent coin flip.

## Development

```sh
npm install
npm run build      # codegen + tsc
node scripts/smoke.mjs   # stdio handshake + tool surface report
```

`src/generated/schemas.ts` is generated from `spec/openapi.json` by
`scripts/codegen.mjs`. Refresh the spec and re-run `npm run codegen` when the
API changes — layer types, attributes and formats all flow through
automatically.

Codegen fails loudly rather than degrading quietly if the spec's shape changes:
it aborts when `config.objects` loses its `type` discriminator, when no `Layer*`
component schemas are found, or when the modification schemas for images and
batches stop being identical.

`scripts/test-layers.mjs` covers layer validation and the schema reference
without hitting the API.
