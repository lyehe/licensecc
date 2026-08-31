// Subscription, customer, and license identity persistence for order ingest. The
// subscription-to-fingerprint mapping is immutable; license ids are project-bound.

function conflict(status, code) {
  return { ok: false, status, code };
}

function identityMatches(row, fingerprint, fingerprintOrigin) {
  return row !== null &&
    row.license_fingerprint === fingerprint &&
    row.fingerprint_origin === fingerprintOrigin;
}

function auxiliaryIdentityMatches(row, order) {
  const customerId = order.customer?.id ?? null;
  const licenseId = order.license_id ?? null;
  return (customerId === null || row.customer_id === null || row.customer_id === customerId) &&
    (licenseId === null || row.license_id === null || row.license_id === licenseId);
}

export async function establishOrderIdentity(env, order, fingerprint, fingerprintOrigin, now) {
  const existing = await env.DB.prepare(
    "SELECT license_fingerprint, fingerprint_origin, customer_id, license_id FROM orders " +
      "WHERE subscription_id = ? AND project = ? AND feature = ? LIMIT 1",
  ).bind(order.subscription_id, order.project, order.feature).first();
  if (existing !== null && !identityMatches(existing, fingerprint, fingerprintOrigin)) {
    return conflict(409, "fingerprint_owned");
  }
  if (existing !== null && !auxiliaryIdentityMatches(existing, order)) {
    return conflict(400, "invalid_order");
  }

  // This preflight prevents known conflicts without mutation. A second check after
  // successful event admission handles concurrent first use safely.
  if (order.license_id) {
    const license = await env.DB.prepare(
      "SELECT project, customer_id FROM licenses WHERE id = ? LIMIT 1",
    ).bind(order.license_id).first();
    if (
      license !== null &&
      (license.project !== order.project ||
        (order.customer?.id && license.customer_id !== null && license.customer_id !== order.customer.id))
    ) return conflict(400, "invalid_order");
  }

  // Generic DO NOTHING covers both the subscription primary key and the unique
  // fingerprint owner index. The read immediately after classifies either conflict
  // without depending on a racy preflight observation.
  await env.DB.prepare(
    "INSERT INTO orders (subscription_id, project, feature, license_fingerprint, customer_id, license_id, last_seq, order_epoch, fingerprint_origin, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, NULL, NULL, -1, 0, ?, ?, ?) ON CONFLICT DO NOTHING",
  ).bind(
    order.subscription_id,
    order.project,
    order.feature,
    fingerprint,
    fingerprintOrigin,
    now,
    now,
  ).run();
  const persisted = await env.DB.prepare(
    "SELECT license_fingerprint, fingerprint_origin, customer_id, license_id FROM orders " +
      "WHERE subscription_id = ? AND project = ? AND feature = ? LIMIT 1",
  ).bind(order.subscription_id, order.project, order.feature).first();
  if (!identityMatches(persisted, fingerprint, fingerprintOrigin)) return conflict(409, "fingerprint_owned");
  if (!auxiliaryIdentityMatches(persisted, order)) return conflict(400, "invalid_order");
  return { ok: true };
}

export function buildOrderLicenseReservation(env, order, now, fingerprint, fingerprintOrigin) {
  if (!order.license_id) return null;
  const customerId = order.customer?.id ?? null;
  return env.DB.prepare(
    "INSERT INTO licenses (id, customer_id, project, label, metadata_json, created_at, updated_at) " +
      "SELECT ?, ?, ?, '', '{}', ?, ? WHERE EXISTS (" +
      "SELECT 1 FROM orders WHERE subscription_id = ? AND project = ? AND feature = ? " +
      "AND license_fingerprint = ? AND fingerprint_origin = ? " +
      "AND (customer_id IS NULL OR ? IS NULL OR customer_id = ?) " +
      "AND (license_id IS NULL OR license_id = ?) " +
      "AND (order_epoch < ? OR (order_epoch = ? AND last_seq < ?))) " +
      "ON CONFLICT(id) DO UPDATE SET customer_id = COALESCE(licenses.customer_id, excluded.customer_id), updated_at = excluded.updated_at " +
      "WHERE licenses.project = excluded.project " +
      "AND (licenses.customer_id IS NULL OR excluded.customer_id IS NULL OR licenses.customer_id = excluded.customer_id) " +
      "RETURNING id",
  ).bind(
    order.license_id, customerId, order.project, now, now,
    order.subscription_id, order.project, order.feature, fingerprint, fingerprintOrigin,
    customerId, customerId, order.license_id,
    order.order_epoch, order.order_epoch, order.seq,
  );
}

