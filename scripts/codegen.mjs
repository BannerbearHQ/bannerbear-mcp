#!/usr/bin/env node
/**
 * Generates src/generated/schemas.ts from spec/openapi.json.
 *
 * Two distinct layer shapes exist and must not be conflated:
 *
 *   - Authoring (template config.objects) — a oneOf over 11 typed layer
 *     schemas discriminated by `type`. Each type has its own attribute set.
 *   - Modifications (images/batches) — one flat attribute bag, since a
 *     modification targets a layer that already exists and already has a type.
 *
 * The 11 authoring schemas share 31 base attributes; those are emitted once and
 * spread into each type rather than repeated eleven times.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "spec/openapi.json"), "utf8"));

/** Follows a local $ref chain to the schema it points at. */
function deref(node) {
  let seen = 0;
  while (node && typeof node.$ref === "string") {
    if (++seen > 10) throw new Error(`circular $ref at ${node.$ref}`);
    const path = node.$ref.replace(/^#\//, "").split("/");
    node = path.reduce((acc, k) => acc?.[k], spec);
  }
  return node;
}

/** Reads a dotted path, dereferencing at every hop. */
function at(node, path) {
  return path.split(".").reduce((acc, k) => deref(deref(acc)?.[k]), node);
}

const body = (path, method = "post") =>
  deref(spec.paths[path][method].requestBody.content["application/json"].schema);

// --- Authoring layers -------------------------------------------------------
// config.objects.items is a $ref to the Layer union, which carries the
// discriminator. Deref so this keeps working whether it is inlined or referenced.
const objectsItems = at(body("/image_templates"), "properties.config.properties.objects.items");
const discriminator = objectsItems?.discriminator;
if (!discriminator?.mapping) {
  console.error("FATAL: config.objects lost its `type` discriminator.");
  process.exit(1);
}

/** type value -> component name, e.g. "qr_code" -> "LayerQrCode" */
const typeToComponent = Object.fromEntries(
  Object.entries(discriminator.mapping).map(([t, ref]) => [t, ref.split("/").pop()])
);

// Take the concrete layer schemas from the discriminator mapping, not a name
// prefix — the union component is itself named `Layer` and has no properties of
// its own, so matching on the name would silently pull in an empty schema.
const layerSchemas = Object.fromEntries(
  Object.values(typeToComponent).map((component) => {
    const def = deref(spec.components?.schemas?.[component]);
    if (!def?.properties) {
      console.error(`FATAL: layer component ${component} has no properties.`);
      process.exit(1);
    }
    return [component, def];
  })
);

// Attributes present on every layer type: emitted once, spread into each.
const propSets = Object.fromEntries(
  Object.entries(layerSchemas).map(([n, d]) => [n, Object.keys(d.properties ?? {})])
);
const sharedKeys = Object.values(propSets)[0].filter((k) =>
  Object.values(propSets).every((keys) => keys.includes(k))
);
// `type` is per-layer literal, not shared boilerplate.
const baseKeys = sharedKeys.filter((k) => k !== "type");

// --- Modifications ----------------------------------------------------------
const imageMods = at(body("/images"), "properties.modifications.properties.objects.items");
const batchMods = at(
  body("/batches"),
  "properties.items.items.properties.modifications.properties.objects.items"
);

const fingerprint = (s) => JSON.stringify(Object.keys(s.properties).sort());
if (fingerprint(imageMods) !== fingerprint(batchMods)) {
  console.error(
    "FATAL: modification schemas diverged between images and batches.\n" +
      "The single canonical definition is no longer valid — inspect the spec."
  );
  process.exit(1);
}

const imageFormats = body("/images").properties.formats.items.enum;

// --- Emit -------------------------------------------------------------------
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

function zodFor(name, def, { required = false } = {}) {
  let z;
  if (Array.isArray(def.enum) && def.enum.length === 1) {
    z = `z.literal(${JSON.stringify(def.enum[0])})`;
  } else if (Array.isArray(def.enum) && def.enum.length) {
    const allString = def.enum.every((v) => typeof v === "string");
    z = allString
      ? `z.enum([${def.enum.map((v) => `"${esc(v)}"`).join(", ")}])`
      : `z.union([${def.enum.map((v) => `z.literal(${JSON.stringify(v)})`).join(", ")}])`;
  } else {
    switch (def.type) {
      case "integer":
        z = "z.number().int()";
        if (typeof def.minimum === "number") z += `.min(${def.minimum})`;
        if (typeof def.maximum === "number") z += `.max(${def.maximum})`;
        break;
      case "number":
        z = "z.number()";
        break;
      case "boolean":
        z = "z.boolean()";
        break;
      case "array":
        z = "z.array(z.any())";
        break;
      case "object":
        z = "z.record(z.any())";
        break;
      default:
        z = "z.string()";
    }
  }
  if (def.description) z += `.describe("${esc(def.description)}")`;
  if (!required) z += ".optional()";
  return `${key(name)}: ${z},`;
}

const shapeFrom = (props, keys, required = []) =>
  keys
    .map((k) => "  " + zodFor(k, props[k], { required: required.includes(k) }))
    .join("\n");

/** Compact markdown used by get_layer_schema. */
const reference = (props, keys) =>
  keys
    .map((k) => {
      const d = props[k] ?? {};
      const t = d.enum ? d.enum.join(" | ") : d.type || "string";
      return `- \`${k}\` (${t})${d.description ? ` — ${d.description}` : ""}`;
    })
    .join("\n");

const baseProps = layerSchemas[Object.keys(layerSchemas)[0]].properties;

const layerBlocks = Object.entries(typeToComponent)
  .map(([typeValue, component]) => {
    const def = layerSchemas[component];
    const props = def.properties ?? {};
    const own = Object.keys(props).filter((k) => !sharedKeys.includes(k));
    return `export const ${component} = z.object({
  ...layerBaseShape,
  type: z.literal(${JSON.stringify(typeValue)}),
${shapeFrom(props, own, def.required ?? [])}
}).passthrough();`;
  })
  .join("\n\n");

const perTypeReference = Object.fromEntries(
  Object.entries(typeToComponent).map(([typeValue, component]) => {
    const props = layerSchemas[component].properties ?? {};
    const own = Object.keys(props).filter((k) => !sharedKeys.includes(k));
    return [
      typeValue,
      own.length
        ? reference(props, own)
        : "_No attributes beyond the shared base._",
    ];
  })
);

const modProps = imageMods.properties;

const out = `// GENERATED BY scripts/codegen.mjs — DO NOT EDIT BY HAND.
// Regenerate with: npm run codegen
import { z } from "zod";

/** Layer type values, from the config.objects discriminator. */
export const LAYER_TYPES = ${JSON.stringify(Object.keys(typeToComponent))} as const;
export type LayerType = (typeof LAYER_TYPES)[number];

/** The ${baseKeys.length} attributes every layer type shares. */
export const layerBaseShape = {
${shapeFrom(baseProps, baseKeys, ["id"])}
} as const;

${layerBlocks}

/** Authoring layer — validated by \`type\`. */
export const AnyLayer = z.discriminatedUnion("type", [
${Object.values(typeToComponent).map((c) => `  ${c},`).join("\n")}
]);

/**
 * Modification attribute bag (${Object.keys(modProps).length} attributes).
 * Verified identical across /images and /batches at codegen time.
 * Flat by design: modifications target a layer that already has a type.
 */
export const modificationShape = {
${shapeFrom(modProps, Object.keys(modProps))}
} as const;

export const LayerModification = z.object(modificationShape).passthrough();

export const IMAGE_FORMATS = ${JSON.stringify(imageFormats)} as const;

/**
 * Attributes each layer type accepts. Used to catch attributes that belong to a
 * different layer type, without rejecting ones the spec simply hasn't caught up
 * with yet.
 */
export const LAYER_TYPE_KEYS: Record<string, readonly string[]> = ${JSON.stringify(
  Object.fromEntries(
    Object.entries(typeToComponent).map(([t, c]) => [
      t,
      Object.keys(layerSchemas[c].properties ?? {}),
    ])
  ),
  null,
  2
)};

// --- Markdown references served by get_layer_schema -------------------------
export const SHARED_LAYER_REFERENCE = ${JSON.stringify(reference(baseProps, baseKeys))};
export const LAYER_TYPE_REFERENCE: Record<string, string> = ${JSON.stringify(perTypeReference, null, 2)};
export const MODIFICATION_REFERENCE = ${JSON.stringify(reference(modProps, Object.keys(modProps)))};
`;

// src/generated is gitignored, so it does not exist in a fresh clone.
mkdirSync(join(root, "src/generated"), { recursive: true });
writeFileSync(join(root, "src/generated/schemas.ts"), out);
console.log(
  `generated src/generated/schemas.ts\n` +
    `  ${Object.keys(typeToComponent).length} layer types: ${Object.keys(typeToComponent).join(", ")}\n` +
    `  ${baseKeys.length} shared base attributes\n` +
    `  ${Object.keys(modProps).length} modification attributes`
);
