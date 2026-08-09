import { readTextBody } from "@licensecc/cloudflare-runtime/http/kit";
import { envelope } from "./responses.js";

const MAX_BODY_BYTES = 8192;
export const MAX_NOTES_SIZE = 1000;

export function safeNotes(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_NOTES_SIZE) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  return value;
}

export async function parseJsonBody(request: Request, requestIdValue: string): Promise<unknown | Response> {
  const body = await readTextBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return envelope(requestIdValue, "body_too_large", undefined, 413);
  }
  try {
    return body.text === "" ? {} : JSON.parse(body.text);
  } catch {
    return envelope(requestIdValue, "invalid_json", undefined, 400);
  }
}

// Keep the historical request-module export while query.ts owns the one parser implementation.
export { boundedCursor } from "./query.js";