export function buildOrderCursorAdvance(env, order, now, fingerprint, fingerprintOrigin, requiresReservation) {
  return env.DB.prepare(
    "UPDATE orders SET order_epoch = ?, last_seq = ?, customer_id = COALESCE(customer_id, ?), license_id = COALESCE(license_id, ?), updated_at = ? " +
      `WHERE ${requiresReservation ? "changes() = 1 AND " : ""}` +
      "subscription_id = ? AND project = ? AND feature = ? AND " +
      "license_fingerprint = ? AND fingerprint_origin = ? AND " +
      "(customer_id IS NULL OR ? IS NULL OR customer_id = ?) AND " +
      "(license_id IS NULL OR ? IS NULL OR license_id = ?) AND " +
      "(order_epoch < ? OR (order_epoch = ? AND last_seq < ?)) " +
      "RETURNING last_seq, order_epoch",
  ).bind(
    order.order_epoch, order.seq, order.customer?.id ?? null, order.license_id ?? null, now,
    order.subscription_id, order.project, order.feature, fingerprint, fingerprintOrigin,
    order.customer?.id ?? null, order.customer?.id ?? null,
    order.license_id ?? null, order.license_id ?? null,
    order.order_epoch, order.order_epoch, order.seq,
  );
}

export async function orderIdentityConflictsAfterFailedAccept(env, order) {
  const row = await env.DB.prepare(
    "SELECT customer_id, license_id FROM orders WHERE subscription_id = ? AND project = ? AND feature = ? LIMIT 1",
  ).bind(order.subscription_id, order.project, order.feature).first();
  if (row !== null && !auxiliaryIdentityMatches(row, order)) return true;
  if (!order.license_id) return false;
  const license = await env.DB.prepare(
    "SELECT project, customer_id FROM licenses WHERE id = ? LIMIT 1",
  ).bind(order.license_id).first();
  return license !== null &&
    (license.project !== order.project ||
      (order.customer?.id && license.customer_id !== null && license.customer_id !== order.customer.id));
}

export async function materializeOrderAuxiliaryIdentities(env, order, now) {
  // A globally keyed license id may be reused only within its original project and
  // without contradicting an explicit customer. This conditional upsert is the
  // race-safe check for concurrent first use in different projects.
  if (order.license_id) {
    const license = await env.DB.prepare(
      "INSERT INTO licenses (id, customer_id, project, label, metadata_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, '', '{}', ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET customer_id = COALESCE(licenses.customer_id, excluded.customer_id), updated_at = excluded.updated_at " +
        "WHERE licenses.project = excluded.project " +
        "AND (licenses.customer_id IS NULL OR excluded.customer_id IS NULL OR licenses.customer_id = excluded.customer_id) " +
        "RETURNING id",
    ).bind(order.license_id, order.customer?.id ?? null, order.project, now, now).first();
    if (license === null) return conflict(400, "invalid_order");
  }
  if (order.customer?.id) {
    const email = typeof order.customer.email === "string" ? order.customer.email.trim().toLowerCase() : "";
    const name = typeof order.customer.name === "string" ? order.customer.name : "";
    const externalRef = typeof order.customer.external_ref === "string" ? order.customer.external_ref : "";
    await env.DB.prepare(
      "INSERT INTO customers (id, name, email, metadata_json, created_at, updated_at, status, external_ref) " +
        "VALUES (?, ?, ?, '{}', ?, ?, 'active', ?) " +
        "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
    ).bind(order.customer.id, name, email, now, now, externalRef).run();
  }
  return { ok: true };
}
