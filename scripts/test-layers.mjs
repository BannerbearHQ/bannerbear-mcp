#!/usr/bin/env node
/**
 * Exercises layer validation and the schema reference without touching the API.
 * Uses a bogus key: valid input must fail at the network, invalid input must be
 * rejected locally with a useful message before any request is made.
 */
import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/index.js"], {
  env: { ...process.env, BANNERBEAR_API_KEY: "bb_ak_v5_invalid" },
  stdio: ["pipe", "pipe", "pipe"],
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

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test", version: "0" },
});
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const call = async (name, args) => {
  const { result } = await rpc("tools/call", { name, arguments: args });
  return { text: result.content[0].text, isError: !!result.isError };
};

let failures = 0;
const check = (label, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) {
    failures++;
    console.log(`      ${detail}`);
  }
};

// --- schema reference -------------------------------------------------------
const overview = await call("get_layer_schema", {});
check(
  "overview lists all 11 layer types",
  [
    "text", "rectangle", "rectangle_image_container", "circle",
    "circle_image_container", "image", "svg_shape", "qr_code",
    "bar_code", "rating", "group",
  ].every((t) => overview.text.includes(`\`${t}\``)),
  overview.text.slice(0, 200)
);

const textSchema = await call("get_layer_schema", { layer_type: "text" });
check(
  "text schema has text-specific attributes",
  ["font-family", "text-stroke-width", "letter-spacing"].every((a) =>
    textSchema.text.includes(`\`${a}\``)
  ),
  textSchema.text.slice(0, 200)
);
check(
  "text schema excludes other types' attributes",
  !textSchema.text.includes("`qr-target`") && !textSchema.text.includes("`barcode-data`"),
  "leaked attributes from another layer type"
);

const bar = await call("get_layer_schema", { layer_type: "bar_code" });
check(
  "bar_code schema has barcode attributes",
  ["barcode-data", "barcode-format"].every((a) => bar.text.includes(`\`${a}\``)),
  bar.text.slice(0, 200)
);

const mods = await call("get_layer_schema", { section: "modifications" });
check(
  "modifications section is the flat bag",
  mods.text.includes("`text`") && mods.text.includes("`qr-target`"),
  mods.text.slice(0, 200)
);

const kf = await call("get_layer_schema", { section: "keyframes" });
check(
  "keyframes section lists easings",
  kf.text.includes("easeInOutQuad") && kf.text.includes("`duration`"),
  kf.text.slice(0, 200)
);

// --- protocol robustness ---------------------------------------------------
const omitted = await rpc("tools/call", { name: "get_account" });
check(
  "tools/call with `arguments` omitted is accepted (spec allows it)",
  !omitted.error && /Bannerbear API error/.test(omitted.result?.content?.[0]?.text ?? ""),
  omitted.error ? `protocol error: ${omitted.error.message}` : JSON.stringify(omitted.result)
);

const omittedList = await rpc("tools/call", { name: "list_batches" });
check(
  "paginated list with `arguments` omitted is accepted",
  !omittedList.error,
  omittedList.error ? `protocol error: ${omittedList.error.message}` : "ok"
);

// --- validation -------------------------------------------------------------
const unknownType = await call("upsert_image_template", {
  name: "t",
  config: { objects: [{ id: "a", type: "textbox" }] },
});
check(
  "unknown layer type rejected locally with the valid list",
  /unknown layer type "textbox"|Invalid enum value/.test(unknownType.text) &&
    unknownType.text.includes("svg_shape"),
  unknownType.text
);

const missingType = await call("upsert_image_template", {
  name: "t",
  config: { objects: [{ id: "a", name: "headline" }] },
});
check(
  "missing type rejected locally",
  missingType.isError && /missing required "type"|Required/i.test(missingType.text),
  missingType.text
);

const badIndex = await call("upsert_image_template", {
  name: "t",
  config: {
    objects: [
      { id: "a", type: "text", text: "hi" },
      { id: "b", type: "nope" },
    ],
  },
});
check(
  "error names the offending index",
  badIndex.isError && badIndex.text.includes("config.objects[1]"),
  badIndex.text
);

