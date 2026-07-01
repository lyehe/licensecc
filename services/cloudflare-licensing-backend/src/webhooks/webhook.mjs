// Webhook dispatcher: a strictly READ-SIDE, cron-drained transactional outbox over the EXISTING
// audit tables (entitlement_events, customer_events, order_events). It NEVER touches a mutator /
// event-write path — it only READS those logs, ENQUEUEs one pending delivery per (endpoint, event)
// into webhook_deliveries (the UNIQUE makes a re-run a no-op = exactly-once), then DELIVERs pending
// rows with an HMAC-signed POST + exponential backoff. Emission is UNMETERED: enqueueAndDeliver-
// Webhooks runs ONLY from scheduled() (the cron), never inline / waitUntil. A delivery failure NEVER
// throws out of scheduled().
//
// Worker-safe: no node:/Buffer; only Web Crypto (crypto.subtle), TextEncoder, atob, AbortController.
// Runs raw under `node --test` (and `--experimental-sqlite`). The pure helpers (buildWebhookPayload,
// signWebhookBody, verifyWebhookSignature, nextBackoff, eventTypeMatches) do NO I/O so they are
// hermetically unit-testable; verifyWebhookSignature is also exported via the package exports map so
// the admin worker + receivers can import the SAME verifier.
//
// SIGNING: a Worker-env WEBHOOK_SIGNING_SECRETS — a JSON map {keyId: base64secret} mirroring
// ORDER_HMAC_SECRETS (each secret >= 32 bytes), loaded via the shared fail-closed loadSecretMap.
// NO per-endpoint secret is stored in D1 (the repo forbids plaintext secrets in D1; the signer needs
// the raw secret, so it lives ONLY in the env map). Fail-closed: with no usable signing secret the
// dispatcher LOGS + SKIPS delivery — it never sends an unsigned request (no oracle).
//
// Signature scheme: HMAC-SHA256 over "<t>.<rawjsonbody>"; header
//   Licensecc-Signature: t=<epoch>,keyid=<id>,v1=<hex>
// Receivers MUST recompute over the EXACT raw body bytes and enforce a 5-minute replay window on t.

import { loadSecretMap, lookupSecret } from "../fulfillment/order_hmac.mjs";

const textEncoder = new TextEncoder();

// Replay window receivers should enforce (documented for receivers; verifyWebhookSignature defaults
// to it). The signer never expires a signature itself — freshness is the receiver's check on `t`.
export const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

// Delivery tuning. Backoff schedule (seconds) is applied by attempt index; after MAX_ATTEMPTS the
// delivery is marked 'failed'. Bounds keep one cron tick cheap and the table from unbounded growth.
export const WEBHOOK_MAX_ATTEMPTS = 6;
const BACKOFF_SCHEDULE_SECONDS = [30, 120, 600, 3600, 21600]; // 30s, 2m, 10m, 1h, 6h
export const WEBHOOK_ENQUEUE_BATCH = 500;
export const WEBHOOK_DELIVER_BATCH = 50;
const DELIVER_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------------------------
// Event-source descriptors. The three READ-ONLY audit tables, the monotonic integer the cursor
// advances on, and the columns the payload builder needs. order_events has a TEXT event_id PK and
// no integer id, so it cursors on the implicit monotonic `rowid` (SQLite assigns it per insert).
// ---------------------------------------------------------------------------------------------
export const WEBHOOK_EVENT_SOURCES = ["entitlement", "customer", "order"];

const SOURCE_SELECT = {
  // entitlement_events: integer id; carries BEFORE/AFTER as prev_json/next_json.
  entitlement:
    "SELECT id AS event_id, event_type, created_at AS occurred_at, project, feature, license_fingerprint, " +
    "status, prev_json, next_json FROM entitlement_events WHERE id > ? ORDER BY id ASC LIMIT ?",
  // customer_events: integer id; carries BEFORE/AFTER as prev_status/next_status.
  customer:
    "SELECT id AS event_id, event_type, created_at AS occurred_at, customer_id, prev_status, next_status " +
    "FROM customer_events WHERE id > ? ORDER BY id ASC LIMIT ?",
  // order_events: TEXT event_id PK -> cursor on the implicit monotonic rowid; the order RESULT is
  // result_json (the applied/cached body). order_event_id is the stable external id for the payload.
  order:
    "SELECT rowid AS event_id, event_id AS order_event_id, intent AS event_type, received_at AS occurred_at, " +
    "subscription_id, project, feature, status, result_json FROM order_events WHERE rowid > ? ORDER BY rowid ASC LIMIT ?",
};

