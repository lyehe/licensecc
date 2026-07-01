// Tamper-evident audit log (audit R6.4).
//
// entitlement_events is append-only by convention but not tamper-EVIDENT. This maintains a hash
// CHAIN over it: a cron segment covers new events (id > the last cursor) and stores
//   digest_N = sha256(prev_digest + "\n" + join(canonical(events), "\n"))
// linked to the prior segment via prev_digest. Altering or deleting a covered event changes that
// segment's recomputed digest, which breaks the chain from that point on -- detected by replaying the
// events (verifyAuditChain). This module only READS entitlement_events + appends to audit_digests;
// no mutator / event-write path changes. Emission is UNMETERED (cron only).

const textEncoder = new TextEncoder();
const AUDIT_DIGEST_BATCH = 1000; // events folded into one segment per tick (bounded)
const DEFAULT_SOURCE = "entitlement";

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Deterministic serialization of an entitlement_events row's IMMUTABLE fields, in a fixed order.
// JSON.stringify of an array escapes newlines/quotes, so no field value can inject a separator.
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

/** Chain step: digest_N = sha256(prev_digest + "\n" + canonical events joined by "\n"). */
export async function computeSegmentDigest(prevDigest, canonicalEvents) {
  return sha256Hex(prevDigest + "\n" + canonicalEvents.join("\n"));
}

async function lastDigest(env, source) {
  const row = await env.DB.prepare(
    "SELECT up_to_id, digest FROM audit_digests WHERE source = ? ORDER BY id DESC LIMIT 1",
  )
    .bind(source)
    .first();
  return row ? { up_to_id: Number(row.up_to_id), digest: String(row.digest) } : null;
}

/**
 * Append ONE digest segment covering entitlement_events with id > the last cursor (bounded batch).
 * No-op (returns null) when there are no new events. Idempotent across ticks: the cursor only moves
 * forward, and the UNIQUE-less append is safe because each tick reads a disjoint id range.
 */
export async function appendAuditDigest(env, now, source = DEFAULT_SOURCE) {
  const last = await lastDigest(env, source);
  const cursor = last ? last.up_to_id : 0;
  const prevDigest = last ? last.digest : "";
  const res = await env.DB.prepare("SELECT * FROM entitlement_events WHERE id > ? ORDER BY id ASC LIMIT ?")
    .bind(cursor, AUDIT_DIGEST_BATCH)
    .all();
  const rows = res.results ?? [];
  if (rows.length === 0) {
    return null;
  }
  const digest = await computeSegmentDigest(prevDigest, rows.map(canonicalEntitlementEvent));
  const upToId = Number(rows[rows.length - 1].id);
  await env.DB.prepare(
    "INSERT INTO audit_digests (source, up_to_id, event_count, prev_digest, digest, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(source, upToId, rows.length, prevDigest, digest, now)
    .run();
  return { up_to_id: upToId, event_count: rows.length, digest };
}

/**
 * Verify the chain end-to-end: replay the events covered by each stored segment, recompute its
 * digest, and check both the chain link (prev_digest) and the recomputed digest. Returns
 * { ok, checked, brokenAt?, reason? } -- brokenAt is the audit_digests.id whose segment diverged.
 */
export async function verifyAuditChain(env, source = DEFAULT_SOURCE) {
  const res = await env.DB.prepare(
    "SELECT id, up_to_id, event_count, prev_digest, digest FROM audit_digests WHERE source = ? ORDER BY id ASC",
  )
    .bind(source)
    .all();
  const digests = res.results ?? [];
  let prevDigest = "";
  let cursor = 0;
  let checked = 0;
  for (const d of digests) {
    if (String(d.prev_digest) !== prevDigest) {
      return { ok: false, checked, brokenAt: Number(d.id), reason: "prev_digest_mismatch" };
    }
    const upTo = Number(d.up_to_id);
    const seg = await env.DB.prepare("SELECT * FROM entitlement_events WHERE id > ? AND id <= ? ORDER BY id ASC")
      .bind(cursor, upTo)
      .all();
    const rows = seg.results ?? [];
    if (rows.length !== Number(d.event_count)) {
      // A deleted (or inserted-into-range) event changes the count before the digest even runs.
      return { ok: false, checked, brokenAt: Number(d.id), reason: "event_count_mismatch" };
    }
    const recomputed = await computeSegmentDigest(prevDigest, rows.map(canonicalEntitlementEvent));
    if (recomputed !== String(d.digest)) {
      return { ok: false, checked, brokenAt: Number(d.id), reason: "digest_mismatch" };
    }
    prevDigest = String(d.digest);
    cursor = upTo;
    checked += 1;
  }
  return { ok: true, checked };
}