const badScene = await call("upsert_video_template", {
  name: "v",
  config: { scenes: [{ name: "s1", config: { objects: [{ id: "a", type: "bogus" }] } }] },
});
check(
  "video scene layers validated with scene path",
  badScene.isError && badScene.text.includes("config.scenes[0].config.objects[0]"),
  badScene.text
);

const misplaced = await call("upsert_image_template", {
  name: "t",
  config: { objects: [{ id: "a", type: "text", text: "hi", "qr-target": "https://x" }] },
});
check(
  "attribute from another layer type is caught and attributed",
  misplaced.isError &&
    misplaced.text.includes('"qr-target" is not valid on a "text" layer') &&
    misplaced.text.includes('"qr_code"'),
  misplaced.text
);

const unknownAttr = await call("upsert_image_template", {
  name: "t",
  config: { objects: [{ id: "a", type: "text", text: "hi", "future-attr": 1 }] },
});
check(
  "attribute unknown to the spec is allowed through",
  /Bannerbear API error/.test(unknownAttr.text),
  `expected passthrough to the API, got: ${unknownAttr.text.slice(0, 200)}`
);

const sceneAlias = await call("upsert_video_template", {
  name: "v",
  scenes: [{ name: "s1", objects: [{ id: "a", type: "text", "qr-target": "https://x" }] }],
});
check(
  "top-level scenes + scene objects aliases both lift into config",
  sceneAlias.isError &&
    sceneAlias.text.includes("config.scenes[0].config.objects[0]") &&
    sceneAlias.text.includes('"qr-target" is not valid on a "text" layer'),
  sceneAlias.text
);

const bothScenes = await call("upsert_video_template", {
  name: "v",
  scenes: [{ name: "a" }],
  config: { scenes: [{ name: "b" }] },
});
check(
  "scenes given both ways is rejected",
  bothScenes.isError && bothScenes.text.includes("not both"),
  bothScenes.text
);

const bothShapes = await call("upsert_image_template", {
  name: "t",
  objects: [{ id: "a", type: "text" }],
  config: { objects: [{ id: "b", type: "text" }] },
});
check(
  "layers given as both `objects` and `config.objects` are rejected",
  bothShapes.isError && bothShapes.text.includes("not both"),
  bothShapes.text
);

const aliased = await call("upsert_image_template", {
  name: "t",
  objects: [{ id: "a", type: "text", text: "hi" }, { id: "q", type: "qr_code" }],
});
check(
  "top-level `objects` alias is accepted and validated",
  /Bannerbear API error/.test(aliased.text),
  `expected the alias to normalise and reach the API, got: ${aliased.text.slice(0, 200)}`
);

const aliasedBad = await call("upsert_image_template", {
  name: "t",
  objects: [{ id: "a", type: "text", "qr-target": "https://x" }],
});
check(
  "layers passed via the alias are still validated",
  aliasedBad.isError && aliasedBad.text.includes('"qr-target" is not valid on a "text" layer'),
  aliasedBad.text
);

const missingName = await call("upsert_image_template", {});
check(
  "create without name rejected",
  missingName.isError && missingName.text.includes("name is required"),
  missingName.text
);

// Valid layers must pass validation and reach the API (which rejects the key).
const validLayers = await call("upsert_image_template", {
  name: "t",
  width: 1200,
  height: 630,
  config: {
    objects: [
      { id: "bg", type: "rectangle", "background-color": "#111111" },
      { id: "title", type: "text", text: "Hello", "font-size": 64 },
      { id: "qr", type: "qr_code", "qr-target": "https://bannerbear.com" },
      { id: "logo", type: "image", "background-image": "https://x/y.png" },
      { id: "stars", type: "rating", "rating-score": 4.5, "rating-shape": "star" },
    ],
  },
});
check(
  "valid layers of 5 types pass validation and reach the API",
  validLayers.isError && /Bannerbear API error/.test(validLayers.text),
  `expected an API-level error, got: ${validLayers.text.slice(0, 300)}`
);

console.log(failures ? `\n${failures} failing` : "\nall checks passed");
proc.kill();
process.exit(failures ? 1 : 0);
