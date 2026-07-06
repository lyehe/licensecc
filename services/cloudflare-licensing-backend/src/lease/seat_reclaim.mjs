// Backend-owned seat reclaim helper shared by the admin Worker.
//
// Force-release is an operator action, but the lifecycle invariant is backend-owned: every live seat
// reclaimed outside a normal client release must emit one usage_events('reclaim') row so
// peak-concurrent analytics stay balanced. Keep that SQL here instead of duplicating it in admin.

export async function forceReleaseLiveSeats(env, key, now, reason = "force_release") {
  if (typeof env?.DB?.batch !== "function") {
    throw new Error("d1_batch_required");
  }
  const bindKey = [key.project, key.feature, key.license_fingerprint];
  const statements = [
    env.DB.prepare(
      "INSERT INTO usage_events (project, feature, license_fingerprint, event_type, seat_id, device_key_id, reason, ts) " +
        "SELECT project, feature, license_fingerprint, 'reclaim', seat_id, NULL, ?, ? " +
        "FROM seat_checkouts WHERE project = ? AND feature = ? AND license_fingerprint = ? AND heartbeat_deadline > ? " +
        "ORDER BY seat_id RETURNING seat_id",
    ).bind(reason, now, ...bindKey, now),
    env.DB.prepare(
      "DELETE FROM seat_checkouts WHERE project = ? AND feature = ? AND license_fingerprint = ? AND heartbeat_deadline > ? RETURNING seat_id",
    ).bind(...bindKey, now),
  ];
  const results = await env.DB.batch(statements);
  const deleted = results[1]?.results ?? [];
  const seatIds = deleted.map((row) => row.seat_id).sort();
  return { released: seatIds.length, seat_ids: seatIds };
}
