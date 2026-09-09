import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BannerbearClient } from "../client.js";
import {
  AnyLayer,
  LAYER_TYPES,
  LAYER_TYPE_KEYS,
  SHARED_LAYER_REFERENCE,
  LAYER_TYPE_REFERENCE,
  MODIFICATION_REFERENCE,
} from "../generated/schemas.js";
import {
  fail,
  findGenerativeFields,
  guard,
  ok,
  pageParam,
  summariseTemplate,
} from "./common.js";

const layerTypeEnum = z.enum(LAYER_TYPES as unknown as [string, ...string[]]);

/**
 * Layers are declared loosely in the tool schema and validated strictly in the
 * handler. Inlining the full oneOf would put ~45KB of duplicated attributes
 * into every conversation; validating here gives the same correctness with a
 * targeted error message, and get_layer_schema serves the detail on demand.
 */
const AuthoredLayer = z
  .object({
    id: z.string().describe("Unique layer id"),
    type: layerTypeEnum.describe("Layer type — determines which attributes apply"),
    name: z.string().optional().describe("Layer name — how modifications target it later"),
  })
  .passthrough()
  .describe(
    "A layer on the canvas. Requires id and type; accepts that type's " +
      "attributes. Call get_layer_schema with the layer_type before designing."
  );

/**
 * Requests and responses both use `config` now, so the round trip is safe. The
 * top-level alias is kept as a convenience for hand-written calls: lifts
 * `objects` into `config` rather than letting the API ignore it.
 */
function liftIntoConfig(body: any, key: "objects"): any {
  const value = body?.[key];
  if (value === undefined) return body;
  const { [key]: _lifted, ...rest } = body;
  if (rest.config?.[key]) {
    throw new Error(
      `Pass ${key} either as \`config.${key}\` or as top-level \`${key}\`, not both.`
    );
  }
  return { ...rest, config: { ...rest.config, [key]: value } };
}

const SCHEMA_HINT =
  "Call get_layer_schema first for the attributes of each layer type. " +
  "Passing config replaces it wholesale — fetch the template with " +
  "get_template and send back the complete list, or existing layers are lost.";

/** Which layer types accept a given attribute — for "you meant this type" errors. */
const attributeOwners = new Map<string, string[]>();
for (const [type, keys] of Object.entries(LAYER_TYPE_KEYS)) {
  for (const k of keys) {
    attributeOwners.set(k, [...(attributeOwners.get(k) ?? []), type]);
  }
}

/**
 * Validates layers against the per-type schemas, reporting the first failure
 * precisely. Exported because animation templates now carry the same Layer
 * union, and a second implementation would drift from this one.
 */
export function validateLayers(layers: unknown[], where: string): string | null {
  for (const [i, layer] of layers.entries()) {
    const at = `${where}[${i}]`;
    const type = (layer as any)?.type;

    if (!type) return `${at}: missing required "type". Expected one of: ${LAYER_TYPES.join(", ")}.`;
    if (!LAYER_TYPES.includes(type)) {
      return `${at}: unknown layer type "${type}". Expected one of: ${LAYER_TYPES.join(", ")}.`;
    }

    const result = AnyLayer.safeParse(layer);
    if (!result.success) {
      const issue = result.error.issues[0];
      return (
        `${at} (type "${type}"): ${issue.message} at ${issue.path.join(".") || "(root)"}. ` +
        `Call get_layer_schema with layer_type "${type}" for the valid attributes.`
      );
    }

    // Layers are passthrough, so a misplaced attribute would otherwise reach the
    // API silently. Only flag attributes the spec assigns to a *different* type;
    // genuinely unknown ones are left alone in case the spec is behind the API.
    const allowed = LAYER_TYPE_KEYS[type];
    for (const attr of Object.keys(layer as object)) {
      if (allowed.includes(attr)) continue;
      const owners = attributeOwners.get(attr);
      if (!owners) continue;
      return (
        `${at}: "${attr}" is not valid on a "${type}" layer — it belongs to ` +
        `${owners.map((o) => `"${o}"`).join(", ")}. Call get_layer_schema with ` +
        `layer_type "${type}" for the attributes it does accept.`
      );
    }
  }
  return null;
}

export interface TemplateOptions {
  /**
   * Whether a layer may carry an AI generation prompt. Gating only the
   * generation tools would be theatre: a prompt saved onto the template
   * generates on every later render, with no modification involved.
   */
  allowGenerative: boolean;
}

