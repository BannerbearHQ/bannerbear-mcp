import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BannerbearError, type BannerbearClient } from "../client.js";
import {
  ANIMATION_FORMATS,
  ANIMATION_FRAME_RATES,
} from "../generated/schemas.js";
import {
  describeError,
  fail,
  findGenerativeFields,
  guard,
  ok,
  pageParam,
  summariseTemplate,
  type ToolResult,
} from "./common.js";
import { progressReporter } from "./toolkit.js";
import { validateLayers } from "./templates.js";

/**
 * Animations render from their own template family, keyframed in the dashboard.
 *
 * The split matters: unlike image templates, the API manages animation template
 * *metadata* only — name, dimensions, frame rate. Layers and keyframes are
 * authored in the editor, so there is no equivalent of upsert_image_template's
 * config.objects here, and offering one would invite silent no-ops.
 */

const isTerminal = (animation: { status?: string }) =>
  animation.status === "completed" || animation.status === "failed";

const LayerModification = z
  .object({
    name: z.string().optional().describe("Layer name to target (use name or id, not both)"),
    id: z.string().optional().describe("Layer ID to target (use name or id, not both)"),
  })
  .passthrough()
  .describe(
    "Layer modification. Target a layer by name or id, then set any layer " +
      "attribute. Call get_layer_schema for the full list, or " +
      "get_animation_template to see which layers this template has."
  );

export interface AnimationOptions {
  allowGenerative: boolean;
}

