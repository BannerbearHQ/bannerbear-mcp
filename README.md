# Bannerbear MCP

Model Context Protocol server for the [Bannerbear V5 API](https://developers.bannerbear.com/v5/).
Lets Claude and other MCP clients generate images and videos, and design and
edit templates, in your Bannerbear workspace.

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

Add that to `claude_desktop_config.json` (Claude Desktop) or run
`claude mcp add bannerbear -e BANNERBEAR_API_KEY=bb_ak_v5_... -- npx -y @bannerbear/mcp`.

## Tools

24 tools covering all 30 V5 endpoints.

| Group | Tools |
| --- | --- |
| Workspace | `get_account` |
| Schema | `get_layer_schema` |
| Templates | `list_templates`, `get_template`, `upsert_image_template`, `upsert_video_template`, `delete_template` |
| Generation | `generate_image`, `generate_video`, `get_media`, `list_media` |
| Batches | `create_batch`, `get_batch`, `list_batches` |
| Webhooks | `list_webhooks`, `get_webhook`, `create_webhook`, `update_webhook`, `delete_webhook` |
| Instant URLs | `list_instant_urls`, `get_instant_url`, `create_instant_url`, `update_instant_url`, `delete_instant_url` |

### Design notes

**Sync-first image generation.** `generate_image` posts to
`sync.api.bannerbear.com` and returns the finished file in a single call. That
host has a 10-second ceiling and answers `408` beyond it, so the tool
transparently re-submits to the async endpoint and polls. Videos have no sync
endpoint and always poll.

**Two layer shapes, deliberately kept apart.** Template *authoring* uses 11
typed layer schemas (`text`, `rectangle`, `rectangle_image_container`, `circle`,
`circle_image_container`, `image`, `svg_shape`, `qr_code`, `bar_code`, `rating`,
`group`) discriminated by `type`, each with its own attributes on top of 30
shared ones. *Modifications* at generation time are a single flat bag of 103
attributes, because a modification targets a layer that already has a type.

**Layer schema is pulled, not pushed.** Inlining the authoring `oneOf` would put
~45KB of largely duplicate attributes into every conversation. `get_layer_schema`
serves it in slices instead — an overview, one layer type, the modification bag,
or keyframes — so a conversation pays only for the types it actually uses:

| Call | Size |
| --- | --- |
| overview of all 11 types | 2.8 KB |
| `layer_type: "text"` | 4.6 KB |
| `section: "modifications"` | 8.9 KB |
| `section: "keyframes"` | 3.5 KB |

Tool definitions total ~5.9k tokens.

**Layers are validated locally before the request goes out.** The tool schema
carries the `type` enum, so a bad type is caught by the MCP layer. The handler
then checks each layer against its per-type schema and reports the offending
index — `config.objects[1]`, `scenes[0].config.objects[0]` — with a pointer to
the right `get_layer_schema` call. Attributes belonging to a *different* layer
type are rejected by name (`"qr-target" is not valid on a "text" layer — it
belongs to "qr_code"`), while attributes the spec doesn't know about are passed
through, so the server doesn't block on a spec that trails the API.

**Rate limiting.** The client holds a sliding window just under the documented
30 requests / 10s, and retries `429` and `5xx` with backoff, honouring
`Retry-After`. This matters for batches, which take up to 100 items.

**Upserts.** Create and update are one tool per template family — omit `uid` to
create, pass it to update. Requests and responses both use `config`, so what
`get_template` returns can be sent straight back: image templates use
`config.objects`, video templates `config.scenes[].config.objects`. `config`
replaces wholesale, so send the complete list when editing.

Top-level `objects` and `scenes` are accepted as convenience aliases and lifted
into `config`; passing the same thing both ways is an error rather than a
silent coin flip.

## Development

```sh
npm install
npm run build      # codegen + tsc
node scripts/smoke.mjs   # stdio handshake + tool surface report
```

`src/generated/schemas.ts` is generated from `spec/openapi.json` by
`scripts/codegen.mjs`. Refresh the spec and re-run `npm run codegen` when the
API changes — layer types, attributes, formats, frame rates and easings all flow
through automatically.

Codegen fails loudly rather than degrading quietly if the spec's shape changes:
it aborts when `config.objects` loses its `type` discriminator, when no `Layer*`
component schemas are found, or when the modification schemas for images, videos
and batches stop being identical.

`scripts/test-layers.mjs` covers layer validation and the schema reference
without hitting the API.
