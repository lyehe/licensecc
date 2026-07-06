// pg-sql.mjs
//
// PostgreSQL statement builder for the licensing-backend admin CLI -- a faithful,
// command-for-command mirror of scripts/entitlement.mjs's sqlFor(), but emitting
// PARAMETERIZED Postgres SQL ($1..$n + a positional params array) instead of the
// SQLite-literal-embedded strings the wrangler CLI builds.
//
// WHY a parallel module (not an edit to entitlement.mjs): entitlement.mjs is in-flight
// WIP and must not be touched. This module reuses its EXACT validation rules, field
// builders, and per-command branching so behavior is identical; only the SQL dialect and
// the value-passing mechanism differ:
//
//   entitlement.mjs (D1/SQLite, via wrangler):        pg-sql.mjs (Postgres, via postgres.js):
//   ------------------------------------------        ---------------------------------------
//   string-built literals (sqlString/...)        ->   $1..$n placeholders + params[]
//   unixepoch()                                  ->   EXTRACT(EPOCH FROM now())::bigint
//   two-arg scalar max(a, b)                     ->   GREATEST(a, b)   (inner aggregate MAX() kept)
//   lower(hex(randomblob(8)))                    ->   encode(gen_random_bytes(8), 'hex')
//   excluded.<col>                               ->   EXCLUDED.<col>
//   ON CONFLICT(...) DO UPDATE ... WHERE <guard>  -> kept verbatim (references existing row by table name)
//
// RETURN SHAPE:
//   pgSqlFor(command, args) -> for a READ command:    { text, params }
//                              for a MUTATION command: [ { text, params }, ... ]  (ordered)
//   The ordered array mirrors entitlement.mjs joining statements with ";\n": each element is
//   one statement to run, in order, inside a single transaction (see entitlement-pg.mjs).
//
// Every validator / field builder / limit below is copied verbatim from entitlement.mjs so
// the two CLIs accept and reject exactly the same inputs (same messages, same throw points).

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const DEVICE_KEY_ID = /^sha256:[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const NAME = /^[A-Za-z0-9_.:-]+$/;
const STATUS = new Set(["active", "revoked", "disabled"]);

function validatedName(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !NAME.test(value)) {
    throw new Error(`${label} must be 1-${maxLength} characters using letters, digits, _, ., :, or -`);
  }
  return value;
}

function validatedHex(value, label, required = true) {
  if (!required && (value === undefined || value === "")) {
    return "";
  }
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`${label} must be exactly 64 hex characters`);
  }
  return value.toLowerCase();
}

function validatedDeviceKeyId(value) {
  if (typeof value !== "string" || !DEVICE_KEY_ID.test(value)) {
    throw new Error("device-key-id must be sha256:<64 lowercase hex characters>");
  }
  return value;
}

function validatedBase64(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !BASE64.test(value)) {
    throw new Error(`${label} must be 1-${maxLength} characters of padded base64`);
  }
  return value;
}

function validatedInt(value, label, fallback, min, max) {
  const raw = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  }
  return raw;
}

function validatedOptionalInt(value, label, min, max) {
  if (value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  }
  return parsed;
}

