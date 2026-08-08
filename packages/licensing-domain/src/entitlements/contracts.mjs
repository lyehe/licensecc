// Portable entitlement value contract. These helpers intentionally have no D1,
// Worker Env, or service imports so every deployable has one authoritative public
// entitlement representation.

export function entitlementId(project, feature, licenseFingerprint) {
  const raw = JSON.stringify([project, feature, licenseFingerprint]);
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeEntitlementId(id) {
  try {
    const padded = id.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(id.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [project, feature, licenseFingerprint] = parsed;
    if (typeof project !== "string" || typeof feature !== "string" || typeof licenseFingerprint !== "string") return null;
    return { project, feature, license_fingerprint: licenseFingerprint };
  } catch {
    return null;
  }
}

export function effectiveLicenseMode(row) {
  if (Number(row?.is_trial ?? 0) === 1) return "trial";
  if (Number(row?.pool_size ?? 0) > 0) return "floating";
  return "node_locked";
}

export function withId(row) {
  const publicRow = { ...row };
  delete publicRow.cache_ttl_seconds;
  return {
    ...publicRow,
    license_mode: effectiveLicenseMode(row),
    id: entitlementId(row.project, row.feature, row.license_fingerprint),
  };
}

export function entitlementMatchesInput(row, input) {
  const defaultAssertionTtlSeconds = 300;
  return row.device_hash === (input.device_hash ?? "") &&
    row.status === (input.status ?? "active") &&
    row.assertion_ttl_seconds === (input.assertion_ttl_seconds ?? defaultAssertionTtlSeconds) &&
    row.valid_from === (input.valid_from ?? null) &&
    row.valid_until === (input.valid_until ?? null) &&
    row.notes === (input.notes ?? "") &&
    row.customer_id === (input.customer_id ?? null) &&
    row.license_id === (input.license_id ?? null);
}

export function syncEventType(prev, targetStatus) {
  if (targetStatus === "revoked") return "revoke";
  if (prev === null) return targetStatus === "disabled" ? "disable" : "create";
  if (prev.status !== targetStatus) return targetStatus === "disabled" ? "disable" : "reenable";
  return "update";
}
