// NOTE: the atomic idempotency-from-current-row write in entitlement_mutation.mjs
// (`INSERT ... SELECT json_object(...)`) is a DIFFERENT statement — it projects a
// freshly-written entitlement row into the cached response inside the mutation
// batch — and intentionally does NOT live here.

export async function readIdempotentResponse(db, scope, key) {
  if (key === null || key === undefined) {
    return null;
  }
  const row = await db.prepare(
    "SELECT response_json FROM mutation_idempotency WHERE scope = ? AND idempotency_key = ? LIMIT 1",
  ).bind(scope, key).first();
  return row === null ? null : row.response_json;
}

export async function writeIdempotentResponse(db, scope, key, responseJson, now) {
  if (key === null || key === undefined) {
    return null;
  }
  await db.prepare(
    "INSERT INTO mutation_idempotency (scope, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, idempotency_key) DO NOTHING",
  ).bind(scope, key, responseJson, now).run();
  // The key is immutable (first writer wins). Reading immediately after the
  // insert lets no-op callers distinguish their own response from a concurrent
  // winner without inventing a second conflict-prone write protocol.
  return readIdempotentResponse(db, scope, key);
}
