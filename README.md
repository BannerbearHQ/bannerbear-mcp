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
      "args": ["-y", "@bannerbear/mcp@0.11.0"],
      "env": { "BANNERBEAR_API_KEY": "bb_ak_v5_..." }
    }
  }
}
```

Add that to `claude_desktop_config.json` (Claude Desktop), or for Claude Code:

```sh
claude mcp add bannerbear -s user \
  -e BANNERBEAR_API_KEY=bb_ak_v5_... \
  -- npx -y @bannerbear/mcp@0.11.0
```

Get an API key from your Bannerbear workspace settings. Prefer passing it from
your environment (`-e BANNERBEAR_API_KEY="$BANNERBEAR_API_KEY"`) so the key
doesn't end up in your shell history.

> **If the first connection fails, retry.** The initial `npx` run downloads the
> package from the registry, which can take longer than the MCP client's
> startup timeout — you may see `Failed to connect` once. Every run after that
> starts in about a second. Pinning the version as shown also stops npx
> checking the registry for a newer release on every launch.

Bump the pin to move to a newer release, or drop `@0.11.0` to always track the
latest — at the cost of that registry check on each launch, and of picking up
breaking changes without opting in.

## Tools

**27 tools by default**, 63 in total across all 65 V5 endpoints.

The default is the working surface — design a template, render an image or an
animation from it — plus workflows. Everything else is opt-in; see *Registering
fewer tools* below.

| Group | Tools |
| --- | --- |
| Workspace | `get_account` |
| Schema | `get_layer_schema` |
| Templates | `list_templates`, `get_template`, `upsert_image_template`, `delete_template` |
| Generation | `generate_image`, `get_image`, `list_images` |
| Batches | `create_batch`, `get_batch`, `list_batches` |
| Assets | `upload_asset`, `check_assets`, `get_asset`, `list_assets` |
| Publications | `list_publications`, `get_publication`, `install_publication` |
| Workflows | `list_workflows`, `get_workflow`, `upsert_workflow`, `delete_workflow`, `run_workflow`, `get_workflow_run`, `list_workflow_runs` |
| Animations | `generate_animation`, `get_animation`, `list_animations`, `list_animation_templates`, `get_animation_template`, `upsert_animation_template`, `animate_template`, `delete_animation_template` |
| Media tools | `remove_bg`, `create_pdf`, `trim_video`, `crop_video`, `resize_video`, `concat_videos`, `overlay_image`, `overlay_video`, `add_audio`, `generate_voiceover`, `subtitle_video`, `create_video_slideshow`, `apply_color_filter`, `soften_video`, `add_cover_art`, `create_gif_preview`, `generate_ai_image`, `get_tool_job`, `list_tool_jobs` |
| Webhooks | `list_webhooks`, `get_webhook`, `create_webhook`, `update_webhook`, `delete_webhook` |
| Instant URLs | `list_instant_urls`, `get_instant_url`, `create_instant_url`, `update_instant_url`, `delete_instant_url` |

**Workflows are the composed form of the rest.** A user assembles steps in the
dashboard and `run_workflow` runs them in order, each feeding the next — so
"run the podcast clip workflow on this video" is one call rather than a chain of
four with intermediate URLs to thread. `/workflows` serves just those five tools
plus `get_account`, at ~2.7k tokens against ~14.2k for everything.

Animation templates carry layers and keyframes like image templates do.
`animate_template` applies a named preset — FadeIn, PopIn, ScaleOut and so on —
across layers with an optional stagger; it is deterministic, costs nothing, and
is the right tool for an ordinary entrance or exit. Hand-written keyframes go
through `upsert_animation_template`, which replaces the canvas wholesale.

A scoped API key sees fewer tools — see below.

### Registering fewer tools

Every tool definition is spent on every conversation whether it gets used or
not, so the default registers five groups rather than ten — 27 tools at ~7.2k
tokens, against 63 and ~16.8k for the lot. A deployment that only runs
workflows can go down to six.

Over stdio, set `MCP_TOOL_GROUPS`:

```sh
MCP_TOOL_GROUPS=workflows npx -y @bannerbear/mcp
```

Hosted, the path picks it, so each caller chooses their own surface at connect
time rather than the deployment choosing for everyone:

```
https://mcp.example.com/            30 tools   ~7.7k tokens   (default)
https://mcp.example.com/workflows    8 tools   ~1.8k
https://mcp.example.com/all         63 tools  ~16.8k
```

| Group | Tools | Tokens |
| --- | --- | --- |
| `account` | 1 | ~129 |
| `webhooks` | 5 | ~782 |
| `instant_urls` | 5 | ~869 |
| `templates` | 5 | ~1,426 |
| `generation` | 6 | ~1,770 |
| `assets` | 4 | ~907 |
| `publications` | 3 | ~524 |
| `media` | 19 | ~6,590 |
| `animations` | 8 | ~2,130 |
| `workflows` | 7 | ~1,694 |

Three profiles are named:

| Profile | Groups | Tools |
| --- | --- | --- |
| `default` | account, templates, generation, publications, animations, workflows | 30 |
| `workflows` | account, workflows | 8 |
| `all` | every group | 63 |

Anything else is a comma-separated list of groups — `account,workflows,generation`
composes exactly what a caller needs, so no argument about what belongs in a name
like "core" is required. Nothing is unreachable: `all` is always there.

A profile shadows the group it is named after, so `workflows` means the pair;
`workflows_only` reaches the bare group. An unrecognised name is refused — stdio
won't start, hosted answers `404` naming the valid options — because a typo that
quietly halves the tool list looks like a broken server rather than a config
mistake.

Scoped credentials narrow the list too, and the two compose: a token without
`workflows:*` loses those tools whether or not the profile included them.

### Switching off generative content

Some MCP platforms have a policy against tools that synthesise new content. Add
`?chat=true` to the URL, or set `MCP_DISABLE_GENERATIVE=1` over stdio:

```
https://mcp.example.com/?chat=true
https://mcp.example.com/workflows?chat=true
```

`?disable-generative=true` is accepted as an alias, but `chat` is the one to
hand out: a URL that reads *disable-generative* announces there is a generative
capability behind it, which invites the probing the flag exists to avoid. For
the same reason a refusal never names the parameter — it says the limit belongs
to the deployment rather than the account, which is what stops a pointless retry,
and stops there.

It refuses `ai-prompt` and `ai-background-generate: enabled` in modifications
*and* in template layers, and leaves `generate_voiceover` and
`generate_ai_image` unregistered. Gating
only modifications would be theatre — a prompt saved onto a template generates
on every later render with no modification involved — and leaving speech
synthesis registered while refusing image prompts would be an inconsistent line.

Untouched: `ai-background-remove` and the `ai-detect*` family, which analyse or
strip imagery the caller already supplied. `remove_bg` stays for the same
reason. A policy against generative tools is not a policy against cropping to a
face.

`run_workflow` is deliberately not gated. A workflow may contain a generative
step, but the composition was authored by its owner in the dashboard, and the
policy these platforms state is against *direct* exposure to generative tools
rather than against generated output existing. Gating it would break the very
profile the flag exists to make acceptable.

The flag fails safe. Present means on, unless explicitly `false` or `0`, so a
typo cannot quietly re-enable what a policy forbids. Refusals name the offending
index and say the restriction belongs to the deployment rather than the account
— otherwise a caller reasonably retries, or concludes their plan lacks the
feature.

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
It takes a comma-separated list, which is worth setting when a deployment is
reachable by more than one name — reaching the origin directly as well as
through a CDN is how a proxy problem gets told apart from an origin one:

```sh
MCP_PUBLIC_HOST=mcp.example.com,my-app.herokuapp.com
```

A rejected host answers `403` naming both what arrived and what is allowed, so
the fix is visible without going through the logs:

```json
{"error":"Host not allowed","host":"my-app.herokuapp.com","allowed":["mcp.example.com"]}
```

The host is checked before the credential, so a wrong host reads as `403` even
when the key is also wrong, and a request from an unexpected origin never gets
to probe whether a key is valid. `GET /health` skips both checks — it answers on
any hostname, which makes it the way to tell "the app is down" from "the app is
refusing this hostname".

**An unauthorized response explains itself.** A bare `401` tells an agent
nothing about whether authorizing is worth it, so the body carries what this
path serves — groups, tool count, tool names, whether generation is available —
the same `instructions` the handshake returns, where to get a token, the other
paths available, and a copy-paste `claude mcp add` line. Protocol clients read
the status and `WWW-Authenticate` and ignore the body, so none of this costs
them anything, and it is all the same information the README publishes.

**Server instructions are set on the handshake**, which is the standard place
for guidance that spans tools rather than sitting inside one — which of several
to reach for, and why. They vary by profile: a `/workflows` connection is not
told about `create_batch`.

**Plaintext is refused, not quietly upgraded.** A request arriving over `http`
without a credential is redirected to the `https` URL. One arriving *with* an
`Authorization` header answers `403` and says the credential should be treated
as exposed — by then it has already crossed the network in the clear, and
redirecting would only get it re-sent over TLS while letting the first attempt
pass unnoticed. Responses over `https` carry HSTS.

The scheme is read from `x-forwarded-proto`, which the platform's router sets.
Absent means nothing is fronting the process — local development — so nothing is
enforced. Turn on *Always Use HTTPS* at the CDN as well: that stops plaintext
before it reaches the origin at all, which is earlier than anything this server
can do.

`GET /health` answers `200` unauthenticated with the running version, so a
deployment can be told apart from an outage. Everything else without a
credential is `401` — visiting the host in a browser gives
`{"error":"Unauthorized"}`, which is correct rather than a symptom.

**OAuth discovery is served, so a client can find its own way to a token.**
`GET /.well-known/oauth-protected-resource` (RFC 9728) names this resource and
points at the authorization server — Bannerbear's own, since that is where
accounts live. Both `401`s carry the matching hint:

```
WWW-Authenticate: Bearer resource_metadata="https://mcp.bannerbear.com/.well-known/oauth-protected-resource"
```

Together those are the whole discovery flow: a client that has never seen this
server goes from a bare URL to a token without being told anything else, which
is what the Claude connector directory requires. Override the authorization
server with `MCP_AUTHORIZATION_SERVER`.

The advertised scopes are generated from `TOOL_SCOPES`, so a consent screen
built from them grants exactly what the tool filter later reads back — there is
no second vocabulary to keep in step.

Credential handling did not change for this. The bearer is treated as opaque and
proven against `/account`, so an access token and an API key travel the same
path; the API accepting both is what makes that work.

**Keys are proven before anything is served.** `/account` answers on any valid
key regardless of scope, so it doubles as the authentication check: a `401` from
it means the key is bad, and the request is refused before a client is
connected. Without this a mistyped key produced a working-looking install —
`initialize` succeeded, all tools listed, and every call then failed — with the
error pointing at the tool rather than the config.

Only a `401` rejects. A network failure or a `5xx` leaves the key unproven, and
the request goes through unfiltered rather than refusing service because the API
had a bad minute. The result is cached for five minutes per key, so this costs
one round trip per key rather than one per request, and the scope narrowing
reuses the same response instead of fetching again.

**Errors go to stderr**, which the platform captures and a log drain can
forward on. There is no reporting SDK — the one worth using pulls ~56MB through
OpenTelemetry, taking a runtime install from 23MB to 79MB, which every `npx`
user would download on first run to support something only the hosted server
uses.

Each failure is one JSON line, because platforms split multi-line output into
separate records and a stack trace scattered across entries no longer sorts
together. Lines are swept for key-shaped strings before they are written: every
request here carries a live API key, and a log drain forwards to a third party.
`scripts/test-registration.mjs` asserts none survives.

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

While a job runs, each poll's `progress` (0-100) is forwarded as an MCP
progress notification, so a client that asked for one can show movement instead
of a call that appears stalled for minutes. It also matters for survival:
clients that implement it reset their request timeout on progress, so a long job
is less likely to be abandoned by the caller while it is still working. A client
that sends no `progressToken` gets nothing extra.

These jobs run `pending → running → completed`, so the client's poll takes a
predicate — stopping at "anything but pending" would return a job before it has
an output. A job that ends `failed` is reported as a tool error carrying
`error_message`, not as data: the HTTP call succeeded, so otherwise the model
would have to notice a buried status field to know the work didn't happen.

They gate on `tools:write` to dispatch a job and `tools:read` to read one back,
so a key without them sees a shorter list rather than a wall of `403`s. Only
`get_account` and `get_layer_schema` are unscoped now — the first is reachable
on any key, the second never touches the API. `UNSCOPED_TOOLS` records that
pair, and a test asserts every registered tool is either scoped or listed there,
which is what caught the media tools the moment the spec gained a scope for
them.

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

Tool definitions total ~11.1k tokens.

**Layers are validated locally before the request goes out.** The tool schema
carries the `type` enum, so a bad type is caught by the MCP layer. The handler
then checks each layer against its per-type schema and reports the offending
index — `config.objects[1]` — with a pointer to the right `get_layer_schema`
call. Attributes belonging to a *different* layer type are rejected by name
(`"qr-target" is not valid on a "text" layer — it
belongs to "qr_code"`), while attributes the spec doesn't know about are passed
through, so the server doesn't block on a spec that trails the API.

**Rate limiting.** The limit is 30 requests / 10s and applies to `POST` only —
reads and updates are unmetered. The client holds a sliding window just under
that and counts `POST`s against it, so a caller stays inside the limit without
having to think about it.

Only metering `POST` matters more than it sounds. Polling is all `GET`s and is
the most frequent thing the client does — a video job can poll for minutes — so
counting it would spend budget that was never charged, and throttle a render
behind its own status checks.

The window is a separate object rather than client state, because the limit is
counted per API key and hosted mode builds a client per request — an unshared
window would restart empty each time and never throttle. `src/http.ts` keeps one
per key and hands it to every request acting as that key.

It is a courtesy, not a guarantee. The window is per process, so several
instances under-count, and it cannot see the same key being used by your own
app at the same time. The server-side limit stays the real ceiling: `429` and
`5xx` are retried with backoff, honouring `Retry-After`.

One request shape is worth knowing: `create_batch` queues up to 100 images as a
single `POST`, where the equivalent `generate_image` loop would be 100. The tool
description says so, so the model reaches for it unprompted.

**Templates can be locked against the API.** `api_write_access` decides who may
update or delete a template — `team` by default, `owner_only` for the creator's
keys, or `nobody` to block the API entirely until it is unlocked in the
dashboard. Writes to a locked template come back `403` or `423`; `get_template`
reports the current setting, and neither field is writable through the API.

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
is silent and hands out arbitrary file reads. It also checks the media tools
against the spec in both directions, so an endpoint added upstream fails the
build rather than going quietly unimplemented. All three run under `npm test`.

`src/server.ts` builds a server bound to one key and knows nothing about
transports; `src/index.ts` and `src/serve.ts` are the two entry points. Adding a
tool means touching a module under `src/tools/`, not either entry point.