export function registerAnimationTools(
  server: McpServer,
  client: BannerbearClient,
  opts: AnimationOptions = { allowGenerative: true }
) {
  server.registerTool(
    "generate_animation",
    {
      title: "Generate an animation",
      description:
        "Render an animation from an animation template. Duration comes from " +
        "the template's keyframes rather than being set per render. Async, so " +
        "this polls until the file is ready.",
      inputSchema: {
        template: z.string().describe("Animation template UID"),
        modifications: z
          .object({
            objects: z.array(LayerModification).optional().describe("Per-layer modifications"),
          })
          .describe("Layer modifications"),
        formats: z
          .array(z.enum(ANIMATION_FORMATS as unknown as [string, ...string[]]))
          .optional()
          .describe("Output formats (defaults to mp4)"),
        metadata: z.string().optional().describe("Arbitrary string echoed back on the result"),
        wait: z
          .boolean()
          .default(true)
          .describe("Wait for the finished file, or return a uid immediately"),
        timeout_seconds: z
          .number()
          .int()
          .min(10)
          .max(900)
          .default(300)
          .describe("How long to poll before handing back the uid to check later"),
      },
    },
    async ({ wait, timeout_seconds, ...body }, extra): Promise<ToolResult> => {
      if (!opts.allowGenerative) {
        const problem = findGenerativeFields(
          (body as any)?.modifications?.objects,
          "modifications.objects"
        );
        if (problem) return fail(problem);
      }
      const onProgress = progressReporter(extra);
      try {
        const queued = await client.request<any>("POST", "/animations", { body });
        if (!wait) return ok(queued);

        const finished = await client.pollUntilDone<any>(
          `/animations/${queued.uid}`,
          timeout_seconds * 1000,
          isTerminal,
          onProgress &&
            ((state) =>
              onProgress(typeof state.progress === "number" ? state.progress : 0))
        );
        if (finished.status === "failed") {
          return fail(
            `Animation ${finished.uid} failed: ${finished.error ?? "no reason given"}`
          );
        }
        return ok(finished);
      } catch (err) {
        if (err instanceof BannerbearError && err.status === 504 && err.body) {
          return ok(err.body);
        }
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "get_animation",
    {
      title: "Get an animation",
      description:
        "Retrieve a previously generated animation by uid — use this to check " +
        "on one queued without waiting.",
      inputSchema: { uid: z.string() },
    },
    async ({ uid }) => guard(() => client.request("GET", `/animations/${uid}`))
  );

  server.registerTool(
    "list_animations",
    {
      title: "List animations",
      description: "List previously generated animations.",
      inputSchema: { ...pageParam },
    },
    async ({ page }) =>
      guard(() => client.request("GET", "/animations", { query: { page } }))
  );

  server.registerTool(
    "list_animation_templates",
    {
      title: "List animation templates",
      description:
        "List animation templates — uid, name, dimensions, frame rate, " +
        "duration, creation time, a preview and a layer summary.",
      inputSchema: { ...pageParam },
    },
    async ({ page }) =>
      guard(async () => {
        const rows = await client.request<any[]>("GET", "/animation_templates", {
          query: { page },
        });
        return (Array.isArray(rows) ? rows : []).map((t) => ({
          ...summariseTemplate(t),
          frame_rate: t?.frame_rate,
          duration_seconds: t?.duration_seconds,
        }));
      })
  );

  server.registerTool(
    "get_animation_template",
    {
      title: "Get an animation template",
      description:
        "Fetch one animation template with its full config — the layers and " +
        "keyframes to target when generating.",
      inputSchema: { uid: z.string().describe("Animation template UID") },
    },
    async ({ uid }) =>
      guard(() => client.request("GET", `/animation_templates/${uid}`))
  );

  server.registerTool(
    "upsert_animation_template",
    {
      title: "Create or update an animation template",
      description:
        "Create a new animation template, or update an existing one by passing " +
        "uid. Pass config to set layers and keyframes; omit it to change only " +
        "the metadata. config replaces wholesale, so fetch the template first " +
        "and send back the complete canvas when editing. For ordinary entrance " +
        "and exit animations, animate_template is easier and cannot corrupt a " +
        "timeline by omission. Subject to the same api_write_access lock as " +
        "image templates.",
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
        frame_rate: z
          .union(ANIMATION_FRAME_RATES.map((f) => z.literal(f)) as any)
          .optional()
          .describe("Frames per second"),
        config: z
          .object({
            objects: z
              .array(z.record(z.any()))
              .optional()
              .describe("Layers on the canvas — same shape as an image template"),
            keyframes: z
              .record(z.any())
              .optional()
              .describe(
                "Animation keyframes, keyed by layer id. Drives the animation " +
                  "and determines the duration."
              ),
          })
          .optional()
          .describe(
            "Canvas configuration, replaced wholesale. Omit to leave the " +
              "existing config untouched — sending a partial config discards " +
              "whatever you left out."
          ),
      },
    },
    async ({ uid, ...body }) => {
      if (!uid && !body.name) return fail("name is required when creating a template");
      if ((body as any).config?.objects) {
        const problem = validateLayers((body as any).config.objects, "config.objects");
        if (problem) return fail(problem);
      }
      if (!opts.allowGenerative && (body as any).config?.objects) {
        const problem = findGenerativeFields((body as any).config.objects, "config.objects");
        if (problem) return fail(problem);
      }
      return guard(() =>
        uid
          ? client.request("PATCH", `/animation_templates/${uid}`, { body })
          : client.request("POST", "/animation_templates", { body })
      );
    }
  );

  server.registerTool(
    "animate_template",
    {
      title: "Animate a template with a preset",
      description:
        "Apply a named animation preset to a template's layers, optionally " +
        "staggered so they start one after another. Deterministic and free — " +
        "no model call, no AI credits, and the same request always produces " +
        "the same keyframes. Prefer this over hand-writing keyframes through " +
        "upsert_animation_template whenever the request is an ordinary " +
        "entrance or exit.",
      inputSchema: {
        uid: z.string().describe("Animation template UID"),
        preset: z
          .enum([
            "FadeIn", "FadeOut", "ZoomIn", "ZoomOut", "GetBigger",
            "GetSmaller", "ScaleIn", "ScaleOut", "PopIn", "PopOut",
          ])
          .describe(
            "PopIn and PopOut are measured in em and apply to text layers " +
              "only; the rest work on any layer"
          ),
        objects: z
          .array(z.string())
          .optional()
          .describe(
            "Layer ids, in the order the stagger should run. Omit to animate " +
              "every layer."
          ),
        duration: z
          .number()
          .int()
          .optional()
          .describe("How long each layer's tween runs, in ms. Defaults to 400."),
        stagger: z
          .number()
          .int()
          .optional()
          .describe(
            "Milliseconds between each layer's start. At 500, layers begin at " +
              "0, 500, 1000. Defaults to 0, meaning all at once."
          ),
        easing: z
          .string()
          .optional()
          .describe("Optional anime.js easing, e.g. easeOutCubic"),
        merge: z
          .boolean()
          .optional()
          .describe(
            "Keep keyframes on layers this call does not touch. Defaults to " +
              "false, which replaces the whole timeline — pass true when adding " +
              "to an existing animation rather than starting over."
          ),
      },
    },
    async ({ uid, ...body }) =>
      guard(() =>
        client.request("POST", `/animation_templates/${uid}/animate`, { body })
      )
  );

  server.registerTool(
    "delete_animation_template",
    {
      title: "Delete an animation template",
      description:
        "Permanently delete an animation template. Subject to the same " +
        "api_write_access lock as updating.",
      inputSchema: { uid: z.string().describe("Animation template UID") },
    },
    async ({ uid }) =>
      guard(async () => {
        await client.request("DELETE", `/animation_templates/${uid}`);
        return { deleted: uid };
      })
  );
}
