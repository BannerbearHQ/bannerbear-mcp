#!/usr/bin/env node
/**
 * Exercises scope filtering against stub tool handles — no network, no server.
 *
 * The important failure mode is disabling a tool that would have worked, so
 * every uncertain path is asserted to leave the surface untouched. A typo in a
 * scope string would do exactly that silently, hence the check against the
 * spec's own enum.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyScopeFilter, TOOL_SCOPES } from "../dist/scopes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const check = (label, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) {
    failures++;
    console.log(`      ${detail}`);
  }
};

const makeTools = () =>
  Object.fromEntries(
    Object.keys(TOOL_SCOPES).map((n) => [
      n,
      {
        enabled: true,
        disable() {
          this.enabled = false;
        },
      },
    ])
  );

const stubClient = (result) => ({
  request: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

const disabledIn = (tools) =>
  Object.entries(tools)
    .filter(([, t]) => !t.enabled)
    .map(([n]) => n)
    .sort();

// --- the scope table matches the spec ---------------------------------------
const spec = JSON.parse(readFileSync(join(root, "spec/openapi.json"), "utf8"));
const specScopes = new Set(
  spec.paths["/account"].get.responses["200"].content["application/json"].schema
    .properties.api_key.properties.scopes.items.enum
);
const used = new Set(Object.values(TOOL_SCOPES));

const unknown = [...used].filter((s) => !specScopes.has(s)).sort();
check(
  "every scope the table uses exists in the spec",
  unknown.length === 0,
  `not in spec: ${unknown.join(", ")}`
);

const unused = [...specScopes].filter((s) => !used.has(s)).sort();
check(
  "every scope the spec defines is claimed by a tool",
  unused.length === 0,
  `no tool requires: ${unused.join(", ")}`
);

check(
  "always-reachable tools are exempt from scoping",
  !("get_account" in TOOL_SCOPES) && !("get_layer_schema" in TOOL_SCOPES),
  "get_account or get_layer_schema is scope-gated but should not be"
);

// --- full access -------------------------------------------------------------
let tools = makeTools();
await applyScopeFilter(stubClient({ api_key: { scopes: [] } }), tools);
check(
  "empty scope array means full access, nothing disabled",
  disabledIn(tools).length === 0,
  `disabled: ${disabledIn(tools).join(", ")}`
);

// --- a genuinely scoped key --------------------------------------------------
tools = makeTools();
await applyScopeFilter(
  stubClient({ api_key: { scopes: ["images:read", "image_templates:read"] } }),
  tools
);
const stillOn = Object.entries(tools)
  .filter(([, t]) => t.enabled)
  .map(([n]) => n)
  .sort();
check(
  "a read-only key keeps exactly its authorized tools",
  JSON.stringify(stillOn) ===
    JSON.stringify(["get_image", "get_template", "list_images", "list_templates"]),
  `still enabled: ${stillOn.join(", ")}`
);
check(
  "a read-only key loses the write tools",
  !tools.generate_image.enabled && !tools.upsert_image_template.enabled,
  "a write tool survived a read-only key"
);

// --- fail-open paths ---------------------------------------------------------
for (const [label, response] of [
  ["/account unreachable", new Error("network down")],
  ["response has no api_key", { workspace: "w" }],
  ["scopes is not an array", { api_key: { scopes: "images:read" } }],
  ["response is empty", undefined],
]) {
  tools = makeTools();
  await applyScopeFilter(stubClient(response), tools);
  check(
    `fails open when ${label}`,
    disabledIn(tools).length === 0,
    `disabled ${disabledIn(tools).length} tools when it should have disabled none`
  );
}

// --- an unmapped tool is never touched ---------------------------------------
tools = makeTools();
tools.some_future_tool = {
  enabled: true,
  disable() {
    this.enabled = false;
  },
};
await applyScopeFilter(stubClient({ api_key: { scopes: ["images:read"] } }), tools);
check(
  "a tool absent from the scope table is left enabled",
  tools.some_future_tool.enabled,
  "an unmapped tool was disabled"
);

console.log(failures ? `\n${failures} failing` : "\nall checks passed");
process.exit(failures ? 1 : 0);
