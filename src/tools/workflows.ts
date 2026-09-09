import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BannerbearError, type BannerbearClient } from "../client.js";
import { describeError, fail, guard, ok, pageParam, type ToolResult } from "./common.js";
import { progressReporter } from "./toolkit.js";

/**
 * Workflows are the composed form of everything else: a user assembles steps in
 * the dashboard, and the API runs them in order, each feeding the next.
 *
 * That makes this a much better surface for a model than the individual media
 * tools. "Run the podcast clip workflow on this video" is one intention; the
 * equivalent chain of trim, subtitle, add_audio and cover art is four calls and
 * four chances to mis-thread an intermediate URL.
 */

/** Runs go queued → running → completed / failed. Only the last two are terminal. */
const isTerminal = (run: { status?: string }) =>
  run.status === "completed" || run.status === "failed";

export function registerWorkflowTools(
  server: McpServer,
  client: BannerbearClient
) {
  server.registerTool(
    "list_workflows",
    {
      title: "List workflows",
      description:
        "List the workflows configured in this workspace. Each row carries the " +
        "inputs it accepts and the steps it runs, so this is usually enough to " +
        "pick one and run it without a second call.",
      inputSchema: { ...pageParam },
    },
    async ({ page }) =>
      guard(() => client.request("GET", "/workflows", { query: { page } }))
  );

  server.registerTool(
    "get_workflow",
    {
      title: "Get a workflow",
      description:
        "Fetch one workflow's definition — the inputs it declares and the steps " +
        "it runs, in order. Read the inputs before running it: each says whether " +
        "it is required and what type it expects.",
      inputSchema: { uid: z.string().describe("Workflow UID") },
    },
    async ({ uid }) => guard(() => client.request("GET", `/workflows/${uid}`))
  );

  // Deliberately not gated by allowGenerative. A workflow may well contain a
  // generative step, but the composition was authored by the user in the
  // dashboard — the policy Anthropic stated is against *direct* exposure to
  // generative tools, which is what the gates on generate_image and
  // generate_voiceover address. Closing this "gap" would break the profile
  // that the restriction is meant to make acceptable.
  server.registerTool(
    "run_workflow",
    {
      title: "Run a workflow",
      description:
        "Start a workflow and return its finished output. Inputs are whatever " +
        "the workflow declares — call get_workflow or list_workflows first if " +
        "you don't already know them. Each step is billed as the resource it " +
        "creates, so a run costs what running its steps separately would. " +
        "To process many rows, run it once per row.",
      inputSchema: {
        workflow: z.string().describe("Workflow UID"),
        inputs: z
          .record(z.any())
          .optional()
          .describe(
            "Values for the workflow's declared inputs, keyed by input name"
          ),
        metadata: z
          .string()
          .optional()
          .describe("Arbitrary string stored with the run and returned on it"),
        wait: z
          .boolean()
          .default(true)
          .describe(
            "Wait for the run to finish. Set false to get the run uid back " +
              "immediately and poll it with get_workflow_run."
          ),
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
      const onProgress = progressReporter(extra);
      try {
        const run = await client.request<any>("POST", "/workflow_runs", { body });
        if (!wait) return ok(run);

        const finished = await client.pollUntilDone<any>(
          `/workflow_runs/${run.uid}`,
          timeout_seconds * 1000,
          isTerminal,
          onProgress &&
            ((state) =>
              onProgress(typeof state.progress === "number" ? state.progress : 0))
        );

        // A failed run is reported as a tool error, not as data. The HTTP call
        // succeeded, so otherwise the model would have to notice `status` buried
        // in the payload — and `progress` says how far it got, which is the part
        // worth surfacing when a five-step run dies on step four.
        if (finished.status === "failed") {
          return fail(
            `Workflow run ${finished.uid} failed at ${finished.progress ?? 0}% ` +
              `progress: ${finished.error ?? "no reason given"}`
          );
        }
        return ok(finished);
      } catch (err) {
        // Running out of patience is not failing — the run continues at
        // Bannerbear, so hand back the last state, which carries the uid.
        if (err instanceof BannerbearError && err.status === 504 && err.body) {
          return ok(err.body);
        }
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "upsert_workflow",
    {
      title: "Create or update a workflow",
      description:
        "Create a workflow, or update one by passing uid. Steps run in array " +
        "order, and each may reference the workflow's inputs as " +
        "{{inputs.<name>}} or an EARLIER step's output as " +
        "{{steps.<key>.<output>}} — a forward reference is rejected. " +
        "inputs and steps are each replaced wholesale when present and left " +
        "alone when omitted, so renaming a workflow does not disturb its " +
        "definition; read it back with get_workflow before editing either.",
      inputSchema: {
        uid: z
          .string()
          .optional()
          .describe("Omit to create a new workflow; pass to update an existing one"),
        name: z.string().optional().describe("Workflow name (required when creating)"),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        inputs: z
          .record(
            z.object({
              type: z
                .enum(["string", "url", "number", "boolean"])
                .describe("`url` is validated as an http(s) URL when a run starts"),
              required: z.boolean().optional(),
            })
          )
          .optional()
          .describe(
            "Inputs the workflow accepts, keyed by name. Omit to leave " +
              "untouched; send {} to clear."
          ),
        steps: z
          .array(
            z
              .object({
                key: z
                  .string()
                  .regex(/^[a-z0-9_]+$/)
                  .describe(
                    "Stable handle, unique within the workflow. Later steps " +
                      "reference its output as {{steps.<key>.<output>}}."
                  ),
                type: z
                  .enum(["tool", "image", "animation"])
                  .describe("What kind of operation this step performs"),
                ref: z
                  .string()
                  .describe(
                    "A tool slug for `tool` steps, or a template UID for " +
                      "`image` and `animation` steps"
                  ),
                inputs: z
                  .record(z.any())
                  .optional()
                  .describe("Step payload, which may carry {{…}} references"),
              })
              .passthrough()
          )
          .optional()
          .describe(
            "Ordered step list, replaced wholesale. Array order is execution " +
              "order. Omit to leave the existing steps untouched."
          ),
      },
    },
    async ({ uid, ...body }) => {
      if (!uid && !body.name) return fail("name is required when creating a workflow");
      return guard(() =>
        uid
          ? client.request("PATCH", `/workflows/${uid}`, { body })
          : client.request("POST", "/workflows", { body })
      );
    }
  );

  server.registerTool(
    "delete_workflow",
    {
      title: "Delete a workflow",
      description:
        "Discard a workflow. Its past runs are kept, so history survives. " +
        "Subject to the same api_write_access lock as updating.",
      inputSchema: { uid: z.string().describe("Workflow UID") },
    },
    async ({ uid }) =>
      guard(async () => {
        await client.request("DELETE", `/workflows/${uid}`);
        return { deleted: uid };
      })
  );

  server.registerTool(
    "get_workflow_run",
    {
      title: "Get a workflow run",
      description:
        "Check a run started with wait=false, or review a past one. Returns " +
        "status, progress, and every completed step's output keyed by step name.",
      inputSchema: { uid: z.string().describe("Workflow run UID") },
    },
    async ({ uid }) => guard(() => client.request("GET", `/workflow_runs/${uid}`))
  );

  server.registerTool(
    "list_workflow_runs",
    {
      title: "List workflow runs",
      description:
        "List recent workflow runs, newest first — use it to find a run whose " +
        "uid wasn't kept, or to review what a workflow has been producing.",
      inputSchema: { ...pageParam },
    },
    async ({ page }) =>
      guard(() => client.request("GET", "/workflow_runs", { query: { page } }))
  );
}
