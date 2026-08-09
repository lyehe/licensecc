import { safeString } from "@licensecc/cloudflare-runtime/http/kit";

export function likeContains(value: unknown): string | null {
  const term = safeString(value, 128);
  if (term === null) {
    return null;
  }
  return `%${term.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parsePageInteger(raw: string | null, defaultValue: number, min: number, max: number): number | null {
  if (raw === null || raw === "") {
    return defaultValue;
  }
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/** Parse the shared offset pagination contract; null means an explicit value is malformed. */
export function boundedCursor(url: URL): { limit: number; cursor: number } | null {
  const limit = parsePageInteger(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const cursor = parsePageInteger(url.searchParams.get("cursor"), 0, 0, Number.MAX_SAFE_INTEGER);
  return limit === null || cursor === null ? null : { limit, cursor };
}

// ── Workstream C BACKEND: CSV export, global search, bulk transitions ─────────
// CSV export rides ?format=csv on the EXISTING list routes (no new routes, so the
// OpenAPI cross-check is undisturbed). Global search and bulk transitions are the
// only TWO new routes. Design: admin Worker conventions in CLAUDE.md (Slice 4 +
// entitlement transitions are the closest existing patterns).

// Hard ceiling on a single CSV export. A list endpoint with ?format=csv streams up to
// this many rows (the SAME filters as the JSON list), then appends a trailing comment row
// noting the cap so an operator can tell a truncated export from a complete one.
export const CSV_ROW_CAP = 10000;
// Cap on the number of ids a single bulk transition may carry (over -> 400 too_many).
const BATCH_MAX_IDS = 100;
// Per-type fan-out cap for global search (bounded so no single type floods the result).
export const SEARCH_PER_TYPE_LIMIT = 10;

// CSV-escape one field: stringify, then quote + double any embedded quote. null/undefined
// render as the empty string. Always quoted so commas/newlines/quotes in data are inert.
export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // Prefix formula-like cells after optional leading spaces. Tabs and CR are themselves
  // dangerous effective prefixes, so they remain in the checked character class.
  const safeText = /^[ ]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

// Render header + rows (each a record keyed by `columns`) as a CSV body, then append a
// trailing comment row when the export hit the cap so truncation is visible to the reader.
export function toCsv(columns: ReadonlyArray<string>, rows: ReadonlyArray<Record<string, unknown>>, capped: boolean): string {
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvField(row[column])).join(","));
  }
  if (capped) {
    lines.push(csvField(`# export truncated at the ${CSV_ROW_CAP}-row cap; narrow your filters for the full set`));
  }
  return `${lines.join("\r\n")}\r\n`;
}

// Build the streaming text/csv Response with an attachment Content-Disposition.
export function csvResponse(filename: string, columns: ReadonlyArray<string>, rows: ReadonlyArray<Record<string, unknown>>): Response {
  const capped = rows.length >= CSV_ROW_CAP;
  return new Response(toCsv(columns, rows.slice(0, CSV_ROW_CAP), capped), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export function wantsCsv(url: URL): boolean {
  return url.searchParams.get("format") === "csv";
}

// Turn a user search term into a PREFIX LIKE pattern (`q%`), escaping the wildcards so the
// literal term anchors at the start. Used for the hex license_fingerprint prefix search.
export function likePrefix(value: unknown): string | null {
  const term = safeString(value, 128);
  if (term === null) {
    return null;
  }
  return `${term.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
