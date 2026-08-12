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
import { createServer } from "../dist/server.js";
import { RateWindow, isRateLimitedMethod } from "../dist/client.js";

let failures = 0;
const check = (label, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) {
    failures++;
    console.log(`      ${detail}`);
  }
};

const build = (over) =>
  Object.keys(
    createServer({
      apiKey: "bb_ak_v5_test",
      filesystemTools: true,
      pollMediaJobs: true,
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
}).handles;
const hostedHandles = createServer({
  apiKey: "bb_ak_v5_test",
  filesystemTools: false,
  pollMediaJobs: false,
}).handles;

check(
  "stdio polls media jobs to completion by default",
  waitDefault(localHandles, "trim_video") === true,
  `got ${waitDefault(localHandles, "trim_video")}`
);

check(
  "hosted returns the job uid instead of holding a poll",
  waitDefault(hostedHandles, "trim_video") === false,
  `got ${waitDefault(hostedHandles, "trim_video")}`
);

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
