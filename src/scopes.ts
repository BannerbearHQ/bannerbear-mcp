import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BannerbearClient } from "./client.js";

/**
 * Tools that need no scope, listed so an unmapped tool is a deliberate choice
 * rather than an oversight. `scripts/test-layers.mjs` asserts every registered
 * tool appears here or in TOOL_SCOPES.
 *
 * /account is reachable on any key, and get_layer_schema is served from the
 * generated schema without touching the API.
 */
export const UNSCOPED_TOOLS: ReadonlySet<string> = new Set([
  "get_account",
  "get_layer_schema",
]);

/**
 * The scope each tool needs, from the `api_key.scopes` enum on GET /account.
 * A tool missing from this map is never disabled; see UNSCOPED_TOOLS.
 */
export const TOOL_SCOPES: Record<string, string> = {
  generate_image: "images:write",
  get_image: "images:read",
  list_images: "images:read",

  list_templates: "image_templates:read",
  get_template: "image_templates:read",
  upsert_image_template: "image_templates:write",
  delete_template: "image_templates:write",

  create_batch: "batches:write",
  get_batch: "batches:read",
  list_batches: "batches:read",

  list_webhooks: "webhooks:read",
  get_webhook: "webhooks:read",
  create_webhook: "webhooks:write",
  update_webhook: "webhooks:write",
  delete_webhook: "webhooks:write",

  list_instant_urls: "instant_urls:read",
  get_instant_url: "instant_urls:read",
  create_instant_url: "instant_urls:write",
  update_instant_url: "instant_urls:write",
  delete_instant_url: "instant_urls:write",

  upload_asset: "assets:write",
  get_asset: "assets:read",
  list_assets: "assets:read",
  // A POST, but it only reads existence — mapped to :read on purpose. If the
  // API turns out to gate it on :write, the cost is a visible tool that 403s;
  // the reverse would hide a tool a read-only key could actually use.
  check_assets: "assets:read",

  list_publications: "publications:read",
  get_publication: "publications:read",
  install_publication: "publications:write",

  // Each media tool dispatches a job, so they count as writes; reading a job
  // back is a read. These were unscoped until the spec gained tools:read and
  // tools:write, and a key without them now sees a narrower list rather than
  // a wall of 403s.
  remove_bg: "tools:write",
  create_pdf: "tools:write",
  trim_video: "tools:write",
  crop_video: "tools:write",
  resize_video: "tools:write",
  concat_videos: "tools:write",
  overlay_image: "tools:write",
  overlay_video: "tools:write",
  add_audio: "tools:write",
  generate_voiceover: "tools:write",
  subtitle_video: "tools:write",
  create_video_slideshow: "tools:write",
  apply_color_filter: "tools:write",
  soften_video: "tools:write",
  add_cover_art: "tools:write",
  get_tool_job: "tools:read",
  list_tool_jobs: "tools:read",
};

/**
 * Hides tools the API key isn't authorized for, so a scoped key stops offering
 * calls that could only ever come back 403.
 *
 * Runs after the transport is connected rather than before, so the /account
 * round trip never counts against the client's startup timeout. The tool list
 * is briefly complete and then narrows; `listChanged` (already advertised)
 * tells the client to re-read it.
 *
 * Fails open in every uncertain case — an unreachable /account, an unparseable
 * response, or an empty scope list all leave the full surface enabled. Wrongly
 * hiding a working tool is worse than leaving a 403 to speak for itself.
 */
export async function applyScopeFilter(
  client: BannerbearClient,
  tools: Record<string, RegisteredTool>
): Promise<void> {
  let account: any;
  try {
    account = await client.request("GET", "/account");
  } catch (err) {
    console.error(
      `Could not read API key scopes (${(err as Error).message}). ` +
        "All tools left enabled."
    );
    return;
  }

  const scopes = account?.api_key?.scopes;
  // An empty array means full access, per the spec. A missing or malformed
  // field means we can't tell, which is treated the same way.
  if (!Array.isArray(scopes) || scopes.length === 0) return;

  const held = new Set<string>(scopes);
  const disabled: string[] = [];
  for (const [name, required] of Object.entries(TOOL_SCOPES)) {
    if (held.has(required)) continue;
    const tool = tools[name];
    if (!tool || !tool.enabled) continue;
    tool.disable();
    disabled.push(name);
  }

  if (disabled.length === 0) {
    console.error(`API key scopes cover every tool (${scopes.length} scopes).`);
    return;
  }
  console.error(
    `API key is scoped to ${scopes.join(", ")}. ` +
      `Disabled ${disabled.length} unauthorized tool(s): ${disabled.join(", ")}.`
  );
}
