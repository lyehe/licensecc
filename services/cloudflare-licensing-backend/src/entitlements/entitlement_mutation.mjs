// Shared entitlement-mutation core. Imported by BOTH the licensing-backend Worker
// (order-ingest, Slice 1) and the admin Worker so the two can never drift on how
// an entitlement row + its audit event are written. Worker-safe: no node:/Buffer,
// only Web Crypto + standard globals (btoa/atob/TextEncoder), so it bundles
// identically under wrangler/esbuild and runs raw under `node --test`.
//
// Consumed cross-package via the backend package's `exports` map
// (`@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation`);
// the co-located .d.ts supplies types to the admin's tsc.

/**
 * Stable, URL-safe-base64 id for an entitlement's composite primary key
 * (project, feature, license_fingerprint). Inverse of decodeEntitlementId.
 */
export function entitlementId(project, feature, licenseFingerprint) {
  const raw = JSON.stringify([project, feature, licenseFingerprint]);
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Decode an entitlementId() back to its key, or null if malformed.
 */
export function decodeEntitlementId(id) {
  try {
    const padded = id.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(id.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 3) {
      return null;
    }
    const [project, feature, licenseFingerprint] = parsed;
    if (typeof project !== "string" || typeof feature !== "string" || typeof licenseFingerprint !== "string") {
      return null;
    }
    return { project, feature, license_fingerprint: licenseFingerprint };
  } catch {
    return null;
  }
}