// -------------------------------------------------------------------------------------------------
// PURE HELPERS (no I/O) — unit-testable in isolation.
// -------------------------------------------------------------------------------------------------

/**
 * CSV event_types filter. '' (or all-empty entries) means "all event types". Otherwise the event's
 * type must appear (exact, trimmed) in the comma-separated allow-list. Pure string logic so an
 * endpoint's filter can be tested without a DB.
 */
export function eventTypeMatches(filterCsv, eventType) {
  if (typeof filterCsv !== "string" || filterCsv.trim() === "") return true;
  const allow = filterCsv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (allow.length === 0) return true;
  return allow.includes(eventType);
}

/** Parse a stored JSON string column into an object; '' / null / malformed -> null (never throws). */
function parseJsonColumn(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Build the NORMALIZED webhook payload object for one source event row. Shape:
 *   { id, type, source, occurred_at, data: { ...BEFORE/AFTER state } }
 * - id/type/source/occurred_at are the envelope every receiver can switch on.
 * - data carries the event's BEFORE/AFTER state: prev/next JSON (entitlement), prev/next status
 *   (customer), or the order result (order). Pure: the caller JSON.stringifies the return and signs
 *   over THOSE exact bytes, so the builder and the signed bytes can never drift.
 */
export function buildWebhookPayload(eventSource, row) {
  if (eventSource === "entitlement") {
    return {
      id: Number(row.event_id),
      type: row.event_type,
      source: "entitlement",
      occurred_at: Number(row.occurred_at),
      data: {
        project: row.project,
        feature: row.feature,
        license_fingerprint: row.license_fingerprint,
        status: row.status,
        prev: parseJsonColumn(row.prev_json),
        next: parseJsonColumn(row.next_json),
      },
    };
  }
  if (eventSource === "customer") {
    return {
      id: Number(row.event_id),
      type: row.event_type,
      source: "customer",
      occurred_at: Number(row.occurred_at),
      data: {
        customer_id: row.customer_id,
        prev_status: row.prev_status,
        next_status: row.next_status,
      },
    };
  }
  if (eventSource === "order") {
    return {
      id: Number(row.event_id),
      type: row.event_type,
      source: "order",
      occurred_at: Number(row.occurred_at),
      data: {
        order_event_id: row.order_event_id,
        subscription_id: row.subscription_id,
        project: row.project,
        feature: row.feature,
        status: row.status,
        result: parseJsonColumn(row.result_json),
      },
    };
  }
  throw new Error(`unknown webhook event source: ${eventSource}`);
}

/** Lowercase hex of bytes, no allocations beyond the join. */
function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** Hex string -> bytes; returns null on odd length / non-hex (a tampered/garbage signature). */
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isInteger(byte)) return null;
    // parseInt is lenient ("zz" -> NaN handled above; " a" would slip) — re-validate the two chars.
    if (!/^[0-9a-fA-F]{2}$/.test(hex.slice(i * 2, i * 2 + 2))) return null;
    bytes[i] = byte;
  }
  return bytes;
}

/** The exact bytes a webhook signature is computed over: "<t>.<rawjsonbody>". */
function canonicalSignedText(t, rawBody) {
  return `${t}.${rawBody}`;
}

/**
 * Sign a webhook body with the env secret identified by keyId. Returns the full header VALUE:
 *   t=<now>,keyid=<keyId>,v1=<hex(HMAC-SHA256("<now>.<body>"))>
 * `secretsMap` is the null-prototype map from loadSecretMap; `keyId` must be present (the caller
 * fails closed before calling). `body` is the EXACT raw JSON string that will be sent. Throws only on
 * a crypto failure (the caller treats a throw as "skip this delivery, never send unsigned").
 */
export async function signWebhookBody(secretsMap, keyId, body, now) {
  const secretBytes = lookupSecret(secretsMap, keyId);
  if (secretBytes === null) {
    throw new Error("webhook signing key not in secret map");
  }
  const t = Math.floor(now);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(canonicalSignedText(t, body))),
  );
  return `t=${t},keyid=${keyId},v1=${bytesToHex(sigBytes)}`;
}

