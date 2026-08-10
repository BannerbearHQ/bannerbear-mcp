import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BannerbearClient } from "../client.js";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_RESOURCES,
  WEBHOOK_SCOPES,
  WEBHOOK_STATUSES,
} from "../generated/schemas.js";
import { guard, pageParam } from "./common.js";

/** The spec's enums are the source of truth; these have drifted twice already. */
const asEnum = (values: readonly string[]) =>
  z.enum(values as unknown as [string, ...string[]]);

const webhookShape = {
  name: z.string().describe("Webhook name"),
  url: z.string().describe("URL to receive webhook events"),
  resource: asEnum(WEBHOOK_RESOURCES)
    .optional()
    .describe(
      "Which kind of job fires this webhook — `tool_job` covers the media " +
        "tools (remove_bg, trim_video, …)"
    ),
  event: asEnum(WEBHOOK_EVENTS).optional(),
  status: asEnum(WEBHOOK_STATUSES).optional(),
  scope: asEnum(WEBHOOK_SCOPES).optional(),
  templates: z
    .array(z.string())
    .optional()
    .describe("Template UIDs, when scope is specific_templates"),
};

const instantUrlShape = {
  name: z.string(),
  template: z.string().describe("Image template UID this Instant URL is bound to"),
  mode: z.enum(["encoded", "named_params"]).optional(),
  security: z.enum(["signed", "open"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  scale: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  rate_limit: z.boolean().optional(),
  template_version: z.number().int().nullable().optional(),
  max_renders: z.number().int().nullable().optional(),
  expires_at: z.string().nullable().optional().describe("ISO 8601 timestamp"),
};

export function registerWorkspaceTools(
  server: McpServer,
  client: BannerbearClient
) {
  server.registerTool(
    "get_account",
    {
      title: "Get account info",
      description:
        "Workspace name, subscription plan and quota usage, plus what the API " +
        "key in use is allowed to do: its scopes and any browser origin " +
        "restrictions. Reachable on every key regardless of scope, so it also " +
        "works as a connectivity check.",
      inputSchema: {},
    },
    async () => guard(() => client.request("GET", "/account"))
  );

  // --- Webhooks -------------------------------------------------------------
  server.registerTool(
    "list_webhooks",
    { title: "List webhooks", description: "List webhooks.", inputSchema: { ...pageParam } },
    async ({ page }) => guard(() => client.request("GET", "/webhooks", { query: { page } }))
  );

  server.registerTool(
    "get_webhook",
    { title: "Get a webhook", description: "Retrieve one webhook.", inputSchema: { uid: z.string() } },
    async ({ uid }) => guard(() => client.request("GET", `/webhooks/${uid}`))
  );

  server.registerTool(
    "create_webhook",
    {
      title: "Create a webhook",
      description: "Register a URL to receive generation events.",
      inputSchema: webhookShape,
    },
    async (body) => guard(() => client.request("POST", "/webhooks", { body }))
  );

  server.registerTool(
    "update_webhook",
    {
      title: "Update a webhook",
      description: "Update any subset of a webhook's attributes.",
      inputSchema: {
        uid: z.string(),
        name: webhookShape.name.optional(),
        url: webhookShape.url.optional(),
        resource: webhookShape.resource,
        event: webhookShape.event,
        status: webhookShape.status,
        scope: webhookShape.scope,
        templates: webhookShape.templates,
      },
    },
    async ({ uid, ...body }) =>
      guard(() => client.request("PATCH", `/webhooks/${uid}`, { body }))
  );

  server.registerTool(
    "delete_webhook",
    { title: "Delete a webhook", description: "Permanently delete a webhook.", inputSchema: { uid: z.string() } },
    async ({ uid }) =>
      guard(async () => {
        await client.request("DELETE", `/webhooks/${uid}`);
        return { deleted: uid };
      })
  );

  // --- Instant URLs ---------------------------------------------------------
  server.registerTool(
    "list_instant_urls",
    { title: "List Instant URLs", description: "List Instant URLs.", inputSchema: { ...pageParam } },
    async ({ page }) =>
      guard(() => client.request("GET", "/instant_urls", { query: { page } }))
  );

  server.registerTool(
    "get_instant_url",
    {
      title: "Get an Instant URL",
      description: "Retrieve one Instant URL, including its base URL.",
      inputSchema: { uid: z.string() },
    },
    async ({ uid }) => guard(() => client.request("GET", `/instant_urls/${uid}`))
  );

  server.registerTool(
    "create_instant_url",
    {
      title: "Create an Instant URL",
      description:
        "Create an Instant URL bound to an image template — renders on GET " +
        "without an API call.",
      inputSchema: instantUrlShape,
    },
    async (body) => guard(() => client.request("POST", "/instant_urls", { body }))
  );

  server.registerTool(
    "update_instant_url",
    {
      title: "Update an Instant URL",
      description: "Update any subset of an Instant URL's attributes.",
      inputSchema: {
        uid: z.string(),
        name: instantUrlShape.name.optional(),
        template: instantUrlShape.template.optional(),
        mode: instantUrlShape.mode,
        security: instantUrlShape.security,
        status: instantUrlShape.status,
        scale: instantUrlShape.scale,
        rate_limit: instantUrlShape.rate_limit,
        template_version: instantUrlShape.template_version,
        max_renders: instantUrlShape.max_renders,
        expires_at: instantUrlShape.expires_at,
      },
    },
    async ({ uid, ...body }) =>
      guard(() => client.request("PATCH", `/instant_urls/${uid}`, { body }))
  );

  server.registerTool(
    "delete_instant_url",
    {
      title: "Delete an Instant URL",
      description: "Permanently delete an Instant URL.",
      inputSchema: { uid: z.string() },
    },
    async ({ uid }) =>
      guard(async () => {
        await client.request("DELETE", `/instant_urls/${uid}`);
        return { deleted: uid };
      })
  );
}
