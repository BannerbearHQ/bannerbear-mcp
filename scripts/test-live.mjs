#!/usr/bin/env node
/**
 * End-to-end pass against the real API. Requires BANNERBEAR_API_KEY.
 *
 * Creates a template, generates an image from it, then deletes the template.
 * Pass --keep to leave the template behind for inspection.
 */
import { spawn } from "node:child_process";

const KEY = process.env.BANNERBEAR_API_KEY;
if (!KEY) {
  console.error("BANNERBEAR_API_KEY is not set.\n\n  export BANNERBEAR_API_KEY=bb_ak_v5_...");
  process.exit(1);
}
const KEEP = process.argv.includes("--keep");

const proc = spawn("node", ["dist/index.js"], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
  }
});

const rpc = (method, params) =>
  new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6);
    pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

async function call(name, args) {
  const started = Date.now();
  const { result } = await rpc("tools/call", { name, arguments: args ?? {} });
  const ms = Date.now() - started;
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(`${name} failed after ${ms}ms:\n${text}`);
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* markdown reference, not JSON */
  }
  return { data, ms, text };
}

const step = (n, label) => console.log(`\n[${n}] ${label}`);

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "live", version: "0" },
});
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let templateUid = null;
let failed = false;

try {
  step(1, "get_account — verifying the key");
  const acct = await call("get_account");
  console.log(
    `    workspace: ${acct.data.workspace}  plan: ${acct.data.plan}  (${acct.ms}ms)`
  );
  if (acct.data.quota) console.log(`    quota: ${JSON.stringify(acct.data.quota)}`);

  step(2, "list_templates — reading existing image templates");
  const list = await call("list_templates");
  console.log(`    ${list.data.length} template(s) (${list.ms}ms)`);
  for (const t of list.data.slice(0, 3)) {
    console.log(`      ${t.uid}  ${t.name}  ${t.width}x${t.height}`);
  }

  step(3, "upsert_image_template — creating a template with 3 layer types");
  const created = await call("upsert_image_template", {
    name: `MCP live test ${new Date().toISOString()}`,
    width: 1200,
    height: 630,
    config: {
      objects: [
        { id: "bg", type: "rectangle", left: 0, top: 0, width: 1200, height: 630, "background-color": "#0F172A" },
        { id: "title", type: "text", name: "title", left: 80, top: 220, width: 1040, height: 120,
          text: "Generated via MCP", color: "#FFFFFF", "font-size": 72, "text-align": "left" },
        { id: "qr", type: "qr_code", name: "qr", left: 1000, top: 460, width: 120, height: 120,
          "qr-target": "https://bannerbear.com" },
      ],
    },
  });
  templateUid = created.data.uid;
  console.log(`    created ${templateUid} (${created.ms}ms)`);

  step(4, "get_template — reading it back");
  const fetched = await call("get_template", { uid: templateUid });
  // Requests and responses both use config.objects since the API was tightened.
  const layers = fetched.data.config?.objects ?? fetched.data.objects ?? [];
  console.log(`    ${layers.length} layers: ${layers.map((l) => `${l.id}(${l.type})`).join(" ")}`);
  if (layers.length !== 3) {
    console.log(`    response keys: ${Object.keys(fetched.data).join(", ")}`);
    throw new Error(
      `expected 3 layers to persist, got ${layers.length} — layers were dropped on create`
    );
  }
  const types = layers.map((l) => l.type).sort().join(",");
  if (types !== "qr_code,rectangle,text") {
    throw new Error(`layer types came back altered: ${types}`);
  }
  console.log("    round-trip OK — all 3 layers and types preserved");

  step("4b", "upsert with the exact shape get_template returned");
  await call("upsert_image_template", {
    uid: templateUid,
    config: {
      objects: layers.map((l) => (l.type === "text" ? { ...l, text: "Round-tripped" } : l)),
    },
  });
  const after = await call("get_template", { uid: templateUid });
  const afterLayers = after.data.config?.objects ?? after.data.objects ?? [];
  if (afterLayers.length !== 3) {
    throw new Error(
      `sending back the response shape lost layers: ${afterLayers.length} of 3 survived`
    );
  }
  const title = afterLayers.find((l) => l.type === "text");
  console.log(`    ${afterLayers.length} layers survived; title now ${JSON.stringify(title?.text)}`);

  step(5, "generate_image — sync path, modifying the title");
  const img = await call("generate_image", {
    template: templateUid,
    modifications: { objects: [{ name: "title", text: "Hello from the MCP" }] },
  });
  console.log(`    status: ${img.data.status}  (${img.ms}ms)`);
  console.log(`    files: ${JSON.stringify(img.data.files ?? img.data.image_url ?? {})}`);
  if (img.ms < 10_000) {
    console.log(`    → returned under 10s, so this came back on the sync host`);
  } else {
    console.log(`    → exceeded 10s, so the 408 async fallback fired`);
  }
  if (img.data.status !== "completed") {
    throw new Error(`expected status "completed", got "${img.data.status}"`);
  }

  step(6, "list_images — confirming it landed");
  const media = await call("list_images");
  console.log(`    ${Array.isArray(media.data) ? media.data.length : "?"} image(s) in the workspace`);
} catch (err) {
  failed = true;
  console.error(`\nFAILED: ${err.message}`);
} finally {
  if (templateUid && !KEEP) {
    step("cleanup", `deleting template ${templateUid}`);
    try {
      await call("delete_template", { uid: templateUid });
      console.log("    deleted");
    } catch (err) {
      console.error(`    cleanup failed — remove ${templateUid} by hand: ${err.message}`);
    }
  } else if (templateUid) {
    console.log(`\nkept template ${templateUid}`);
  }
  proc.kill();
  console.log(failed ? "\nlive test FAILED" : "\nlive test passed");
  process.exit(failed ? 1 : 0);
}
