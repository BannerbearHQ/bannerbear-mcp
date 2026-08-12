import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BannerbearClient } from "../client.js";
import {
  describeError,
  fail,
  guard,
  ok,
  pageParam,
  type ToolResult,
} from "./common.js";

/**
 * Standalone media operations under /tools — they take URLs and return files,
 * with no template involved. Every one is async: POST answers 202 with a
 * pending job, and the result arrives via GET /tool_jobs/{uid}.
 */

/** Jobs run pending → running → completed / failed. Only the last two are terminal. */
const isTerminal = (job: { status?: string }) =>
  job.status === "completed" || job.status === "failed";

/**
 * Sent as part of the body, unlike wait/timeout_seconds which are stripped out
 * before the request — the handler forwards everything it doesn't destructure.
 */
const metadataParam = {
  metadata: z
    .string()
    .optional()
    .describe("Arbitrary string stored with the run and returned on the job"),
};

const asyncParams = (pollByDefault: boolean) => ({
  wait: z
    .boolean()
    .default(pollByDefault)
    .describe(
      "Wait for the job to finish. Set false to get the job uid back " +
        "immediately and poll it yourself with get_tool_job."
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(10)
    .max(900)
    .default(300)
    .describe("How long to poll before handing back the uid to check later"),
});

/**
 * A failed job is reported as a tool error rather than as data. The HTTP call
 * succeeded, so `guard` would call it a success and the model would have to
 * notice `status: "failed"` buried in the payload to know otherwise.
 */
async function runTool(
  client: BannerbearClient,
  slug: string,
  body: Record<string, unknown>,
  wait: boolean,
  timeoutSeconds: number
): Promise<ToolResult> {
  try {
    const job = await client.request<any>("POST", `/tools/${slug}`, { body });
    if (!wait) return ok(job);

    const finished = await client.pollUntilDone<any>(
      `/tool_jobs/${job.uid}`,
      timeoutSeconds * 1000,
      isTerminal
    );
    if (finished.status === "failed") {
      return fail(
        `${slug} job ${finished.uid} failed: ` +
          `${finished.error_message ?? "no reason given"}`
      );
    }
    return ok(finished);
  } catch (err) {
    return fail(describeError(err));
  }
}

const videoUrl = z.string().describe("Video URL");

export interface ToolkitOptions {
  /**
   * Whether the media tools poll to completion by default. False where the
   * process may be recycled mid-job: the work continues at Bannerbear either
   * way, so returning the uid loses nothing while a dropped poll loses a
   * finished render.
   */
  pollByDefault: boolean;
}

export function registerToolkitTools(
  server: McpServer,
  client: BannerbearClient,
  opts: ToolkitOptions
) {
  const shared = asyncParams(opts.pollByDefault);
  const asyncTool = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>
  ) =>
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: { ...inputSchema, ...metadataParam, ...shared },
      },
      async ({ wait, timeout_seconds, ...body }: any) =>
        runTool(client, name, body, wait, timeout_seconds)
    );

  asyncTool(
    "remove_bg",
    "Remove an image background",
    "Cut the subject out of an image and return it on a transparent " +
      "background. Takes a URL — upload_asset first if the image is local.",
    { image_url: z.string().describe("PNG or JPG source URL") }
  );

  asyncTool(
    "create_pdf",
    "Create a multi-page PDF",
    "Stitch JPGs, PNGs and PDFs into one multi-page document, in the order " +
      "given.",
    {
      urls: z
        .array(z.string())
        .min(1)
        .describe("Source URLs — JPG, PNG or PDF. Order is preserved."),
    }
  );

  asyncTool(
    "trim_video",
    "Trim a video",
    "Keep the slice of a video between two timestamps, in seconds.",
    {
      video_url: videoUrl,
      start: z.number().describe("Start time in seconds"),
      end: z.number().describe("End time in seconds"),
    }
  );

  asyncTool(
    "crop_video",
    "Crop a video",
    "Crop a video to an explicit rectangle in pixels.",
    {
      video_url: videoUrl,
      x: z.number().int().describe("Left edge in pixels"),
      y: z.number().int().describe("Top edge in pixels"),
      width: z.number().int().describe("Width in pixels"),
      height: z.number().int().describe("Height in pixels"),
    }
  );

  asyncTool(
    "resize_video",
    "Resize a video",
    "Rescale a video to target dimensions, either cropping to fill or " +
      "letterboxing to fit.",
    {
      video_url: videoUrl,
      width: z.number().int().describe("Target width in pixels"),
      height: z.number().int().describe("Target height in pixels"),
      fit: z
        .enum(["cover", "contain"])
        .optional()
        .describe("cover crops to fill, contain letterboxes to fit"),
    }
  );

  asyncTool(
    "concat_videos",
    "Join videos end-to-end",
    "Join two or more videos into a single file, in the order given.",
    {
      video_urls: z
        .array(z.string())
        .min(2)
        .describe("Two or more video URLs, in play order"),
      width: z.number().int().optional().describe("Output width, defaults to 1280"),
      height: z.number().int().optional().describe("Output height, defaults to 720"),
    }
  );

  asyncTool(
    "overlay_image",
    "Burn an image onto a video",
    "Place a logo, watermark or badge over a video at a fixed position.",
    {
      video_url: videoUrl,
      image_url: z.string().describe("Overlay image URL"),
      x: z.number().int().describe("Left offset in pixels"),
      y: z.number().int().describe("Top offset in pixels"),
      opacity: z.number().min(0).max(1).optional().describe("0.0 to 1.0"),
    }
  );

  asyncTool(
    "overlay_video",
    "Overlay one video on another",
    "Layer a video over a base video as picture-in-picture.",
    {
      base_video_url: z.string().describe("Base video URL"),
      overlay_video_url: z.string().describe("Overlay video URL"),
      x: z.number().int().describe("Left offset in pixels"),
      y: z.number().int().describe("Top offset in pixels"),
      scale: z.number().optional().describe("1.0 keeps the overlay's original size"),
      start: z.number().optional().describe("When the overlay begins, in seconds"),
    }
  );

  asyncTool(
    "add_audio",
    "Add or replace a video's audio",
    "Mix an audio track over a video, or replace the original entirely. " +
      "Pair with generate_voiceover to narrate a clip.",
    {
      video_url: videoUrl,
      audio_url: z.string().describe("Audio URL"),
      mode: z
        .enum(["mix", "replace"])
        .default("mix")
        .describe("mix keeps the original audio underneath; replace discards it"),
      volume: z.number().optional().describe("1.0 is the original level"),
      loop: z
        .enum(["on", "off"])
        .optional()
        .describe("Loop the audio to the video's length. Off for one-shot sounds."),
      ducking: z
        .enum(["off", "subtle", "medium", "heavy"])
        .optional()
        .describe("Dip the new audio under the original. Mix mode only."),
    }
  );

  asyncTool(
    "generate_voiceover",
    "Generate a voiceover",
    "Turn text into spoken audio. Returns an audio URL — feed it to add_audio " +
      "to lay it over a video.",
    {
      text: z.string().max(2000).describe("What the voice should say, up to 2000 characters"),
      voice: z
        .enum([
          "rachel", "adam", "antoni", "bella", "domi",
          "elli", "josh", "arnold", "charlie", "freya",
        ])
        .default("rachel")
        .describe("Pre-made voice. rachel and adam are safe defaults."),
    }
  );

  asyncTool(
    "subtitle_video",
    "Transcribe and burn in subtitles",
    "Auto-transcribe a video's audio and burn styled subtitles onto it. " +
      "Leave language unset to auto-detect, which works well on clear audio.",
    {
      video_url: videoUrl,
      language: z
        .enum([
          "", "en", "es", "fr", "de", "it", "pt", "nl", "ru", "pl",
          "tr", "ar", "hi", "zh", "ja", "ko", "id", "vi", "th",
        ])
        .optional()
        .describe("Spoken language; omit or pass \"\" to auto-detect"),
      font: z
        .enum([
          "inter", "roboto", "open-sans", "noto-sans", "montserrat",
          "poppins", "bebas-neue", "anton", "oswald", "playfair-display",
        ])
        .optional(),
      font_size: z.number().int().optional().describe("Defaults to 28"),
      color: z.string().optional().describe("Text colour, defaults to #ffffff"),
      bold: z.enum(["off", "on"]).optional(),
      italic: z.enum(["off", "on"]).optional(),
      outline_color: z.string().optional().describe("Defaults to #000000"),
      outline_width: z.number().int().optional().describe("0 for no outline"),
      shadow_size: z.number().int().optional().describe("0 for no shadow"),
      shadow_color: z.string().optional().describe("Defaults to #000000"),
      background_style: z
        .enum(["outline", "box", "none"])
        .optional()
        .describe("outline is classic subtitles; box paints a solid panel behind"),
      background_color: z
        .string()
        .optional()
        .describe("Only used when background_style is box"),
      alignment: z
        .enum(["1", "2", "3", "4", "5", "6", "7", "8", "9"])
        .optional()
        .describe("Numpad position, 2 is bottom-centre and the default"),
    }
  );

  asyncTool(
    "create_video_slideshow",
    "Build a slideshow from images",
    "Turn a series of images into an mp4 slideshow, optionally with " +
      "transitions between slides.",
    {
      image_urls: z
        .array(z.string())
        .min(2)
        .describe("Two or more image URLs, in slide order"),
      slide_duration: z.number().optional().describe("Seconds per slide, defaults to 3"),
      transition: z
        .enum(["none", "fade", "dissolve", "wipeleft", "slideleft"])
        .optional()
        .describe("How each slide flows into the next, defaults to none"),
      transition_duration: z
        .number()
        .optional()
        .describe("Seconds, only used when transition is set. Defaults to 1."),
      width: z.number().int().optional().describe("Defaults to 1280"),
      height: z.number().int().optional().describe("Defaults to 720"),
    }
  );

  asyncTool(
    "apply_color_filter",
    "Apply a colour filter to a video",
    "Apply a named colour-grade preset to a video.",
    {
      video_url: videoUrl,
      filter: z
        .enum([
          "black-and-white", "sepia", "invert", "warm", "cool", "vivid",
          "muted", "dark-and-moody", "faded", "vintage", "cross-process",
          "teal-and-orange", "bleach-bypass",
        ])
        .default("vintage")
        .describe("Preset colour grade"),
    }
  );

  asyncTool(
    "soften_video",
    "Soften a video",
    "Smooth skin and flat surfaces while keeping edges sharp.",
    {
      video_url: videoUrl,
      strength: z
        .enum(["subtle", "medium", "strong"])
        .default("medium")
        .describe("How much smoothing to apply"),
    }
  );

  asyncTool(
    "add_cover_art",
    "Set a video's poster image",
    "Embed a still as the video's poster thumbnail. No re-encode, so this is " +
      "quick and lossless.",
    {
      video_url: videoUrl,
      image_url: z.string().describe("Cover image URL"),
    }
  );

  server.registerTool(
    "get_tool_job",
    {
      title: "Get a tool job",
      description:
        "Check a tool run started with wait=false. Returns status, progress " +
        "and — once completed — the output URL under `outputs`.",
      inputSchema: { uid: z.string().describe("Tool job UID") },
    },
    async ({ uid }) => guard(() => client.request("GET", `/tool_jobs/${uid}`))
  );

  server.registerTool(
    "list_tool_jobs",
    {
      title: "List tool jobs",
      description:
        "List tool runs across every tool, newest first, 20 per page — use " +
        "it to find a job whose uid wasn't kept, or to review recent runs and " +
        "their outputs.",
      inputSchema: { ...pageParam },
    },
    async ({ page }) =>
      guard(() => client.request("GET", "/tool_jobs", { query: { page } }))
  );
}