/** Parse a "t=..,keyid=..,v1=.." header into its parts; missing parts -> null. Order-insensitive. */
function parseSignatureHeader(header) {
  if (typeof header !== "string" || header.length === 0) return null;
  const parts = Object.create(null);
  for (const segment of header.split(",")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const k = segment.slice(0, eq).trim();
    const v = segment.slice(eq + 1).trim();
    if (k === "t" || k === "keyid" || k === "v1") parts[k] = v;
  }
  if (typeof parts.t !== "string" || typeof parts.keyid !== "string" || typeof parts.v1 !== "string") {
    return null;
  }
  return parts;
}

/**
 * Verify a "Licensecc-Signature" header over the EXACT raw body bytes. Used by the test AND exported
 * for receivers (and the admin worker). Returns true only when:
 *   - the header parses, the keyid is a known secret, t is a canonical integer,
 *   - |now - t| <= skewSec (the replay window — default 5 minutes), AND
 *   - HMAC-SHA256("<t>.<rawBody>") with that secret matches v1 (crypto.subtle.verify — constant-time).
 * Constant-time: the compare is crypto.subtle.verify, never a manual === on the hex.
 */
export async function verifyWebhookSignature(
  rawBody,
  header,
  secretsMap,
  now,
  skewSec = WEBHOOK_REPLAY_WINDOW_SECONDS,
) {
  if (secretsMap === null || typeof secretsMap !== "object") return false;
  const parts = parseSignatureHeader(header);
  if (parts === null) return false;

  // t must be a canonical non-negative integer string ("123" ok; "123.0"/" 123"/"+1" rejected).
  const t = Number(parts.t);
  if (!Number.isInteger(t) || t < 0 || String(t) !== parts.t) return false;
  const skew = Number.isInteger(skewSec) && skewSec >= 0 ? skewSec : WEBHOOK_REPLAY_WINDOW_SECONDS;
  if (Math.abs(Math.floor(now) - t) > skew) return false;

  const secretBytes = lookupSecret(secretsMap, parts.keyid);
  if (secretBytes === null) return false;

  const sigBytes = hexToBytes(parts.v1);
  if (sigBytes === null) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      textEncoder.encode(canonicalSignedText(parts.t, rawBody)),
    );
  } catch {
    return false;
  }
}

/**
 * Exponential backoff (seconds) for a delivery that has already recorded `attempts` failures (so the
 * 1st retry uses index 0). Past the schedule's tail it clamps to the last (longest) interval. Pure.
 */
export function nextBackoff(attempts) {
  const i = Number.isInteger(attempts) && attempts > 0 ? attempts - 1 : 0;
  if (i < BACKOFF_SCHEDULE_SECONDS.length) return BACKOFF_SCHEDULE_SECONDS[i];
  return BACKOFF_SCHEDULE_SECONDS[BACKOFF_SCHEDULE_SECONDS.length - 1];
}

// -------------------------------------------------------------------------------------------------
// ENQUEUE + DELIVER (D1 I/O) — called ONLY from scheduled(). Best-effort: every DB/fetch error is
// swallowed so a webhook problem can never break the cron sweep that runs alongside it.
// -------------------------------------------------------------------------------------------------

/** Load the active endpoints once per tick (cheap; the set is operator-sized, not user-sized). */
async function loadActiveEndpoints(env) {
  const res = await env.DB.prepare(
    "SELECT id, url, event_types, scope_project, scope_customer_id FROM webhook_endpoints WHERE status = 'active'",
  ).all();
  return res.results ?? [];
}

/**
 * Per-tenant scope filter (audit R2.2). A global endpoint (both scope columns null/empty) receives
 * every event (back-compat). An endpoint scoped on a dimension receives ONLY events that carry AND
 * match that dimension: entitlement/order events carry `project`; customer events carry `customer_id`.
 * An endpoint scoped on a dimension the event does not carry (e.g. a project-scoped endpoint vs a
 * customer event) does not match, so a webhook no longer fans every tenant's row snapshots out to
 * every endpoint. (Note: entitlement_events carry project but not customer_id, so a customer-scoped
 * endpoint receives customer_events only, not that customer's entitlement changes.)
 */
function endpointScopeMatches(endpoint, source, row) {
  const scopeProject = endpoint.scope_project;
  const scopeCustomer = endpoint.scope_customer_id;
  const hasProjectScope = typeof scopeProject === "string" && scopeProject.length > 0;
  const hasCustomerScope = typeof scopeCustomer === "string" && scopeCustomer.length > 0;
  if (!hasProjectScope && !hasCustomerScope) return true; // global endpoint
  const eventProject = source === "customer" ? null : row.project ?? null;
  const eventCustomer = source === "customer" ? row.customer_id ?? null : null;
  if (hasProjectScope && eventProject !== scopeProject) return false;
  if (hasCustomerScope && eventCustomer !== scopeCustomer) return false;
  return true;
}

