export function shortHash(value: string): string {
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

// Event/audit timestamps (created_at, updated_at, "last seen", webhook deliveries, request times):
// these describe when something happened in the operator's own browser, so they stay in local time.
// A short zone label keeps the value unambiguous without forcing the operator to convert it.
export function formatEpoch(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  return new Date(value * 1000).toLocaleString(undefined, { timeZoneName: "short" });
}

// Validity values (valid_from/valid_until, trial and lease deadlines, hold/grant expiry, catalog
// plan or policy validity windows, and other inspector validity rows): the displayed date must equal
// the date an operator typed or the server enforces, in every browser time zone. Built from UTC
// getters (via toISOString), never locale APIs, so the output is identical everywhere.
export function formatUtcDate(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  const date = new Date(value * 1000);
  const isoDate = date.toISOString().slice(0, 10);
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  if (hours === 0 && minutes === 0 && seconds === 0) {
    return `${isoDate} UTC`;
  }
  const pad = (part: number): string => String(part).padStart(2, "0");
  // A computed deadline (for example a trial end = issue time + duration) keeps its time here
  // instead of being truncated to a date, so it never looks like it lasts until midnight.
  return `${isoDate} ${pad(hours)}:${pad(minutes)} UTC`;
}