function validatedText(value, label, maxLength, required = false) {
  if (value === undefined || value === "") {
    if (required) {
      throw new Error(`${label} is required`);
    }
    return "";
  }
  if (typeof value !== "string" || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be at most ${maxLength} characters without control line breaks`);
  }
  return value;
}

function baseFields(options) {
  return {
    project: validatedName(options.project ?? "DEFAULT", "project", 127),
    feature: validatedName(options.feature ?? "DEFAULT", "feature", 15),
    fingerprint: validatedHex(options.fingerprint, "fingerprint"),
    deviceHash: validatedHex(options["device-hash"], "device-hash", false),
  };
}

function deviceFields(options, requirePublicKey = false) {
  const fields = baseFields(options);
  return {
    ...fields,
    deviceKeyId: validatedDeviceKeyId(options["device-key-id"]),
    publicKeySpkiDerBase64:
      options["public-key-spki-der-base64"] === undefined && !requirePublicKey
        ? ""
        : validatedBase64(options["public-key-spki-der-base64"], "public-key-spki-der-base64", 2048),
  };
}

function mutationContext(options, reasonRequired = false) {
  return {
    actor: validatedText(options.actor, "actor", 128, true),
    reason: validatedText(options.reason, "reason", 1000, reasonRequired),
  };
}

function shortDeviceKeyId(deviceKeyId) {
  const digest = deviceKeyId.slice("sha256:".length);
  return `sha256:${digest.slice(0, 8)}...${digest.slice(-8)}`;
}

// ---------------------------------------------------------------------------------------
// $n placeholder builder. Each *statement* gets its OWN params array starting at $1, so a
// statement can be run independently by the adapter. (entitlement.mjs builds one literal
// string per statement; we build one {text, params} per statement.)
// ---------------------------------------------------------------------------------------
function placeholders() {
  const params = [];
  return {
    params,
    // bind(value) -> the next "$N" token, appending value to params.
    bind(value) {
      params.push(value);
      return `$${params.length}`;
    },
  };
}

// Postgres translations of the SQLite-ism helper fragments (entitlement.mjs:166-187).
// These take a `pb` (placeholder builder) so values bind into the CURRENT statement's params.

// eventSqlFromCurrent (entitlement.mjs:166): event_type/status are params; detail == reason.
function eventSqlFromCurrent(pb, fields, eventType, status, actor, reason) {
  const project = pb.bind(fields.project);
  const feature = pb.bind(fields.feature);
  const fingerprint = pb.bind(fields.fingerprint);
  const evt = pb.bind(eventType);
  const reasonDetail = pb.bind(reason); // detail column = reason
  const actorBind = pb.bind(actor);
  const reasonBind = pb.bind(reason); // reason column = reason
  const statusBind = pb.bind(status);
  return (
    "INSERT INTO entitlement_events (project, feature, license_fingerprint, device_hash, event_type, " +
    "status, revocation_seq, detail, actor, actor_type, source, request_id, reason, created_at) " +
    "SELECT project, feature, license_fingerprint, device_hash, " +
    `${evt}, status, revocation_seq, ${reasonDetail}, ${actorBind}, 'cli', 'cli', ` +
    "'cli-' || encode(gen_random_bytes(8), 'hex'), " +
    `${reasonBind}, EXTRACT(EPOCH FROM now())::bigint ` +
    `FROM entitlements WHERE project = ${project} AND feature = ${feature} ` +
    `AND license_fingerprint = ${fingerprint} AND status = ${statusBind}`
  );
}

// updateEventSqlFromCurrent (entitlement.mjs:174): event_type LITERAL 'update'; device EXISTS guard;
// detail and reason are separate values.
function updateEventSqlFromCurrent(pb, fields, actor, detail, reason) {
  const project = pb.bind(fields.project);
  const feature = pb.bind(fields.feature);
  const fingerprint = pb.bind(fields.fingerprint);
  const detailBind = pb.bind(detail);
  const actorBind = pb.bind(actor);
  const reasonBind = pb.bind(reason);
  const deviceKeyId = pb.bind(fields.deviceKeyId);
  return (
    "INSERT INTO entitlement_events (project, feature, license_fingerprint, device_hash, event_type, " +
    "status, revocation_seq, detail, actor, actor_type, source, request_id, reason, created_at) " +
    "SELECT project, feature, license_fingerprint, device_hash, " +
    `'update', status, revocation_seq, ${detailBind}, ${actorBind}, 'cli', 'cli', ` +
    "'cli-' || encode(gen_random_bytes(8), 'hex'), " +
    `${reasonBind}, EXTRACT(EPOCH FROM now())::bigint ` +
    `FROM entitlements WHERE project = ${project} AND feature = ${feature} ` +
    `AND license_fingerprint = ${fingerprint} AND EXISTS (SELECT 1 FROM entitlement_devices ` +
    `WHERE project = ${project} AND feature = ${feature} AND license_fingerprint = ${fingerprint} ` +
    `AND device_key_id = ${deviceKeyId})`
  );
}

// nextExistingRevocationSeqSql (entitlement.mjs:182): SQLite scalar max(a,b) -> Postgres GREATEST(a,b);
// inner single-column aggregate MAX(revocation_seq) over entitlement_events stays MAX. No params (all
// columns are the existing entitlements row, referenced by table name).
function nextExistingRevocationSeqSql() {
  return (
    "GREATEST(entitlements.revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events " +
    "WHERE project = entitlements.project AND feature = entitlements.feature " +
    "AND license_fingerprint = entitlements.license_fingerprint), entitlements.revocation_seq)) + 1"
  );
}

// nextInsertedRevocationSeqSql (entitlement.mjs:186): used in the upsert VALUES (insert path floor).
// Binds the three identity columns into the current statement.
function nextInsertedRevocationSeqSql(pb, fields) {
  const project = pb.bind(fields.project);
  const feature = pb.bind(fields.feature);
  const fingerprint = pb.bind(fields.fingerprint);
  return (
    "COALESCE((SELECT MAX(revocation_seq) + 1 FROM entitlement_events " +
    `WHERE project = ${project} AND feature = ${feature} AND license_fingerprint = ${fingerprint}), 1)`
  );
}

/**
 * Build the PostgreSQL statement(s) for an admin CLI command.
 *
 * @param {string} command  one of: upsert, revoke, disable, reenable, get, list,
 *                          device-upsert, device-disable, device-revoke, device-list
 * @param {Record<string, string|boolean|undefined>} options  parsed CLI flags (same shape
 *        entitlement.mjs's parseArgs produces; e.g. options.fingerprint, options["device-key-id"]).
 * @returns {{text:string, params:unknown[]} | {text:string, params:unknown[]}[]}
 *          a single {text,params} for reads; an ordered array for mutations.
 * @throws {Error} on validation failure (same messages as entitlement.mjs). Unknown command
 *         throws "unknown command: <command>" (the CLI maps unknown commands to usage()/exit 2).
 */
export function pgSqlFor(command, options) {
  if (command === "upsert") {
    const fields = baseFields(options);
    const status = options.status ?? "active";
    if (!STATUS.has(status)) {
      throw new Error("status must be active, revoked, or disabled");
    }
    const allowRevokedOverride = options["allow-revoked-override"] === true;
    const assertionTtl = validatedInt(options["assertion-ttl"], "assertion-ttl", 300, 1, 3600);
    const cacheTtl = assertionTtl;
    const validFrom = validatedOptionalInt(options["valid-from"], "valid-from", 0, Number.MAX_SAFE_INTEGER);
    const validUntil = validatedOptionalInt(options["valid-until"], "valid-until", 0, Number.MAX_SAFE_INTEGER);
    const customerId = validatedText(options["customer-id"], "customer-id", 128);
    const licenseId = validatedText(options["license-id"], "license-id", 128);
    const ctx = mutationContext(options, allowRevokedOverride);
    if (validFrom !== null && validUntil !== null && validFrom >= validUntil) {
      throw new Error("valid-from must be less than valid-until");
    }
    const conflictGuard = allowRevokedOverride ? "" : " WHERE entitlements.status != 'revoked'";
    const eventType = allowRevokedOverride ? "revoked-override" : "upsert";

    // Statement 1: entitlement upsert (B1 / B5).
    const up = placeholders();
    const project = up.bind(fields.project);
    const feature = up.bind(fields.feature);
    const fingerprint = up.bind(fields.fingerprint);
    const deviceHash = up.bind(fields.deviceHash);
    const statusBind = up.bind(status);
    const assertionTtlBind = up.bind(assertionTtl);
    const cacheTtlBind = up.bind(cacheTtl);
    const insertSeq = nextInsertedRevocationSeqSql(up, fields);
    // sqlNullableInt: null -> SQL NULL (pass JS null through as a bound param; Postgres binds NULL).
    const validFromBind = up.bind(validFrom);
    const validUntilBind = up.bind(validUntil);
    // sqlNullableString: "" / null / undefined -> NULL. Normalize "" to null before binding.
    const customerIdBind = up.bind(customerId === "" ? null : customerId);
    const licenseIdBind = up.bind(licenseId === "" ? null : licenseId);
    const upsertText =
      "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, " +
      "customer_id, license_id, created_at, updated_at) VALUES (" +
      `${project}, ${feature}, ${fingerprint}, ${deviceHash}, ${statusBind}, ` +
      `${assertionTtlBind}, ${cacheTtlBind}, ${insertSeq}, ${validFromBind}, ${validUntilBind}, ` +
      `${customerIdBind}, ${licenseIdBind}, EXTRACT(EPOCH FROM now())::bigint, EXTRACT(EPOCH FROM now())::bigint) ` +
      "ON CONFLICT (project, feature, license_fingerprint) DO UPDATE SET " +
      "device_hash = EXCLUDED.device_hash, status = EXCLUDED.status, " +
      "assertion_ttl_seconds = EXCLUDED.assertion_ttl_seconds, cache_ttl_seconds = EXCLUDED.cache_ttl_seconds, " +
      `revocation_seq = ${nextExistingRevocationSeqSql()}, valid_from = EXCLUDED.valid_from, ` +
      "valid_until = EXCLUDED.valid_until, customer_id = EXCLUDED.customer_id, " +
      `license_id = EXCLUDED.license_id, updated_at = EXTRACT(EPOCH FROM now())::bigint${conflictGuard}`;

    // Statement 2: audit event (B2).
    const ev = placeholders();
    const eventText = eventSqlFromCurrent(ev, fields, eventType, status, ctx.actor, ctx.reason);
    return [
      { text: upsertText, params: up.params },
      { text: eventText, params: ev.params },
    ];
  }

  if (command === "revoke" || command === "disable" || command === "reenable") {
    const fields = baseFields(options);
    const status = command === "revoke" ? "revoked" : command === "disable" ? "disabled" : "active";
    const eventType = command === "revoke" ? "revoke" : command === "disable" ? "disable" : "reenable";
    const ctx = mutationContext(options, command !== "reenable");
    const terminalGuard = command === "disable" || command === "reenable" ? " AND status != 'revoked'" : "";

    // Statement 1: status UPDATE (B6a/b/c).
    const up = placeholders();
    const statusBind = up.bind(status);
    const project = up.bind(fields.project);
    const feature = up.bind(fields.feature);
    const fingerprint = up.bind(fields.fingerprint);
    const updateText =
      `UPDATE entitlements SET status = ${statusBind}, ` +
      `revocation_seq = ${nextExistingRevocationSeqSql()}, updated_at = EXTRACT(EPOCH FROM now())::bigint ` +
      `WHERE project = ${project} AND feature = ${feature} AND license_fingerprint = ${fingerprint}${terminalGuard}`;

    // Statement 2: audit event (B2).
    const ev = placeholders();
    const eventText = eventSqlFromCurrent(ev, fields, eventType, status, ctx.actor, ctx.reason);
    return [
      { text: updateText, params: up.params },
      { text: eventText, params: ev.params },
    ];
  }

  if (command === "get") {
    const fields = baseFields(options);
    const pb = placeholders();
    const project = pb.bind(fields.project);
    const feature = pb.bind(fields.feature);
    const fingerprint = pb.bind(fields.fingerprint);
    return {
      text:
        "SELECT project, feature, license_fingerprint, device_hash, status, " +
        "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, " +
        "notes, created_at, updated_at FROM entitlements " +
        `WHERE project = ${project} AND feature = ${feature} AND license_fingerprint = ${fingerprint}`,
      params: pb.params,
    };
  }

  if (command === "device-upsert") {
    const device = deviceFields(options, true);
    const status = options.status ?? "active";
    if (!STATUS.has(status)) {
      throw new Error("status must be active, revoked, or disabled");
    }
    const ctx = mutationContext(options);
    const detail = `device-upsert ${shortDeviceKeyId(device.deviceKeyId)}${ctx.reason === "" ? "" : `: ${ctx.reason}`}`;

    // Statement 1: device upsert (B4).
    const up = placeholders();
    const project = up.bind(device.project);
    const feature = up.bind(device.feature);
    const fingerprint = up.bind(device.fingerprint);
    const deviceKeyId = up.bind(device.deviceKeyId);
    const publicKey = up.bind(device.publicKeySpkiDerBase64);
    const statusBind = up.bind(status);
    const deviceText =
      "INSERT INTO entitlement_devices (project, feature, license_fingerprint, device_key_id, " +
      "public_key_spki_der_base64, status, created_at, updated_at) VALUES (" +
      `${project}, ${feature}, ${fingerprint}, ${deviceKeyId}, ${publicKey}, ${statusBind}, ` +
      "EXTRACT(EPOCH FROM now())::bigint, EXTRACT(EPOCH FROM now())::bigint) " +
      "ON CONFLICT (project, feature, license_fingerprint, device_key_id) DO UPDATE SET " +
      "public_key_spki_der_base64 = EXCLUDED.public_key_spki_der_base64, status = EXCLUDED.status, " +
      "updated_at = EXTRACT(EPOCH FROM now())::bigint";

    // Statement 2: parent revocation_seq bump, guarded by device existence (B8).
    const bump = placeholders();
    const bumpText = parentBumpSql(bump, device);

    // Statement 3: update event (B7).
    const ev = placeholders();
    const eventText = updateEventSqlFromCurrent(ev, device, ctx.actor, detail, ctx.reason);
    return [
      { text: deviceText, params: up.params },
      { text: bumpText, params: bump.params },
      { text: eventText, params: ev.params },
    ];
  }

  if (command === "device-disable" || command === "device-revoke") {
    const device = deviceFields(options);
    const status = command === "device-disable" ? "disabled" : "revoked";
    const ctx = mutationContext(options, true);
    const detail = `${command} ${shortDeviceKeyId(device.deviceKeyId)}: ${ctx.reason}`;

    // Statement 1: device state UPDATE (B9).
    const up = placeholders();
    const statusBind = up.bind(status);
    const project = up.bind(device.project);
    const feature = up.bind(device.feature);
    const fingerprint = up.bind(device.fingerprint);
    const deviceKeyId = up.bind(device.deviceKeyId);
    const deviceText =
      `UPDATE entitlement_devices SET status = ${statusBind}, updated_at = EXTRACT(EPOCH FROM now())::bigint ` +
      `WHERE project = ${project} AND feature = ${feature} AND license_fingerprint = ${fingerprint} ` +
      `AND device_key_id = ${deviceKeyId}`;

    // Statement 2: parent revocation_seq bump, guarded by device existence (B8).
    const bump = placeholders();
    const bumpText = parentBumpSql(bump, device);

    // Statement 3: update event (B7).
    const ev = placeholders();
    const eventText = updateEventSqlFromCurrent(ev, device, ctx.actor, detail, ctx.reason);
    return [
      { text: deviceText, params: up.params },
      { text: bumpText, params: bump.params },
      { text: eventText, params: ev.params },
    ];
  }

  if (command === "device-list") {
    const device = baseFields(options);
    const pb = placeholders();
    const project = pb.bind(device.project);
    const feature = pb.bind(device.feature);
    const fingerprint = pb.bind(device.fingerprint);
    return {
      text:
        "SELECT project, feature, license_fingerprint, device_key_id, status, " +
        "created_at, updated_at, last_seen_at, notes FROM entitlement_devices " +
        `WHERE project = ${project} AND feature = ${feature} AND license_fingerprint = ${fingerprint} ` +
        "ORDER BY updated_at DESC LIMIT 100",
      params: pb.params,
    };
  }

  if (command === "list") {
    const project = options.project === undefined ? undefined : validatedName(options.project, "project", 127);
    const feature = options.feature === undefined ? undefined : validatedName(options.feature, "feature", 15);
    const pb = placeholders();
    const filters = [];
    if (project !== undefined) {
      filters.push(`project = ${pb.bind(project)}`);
    }
    if (feature !== undefined) {
      filters.push(`feature = ${pb.bind(feature)}`);
    }
    const where = filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`;
    return {
      text:
        "SELECT project, feature, license_fingerprint, device_hash, status, " +
        "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, " +
        `notes, created_at, updated_at FROM entitlements${where} ORDER BY updated_at DESC LIMIT 100`,
      params: pb.params,
    };
  }

  throw new Error(`unknown command: ${command}`);
}