/** Read the per-source cursor high-water mark (0 if never run). */
async function readCursor(env, source) {
  const row = await env.DB.prepare("SELECT last_id FROM webhook_cursor WHERE event_source = ?")
    .bind(source)
    .first();
  return row && row.last_id !== undefined && row.last_id !== null ? Number(row.last_id) : 0;
}

/** Advance (upsert) the per-source cursor to `lastId`. */
async function writeCursor(env, source, lastId, now) {
  await env.DB.prepare(
    "INSERT INTO webhook_cursor (event_source, last_id, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(event_source) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at",
  )
    .bind(source, lastId, now)
    .run();
}

/**
 * ENQUEUE pass for ONE event source. Reads events with id > cursor (bounded), and for each event x
 * each active endpoint whose filter matches, INSERT OR IGNORE a pending webhook_delivery. The UNIQUE
 * (endpoint_id, event_source, event_id) makes a re-run a no-op = exactly-once. Advances the cursor to
 * the max id read (whether or not any endpoint matched — a filtered-out event is still "seen", so we
 * never re-scan it). Returns the count of rows scanned (for an inner loop to keep draining).
 */
async function enqueueSource(env, source, endpoints, now) {
  const cursor = await readCursor(env, source);
  const res = await env.DB.prepare(SOURCE_SELECT[source]).bind(cursor, WEBHOOK_ENQUEUE_BATCH).all();
  const rows = res.results ?? [];
  if (rows.length === 0) return 0;

  let maxId = cursor;
  for (const row of rows) {
    const eventId = Number(row.event_id);
    if (eventId > maxId) maxId = eventId;
    for (const endpoint of endpoints) {
      if (!eventTypeMatches(endpoint.event_types, row.event_type)) continue;
      if (!endpointScopeMatches(endpoint, source, row)) continue;
      const payload = buildWebhookPayload(source, row);
      const payloadJson = JSON.stringify(payload);
      // INSERT OR IGNORE: the UNIQUE guard turns a duplicate (re-run) into a silent no-op. next_
      // attempt_at = now so the very next deliver pass picks it up immediately.
      await env.DB.prepare(
        "INSERT OR IGNORE INTO webhook_deliveries " +
          "(endpoint_id, event_source, event_id, event_type, payload_json, status, attempts, " +
          "last_status, last_error, next_attempt_at, created_at) " +
          "VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, '', ?, ?)",
      )
        .bind(endpoint.id, source, eventId, row.event_type, payloadJson, now, now)
        .run();
    }
  }
  // Advance the cursor to the max id we scanned (monotonic) so the next tick starts after it.
  if (maxId > cursor) await writeCursor(env, source, maxId, now);
  return rows.length;
}

/**
 * ENQUEUE across all sources. Each source drains in bounded batches until a partial batch (so a
 * backlog still catches up, but one tick is bounded by WEBHOOK_ENQUEUE_BATCH * a small loop cap).
 * Best-effort per source: one source's DB error never blocks the others.
 */
export async function enqueueWebhooks(env, now) {
  let endpoints;
  try {
    endpoints = await loadActiveEndpoints(env);
  } catch {
    return; // no endpoints readable -> nothing to enqueue this tick
  }
  if (endpoints.length === 0) return;

  for (const source of WEBHOOK_EVENT_SOURCES) {
    try {
      // Bounded drain: at most a few full batches per tick so the cron stays cheap under a backlog.
      for (let pass = 0; pass < 4; pass += 1) {
        const scanned = await enqueueSource(env, source, endpoints, now);
        if (scanned < WEBHOOK_ENQUEUE_BATCH) break;
      }
    } catch {
      // best-effort: a single source's enqueue failure must not block the others or the cron.
    }
  }
}

/**
 * DELIVER pass: pick up to WEBHOOK_DELIVER_BATCH due deliveries (pending AND next_attempt_at <= now),
 * sign + POST each, and on 2xx mark delivered, else bump attempts with exponential backoff, and after
 * MAX_ATTEMPTS mark failed. Fail-closed signing: if the env has no usable signing secret (or none for
 * the configured key id), the dispatcher LOGS + SKIPS — it never sends unsigned. Best-effort: a fetch
 * that throws/times out is caught and recorded as a retry, never escaping scheduled().
 */
