import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BannerbearClient } from "../client.js";
import { ASSET_MIME_TYPES } from "../generated/schemas.js";
import { fail, guard, pageParam } from "./common.js";

const ACCEPTED = new Set<string>(ASSET_MIME_TYPES);
const ACCEPTED_LIST = ASSET_MIME_TYPES.join(", ");

/**
 * Documented cap on POST /assets. Checked locally so an oversized file fails
 * immediately with its actual size, rather than after pushing the whole body
 * up to get a bare 413 back.
 */
const MAX_ASSET_BYTES = 5 * 1024 * 1024;

/**
 * Node has no built-in mime lookup, and the API stores whatever Content-Type it
 * is handed and serves the CDN URL with it — so a wrong guess here is visible to
 * every later consumer of that URL. Unknown extensions are refused rather than
 * defaulting to application/octet-stream, with `content_type` as the escape
 * hatch.
 *
 * Deliberately wider than ASSET_MIME_TYPES: recognising `.svg` as an image the
 * API won't take produces a far better error than failing to recognise it at
 * all. Acceptance is checked separately, against the generated list.
 */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export function registerAssetTools(server: McpServer, client: BannerbearClient) {
  server.registerTool(
    "upload_asset",
    {
      title: "Upload a local file",
      description:
        "Upload an image from this machine and get back a durable CDN URL to " +
        "use in a template layer or modification (background-image, image, " +
        "avatar, …). Only needed for files that live on disk — anything " +
        "already reachable at a public URL can be referenced directly without " +
        `uploading. Accepts ${ACCEPTED_LIST}, max 5MB. Uploading the same ` +
        "bytes twice is safe: the workspace deduplicates by content hash and " +
        "returns the existing asset instead of a duplicate, without counting " +
        "against the trial account limit of 20 assets. To skip the transfer " +
        "entirely for files that are already stored, call check_assets first.",
      inputSchema: {
        path: z
          .string()
          .describe("Path to the file on this machine, absolute or relative to the server's cwd"),
        content_type: z
          .enum(ASSET_MIME_TYPES as unknown as [string, ...string[]])
          .optional()
          .describe(
            "Mime type override. Inferred from the file extension when omitted; " +
              "needed for extensions the server doesn't recognise."
          ),
      },
    },
    async ({ path, content_type }) => {
      const abs = resolve(path);

      let info;
      try {
        info = await stat(abs);
      } catch {
        return fail(`No such file: ${abs}`);
      }
      if (!info.isFile()) return fail(`Not a file: ${abs}`);

      // The API answers 400 on an empty body and 413 over the cap. Both are
      // knowable here, and the local message can name the file and its size.
      if (info.size === 0) return fail(`File is empty: ${abs}`);
      if (info.size > MAX_ASSET_BYTES) {
        const mb = (info.size / 1024 / 1024).toFixed(1);
        return fail(`${abs} is ${mb} MB, over the 5 MB upload cap.`);
      }

      const ext = extname(abs).toLowerCase();
      const mime = content_type ?? MIME_BY_EXT[ext];
      if (!mime) {
        return fail(
          `Could not infer a mime type for "${ext || basename(abs)}". ` +
            `Pass content_type explicitly (one of: ${ACCEPTED_LIST}).`
        );
      }
      // Recognised but not uploadable — the API answers 415. Say which format
      // it is and what would work, rather than letting the round trip do it.
      if (!ACCEPTED.has(mime)) {
        return fail(
          `${basename(abs)} is ${mime}, which the assets endpoint does not ` +
            `accept. Accepted types: ${ACCEPTED_LIST}.`
        );
      }

      const data = await readFile(abs);
      return guard(() =>
        client.request("POST", "/assets", { raw: { data, contentType: mime } })
      );
    }
  );

  server.registerTool(
    "check_assets",
    {
      title: "Check which local files are already uploaded",
      description:
        "Given local file paths, report which are already stored in this " +
        "workspace and which still need uploading. Hashes each file here and " +
        "batch-checks the hashes, so nothing is transferred — use it before a " +
        "run of uploads to skip files that are already there. Returns the CDN " +
        "URL for the ones that exist, so a hit needs no further call. " +
        "Max 100 files.",
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe("Paths to files on this machine, absolute or relative to the server's cwd"),
      },
    },
    async ({ paths }) => {
      // Validate every path before hashing any of it, and report all the bad
      // ones at once — failing a 100-file check one typo at a time is miserable.
      const resolved = paths.map((p) => resolve(p));
      const problems: string[] = [];
      for (const abs of resolved) {
        try {
          const info = await stat(abs);
          if (!info.isFile()) problems.push(`Not a file: ${abs}`);
        } catch {
          problems.push(`No such file: ${abs}`);
        }
      }
      if (problems.length) return fail(problems.join("\n"));

      // Sequential so peak memory stays at one file rather than all 100.
      const hashes: string[] = [];
      for (const abs of resolved) {
        hashes.push(createHash("sha256").update(await readFile(abs)).digest("hex"));
      }

      return guard(async () => {
        const found = await client.request<Record<string, unknown>>(
          "POST",
          "/assets/check",
          // Duplicate paths would send a duplicate hash; the response is keyed
          // by hash either way, so collapse them before asking.
          { body: { content_hashes: [...new Set(hashes)] } }
        );
        return resolved.map((abs, i) => {
          const asset = found?.[hashes[i]] ?? null;
          return {
            path: abs,
            content_hash: hashes[i],
            uploaded: asset !== null,
            asset,
          };
        });
      });
    }
  );

  server.registerTool(
    "get_asset",
    {
      title: "Get an asset",
      description: "Retrieve one uploaded asset by uid, including its CDN URL.",
      inputSchema: { uid: z.string() },
    },
    async ({ uid }) => guard(() => client.request("GET", `/assets/${uid}`))
  );

  server.registerTool(
    "list_assets",
    {
      title: "List assets",
      description:
        "List files uploaded by this workspace, newest first — use it to find " +
        "the CDN URL of something uploaded earlier instead of uploading again.",
      inputSchema: { ...pageParam },
    },
    async ({ page }) =>
      guard(() => client.request("GET", "/assets", { query: { page } }))
  );
}
