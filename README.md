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
      "args": ["-y", "@bannerbear/mcp@0.6.0"],
      "env": { "BANNERBEAR_API_KEY": "bb_ak_v5_..." }
    }
  }
}
```

Add that to `claude_desktop_config.json` (Claude Desktop), or for Claude Code:

```sh
claude mcp add bannerbear -s user \
  -e BANNERBEAR_API_KEY=bb_ak_v5_... \
  -- npx -y @bannerbear/mcp@0.6.0
```

Get an API key from your Bannerbear workspace settings. Prefer passing it from
your environment (`-e BANNERBEAR_API_KEY="$BANNERBEAR_API_KEY"`) so the key
doesn't end up in your shell history.

> **If the first connection fails, retry.** The initial `npx` run downloads the
> package from the registry, which can take longer than the MCP client's
> startup timeout — you may see `Failed to connect` once. Every run after that
> starts in about a second. Pinning the version as shown also stops npx
> checking the registry for a newer release on every launch.

Bump the pin to move to a newer release, or drop `@0.6.0` to always track the
latest — at the cost of that registry check on each launch, and of picking up
breaking changes without opting in.

## Tools

39 tools covering all 39 V5 endpoints.

| Group | Tools |
| --- | --- |
| Workspace | `get_account` |
| Schema | `get_layer_schema` |
| Templates | `list_templates`, `get_template`, `upsert_image_template`, `delete_template` |
| Generation | `generate_image`, `get_image`, `list_images` |
| Batches | `create_batch`, `get_batch`, `list_batches` |
| Assets | `upload_asset`, `check_assets`, `get_asset`, `list_assets` |
| Publications | `list_publications`, `get_publication`, `install_publication` |
| Media tools | `remove_bg`, `create_pdf`, `trim_video`, `crop_video`, `resize_video`, `concat_videos`, `overlay_image`, `overlay_video`, `get_tool_job`, `list_tool_jobs` |
| Webhooks | `list_webhooks`, `get_webhook`, `create_webhook`, `update_webhook`, `delete_webhook` |
| Instant URLs | `list_instant_urls`, `get_instant_url`, `create_instant_url`, `update_instant_url`, `delete_instant_url` |

The media tools operate on video, but *video templates* — designing and
rendering video from a template, as image templates do — are still to come.

A scoped API key sees fewer tools — see below.

### Running it as a hosted endpoint

The same tools serve two shapes. `dist/index.js` is the stdio binary above.
`dist/serve.js` is an HTTP entry point over Streamable HTTP:

```sh
PORT=3000 MCP_PUBLIC_HOST=your-app.example.com npm run serve
```

`Procfile` points at it for platforms that read one. Auth is a single seam —
`ResolveApiKey` in `src/http.ts` — which defaults to treating
`Authorization: Bearer <key>` as the Bannerbear key. Swapping in an OAuth token
exchange touches nothing else.

`MCP_PUBLIC_HOST` must match the `Host` header exactly, including a port if the
port is non-default, or the DNS-rebinding check rejects the request with `403`.

Hosted mode differs from stdio in three ways, all of them deliberate:

- **`upload_asset` and `check_assets` are not registered.** Both resolve a
  caller-supplied path on the machine running the server. Over stdio that is
  the caller's own disk, which is the point. Hosted it is *your* disk, so
  `upload_asset` would copy any readable file into the caller's workspace and
  return a CDN URL for it, and `check_assets` would still confirm a path's
  existence and contents by hash. `get_asset` and `list_assets` take a uid and
  a page, touch no disk, and stay.
- **The media tools return a job uid instead of polling.** A hosted process can
  be recycled mid-job. The work continues at Bannerbear regardless, so handing
  back the uid loses nothing, while a dropped poll loses a finished render.
  Callers use `get_tool_job`.
- **One server and client per request, never per process.** The rate-limit
  window and the tool registry that scope filtering mutates both live on the
  instance. Sharing one would let a single scoped key disable tools for every
  user, and one caller's burst throttle everyone else.

The transport streams over SSE rather than buffering a JSON response, which is
load-bearing behind a router that times out an idle request: the response starts
immediately and heartbeats while a job runs. Setting `enableJsonResponse` would
send nothing until the work finished and reintroduce that timeout.

Sessions are stateless (`sessionIdGenerator: undefined`), so no affinity is
needed and nothing is lost when a process restarts. Scope lookups are cached for
five minutes, keyed by a digest of the API key, so rebuilding per request does
not mean an `/account` call per request.

### Design notes

**Tools narrow to the key's scopes.** `GET /account` reports the scopes the API
key holds, and is reachable on every key regardless of scope. On startup the
server reads them and disables the tools the key isn't authorized for, so a
read-only key stops offering calls that could only ever come back `403`.

This runs *after* the transport connects, not before: the full list is served
immediately and then narrows, which the client picks up through the
`listChanged` notification. Putting the round trip in front of the handshake
would add it to every launch, and startup latency is already the one thing that
makes `npx` installs fail.

It fails open in every uncertain case. An unreachable `/account`, a malformed
response, or an empty `scopes` array (which the API uses to mean full access)
all leave the complete surface enabled — wrongly hiding a tool that would have
worked is worse than letting a `403` speak for itself. `scripts/test-scopes.mjs`
asserts each of those paths, and checks the scope table against the enum in the
spec so a typo can't silently disable a tool.

**Media tools are async, and polled to completion.** The `/tools` endpoints
take URLs rather than templates — background removal, PDF assembly, and video
trim/crop/resize/concat/overlay. Each answers `202` with a pending job, so the
tools poll `/tool_jobs/{uid}` and return the finished output by default; pass
`wait: false` to get the uid straight back and check it later with
`get_tool_job`. Every run takes an optional `metadata` string, returned on the
job — handy for tying a result back to whatever triggered it. `list_tool_jobs`
walks recent runs when a uid wasn't kept.

These jobs run `pending → running → completed`, so the client's poll takes a
predicate — stopping at "anything but pending" would return a job before it has
an output. A job that ends `failed` is reported as a tool error carrying
`error_message`, not as data: the HTTP call succeeded, so otherwise the model
would have to notice a buried status field to know the work didn't happen.

They have no scope of their own — the `/account` enum has no `tools:*` entry —
so they can't be filtered by key and stay visible. `UNSCOPED_TOOLS` records
that, and a test asserts every registered tool is either scoped or listed there.

**Sync-first image generation.** `generate_image` posts to
`sync.api.bannerbear.com` and returns the finished file in a single call. That
host has a 10-second ceiling and answers `408` beyond it, so the tool
transparently re-submits to the async endpoint and polls.

**Asset upload reads local disk.** `upload_asset` exists for the one case a URL
can't cover: a file that only exists on the machine running the server. It reads
the path you give it and sends the raw bytes with the file's own mime type —
the single request in the client that isn't JSON. Anything already reachable at
a public URL should be referenced directly instead.

Existence, file-ness, emptiness, the 5MB cap and the mime type are all checked
locally, so the failures the API would return as `400`/`413`/`415` arrive naming
the file, its size and its format. The accepted types come from the spec via
codegen (`ASSET_MIME_TYPES`), so a format the API adds later needs no code
change. The extension table is deliberately wider than that list: recognising
`.svg` as an image the endpoint won't take gives a far better error than not
recognising it at all.

Re-uploading is safe — the workspace deduplicates by content hash and returns
the existing asset rather than a copy, and a dedupe hit doesn't count against
the trial account's 20-asset limit.

`check_assets` skips the transfer altogether. It hashes local files here and
batch-checks the hashes, so a file that's already stored costs no upload at all
and comes back with its CDN URL. It takes paths rather than hashes deliberately:
the endpoint is specified in terms of SHA-256 digests, but a model can't compute
one, so a hash-shaped tool would be unusable from the thing driving it.

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

Tool definitions total ~8.5k tokens.

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
component schemas are found, when the modification schemas for images and
batches stop being identical, when `POST /assets` stops listing the content
types it accepts, or when a webhook field loses its enum.

Small enums are generated too, not just the big schemas — accepted asset mime
types and the four webhook fields. Both had drifted by hand more than once
(`video` leaving the webhook `resource` list, `tool_job` joining it), which is
exactly the kind of change that is easy to miss in a diff and silently rejects
valid input.

`scripts/test-layers.mjs` covers layer validation and the schema reference
without hitting the API. `scripts/test-scopes.mjs` covers scope filtering
against stub tool handles, including every fail-open path.
`scripts/test-registration.mjs` covers what each deployment shape registers —
above all that hosted mode omits the two filesystem tools, since that failure
is silent and hands out arbitrary file reads. All three run under `npm test`.

`src/server.ts` builds a server bound to one key and knows nothing about
transports; `src/index.ts` and `src/serve.ts` are the two entry points. Adding a
tool means touching a module under `src/tools/`, not either entry point.
