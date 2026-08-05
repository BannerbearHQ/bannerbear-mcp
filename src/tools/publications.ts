import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BannerbearClient } from "../client.js";
import { guard, pageParam } from "./common.js";

export function registerPublicationTools(
  server: McpServer,
  client: BannerbearClient
) {
  server.registerTool(
    "list_publications",
    {
      title: "Browse the public template library",
      description:
        "Browse publicly shared publications from every team — a starting " +
        "point when you want a design to build from rather than authoring one " +
        "from scratch. Install one with install_publication. " +
        "Note this lists the *public library* only: publications are " +
        "user-owned and span workspaces, so there is no way to list your own " +
        "unlisted ones. Get those UIDs from the dashboard and pass them " +
        "straight to get_publication or install_publication.",
      inputSchema: { ...pageParam },
    },
    async ({ page }) =>
      guard(() => client.request("GET", "/publications", { query: { page } }))
  );

  server.registerTool(
    "get_publication",
    {
      title: "Get a publication",
      description:
        "Retrieve one publication by uid. Public library entries are visible " +
        "to anyone; unlisted ones only to the user who created them.",
      inputSchema: { uid: z.string().describe("Publication UID") },
    },
    async ({ uid }) => guard(() => client.request("GET", `/publications/${uid}`))
  );

  server.registerTool(
    "install_publication",
    {
      title: "Install a publication as a template",
      description:
        "Clone a publication into this workspace as a new template and return " +
        "it. The copy is independent — editing it does not affect the " +
        "publication. Drafts cannot be installed, and trial accounts are " +
        "capped at 3 templates.",
      inputSchema: { uid: z.string().describe("Publication UID") },
    },
    async ({ uid }) =>
      guard(() => client.request("POST", `/publications/${uid}/install`))
  );
}