// parentBumpSql (entitlement.mjs:248 / :259): UPDATE entitlements ... GUARDED by device existence (B8).
function parentBumpSql(pb, device) {
  const project = pb.bind(device.project);
  const feature = pb.bind(device.feature);
  const fingerprint = pb.bind(device.fingerprint);
  const deviceKeyId = pb.bind(device.deviceKeyId);
  return (
    `UPDATE entitlements SET revocation_seq = ${nextExistingRevocationSeqSql()}, ` +
    `updated_at = EXTRACT(EPOCH FROM now())::bigint ` +
    `WHERE project = ${project} AND feature = ${feature} AND license_fingerprint = ${fingerprint} ` +
    `AND EXISTS (SELECT 1 FROM entitlement_devices WHERE project = ${project} AND feature = ${feature} ` +
    `AND license_fingerprint = ${fingerprint} AND device_key_id = ${deviceKeyId})`
  );
}

// The set of commands that mutate (return an ordered array of statements run in one
// transaction). Mirrors entitlement.mjs's MUTATION_COMMANDS.
export const MUTATION_COMMANDS = new Set([
  "upsert",
  "revoke",
  "disable",
  "reenable",
  "device-upsert",
  "device-disable",
  "device-revoke",
]);

// Read commands (return a single {text, params}). Used by the CLI to choose .all()/.first().
export const READ_COMMANDS = new Set(["get", "list", "device-list"]);
