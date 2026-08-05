#!/usr/bin/env node
/**
 * Exercises layer validation and the schema reference without touching the API.
 * Uses a bogus key: valid input must fail at the network, invalid input must be
 * rejected locally with a useful message before any request is made.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// --- asset upload -----------------------------------------------------------
// Everything the upload tool can know without the network: the file exists, is
// a file, is non-empty, is under the cap, and has a mime type we can name.
const tmp = mkdtempSync(join(tmpdir(), "bb-assets-"));

const missingFile = await call("upload_asset", { path: join(tmp, "nope.png") });
check(
  "upload of a nonexistent path is rejected locally",
  missingFile.isError && missingFile.text.includes("No such file"),
  missingFile.text
);

const dirUpload = await call("upload_asset", { path: tmp });
check(
  "upload of a directory is rejected locally",
  dirUpload.isError && dirUpload.text.includes("Not a file"),
  dirUpload.text
);

const emptyPath = join(tmp, "empty.png");
writeFileSync(emptyPath, "");
const emptyUpload = await call("upload_asset", { path: emptyPath });
check(
  "upload of an empty file is rejected locally",
  emptyUpload.isError && emptyUpload.text.includes("empty"),
  emptyUpload.text
);

const unknownExt = join(tmp, "thing.xyz");
writeFileSync(unknownExt, "data");
const unknownMime = await call("upload_asset", { path: unknownExt });
check(
  "unknown extension asks for content_type rather than guessing",
  unknownMime.isError && unknownMime.text.includes("content_type"),
  unknownMime.text
);
check(
  "that prompt names the accepted types",
  unknownMime.text.includes("image/png") && unknownMime.text.includes("image/webp"),
  unknownMime.text
);

// Recognised, but the endpoint only takes four raster formats.
const svgPath = join(tmp, "logo.svg");
writeFileSync(svgPath, "<svg/>");
const unsupported = await call("upload_asset", { path: svgPath });
check(
  "a recognised but unaccepted format is rejected locally, by name",
  unsupported.isError &&
    unsupported.text.includes("image/svg+xml") &&
    unsupported.text.includes("Accepted types"),
  unsupported.text
);

const badOverride = await call("upload_asset", {
  path: svgPath,
  content_type: "application/pdf",
});
check(
  "content_type outside the accepted list is refused by the tool schema",
  badOverride.isError,
  badOverride.text
);

const overridden = await call("upload_asset", {
  path: unknownExt,
  content_type: "image/png",
});
check(
  "content_type override lets an unknown extension through to the API",
  /Bannerbear API error/.test(overridden.text),
  `expected the override to reach the API, got: ${overridden.text.slice(0, 200)}`
);

const pngPath = join(tmp, "pixel.png");
writeFileSync(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));
const validUpload = await call("upload_asset", { path: pngPath });
check(
  "a real file infers its mime type and reaches the API",
  /Bannerbear API error/.test(validUpload.text),
  `expected an API-level error, got: ${validUpload.text.slice(0, 200)}`
);

rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} failing` : "\nall checks passed");
proc.kill();
process.exit(failures ? 1 : 0);
