const DEFAULT_MAX_SKEW_SECONDS = 300;
const MAX_SKEW_CAP_SECONDS = 3600;

// Signature acceptance and replay-nonce retention must use the same window.
export function orderMaxSkewSeconds(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return DEFAULT_MAX_SKEW_SECONDS;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_SKEW_SECONDS;
  }
  return Math.min(parsed, MAX_SKEW_CAP_SECONDS);
}
