#!/usr/bin/env node
/** Drives the built server over stdio and reports the tool surface. */
import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/index.js"], {
  env: { ...process.env, BANNERBEAR_API_KEY: "bb_ak_v5_smoketest" },
  stdio: ["pipe", "pipe", "pipe"],
});

const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");
let buf = "";
const pending = new Map();

proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});

const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6);
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
console.log("server:", JSON.stringify(init.result.serverInfo));

send({ jsonrpc: "2.0", method: "notifications/initialized" });

const { result } = await rpc("tools/list", {});
const tools = result.tools;
console.log(`\ntools: ${tools.length}\n`);

let total = 0;
for (const t of tools) {
  const bytes = JSON.stringify(t).length;
  total += bytes;
  const props = Object.keys(t.inputSchema?.properties ?? {}).length;
  console.log(
    `  ${t.name.padEnd(24)} ${String(props).padStart(3)} params  ${String(bytes).padStart(6)} B`
  );
}
console.log(
  `\ntotal tool-definition payload: ${total} B  (~${Math.round(total / 3.5)} tokens)`
);

// Report what each slice of the schema reference costs when pulled on demand.
const slices = [
  ["overview", {}],
  ["layer_type=text", { layer_type: "text" }],
  ["modifications", { section: "modifications" }],
  ["keyframes", { section: "keyframes" }],
];
console.log("\nget_layer_schema (pulled on demand):");
for (const [label, args] of slices) {
  const { result } = await rpc("tools/call", {
    name: "get_layer_schema",
    arguments: args,
  });
  const text = result.content[0].text;
  console.log(
    `  ${label.padEnd(20)} ${String(text.length).padStart(6)} B  ` +
      `${String((text.match(/^- `/gm) || []).length).padStart(3)} attributes` +
      (result.isError ? "  ** ERROR **" : "")
  );
}

proc.kill();
