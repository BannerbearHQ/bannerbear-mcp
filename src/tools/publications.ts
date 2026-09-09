import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BannerbearClient } from "../client.js";
import { guard, pageParam } from "./common.js";
import {
  PUBLICATION_CATEGORIES,
  PUBLICATION_KINDS,
} from "../generated/schemas.js";

/**
 * The public library. Browsing it is discovery — the one thing here a
 * conversation does better than the dashboard, since the model can read a
 * request like "something for a product launch" and turn it into a filter.
 *
 * The filter vocabulary is generated from the spec rather than typed out, so a
 * new category lands with a rebuild instead of silently matching nothing. Both
 * enums are inlined into the schema on purpose: the category values are not
 * guessable (lowercase, ampersands, "food & drinks" not "Food and Drink"), so
 * spelling them out costs ~200 tokens and saves a wasted call every time.
 */
export function registerPublicationTools(
  server: McpServer,
  client: BannerbearClient
) {
  server.registerTool(
    "list_publications",
    {
      title: "Browse the public template library",
      description:
        "Browse publicly shared publications from every team — the same set " +
        "the dashboard's template library shows, and the place to start when " +
        "you want a design to build from rather than authoring one from " +
        "scratch. Filter by kind, category or name; install one with " +
        "install_publication. " +
        "Note this lists the *public library* only: publications are " +
        "user-owned and span workspaces, so there is no way to list your own " +
        "unlisted ones. Get those UIDs from the dashboard and pass them " +
        "straight to get_publication or install_publication.",
      inputSchema: {
        q: z
          .string()
          .optional()
          .describe("Only publications whose name contains this text, case-insensitive"),
        kind: z
          .enum(PUBLICATION_KINDS as unknown as [string, ...string[]])
          .optional()
          .describe(
            "Only publications that install as this kind of resource. Omit for all."
          ),
        category: z
          .array(z.enum(PUBLICATION_CATEGORIES as unknown as [string, ...string[]]))
          .optional()
          .describe("Only publications in any of these categories. Omit for all."),
        ...pageParam,
      },
    },
    async ({ q, kind, category, page }) =>
      guard(() =>
        client.request("GET", "/publications", {
          // The API takes one comma-separated `category`, but an array is what
          // a model can actually build — join on the way out.
          query: { q, kind, category: category?.join(","), page },
        })
      )
  );

  server.registerTool(
    "get_publication",
    {
      title: "Get a publication",
      description:
        "Retrieve one publication by uid — its categories, the kind of " +
        "resource it installs as, and its preview. Public library entries are " +
        "visible to anyone; unlisted ones only to the user who created them.",
      inputSchema: {
        uid: z
          .string()
          .describe("Publication UID, passed back verbatim including any v3_ prefix"),
      },
    },
    async ({ uid }) => guard(() => client.request("GET", `/publications/${uid}`))
  );

  server.registerTool(
    "install_publication",
    {
      title: "Install a publication",
      description:
        "Clone a publication into this workspace and return what it created. " +
        "What that is follows the publication's template_kind: an image " +
        "template, an animation template, or a workflow together with the " +
        "templates its steps use. A legacy V3 publication — its uid carries a " +
        "`v3_` prefix — is converted to a V5 image template on the way in. " +
        "The copy is independent, so editing it does not affect the " +
        "publication. Drafts cannot be installed, and trial accounts are " +
        "capped at 3 templates per kind.",
      inputSchema: {
        uid: z
          .string()
          .describe("Publication UID, passed back verbatim including any v3_ prefix"),
      },
    },
    async ({ uid }) =>
      guard(() => client.request("POST", `/publications/${uid}/install`))
  );
}
