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
// Per-type fan-out cap for global search (bounded so no single type floods the result).
export const SEARCH_PER_TYPE_LIMIT = 10;

export interface PaginationOptions {
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  readonly includeCursor?: boolean;
  readonly allowEmptyValue?: boolean;
}

export const DEFAULT_PAGINATION_OPTIONS = Object.freeze({
  defaultLimit: DEFAULT_LIMIT,
  maxLimit: MAX_LIMIT,
  includeCursor: true,
  allowEmptyValue: true,
} as const);

export const LIMIT_ONLY_PAGINATION_OPTIONS = Object.freeze({
  ...DEFAULT_PAGINATION_OPTIONS,
  includeCursor: false,
} as const);

export const SEARCH_PAGINATION_OPTIONS = Object.freeze({
  ...LIMIT_ONLY_PAGINATION_OPTIONS,
  defaultLimit: SEARCH_PER_TYPE_LIMIT,
  maxLimit: SEARCH_PER_TYPE_LIMIT,
} as const);

// The canonical route keys carrying bounded pagination. Keeping the options here lets the
// Worker call sites, OpenAPI cross-check, and focused route tests consume one support matrix.
export const PAGINATION_ROUTE_OPTIONS = {
  "GET /api/admin/customers": DEFAULT_PAGINATION_OPTIONS,
  "GET /api/admin/licenses": DEFAULT_PAGINATION_OPTIONS,
  "GET /api/admin/orders": DEFAULT_PAGINATION_OPTIONS,
  "GET /api/admin/search": SEARCH_PAGINATION_OPTIONS,
  "GET /api/admin/entitlements": DEFAULT_PAGINATION_OPTIONS,
  "GET /api/admin/events": LIMIT_ONLY_PAGINATION_OPTIONS,
  "GET /api/admin/policies": DEFAULT_PAGINATION_OPTIONS,
  "GET /api/admin/catalog/features": DEFAULT_PAGINATION_OPTIONS,
  "GET /api/admin/catalog/plans": DEFAULT_PAGINATION_OPTIONS,
  "GET /api/admin/webhooks": DEFAULT_PAGINATION_OPTIONS,
  "GET /api/admin/webhooks/deliveries": DEFAULT_PAGINATION_OPTIONS,
  "GET /api/admin/report/expiring": DEFAULT_PAGINATION_OPTIONS,
} as const satisfies Readonly<Record<string, PaginationOptions>>;

function parsePageInteger(
  raw: string | null,
  defaultValue: number,
  min: number,
  max: number,
  allowEmptyValue: boolean,
): number | null {
  if (raw === null || (allowEmptyValue && raw === "")) {
    return defaultValue;
  }
  if (raw === "") {
    return null;
  }
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/** Parse the shared offset pagination contract; null means an explicit value is malformed. */
export function boundedCursor(url: URL, options: PaginationOptions = DEFAULT_PAGINATION_OPTIONS): { limit: number; cursor: number } | null {
  const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = options.maxLimit ?? MAX_LIMIT;
  const allowEmptyValue = options.allowEmptyValue ?? true;
  const limit = parsePageInteger(url.searchParams.get("limit"), defaultLimit, 1, maxLimit, allowEmptyValue);
  const cursor = options.includeCursor === false
    ? 0
    : parsePageInteger(url.searchParams.get("cursor"), 0, 0, Number.MAX_SAFE_INTEGER, allowEmptyValue);
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

// Spreadsheet engines may ignore a run of Unicode whitespace, BOM, or zero-width markers
// before deciding whether a cell is a formula. Leading tab/CR/LF are treated as dangerous
// controls themselves; ASCII and full-width formula introducers are checked after the run.
const CSV_IGNORED_LEADING = /^(?:\s|\uFEFF|\u200B|\u200C|\u200D|\u2060)*/u;
const CSV_FORMULA_PREFIX = /^[=+\-@＝＋－＠]/u;

// CSV-escape one field: stringify, then quote + double any embedded quote. null/undefined
// render as the empty string. Always quoted so commas/newlines/quotes in data are inert.
export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const ignoredLeading = CSV_IGNORED_LEADING.exec(text)?.[0] ?? "";
  const effective = text.slice(ignoredLeading.length);
  const hasDangerousControl = /[\t\r\n]/u.test(ignoredLeading);
  const safeText = hasDangerousControl || CSV_FORMULA_PREFIX.test(effective) ? `'${text}` : text;
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
