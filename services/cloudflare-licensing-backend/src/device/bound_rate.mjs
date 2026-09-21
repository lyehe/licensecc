import { BoundRequestError } from "./bound_request.mjs";
import { boundSecretHash } from "./bound_enrollment.mjs";

const values = `SELECT ?,?,(unixepoch()/60)*60,1,(unixepoch()/60)*60+120,unixepoch()`;
const admission = ` WHERE EXISTS(SELECT 1 FROM rate_limit_counters
  WHERE namespace='device-v2-global' AND rate_key='global' AND window_start=(unixepoch()/60)*60 AND request_count<=1000)`;
const insert = `INSERT INTO rate_limit_counters(namespace,rate_key,window_start,request_count,expires_at,updated_at) `;
const conflict = `
  ON CONFLICT(namespace,rate_key,window_start) DO UPDATE SET request_count=min(request_count+1,10001),updated_at=unixepoch()
  RETURNING request_count,window_start`;

// Fixed protected-protocol namespaces. Legacy rate/proof/account-token "off"
// switches never disable this gate. Registration has a tighter IP budget;
// challenge/issuance traffic shares a coarse NAT-tolerant abuse budget.
export async function limitBoundRequest(request, env, db) {
  const client = await boundSecretHash(request.headers.get("cf-connecting-ip") || "unknown-client");
  const registration = new URL(request.url).pathname === "/v2/device-authorizations";
  if (registration && env.VERIFY_RATE_LIMITER) {
    const decision = await env.VERIFY_RATE_LIMITER.limit({ key: `device-v2:${client}` });
    if (decision.success !== true) throw new BoundRequestError("rate_limited", 429);
  }
  if (!db.batch) throw new BoundRequestError("temporarily_unavailable", 503);
  const result = await db.batch([
    db.prepare(insert + values + " WHERE 1" + conflict).bind("device-v2-global", "global"),
    db.prepare(insert + values + admission + conflict).bind(registration ? "device-v2-registration" : "device-v2-client", client),
  ]);
  const global = result[0]?.results?.[0]?.request_count;
  const individual = result[1]?.results?.[0]?.request_count;
  if (!Number.isSafeInteger(global)) throw new BoundRequestError("temporarily_unavailable", 503);
  if (global > 1000) throw new BoundRequestError("rate_limited", 429);
  if (!Number.isSafeInteger(individual) || result[0].results[0].window_start !== result[1].results[0].window_start) {
    throw new BoundRequestError("temporarily_unavailable", 503);
  }
  if (individual > (registration ? 20 : 600)) throw new BoundRequestError("rate_limited", 429);
  if (global === 1) {
    await db.prepare(`DELETE FROM rate_limit_counters WHERE rowid IN
      (SELECT rowid FROM rate_limit_counters WHERE namespace IN ('device-v2-global','device-v2-client','device-v2-registration','device-v2-device','device-v2-customer')
        AND expires_at<=unixepoch() ORDER BY expires_at LIMIT 6002)`).run();
  }
}

// Call only after signature/PKCE and current authority checks. Client-supplied
// identities cannot create, select or exhaust another customer's counters.
export async function limitBoundVerified(db, keyId, customerId) {
  const customer = await boundSecretHash(customerId);
  const result = await db.batch([
    db.prepare(insert + values + " WHERE 1" + conflict).bind("device-v2-device", keyId),
    db.prepare(insert + values + " WHERE 1" + conflict).bind("device-v2-customer", customer),
  ]);
  const device = result[0]?.results?.[0], account = result[1]?.results?.[0];
  if (!Number.isSafeInteger(device?.request_count) || !Number.isSafeInteger(account?.request_count)
      || device.window_start !== account.window_start) throw new BoundRequestError("temporarily_unavailable", 503);
  if (device.request_count > 60 || account.request_count > 240) throw new BoundRequestError("rate_limited", 429);
}
