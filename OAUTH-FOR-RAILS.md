# OAuth requirements for the Rails app

What Bannerbear's Rails application needs to implement so the MCP server at
`mcp.bannerbear.com` can be listed in the Claude connector directory, which
accepts OAuth connections only.

Written from the MCP authorization spec (revision 2025-06-18). That spec moves;
check it before starting, and treat this document as the shape of the work
rather than the final word on any header name.

---

## The split

**Rails is the OAuth 2.1 Authorization Server.** It owns users, workspaces,
consent and tokens — all of which it already owns. Nothing about identity moves.

**The MCP server is a Resource Server.** It never sees a password, never holds a
user record, and never issues anything. It receives a token, checks it is real,
and acts within whatever that token permits.

This is the standard division and it is the reason the work is mostly yours: an
MCP server that tried to authenticate users itself would be duplicating Rails
badly.

---

## What the user sees

1. Pastes `https://mcp.bannerbear.com` into Claude.
2. Claude gets `401` and discovers Bannerbear is the authoriser.
3. Claude registers itself, then opens a browser at Bannerbear.
4. Already signed in, so no password — a consent screen naming the app and the
   permissions it wants, plus a workspace picker if the user has several.
5. Approve. Browser closes. Connected.

No API key is ever displayed, pasted or stored by the user. Revocation is a
button in the Bannerbear dashboard, not a key rotation that breaks everything
else using that key.

---

## Endpoints Rails must serve

### 1. Authorization server metadata — RFC 8414

`GET /.well-known/oauth-authorization-server`

Public, unauthenticated, JSON. Advertises everything else:

```json
{
  "issuer": "https://www.bannerbear.com",
  "authorization_endpoint": "https://www.bannerbear.com/oauth/authorize",
  "token_endpoint": "https://www.bannerbear.com/oauth/token",
  "registration_endpoint": "https://www.bannerbear.com/oauth/register",
  "revocation_endpoint": "https://www.bannerbear.com/oauth/revoke",
  "scopes_supported": ["images:read", "images:write", "..."],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"]
}
```

`code_challenge_methods_supported` must include `S256`. A client that cannot
confirm PKCE support will refuse to proceed.

### 2. Dynamic client registration — RFC 7591

`POST /oauth/register`

**This is the endpoint that decides whether directory listing works at all**, and
it is the one Doorkeeper does not provide. Claude cannot pre-register with every
MCP server in the world, so it registers itself at connect time:

```http
POST /oauth/register
Content-Type: application/json

{
  "client_name": "Claude",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_method": "none"
}
```

Respond `201` with at least `client_id`, echoing the registered metadata. Public
clients (`token_endpoint_auth_method: "none"`) get no secret; they rely on PKCE.

Registration is open by design, which has consequences — see Security below.

### 3. Authorization — `GET /oauth/authorize`

Standard authorization code with PKCE. Expect `response_type=code`,
`client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`,
`state`, `scope`, and `resource`.

Requirements:

- If not signed in, sign in first, then return to the consent screen.
- Show which client is asking, which scopes it wants, and which workspace the
  grant applies to. Let the user choose the workspace if they have more than one.
- Reject a `redirect_uri` that was not registered by that `client_id`. Exact
  string match, no prefix matching.
- `resource` (RFC 8707) will be `https://mcp.bannerbear.com`. Record it and bind
  the resulting token's audience to it — see Security.

### 4. Token — `POST /oauth/token`

Handles `grant_type=authorization_code` with `code_verifier`, and
`grant_type=refresh_token`.

Verify the `code_verifier` against the stored `code_challenge`. Reject a code
that has been used before, and expire codes quickly — 60 seconds is typical.

Suggested lifetimes: access token ~1 hour, refresh token long-lived but
revocable. Short access tokens are the point of the exercise; a token that never
expires is an API key wearing a costume.

### 5. Revocation — RFC 7009, recommended

