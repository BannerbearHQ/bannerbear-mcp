import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BannerbearClient } from "../client.js";
import {
  AnyLayer,
  LAYER_TYPES,
  LAYER_TYPE_KEYS,
  FRAME_RATES,
  SHARED_LAYER_REFERENCE,
  LAYER_TYPE_REFERENCE,
  MODIFICATION_REFERENCE,
  KEYFRAME_REFERENCE,
  EASINGS,
} from "../generated/schemas.js";
import { fail, guard, ok, pageParam, summariseLayers } from "./common.js";

const layerTypeEnum = z.enum(LAYER_TYPES as unknown as [string, ...string[]]);

/**
 * Layers are declared loosely in the tool schema and validated strictly in the
 * handler. Inlining the full oneOf would put ~45KB of duplicated attributes
 * into every conversation; validating here gives the same correctness with a
 * targeted error message, and get_layer_schema serves the detail on demand.
 */
const AuthoredLayer = z
  .object({
    id: z.string().describe("Unique layer id, referenced by keyframes"),
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
 * `objects`/`scenes` into `config` rather than letting the API ignore them.
 */
function liftIntoConfig<K extends "objects" | "scenes">(body: any, key: K): any {
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
  "Passing config/scenes replaces them wholesale — fetch the template with " +
  "get_template and send back the complete list, or existing layers are lost.";

/** Which layer types accept a given attribute — for "you meant this type" errors. */
const attributeOwners = new Map<string, string[]>();
for (const [type, keys] of Object.entries(LAYER_TYPE_KEYS)) {
  for (const k of keys) {
    attributeOwners.set(k, [...(attributeOwners.get(k) ?? []), type]);
  }
}

/** Validates layers against the per-type schemas, reporting the first failure precisely. */
function validateLayers(layers: unknown[], where: string): string | null {
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

const SceneSchema = z.object({
    uid: z.string().optional().describe("Existing scene UID. Omit to create a new scene."),
    name: z.string().optional().describe("Scene name"),
    sort: z.number().int().optional().describe("Position in the timeline"),
    scene_type: z.enum(["graphic", "video"]).optional(),
    media_url: z.string().optional().describe("Background video URL (video scenes)"),
    play_media_to_end: z
      .boolean()
      .optional()
      .describe("Run the scene for the full length of media_url"),
    objects: z
      .array(AuthoredLayer)
      .optional()
      .describe("Convenience alias for this scene's config.objects"),
    config: z
      .object({
        objects: z.array(AuthoredLayer).optional().describe("Layers on the scene"),
        keyframes: z
          .record(
            z.array(
              z
                .object({
                  delay: z.number().int().min(0).max(10000).optional(),
                  duration: z.number().int().min(0).max(10000).optional(),
                  endDelay: z.number().int().min(0).max(10000).optional(),
                  easing: z.string().optional(),
                })
                .passthrough()
            )
          )
          .optional()
          .describe(
            "Animation keyframes keyed by layer id; each value is an " +
              "ordered array. Timing fields advance the timeline; any " +
              "other attribute sets a target to tween to. See " +
              "get_layer_schema section=keyframes."
          ),
      })
      .optional(),
});

export function registerTemplateTools(
  server: McpServer,
  client: BannerbearClient
) {
  server.registerTool(
    "get_layer_schema",
    {
      title: "Get layer, modification & keyframe schema",
      description:
        `Attribute reference for designing templates. There are ${LAYER_TYPES.length} layer ` +
        `types (${LAYER_TYPES.join(", ")}), each with its own attributes on top ` +
        "of a shared base. Call with a layer_type before creating layers of " +
        "that type.",
      inputSchema: {
        section: z
          .enum(["layers", "modifications", "keyframes"])
          .default("layers")
          .describe(
            "layers = template authoring; modifications = changing an existing " +
              "layer at generation time; keyframes = video animation"
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
            `Used by generate_image / generate_video / create_batch to change a ` +
            `layer that already exists. Target a layer by name or id, then set ` +
            `any of these. Flat across all layer types.\n\n${MODIFICATION_REFERENCE}`
        );
      }

      if (section === "keyframes") {
        return ok(
          `## Keyframe attributes (video only)\n\n` +
            `Keyframes are keyed by layer id, each an ordered array. Timing ` +
            `fields advance the timeline; any other attribute sets a target the ` +
            `layer tweens to over \`duration\` ms.\n\n${KEYFRAME_REFERENCE}\n\n` +
            `### Easings\n${EASINGS.join(", ")}`
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
        "List image or video templates. Returns uid, name, dimensions and a " +
        "layer summary — call get_template for the full canvas config.",
      inputSchema: {
        type: z.enum(["image", "video"]).describe("Which template family to list"),
        ...pageParam,
      },
    },
    async ({ type, page }) =>
      guard(async () => {
        const path = type === "image" ? "/image_templates" : "/video_templates";
        const rows = await client.request<any[]>("GET", path, { query: { page } });
        return (Array.isArray(rows) ? rows : []).map((t) => ({
          uid: t.uid,
          name: t.name,
          width: t.width,
          height: t.height,
          ...(type === "video" ? { frame_rate: t.frame_rate } : {}),
          layers: summariseLayers(t.config),
        }));
      })
  );

  server.registerTool(
    "get_template",
    {
      title: "Get a template",
      description:
        "Fetch one template with its full canvas config — all layers, plus " +
        "scenes and keyframes for video. Use before editing, and to learn the " +
        "layer names to target when generating.",
      inputSchema: {
        type: z.enum(["image", "video"]),
        uid: z.string().describe("Template UID"),
      },
    },
    async ({ type, uid }) =>
      guard(() =>
        client.request(
          "GET",
          `${type === "image" ? "/image_templates" : "/video_templates"}/${uid}`
        )
      )
  );

  server.registerTool(
    "upsert_image_template",
    {
      title: "Create or update an image template",
      description:
        "Create a new image template, or update an existing one by passing " +
        "uid. Image templates render a single static frame — keyframe " +
        "animation is video-only. " +
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
      return guard(() =>
        uid
          ? client.request("PATCH", `/image_templates/${uid}`, { body })
          : client.request("POST", "/image_templates", { body })
      );
    }
  );

  server.registerTool(
    "upsert_video_template",
    {
      title: "Create or update a video template",
      description:
        "Create a new video template, or update an existing one by passing " +
        "uid. Scenes form the ordered timeline; each scene carries its own " +
        "layers and optional animation keyframes, keyed by layer id. " +
        SCHEMA_HINT,
      inputSchema: {
        uid: z
          .string()
          .optional()
          .describe("Omit to create a new template; pass to update an existing one"),
        name: z.string().optional().describe("Template name (required when creating)"),
        description: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        frame_rate: z
          .union(FRAME_RATES.map((f) => z.literal(f)) as any)
          .optional()
          .describe("Frames per second"),
        config: z
          .object({ scenes: z.array(SceneSchema).describe("Ordered scene list") })
          .optional()
          .describe("Full template configuration; replaces the scene list in place"),
        scenes: z
          .array(SceneSchema)
          .optional()
          .describe("Convenience alias for config.scenes"),
      },
    },
    async ({ uid, ...raw }) => {
      if (!uid && !raw.name) return fail("name is required when creating a template");

      let body;
      try {
        // Scenes sit at config.scenes, mirroring image templates' config.objects.
        body = liftIntoConfig(raw, "scenes");
        if (body.config?.scenes) {
          body = {
            ...body,
            config: { ...body.config, scenes: body.config.scenes.map((s: any) => liftIntoConfig(s, "objects")) },
          };
        }
      } catch (err) {
        return fail((err as Error).message);
      }

      for (const [i, scene] of (body.config?.scenes ?? []).entries() as [number, any][]) {
        if (!scene.config?.objects) continue;
        const problem = validateLayers(
          scene.config.objects,
          `config.scenes[${i}].config.objects`
        );
        if (problem) return fail(problem);
      }
      return guard(() =>
        uid
          ? client.request("PATCH", `/video_templates/${uid}`, { body })
          : client.request("POST", "/video_templates", { body })
      );
    }
  );

  server.registerTool(
    "delete_template",
    {
      title: "Delete a template",
      description: "Permanently delete an image or video template.",
      inputSchema: {
        type: z.enum(["image", "video"]),
        uid: z.string().describe("Template UID"),
      },
    },
    async ({ type, uid }) =>
      guard(async () => {
        await client.request(
          "DELETE",
          `${type === "image" ? "/image_templates" : "/video_templates"}/${uid}`
        );
        return { deleted: uid };
      })
  );
}