export async function deliverWebhooks(env, now, logEvent) {
  // Fail-closed: with no usable signing secret map, do not deliver (never send unsigned). Log so the
  // skip is observable, then return — pending rows simply wait for a properly-configured tick.
  const secretsMap = loadSecretMap(env?.WEBHOOK_SIGNING_SECRETS);
  if (secretsMap === null) {
    logEvent?.("warn", "webhook.signing_unconfigured", { skipped: true });
    return;
  }
  const keyId = env?.WEBHOOK_SIGNING_KEY_ID;
  if (typeof keyId !== "string" || keyId.length === 0 || lookupSecret(secretsMap, keyId) === null) {
    logEvent?.("warn", "webhook.signing_key_missing", { skipped: true });
    return;
  }

  let due;
  try {
    const res = await env.DB.prepare(
      "SELECT d.id, d.endpoint_id, d.event_source, d.event_id, d.event_type, d.payload_json, d.attempts, e.url " +
        "FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id " +
        "WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND e.status = 'active' " +
        "ORDER BY d.next_attempt_at ASC, d.id ASC LIMIT ?",
    )
      .bind(now, WEBHOOK_DELIVER_BATCH)
      .all();
    due = res.results ?? [];
  } catch {
    return; // table not readable this tick -> nothing to do
  }

  for (const delivery of due) {
    await deliverOne(env, delivery, secretsMap, keyId, now, logEvent);
  }
}

/** Deliver a single row. All failure modes (sign throw, fetch throw/timeout, non-2xx) are caught and
 *  recorded as a retry/terminal failure — NEVER rethrown. */
async function deliverOne(env, delivery, secretsMap, keyId, now, logEvent) {
  const body = delivery.payload_json;

  let signatureHeader;
  try {
    signatureHeader = await signWebhookBody(secretsMap, keyId, body, now);
  } catch {
    // Should not happen (we checked the key above), but if signing fails we must not send unsigned.
    logEvent?.("warn", "webhook.sign_failed", { delivery_id: Number(delivery.id) });
    return;
  }

  let statusCode = 0;
  let errText = "";
  let ok = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVER_TIMEOUT_MS);
  try {
    const resp = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Licensecc-Signature": signatureHeader,
        "Licensecc-Webhook-Id": String(delivery.id),
        "Licensecc-Event-Source": String(delivery.event_source),
      },
      body,
      signal: controller.signal,
    });
    statusCode = typeof resp.status === "number" ? resp.status : 0;
    ok = statusCode >= 200 && statusCode < 300;
    if (!ok) {
      // Read a short error snippet best-effort; never let a body read failure crash the tick.
      try {
        errText = (await resp.text()).slice(0, 256);
      } catch {
        errText = "";
      }
    }
  } catch (error) {
    // Network error, abort/timeout, DNS, etc. -> a retryable failure.
    errText = error instanceof Error ? error.message.slice(0, 256) : "fetch_error";
  } finally {
    clearTimeout(timer);
  }

  try {
    if (ok) {
      await env.DB.prepare(
        "UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_status = ?, " +
          "last_error = '', delivered_at = ? WHERE id = ?",
      )
        .bind(statusCode, now, Number(delivery.id))
        .run();
      return;
    }
    const attempts = Number(delivery.attempts) + 1;
    if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
      await env.DB.prepare(
        "UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_status = ?, last_error = ? WHERE id = ?",
      )
        .bind(attempts, statusCode, errText, Number(delivery.id))
        .run();
      logEvent?.("warn", "webhook.delivery_failed", {
        delivery_id: Number(delivery.id),
        endpoint_id: delivery.endpoint_id,
        attempts,
        last_status: statusCode,
      });
      return;
    }
    const backoff = nextBackoff(attempts);
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?",
    )
      .bind(attempts, statusCode, errText, now + backoff, Number(delivery.id))
      .run();
  } catch {
    // best-effort: failing to record the attempt outcome must not break the cron.
  }
}

/**
 * The single entry point wired into scheduled() AFTER the existing sweeps. ENQUEUE then DELIVER, both
 * best-effort. NEVER throws: any error is caught and logged so a webhook problem can never break the
 * seat/retention sweeps or the cron itself.
 */
export async function enqueueAndDeliverWebhooks(env, now, logEvent) {
  try {
    await enqueueWebhooks(env, now);
  } catch (error) {
    logEvent?.("error", "webhook.enqueue_error", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
  try {
    await deliverWebhooks(env, now, logEvent);
  } catch (error) {
    logEvent?.("error", "webhook.deliver_error", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
