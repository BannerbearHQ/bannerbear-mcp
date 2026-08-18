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
        "uid. Metadata only — layers and keyframes are authored in the " +
        "dashboard editor and cannot be set through the API, so a new template " +
        "starts empty. Updating is subject to the same api_write_access lock as " +
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
      },
    },
    async ({ uid, ...body }) => {
      if (!uid && !body.name) return fail("name is required when creating a template");
      return guard(() =>
        uid
          ? client.request("PATCH", `/animation_templates/${uid}`, { body })
          : client.request("POST", "/animation_templates", { body })
      );
    }
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
