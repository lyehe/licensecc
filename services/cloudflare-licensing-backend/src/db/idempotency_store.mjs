// Single home for the mutation_idempotency replay/remember SQL pair. Both the
// licensing-backend lease path (src/index.ts) and the admin worker
// (src/worker/idempotency.ts) import these so the SELECT can never drift and the
// paired INSERT uses ONE conflict form (ON CONFLICT(scope, idempotency_key) DO
// NOTHING) rather than the historical `INSERT OR IGNORE` copy the admin carried.
//
// Worker-safe: no node:/Buffer, only the D1 prepared-statement surface, so it
// bundles under wrangler/esbuild and runs raw under `node --test`. `db` is any
// D1DatabaseLike (env.DB). A null/undefined key short-circuits (no key => no
// replay cache), matching the callers' prior guards.
//
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
    return;
  }
  await db.prepare(
    "INSERT INTO mutation_idempotency (scope, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, idempotency_key) DO NOTHING",
  ).bind(scope, key, responseJson, now).run();
}
