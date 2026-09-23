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

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

/** @param {string} text @returns {number[] | null} eight 16-bit groups */
function ipv6Groups(text) {
  let body = text, tail = [];
  if (body.includes(".")) {
    // Embedded dotted IPv4 (e.g. ::ffff:192.0.2.1) supplies the last two groups.
    const lastColon = body.lastIndexOf(":");
    const v4 = body.slice(lastColon + 1);
    if (!IPV4.test(v4)) return null;
    const [a, b, c, d] = v4.split(".").map(Number);
    tail = [(a << 8) | b, (c << 8) | d];
    body = body.slice(0, lastColon + 1);
    if (!body.endsWith("::")) body = body.slice(0, -1);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const parse = (part) => part === "" ? [] : part.split(":").map(group => HEXTET.test(group) ? parseInt(group, 16) : NaN);
  const head = parse(halves[0]), rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
  return [...head, ...Array(8 - explicit).fill(0), ...rest, ...tail];
}

// Per-source identity for the protected limiters. One IPv6 subscriber usually
// controls a whole /64, so IPv6 sources are keyed by that prefix; an
// IPv4-mapped address is its IPv4 address. Anything unparseable keeps the raw
// header value (still hashed), so malformed input never shares a budget with
// a real prefix by accident.
export function boundSourceIdentity(raw) {
  const value = String(raw ?? "").trim();
  if (value === "unknown-client" || IPV4.test(value)) return value;
  const address = value.replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "").toLowerCase();
  if (!address.includes(":")) return value;
  const groups = ipv6Groups(address);
  if (!groups) return value;
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(":")}::/64`;
}

// The one shared range check for BOUND_GLOBAL_RATE_LIMIT: the runtime clamp
// below and the deployment readiness check both call this instead of each
// keeping their own copy of the range. A missing value is not a configuration
// error (callers apply their own default); a present value that is not an
// integer in [100, 1000000] parses to null so callers can tell "unset" apart
// from "set but invalid".
/** @param {string | number | undefined} raw @returns {number | null} */
export function parseGlobalRateLimit(raw) {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 100 && value <= 1000000 ? value : null;
}

function globalLimit(env) {
  return parseGlobalRateLimit(env.BOUND_GLOBAL_RATE_LIMIT) ?? 1000;
}

// Fixed protected-protocol namespaces. Legacy rate/proof/account-token "off"
// switches never disable this gate. Registration has a tighter IP budget;
// challenge/issuance traffic shares a coarse NAT-tolerant abuse budget.
export async function limitBoundRequest(request, env, db) {
  const client = await boundSecretHash(boundSourceIdentity(request.headers.get("cf-connecting-ip") || "unknown-client"));
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
