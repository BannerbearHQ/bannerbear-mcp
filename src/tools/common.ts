import { z } from "zod";
import { BannerbearError } from "../client.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const ok = (data: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    },
  ],
});

export const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Renders a thrown error the way tool results report it. */
export function describeError(err: unknown): string {
  if (err instanceof BannerbearError) {
    return `Bannerbear API error (${err.status}): ${err.message}`;
  }
  return `Unexpected error: ${(err as Error).message}`;
}

/**
 * Surfaces API failures as tool errors rather than throwing, so the model can
 * read the message and correct itself instead of the call disappearing.
 */
export async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(describeError(err));
  }
}

export const pageParam = {
  page: z.number().int().min(1).optional().describe("Page number, 1-indexed"),
};

/**
 * Condenses a layer list so template listings stay readable.
 *
 * Requests and responses both use `config.objects`; the top-level fallback
 * covers callers passing the alias shape.
 */
/**
 * Condenses a template for listing.
 *
 * The full record carries every layer's every attribute, which is thousands of
 * lines per template — unusable in a list. But summarising is easy to overdo:
 * dropping `created_at` made "which is my newest?" unanswerable without
 * fetching each template in turn, and the endpoint documents no ordering, so
 * the timestamp is the only way to know. `preview` is the same kind of cheap:
 * one URL that saves fetching a whole config just to see what something is.
 */
export function summariseTemplate(template: any): Record<string, unknown> {
  return {
    uid: template?.uid,
    name: template?.name,
    width: template?.width,
    height: template?.height,
    created_at: template?.created_at,
    preview: template?.preview,
    layers: summariseLayers(template?.config),
  };
}

export function summariseLayers(source: any): string[] {
  const objects = source?.config?.objects ?? source?.objects;
  if (!Array.isArray(objects)) return [];
  return objects.map((o: any) => {
    const bits = [o?.name ?? o?.id ?? "(unnamed)"];
    if (o?.type) bits.push(`type=${o.type}`);
    if (typeof o?.text === "string") {
      bits.push(`text=${JSON.stringify(o.text.slice(0, 40))}`);
    }
    return bits.join(" ");
  });
}