`POST /oauth/revoke`, plus a "Connected apps" screen listing active grants with a
revoke button. This is the user-visible payoff — the reason OAuth is better than
a pasted key is that a single connection can be cut without disturbing anything
else.

---

## The one requirement outside OAuth

**The V5 API must accept an OAuth access token as a bearer credential, exactly
where it accepts an API key today.**

`components.securitySchemes` currently reads:

```json
"bearerAuth": { "type": "http", "scheme": "bearer", "description": "API key (e.g. bb_ak_v5_...)" }
```

It needs to also accept an access token. One branch in API authentication: is
this bearer an API key, or a token? Everything after that — workspace
resolution, scopes, quota, rate limiting — is identical.

Without this, the MCP server has to exchange each token for an API key and hold
it, which turns a stateless proxy into a store of customer credentials on a
Heroku dyno. That is a far worse thing to operate and a far worse thing to have
breached. With it, the MCP server forwards the token and never holds a
credential at all.

`GET /account` matters most: the MCP server calls it to prove a credential and
read its scopes. If it accepts tokens, the MCP server's existing authentication
path works unchanged.

**This does not affect API keys.** They keep working everywhere, indefinitely.
OAuth is an additional way to authenticate, not a replacement.

---

## Scopes

Reuse the vocabulary that already exists on API keys:

```
images:read          images:write
image_templates:read image_templates:write
batches:read         batches:write
webhooks:read        webhooks:write
instant_urls:read    instant_urls:write
publications:read    publications:write
assets:read          assets:write
tools:read           tools:write
```

Two scope systems meaning almost the same thing is a lasting source of
confusion. Granting `images:read` through OAuth should produce a token
indistinguishable, to the API, from a key scoped the same way.

The MCP server already narrows its tool list to the granted scopes — a token
with only `images:read` sees a handful of tools rather than 44 — so the consent
screen has real consequences the user can observe.

---

## Security notes

**Registration is open.** Anyone can `POST /oauth/register`. That is what the
spec requires, but it means `client_name` is self-asserted and unverified. Show
it on the consent screen, but do not present it as though Bannerbear has
vouched for it — "Claude wants access" is fine, a verified badge is not. Rate
limit the endpoint.

**Bind tokens to an audience.** Honour the `resource` parameter and record it.
A token issued for `https://mcp.bannerbear.com` should not be accepted by an
unrelated Bannerbear service, and vice versa. Without this, a token leaked from
one integration is usable against everything.

**Exact redirect URI matching.** No prefix or wildcard matching, ever. This is
the most commonly exploited weakness in OAuth deployments.

**PKCE is mandatory**, not optional, and `S256` only. Do not accept `plain`.

**Never log tokens.** The MCP server redacts anything key-shaped before writing
a log line; Rails should do the same for tokens.

---

## What the MCP server will do

For reference — this side is small and already scaffolded:

- serve `GET /.well-known/oauth-protected-resource` (RFC 9728) naming Rails as
  the authorization server
- answer `401` with
  `WWW-Authenticate: Bearer resource_metadata="https://mcp.bannerbear.com/.well-known/oauth-protected-resource"`
- forward the bearer token to the API unchanged
- reject a credential the API rejects, before connecting a client

No change is needed to how it resolves credentials — it already treats the
bearer as opaque and proves it against `/account`.

---

## Suggested order

1. **Decide the API question above.** Everything else depends on it, and it is
   the only decision that is expensive to reverse.
2. Doorkeeper for authorize / token / PKCE / revocation.
3. Write `/oauth/register` yourself. Doorkeeper does not ship it and the
   directory flow does not work without it.
4. Consent screen and workspace picker.
5. Connected-apps revocation UI.
6. MCP server side — a few hours, and testable end to end as soon as 1–3 exist.

## Acceptance

The flow works when, from a clean browser profile, a user can paste
`https://mcp.bannerbear.com` into Claude, approve a consent screen, and call a
tool — without ever seeing an API key. Then revoking from the dashboard should
make the next tool call fail.
