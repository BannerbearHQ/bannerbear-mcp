#!/usr/bin/env node
/**
 * Asserts what each deployment shape registers.
 *
 * The filesystem gate is the reason this file exists. upload_asset and
 * check_assets resolve a caller-supplied path on the machine running the
 * server; hosted, that machine is not the caller's, so registering them would
 * let any authenticated user read this box's disk — upload_asset copies the
 * bytes into their workspace and hands back a CDN URL, and check_assets still
 * confirms existence and contents by hash. The failure is silent and severe
 * enough that it should not depend on review.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, resolveGroups } from "../dist/server.js";
import { RateWindow, isRateLimitedMethod } from "../dist/client.js";
import { TOOL_SCOPES } from "../dist/scopes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const check = (label, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) {
    failures++;
    console.log(`      ${detail}`);
  }
};

// These checks are about the capability gates, not the profile, so they ask
// for every group — the default is a curated subset and most of what they
// assert lives outside it.
const build = (over) =>
  Object.keys(
    createServer({
      apiKey: "bb_ak_v5_test",
      filesystemTools: true,
      pollMediaJobs: true,
      groups: resolveGroups("all"),
      ...over,
    }).handles
  );

const local = build({});
const hosted = build({ filesystemTools: false, pollMediaJobs: false });

const DISK_TOOLS = ["upload_asset", "check_assets"];

check(
  "stdio registers the filesystem tools",
  DISK_TOOLS.every((n) => local.includes(n)),
  `missing: ${DISK_TOOLS.filter((n) => !local.includes(n)).join(", ")}`
);

check(
  "hosted registers neither filesystem tool",
  DISK_TOOLS.every((n) => !hosted.includes(n)),
  `leaked into hosted: ${DISK_TOOLS.filter((n) => hosted.includes(n)).join(", ")}`
);

check(
  "hosted keeps the asset tools that touch no disk",
  ["get_asset", "list_assets"].every((n) => hosted.includes(n)),
  `hosted is missing: ${["get_asset", "list_assets"].filter((n) => !hosted.includes(n)).join(", ")}`
);

check(
  "the two shapes differ by exactly the filesystem tools",
  hosted.length === local.length - DISK_TOOLS.length,
  `local ${local.length}, hosted ${hosted.length}`
);

// A hosted process can be recycled mid-job, so the media tools hand back a uid
// rather than holding a poll that would be lost with the process.
const waitDefault = (tools, name) =>
  tools[name].inputSchema?.shape?.wait?._def?.defaultValue?.() ??
  tools[name].inputSchema?.shape?.wait?.parse?.(undefined);

const localHandles = createServer({
  apiKey: "bb_ak_v5_test",
  filesystemTools: true,
  pollMediaJobs: true,
  groups: resolveGroups("all"),
}).handles;
const hostedHandles = createServer({
  apiKey: "bb_ak_v5_test",
  filesystemTools: false,
  pollMediaJobs: false,
  groups: resolveGroups("all"),
}).handles;

// Test the mechanism, not today's policy: both deployments poll now, but the
// option is what a short-lived host would reach for, so it has to actually
// drive the default rather than being decorative.
check(
  "pollMediaJobs true makes the media tools wait",
  waitDefault(localHandles, "trim_video") === true,
  `got ${waitDefault(localHandles, "trim_video")}`
);

check(
  "pollMediaJobs false makes them return the uid instead",
  waitDefault(hostedHandles, "trim_video") === false,
  `got ${waitDefault(hostedHandles, "trim_video")}`
);

// --- listing keeps enough to answer "which is newest?" -----------------------
// Summarising a template is necessary — the full record is thousands of lines —
// but dropping created_at made that question unanswerable without fetching
// every template one by one, and the endpoint documents no ordering to fall
// back on.
{
  const { summariseTemplate } = await import("../dist/tools/common.js");
  const row = summariseTemplate({
    uid: "abc",
    name: "Promo",
    width: 1200,
    height: 700,
    created_at: "2026-08-12T02:13:24.393Z",
    preview: "https://images.example.com/preview.jpg",
    description: null,
    config: { objects: [{ name: "title", type: "text", text: "Hello" }] },
  });

  check(
    "a listed template carries created_at and preview",
    row.created_at === "2026-08-12T02:13:24.393Z" &&
      row.preview === "https://images.example.com/preview.jpg",
    JSON.stringify(row)
  );
  check(
    "identity and dimensions survive too",
    row.uid === "abc" && row.name === "Promo" && row.width === 1200 && row.height === 700,
    JSON.stringify(row)
  );
  check(
    "the layer summary stays condensed rather than full config",
    Array.isArray(row.layers) &&
      row.layers.length === 1 &&
      typeof row.layers[0] === "string" &&
      row.layers[0].includes("title"),
    JSON.stringify(row.layers)
  );
  check(
    "a template missing fields summarises without throwing",
    (() => {
      const bare = summariseTemplate({ uid: "x" });
      return bare.uid === "x" && Array.isArray(bare.layers) && bare.layers.length === 0;
    })(),
    "an incomplete record broke the summariser"
  );
}

// --- every /tools endpoint has a tool, and vice versa ------------------------
// The media family grows a few at a time, and a missing one is invisible: the
// server just quietly doesn't offer it. Comparing against tools:write catches
// both directions, since every dispatcher carries that scope and nothing else
// does.
{
  const spec = JSON.parse(readFileSync(join(root, "spec/openapi.json"), "utf8"));
  const endpoints = Object.keys(spec.paths)
    .filter((p) => p.startsWith("/tools/"))
    .map((p) => p.slice("/tools/".length))
    .sort();
  const dispatchers = Object.entries(TOOL_SCOPES)
    .filter(([, scope]) => scope === "tools:write")
    .map(([name]) => name)
    .sort();

  const unimplemented = endpoints.filter((s) => !dispatchers.includes(s));
  check(
    "every /tools endpoint in the spec has a tool",
    unimplemented.length === 0,
    `no tool for: ${unimplemented.join(", ")}`
  );

  const orphaned = dispatchers.filter((n) => !endpoints.includes(n));
  check(
    "every media tool still has an endpoint behind it",
    orphaned.length === 0,
    `no endpoint for: ${orphaned.join(", ")}`
  );

  check(
    "and each one is actually registered",
    endpoints.every((s) => local.includes(s)),
    `not registered: ${endpoints.filter((s) => !local.includes(s)).join(", ")}`
  );
}

// --- a long job reports progress instead of going silent ---------------------
// The API returns 0-100 on every poll. Forwarding it is what a client needs to
// show something during a job that runs for minutes, and progress notifications
// also reset the request timeout in clients that implement that.
{
  const { progressReporter } = await import("../dist/tools/toolkit.js");
  const { BannerbearClient } = await import("../dist/client.js");

  const sent = [];
  const report = progressReporter({
    _meta: { progressToken: "tok-1" },
    sendNotification: async (n) => {
      sent.push(n);
    },
  });
  report(42);
  await new Promise((r) => setTimeout(r, 20));
  check(
    "a progress token produces a spec-shaped notification",
    sent.length === 1 &&
      sent[0].method === "notifications/progress" &&
      sent[0].params.progressToken === "tok-1" &&
      sent[0].params.progress === 42 &&
      sent[0].params.total === 100,
    JSON.stringify(sent)
  );

  check(
    "no token, no sender, or no extra means no reporter at all",
    progressReporter({ sendNotification: async () => {} }) === undefined &&
      progressReporter({ _meta: { progressToken: "x" } }) === undefined &&
      progressReporter(undefined) === undefined,
    "a reporter was built without something to report to"
  );

  // The poll loop has to actually call it, once per intermediate state and not
  // for the terminal one.
  const client = new BannerbearClient({ apiKey: "bb_ak_v5_test" });
  const states = [
    { status: "pending", progress: 0 },
    { status: "running", progress: 50 },
    { status: "completed", progress: 100 },
  ];
  let i = 0;
  client.request = async () => states[i++];
  const seen = [];
  const done = await client.pollUntilDone(
    "/tool_jobs/x",
    10_000,
    (s) => s.status === "completed" || s.status === "failed",
    (s) => seen.push(s.progress)
  );
  check(
    "the poll loop reports each intermediate state, not the last",
    JSON.stringify(seen) === "[0,50]" && done.status === "completed",
    `saw ${JSON.stringify(seen)}, finished ${done.status}`
  );
}

// --- tool groups -------------------------------------------------------------
// Every tool definition is spent on every conversation whether it gets used or
// not, so a deployment that never touches video shouldn't carry seventeen video
// tools. The failure to guard against is a typo silently serving a smaller
// surface, which looks like a broken server rather than a config mistake.
{
  const { resolveGroups, TOOL_GROUPS } = await import("../dist/server.js");
  const size = (groups) =>
    Object.keys(
      createServer({
        apiKey: "bb_ak_v5_test",
        filesystemTools: true,
        pollMediaJobs: true,
        groups,
      }).handles
    ).length;


  const dflt = size(resolveGroups(undefined));
  const everything = size(resolveGroups("all"));
  check(
    "the default is a curated set, not everything",
    dflt === size(resolveGroups("default")) && dflt < everything && dflt > 10,
    `default ${dflt}, all ${everything}`
  );

  // The default has to be able to do the obvious thing end to end: prove a
  // credential, design a template, render from it, run a workflow.
  const inDefault = Object.keys(
    createServer({
      apiKey: "bb_ak_v5_test",
      filesystemTools: true,
      pollMediaJobs: true,
      groups: resolveGroups(undefined),
    }).handles
  );
  const essential = [
    "get_account",
    "list_templates",
    "upsert_image_template",
    "generate_image",
    "create_batch",
    "list_workflows",
    "run_workflow",
  ];
  check(
    "the default covers designing, rendering and running a workflow",
    essential.every((n) => inDefault.includes(n)),
    `missing: ${essential.filter((n) => !inDefault.includes(n)).join(", ")}`
  );

  check(
    "and leaves out what is configured once or composed by workflows",
    ["create_webhook", "create_instant_url", "trim_video", "generate_animation"].every(
      (n) => !inDefault.includes(n)
    ),
    `unexpectedly present: ${["create_webhook", "create_instant_url", "trim_video", "generate_animation"].filter((n) => inDefault.includes(n)).join(", ")}`
  );

  check(
    "nothing is unreachable — all still registers every group",
    everything > 50 && resolveGroups("all").length === TOOL_GROUPS.length,
    `${everything} tools across ${resolveGroups("all").length} groups`
  );

  const workflows = size(resolveGroups("workflows"));
  check(
    "the workflows profile is the workflow tools plus a credential check",
    workflows === 6,
    `${workflows} tools`
  );

  check(
    "a profile shadows its group, and <group>_only reaches past it",
    size(resolveGroups("workflows_only")) === 5 && workflows === 6,
    `workflows_only ${size(resolveGroups("workflows_only"))}, workflows ${workflows}`
  );

  check(
    "workspace is split, so account comes without the setup tools",
    size(resolveGroups("account")) === 1,
    `account group registers ${size(resolveGroups("account"))} tools`
  );

  check(
    "an explicit list registers only those groups",
    size(resolveGroups("templates,generation")) < workflows + 10,
    `${size(resolveGroups("templates,generation"))} tools`
  );

  check(
    "order and spacing in the list don't matter",
    JSON.stringify(resolveGroups("generation, templates")) ===
      JSON.stringify(resolveGroups("templates,generation")),
    "the same groups in a different order gave a different result"
  );

  let refused = false;
  try {
    resolveGroups("templates,typo");
  } catch (err) {
    refused = err.message.includes("typo") && err.message.includes("templates");
  }
  check(
    "an unknown group is refused, and the error names the valid ones",
    refused,
    "a typo was silently ignored instead of refused"
  );

  check(
    "every group in the profile map is a real group",
    ["all", "default", "workflows"].every((p) =>
      resolveGroups(p).every((g) => TOOL_GROUPS.includes(g))
    ),
    "a profile references a group that does not exist"
  );
}

// --- a credential whose scopes match nothing ---------------------------------
// This is what "no actions available" looks like from a client: not an error,
// just an almost-empty tool list. Worth pinning down, since the two causes —
// a scope mismatch and a broken server — look identical from outside.
{
  const { filterToolsByScopes } = await import("../dist/scopes.js");
  const build = () =>
    createServer({
      apiKey: "bb_ak_v5_test",
      filesystemTools: false,
      pollMediaJobs: true,
      groups: resolveGroups("all"),
    }).handles;

  const enabled = (h) => Object.values(h).filter((t) => t.enabled).length;

  const unrelated = build();
  filterToolsByScopes(["videos:read", "videos:write"], unrelated);
  check(
    "scopes no tool requires leave only the ungated tools",
    enabled(unrelated) === 2,
    `${enabled(unrelated)} tools left`
  );

  const empty = build();
  const before = enabled(empty);
  const disabled = filterToolsByScopes([], empty);
  check(
    "an empty scope list means full access, not zero access",
    disabled.length === 0 && enabled(empty) === before,
    `disabled ${disabled.length}, ${enabled(empty)} of ${before} left`
  );

  const partial = build();
  filterToolsByScopes(["images:read"], partial);
  check(
    "a narrow but valid scope leaves exactly its tools",
    enabled(partial) === 4,
    `${enabled(partial)} tools left`
  );
}

// --- OAuth discovery ---------------------------------------------------------
// A client arriving with no credential has to be able to find its way to one.
// The 401 names the metadata document, the document names the authorization
// server; break either link and the only route left is a human pasting a key.
{
  const { resourceMetadata, challenge } = await import("../dist/http.js");
  const meta = resourceMetadata("mcp.bannerbear.com");

  check(
    "metadata identifies this resource and where to authenticate",
    meta.resource === "https://mcp.bannerbear.com" &&
      Array.isArray(meta.authorization_servers) &&
      meta.authorization_servers.length === 1,
    JSON.stringify(meta)
  );

  check(
    "the 401 challenge points at the metadata document",
    challenge("mcp.bannerbear.com") ===
      'Bearer resource_metadata="https://mcp.bannerbear.com/.well-known/oauth-protected-resource"',
    challenge("mcp.bannerbear.com")
  );

  // The advertised scopes are what this server actually enforces, so a consent
  // screen built from them grants exactly what the tool filter reads back.
  const enforced = [...new Set(Object.values(TOOL_SCOPES))].sort();
  check(
    "advertised scopes are the ones the tools are gated on",
    JSON.stringify(meta.scopes_supported) === JSON.stringify(enforced),
    `advertised ${JSON.stringify(meta.scopes_supported)}`
  );

  check(
    "no scope is advertised that no tool requires",
    meta.scopes_supported.every((s) => enforced.includes(s)),
    "an unenforceable scope is being advertised"
  );
}

// --- a deployment can answer to more than one hostname -----------------------
// Comparing a proxied hostname against the origin's own is how a proxy problem
// is told apart from an origin one, and the rebinding check has to allow both
// for that comparison to be possible.
{
  const { hostsFromEnv } = await import("../dist/http.js");
  check(
    "a single host still works",
    JSON.stringify(hostsFromEnv("mcp.example.com")) === '["mcp.example.com"]',
    JSON.stringify(hostsFromEnv("mcp.example.com"))
  );
  check(
    "several hosts are accepted, whitespace and all",
    JSON.stringify(hostsFromEnv(" mcp.example.com , app.herokuapp.com ")) ===
      '["mcp.example.com","app.herokuapp.com"]',
    JSON.stringify(hostsFromEnv(" mcp.example.com , app.herokuapp.com "))
  );
  check(
    "an unset or empty value falls back to localhost",
    JSON.stringify(hostsFromEnv(undefined)) === '["localhost"]' &&
      JSON.stringify(hostsFromEnv("")) === '["localhost"]' &&
      JSON.stringify(hostsFromEnv(" , ")) === '["localhost"]',
    "empty handling is wrong"
  );
}

// --- a bad key never gets a client ------------------------------------------
// /account answers on any valid key regardless of scope, so a 401 from it means
// the key itself is bad. Anything else is not proof, and refusing service
// because the API had a bad minute would be the worse failure.
{
  const { authenticateKey } = await import("../dist/http.js");
  const { BannerbearError } = await import("../dist/client.js");

  const stub = (behaviour) => {
    let calls = 0;
    return {
      calls: () => calls,
      request: async () => {
        calls++;
        if (behaviour instanceof Error) throw behaviour;
        return behaviour;
      },
    };
  };

  const rejected = stub(new BannerbearError("Invalid API Key", 401));
  const bad = await authenticateKey(rejected, "bb_ak_v5_bad");
  check(
    "a 401 from /account rejects the key",
    bad.ok === false,
    JSON.stringify(bad)
  );

  const flaky = stub(new BannerbearError("upstream exploded", 503));
  const unproven = await authenticateKey(flaky, "bb_ak_v5_unproven");
  check(
    "a 5xx leaves the key unproven and allowed, unfiltered",
    unproven.ok === true && unproven.scopes === null,
    JSON.stringify(unproven)
  );

  const offline = stub(new BannerbearError("Network error", 0));
  const stillIn = await authenticateKey(offline, "bb_ak_v5_offline");
  check(
    "a network failure does not lock a valid key out",
    stillIn.ok === true,
    JSON.stringify(stillIn)
  );

  const good = stub({ api_key: { scopes: ["images:read"] } });
  const first = await authenticateKey(good, "bb_ak_v5_good");
  check(
    "a valid key is accepted and its scopes returned",
    first.ok === true && JSON.stringify(first.scopes) === '["images:read"]',
    JSON.stringify(first)
  );

  await authenticateKey(good, "bb_ak_v5_good");
  check(
    "the result is cached rather than re-fetched per request",
    good.calls() === 1,
    `/account was called ${good.calls()} times`
  );

  const full = stub({ api_key: { scopes: [] } });
  const unrestricted = await authenticateKey(full, "bb_ak_v5_full");
  check(
    "an empty scope list means full access, not zero access",
    unrestricted.ok === true && unrestricted.scopes === null,
    JSON.stringify(unrestricted)
  );
}

// --- logs carry no credentials -----------------------------------------------
// Every request to the hosted server carries a live key in its Authorization
// header, and logs leave the process — to the platform's store and onward to
// any drain. A key in a log line is a key handed to a third party.
{
  const { redact, logError } = await import("../dist/observability.js");

  const swept = JSON.stringify(
    redact({
      message: "POST /images failed for bb_ak_v5_SECRET",
      nested: ["bb_ak_v5_SECRET"],
      deep: { k: "bb_ak_v5_SECRET" },
    })
  );
  check(
    "no key survives redaction, at any depth",
    !swept.includes("bb_ak_v5_SECRET") && swept.includes("[redacted]"),
    swept
  );
  check(
    "the surrounding message is kept",
    swept.includes("POST /images failed"),
    swept
  );

  // logError writes to stderr; capture it to check what actually goes out.
  const original = console.error;
  const written = [];
  console.error = (line) => written.push(String(line));
  try {
    logError("request failed", new Error("boom for bb_ak_v5_SECRET"), {
      url: "/?key=bb_ak_v5_SECRET",
    });
  } finally {
    console.error = original;
  }

  check(
    "logError emits exactly one line",
    written.length === 1 && !written[0].includes("\n"),
    `wrote ${written.length} line(s)`
  );
  check(
    "that line is valid JSON and carries no key",
    (() => {
      try {
        const parsed = JSON.parse(written[0]);
        return (
          parsed.what === "request failed" &&
          !written[0].includes("bb_ak_v5_SECRET") &&
          written[0].includes("[redacted]")
        );
      } catch {
        return false;
      }
    })(),
    written[0]
  );
}

// --- only POST is metered ----------------------------------------------------
// Polling is all GETs and is the highest-frequency traffic the client makes;
// counting it would throttle a render behind its own status checks.
check(
  "POST counts against the window",
  isRateLimitedMethod("POST") && isRateLimitedMethod("post"),
  "POST was not treated as metered"
);
check(
  "reads and updates do not count",
  ["GET", "PATCH", "DELETE", "PUT"].every((m) => !isRateLimitedMethod(m)),
  `unexpectedly metered: ${["GET", "PATCH", "DELETE", "PUT"].filter(isRateLimitedMethod).join(", ")}`
);

// --- the rate window is shared, not per client -------------------------------
// The API counts per key. A server is built per request in hosted mode, so a
// window that isn't shared would restart empty every time and never throttle.
{
  const window = new RateWindow(2, 200);
  const started = Date.now();
  await window.acquire();
  await window.acquire();
  const beforeThird = Date.now() - started;
  await window.acquire();
  const afterThird = Date.now() - started;

  check(
    "a window admits up to its limit without waiting",
    beforeThird < 100,
    `first two acquires took ${beforeThird}ms`
  );
  check(
    "the next acquire waits for the window to roll over",
    afterThird >= 200,
    `third acquire completed after ${afterThird}ms, expected >= 200`
  );
}

{
  // Two servers for the same key share one window, so the second sees the
  // first's traffic rather than starting fresh.
  const shared = new RateWindow(2, 200);
  const opts = {
    apiKey: "bb_ak_v5_test",
    filesystemTools: false,
    pollMediaJobs: false,
    rateWindow: shared,
  };
  createServer(opts);
  createServer(opts);
  await shared.acquire();
  await shared.acquire();
  const started = Date.now();
  await shared.acquire();
  check(
    "servers built separately can share one window",
    Date.now() - started >= 200,
    "the shared window did not throttle across instances"
  );
}

console.log(failures ? `\n${failures} failing` : "\nall checks passed");
process.exit(failures ? 1 : 0);
