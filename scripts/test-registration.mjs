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

console.log(failures ? `\n${failures} failing` : "\nall checks passed");
process.exit(failures ? 1 : 0);
