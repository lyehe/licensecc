// Portable tamper-evident audit digest contract.

const textEncoder = new TextEncoder();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalEntitlementEvent(row) {
  return JSON.stringify([
    Number(row.id),
    Number(row.created_at),
    row.project,
    row.feature,
    row.license_fingerprint,
    row.device_hash ?? "",
    row.event_type,
    row.status,
    Number(row.revocation_seq),
    row.detail ?? "",
    row.actor ?? "",
    row.actor_type ?? "",
    row.source ?? "",
    row.prev_json ?? "",
    row.next_json ?? "",
    row.reason ?? "",
  ]);
}

export async function computeSegmentDigest(prevDigest, canonicalEvents) {
  return sha256Hex(prevDigest + "\n" + canonicalEvents.join("\n"));
}
