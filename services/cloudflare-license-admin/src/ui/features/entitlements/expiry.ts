import { formatUtcDate } from "../../shared/format";

const DAY = 86400;
/** A custom timestamp is an opaque form value, never a value for an HTML date input. */
export function expiryDateInput(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (value > 0 && value % DAY === 0 && value <= Date.UTC(10000, 0, 1) / 1000) {
    const day = new Date((value - 1) * 1000).toISOString().slice(0, 10);
    if (/^[1-9]\d{3}-/.test(day) && day >= "1970-01-01") return day;
  }
  return `exact:${value}`;
}

export function expiryDeadline(input: string, original?: number | null): number | null {
  if (original !== undefined && input === expiryDateInput(original)) return original;
  if (input === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || input < "1970-01-01") throw new Error("valid_until_must_be_a_valid_date");
  const start = Date.parse(`${input}T00:00:00Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== input) throw new Error("valid_until_must_be_a_valid_date");
  return start / 1000 + DAY;
}

export function exactExpiry(value: number): string {
  return value >= 0 && value * 1000 <= 8.64e15
    ? new Date(value * 1000).toISOString().replace(".000Z", "Z")
    : `${formatUtcDate(value)} (${value} epoch seconds)`;
}

export function expiryDescription(value: number | null | undefined): string {
  if (value === null || value === undefined) return "No expiry";
  const input = expiryDateInput(value);
  return input.startsWith("exact:") ? `Expires ${exactExpiry(value)}` : `Valid through ${input} UTC`;
}
