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

/**
 * Surfaces API failures as tool errors rather than throwing, so the model can
 * read the message and correct itself instead of the call disappearing.
 */
export async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof BannerbearError) {
      return fail(`Bannerbear API error (${err.status}): ${err.message}`);
    }
    return fail(`Unexpected error: ${(err as Error).message}`);
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
