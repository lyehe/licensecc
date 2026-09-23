import { BoundRequestError } from "./bound_request.mjs";
import { boundSecretHash } from "./bound_enrollment.mjs";

const window = `(unixepoch()/60)*60`;
const values = `SELECT ?,?,${window},1,${window}+120,unixepoch()`;
const insert = `INSERT INTO rate_limit_counters(namespace,rate_key,window_start,request_count,expires_at,updated_at) `;
const conflict = `
  ON CONFLICT(namespace,rate_key,window_start) DO UPDATE SET request_count=min(request_count+1,10001),updated_at=unixepoch()
  RETURNING request_count,window_start`;
// A client row grows only while the global window is open, so rotating source
// identities cannot create rows once the fuse trips.
const globalOpen = ` WHERE NOT EXISTS(SELECT 1 FROM rate_limit_counters
  WHERE namespace='device-v2-global' AND rate_key='global' AND window_start=${window} AND request_count>=?)`;
// The global fuse counts only requests their own source budget admitted, so a
// single source cannot spend the whole protected budget.
const clientAdmitted = ` WHERE EXISTS(SELECT 1 FROM rate_limit_counters
  WHERE namespace=? AND rate_key=? AND window_start=${window} AND request_count<=?)`;
const observed = `SELECT ${window} AS window_start,
  (SELECT request_count FROM rate_limit_counters WHERE namespace='device-v2-global' AND rate_key='global' AND window_start=${window}) AS global_count`;

function globalLimit(env) {
  const value = Number(env.BOUND_GLOBAL_RATE_LIMIT ?? 1000);
  return Number.isSafeInteger(value) && value >= 100 && value <= 1000000 ? value : 1000;
}

// Fixed protected-protocol namespaces. Legacy rate/proof/account-token "off"
// switches never disable this gate. Registration has a tighter IP budget;
// challenge/issuance traffic shares a coarse NAT-tolerant abuse budget.
export async function limitBoundRequest(request, env, db) {
  const client = await boundSecretHash(request.headers.get("cf-connecting-ip") || "unknown-client");
  const registration = new URL(request.url).pathname === "/v2/device-authorizations";
  const edge = registration ? env.VERIFY_RATE_LIMITER : env.BOUND_SESSION_RATE_LIMITER;
  if (edge) {
    const decision = await edge.limit({ key: `${registration ? "device-v2" : "device-v2-session"}:${client}` });
    if (decision.success !== true) throw new BoundRequestError("rate_limited", 429);
  }
  if (!db.batch) throw new BoundRequestError("temporarily_unavailable", 503);
  const namespace = registration ? "device-v2-registration" : "device-v2-client";
  const clientLimit = registration ? 20 : 600, fuse = globalLimit(env);
  const result = await db.batch([
    db.prepare(insert + values + globalOpen + conflict).bind(namespace, client, fuse),
    db.prepare(insert + values + clientAdmitted + conflict).bind("device-v2-global", "global", namespace, client, clientLimit),
    db.prepare(observed),
  ]);
  const own = result[0]?.results?.[0], view = result[2]?.results?.[0];
  if (!view || !Number.isSafeInteger(view.window_start)) throw new BoundRequestError("temporarily_unavailable", 503);
  if (!own) throw new BoundRequestError("rate_limited", 429);
  if (!Number.isSafeInteger(own.request_count) || own.window_start !== view.window_start) {
    throw new BoundRequestError("temporarily_unavailable", 503);
  }
  if (own.request_count > clientLimit) throw new BoundRequestError("rate_limited", 429);
  if (!Number.isSafeInteger(view.global_count) || view.global_count > fuse) throw new BoundRequestError("rate_limited", 429);
  if (view.global_count === 1) {
    await db.prepare(`DELETE FROM rate_limit_counters WHERE rowid IN
      (SELECT rowid FROM rate_limit_counters WHERE namespace IN ('device-v2-global','device-v2-client','device-v2-registration','device-v2-device','device-v2-customer')
        AND expires_at<=unixepoch() ORDER BY expires_at LIMIT 6002)`).run();
  }
}

// Call only after signature/PKCE and current authority checks. Client-supplied
// identities cannot create, select or exhaust another customer's counters.
export async function limitBoundVerified(db, keyId, customerId, customerLimit = 240) {
  const customer = await boundSecretHash(customerId);
  const result = await db.batch([
    db.prepare(insert + values + " WHERE 1" + conflict).bind("device-v2-device", keyId),
    db.prepare(insert + values + " WHERE 1" + conflict).bind("device-v2-customer", customer),
  ]);
  const device = result[0]?.results?.[0], account = result[1]?.results?.[0];
  if (!Number.isSafeInteger(device?.request_count) || !Number.isSafeInteger(account?.request_count)
      || device.window_start !== account.window_start) throw new BoundRequestError("temporarily_unavailable", 503);
  if (device.request_count > 60 || account.request_count > customerLimit) throw new BoundRequestError("rate_limited", 429);
}
