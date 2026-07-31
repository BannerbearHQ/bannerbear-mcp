import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BannerbearClient, SyncTimeoutError } from "../client.js";
import { IMAGE_FORMATS } from "../generated/schemas.js";
import { guard, pageParam } from "./common.js";

/**
 * Modification targets are kept as open objects rather than expanding all 103
 * attributes again — the same set is already expanded on the template authoring
 * tools, and get_layer_schema serves the full reference on demand. Expanding it
 * here too would triple the cost of every conversation for no new information.
 */
const LayerModification = z
  .object({
    name: z.string().optional().describe("Layer name to target (use name or id, not both)"),
    id: z.string().optional().describe("Layer ID to target (use name or id, not both)"),
  })
  .passthrough()
  .describe(
    "Layer modification. Target a layer by name or id, then set any layer " +
      "attribute (text, color, background-image, hidden, …). Call " +
      "get_layer_schema for the full attribute list, or get_template to see " +
      "which layers this template actually has."
  );

const ImageModifications = z.object({
  template: z
    .object({
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      transparent: z.boolean().optional().describe("Render with a transparent background"),
    })
    .optional()
    .describe("Template-level overrides"),
  objects: z.array(LayerModification).optional().describe("Per-layer modifications"),
});

const imageCreateShape = {
  template: z.string().describe("Template UID"),
  modifications: ImageModifications.describe("Template and layer modifications"),
  formats: z
    .array(z.enum(IMAGE_FORMATS as unknown as [string, ...string[]]))
    .optional()
    .describe("Output file formats (defaults to jpg)"),
  scale: z.number().optional().describe("Output scale multiplier"),
  dpi: z.number().int().optional(),
  quality: z.number().int().optional(),
  proxy: z.string().optional(),
  metadata: z.string().optional().describe("Arbitrary string echoed back on the result"),
  version: z.number().int().optional(),
};

export function registerGenerationTools(
  server: McpServer,
  client: BannerbearClient
) {
  server.registerTool(
    "generate_image",
    {
      title: "Generate an image",
      description:
        "Render an image from a template and return the finished file URLs. " +
        "Uses the synchronous endpoint so most images come back in this one " +
        "call; slow renders fall back to async polling automatically.",
      inputSchema: {
        ...imageCreateShape,
        wait: z
          .boolean()
          .default(true)
          .describe(
            "Wait for the finished image. Set false to queue it and return a " +
              "uid immediately."
          ),
      },
    },
    async ({ wait, ...body }) =>
      guard(async () => {
        if (!wait) {
          return client.request("POST", "/images", { body });
        }
        try {
          return await client.request("POST", "/images", { body, sync: true });
        } catch (err) {
          // 10s ceiling on the sync host — re-submit async and poll it out.
          if (!(err instanceof SyncTimeoutError)) throw err;
          const queued = await client.request<any>("POST", "/images", { body });
          return client.pollUntilDone(`/images/${queued.uid}`);
        }
      })
  );

  server.registerTool(
    "generate_video",
    {
      title: "Generate a video",
      description:
        "Render a video from a video template. Videos have no synchronous " +
        "endpoint, so this queues the job and polls until it finishes.",
      inputSchema: {
        template: z.string().describe("Video template UID"),
        modifications: z
          .object({
            template: z
              .object({
                width: z.number().int().optional(),
                height: z.number().int().optional(),
                fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
              })
              .optional(),
            scenes: z
              .array(
                z
                  .object({
                    name: z.string().optional().describe("Scene name to target"),
                    id: z.string().optional().describe("Scene ID to target"),
                    media_url: z.string().optional(),
                    play_media_to_end: z.boolean().optional(),
                    objects: z.array(LayerModification).optional(),
                  })
                  .passthrough()
              )
              .optional()
              .describe("Per-scene overrides, targeted by scene name or id"),
          })
          .describe("Template, scene and layer modifications"),
        metadata: z.string().optional(),
        wait: z
          .boolean()
          .default(true)
          .describe("Wait for the finished video, or return a uid immediately"),
        timeout_seconds: z
          .number()
          .int()
          .min(10)
          .max(900)
          .default(300)
          .describe("How long to poll before returning the uid to check later"),
      },
    },
    async ({ wait, timeout_seconds, ...body }) =>
      guard(async () => {
        const queued = await client.request<any>("POST", "/videos", { body });
        if (!wait) return queued;
        return client.pollUntilDone(`/videos/${queued.uid}`, timeout_seconds * 1000);
      })
  );

  server.registerTool(
    "get_media",
    {
      title: "Get an image or video",
      description:
        "Retrieve a previously generated image or video by uid — use this to " +
        "check on a job that was queued without waiting.",
      inputSchema: {
        type: z.enum(["image", "video"]),
        uid: z.string(),
      },
    },
    async ({ type, uid }) =>
      guard(() => client.request("GET", `/${type}s/${uid}`))
  );

  server.registerTool(
    "list_media",
    {
      title: "List images or videos",
      description: "List previously generated images or videos, newest first.",
      inputSchema: {
        type: z.enum(["image", "video"]),
        ...pageParam,
      },
    },
    async ({ type, page }) =>
      guard(() => client.request("GET", `/${type}s`, { query: { page } }))
  );

  server.registerTool(
    "create_batch",
    {
      title: "Create a batch of images",
      description:
        "Queue up to 100 images in a single request. Returns the batch uid; " +
        "poll it with get_batch.",
      inputSchema: {
        items: z
          .array(z.object(imageCreateShape).partial({ formats: true }))
          .min(1)
          .max(100)
          .describe("Image payloads, max 100"),
        wait: z
          .boolean()
          .default(false)
          .describe("Poll until every image in the batch finishes"),
      },
    },
    async ({ items, wait }) =>
      guard(async () => {
        const batch = await client.request<any>("POST", "/batches", {
          body: { type: "images", items },
        });
        if (!wait) return batch;
        return client.pollUntilDone(`/batches/${batch.uid}`, 600_000);
      })
  );

  server.registerTool(
    "get_batch",
    {
      title: "Get a batch",
      description: "Retrieve a batch and the status of its images.",
      inputSchema: { uid: z.string() },
    },
    async ({ uid }) => guard(() => client.request("GET", `/batches/${uid}`))
  );

  server.registerTool(
    "list_batches",
    {
      title: "List batches",
      description: "List previously created batches.",
      inputSchema: { ...pageParam },
    },
    async ({ page }) => guard(() => client.request("GET", "/batches", { query: { page } }))
  );
}