export function registerTemplateTools(
  server: McpServer,
  client: BannerbearClient,
  opts: TemplateOptions = { allowGenerative: true }
) {
  server.registerTool(
    "get_layer_schema",
    {
      title: "Get layer & modification schema",
      description:
        `Attribute reference for designing templates. There are ${LAYER_TYPES.length} layer ` +
        `types (${LAYER_TYPES.join(", ")}), each with its own attributes on top ` +
        "of a shared base. Call with a layer_type before creating layers of " +
        "that type.",
      inputSchema: {
        section: z
          .enum(["layers", "modifications"])
          .default("layers")
          .describe(
            "layers = template authoring; modifications = changing an existing " +
              "layer at generation time"
          ),
        layer_type: layerTypeEnum
          .optional()
          .describe(
            "With section=layers, return the full attribute set for this type. " +
              "Omit for an overview of all types."
          ),
      },
    },
    async ({ section, layer_type }) => {
      if (section === "modifications") {
        return ok(
          `## Modification attributes (${MODIFICATION_REFERENCE.split("\n").length})\n\n` +
            `Used by generate_image / create_batch to change a ` +
            `layer that already exists. Target a layer by name or id, then set ` +
            `any of these. Flat across all layer types.\n\n${MODIFICATION_REFERENCE}`
        );
      }

      const shared =
        `## Shared attributes\n\nPresent on every layer type, alongside the ` +
        `required \`id\` and \`type\`.\n\n${SHARED_LAYER_REFERENCE}`;

      if (!layer_type) {
        const overview = LAYER_TYPES.map((t) => {
          const own = LAYER_TYPE_REFERENCE[t];
          const count = own.startsWith("_") ? 0 : own.split("\n").length;
          return `- \`${t}\` — ${count} attributes beyond the shared base`;
        }).join("\n");
        return ok(
          `## Layer types\n\n${overview}\n\nCall again with a layer_type for its ` +
            `full attribute list.\n\n${shared}`
        );
      }

      return ok(
        `## Layer type \`${layer_type}\`\n\n### Attributes specific to this type\n\n` +
          `${LAYER_TYPE_REFERENCE[layer_type]}\n\n${shared}`
      );
    }
  );

  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description:
        "List image templates. Returns uid, name, dimensions, creation time, " +
        "a preview image URL and a layer summary — call get_template for the " +
        "full canvas config. The endpoint documents no ordering, so sort by " +
        "created_at rather than assuming the first row is the newest.",
      inputSchema: { ...pageParam },
    },
    async ({ page }) =>
      guard(async () => {
        const rows = await client.request<any[]>("GET", "/image_templates", {
          query: { page },
        });
        return (Array.isArray(rows) ? rows : []).map(summariseTemplate);
      })
  );

  server.registerTool(
    "get_template",
    {
      title: "Get a template",
      description:
        "Fetch one template with its full canvas config — every layer. Use " +
        "before editing, and to learn the layer names to target when " +
        "generating.",
      inputSchema: { uid: z.string().describe("Template UID") },
    },
    async ({ uid }) => guard(() => client.request("GET", `/image_templates/${uid}`))
  );

  server.registerTool(
    "upsert_image_template",
    {
      title: "Create or update an image template",
      description:
        "Create a new image template, or update an existing one by passing " +
        "uid. Updating can be refused by the template's own lock: " +
        "`api_write_access` of `owner_only` restricts writes to the creator's " +
        "keys, and `nobody` blocks the API entirely until it's unlocked in the " +
        "dashboard. get_template reports it. " +
        SCHEMA_HINT,
      inputSchema: {
        uid: z
          .string()
          .optional()
          .describe("Omit to create a new template; pass to update an existing one"),
        name: z.string().optional().describe("Template name (required when creating)"),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        width: z.number().int().optional().describe("Canvas width in pixels"),
        height: z.number().int().optional().describe("Canvas height in pixels"),
        config: z
          .object({ objects: z.array(AuthoredLayer).describe("Layers on the canvas") })
          .optional()
          .describe("Full canvas configuration; replaces the existing config in place"),
        objects: z
          .array(AuthoredLayer)
          .optional()
          .describe("Convenience alias for config.objects"),
      },
    },
    async ({ uid, ...raw }) => {
      if (!uid && !raw.name) return fail("name is required when creating a template");

      let body;
      try {
        body = liftIntoConfig(raw, "objects");
      } catch (err) {
        return fail((err as Error).message);
      }

      if (body.config?.objects) {
        const problem = validateLayers(body.config.objects, "config.objects");
        if (problem) return fail(problem);
      }
      if (!opts.allowGenerative && body.config?.objects) {
        const problem = findGenerativeFields(body.config.objects, "config.objects");
        if (problem) return fail(problem);
      }
      return guard(() =>
        uid
          ? client.request("PATCH", `/image_templates/${uid}`, { body })
          : client.request("POST", "/image_templates", { body })
      );
    }
  );

  server.registerTool(
    "delete_template",
    {
      title: "Delete a template",
      description:
        "Permanently delete an image template. Subject to the same " +
        "`api_write_access` lock as updating: `owner_only` restricts this to " +
        "the creator's keys, `nobody` blocks it until unlocked in the dashboard.",
      inputSchema: { uid: z.string().describe("Template UID") },
    },
    async ({ uid }) =>
      guard(async () => {
        await client.request("DELETE", `/image_templates/${uid}`);
        return { deleted: uid };
      })
  );
}
