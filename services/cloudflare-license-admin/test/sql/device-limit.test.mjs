import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { entitlementId } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { openApiDocument } from "../../dist-worker/worker/openapi/document.js";
import { loadWorkflowModule } from "../admin-ui-workflow/helpers.mjs";
import { worker, baseEnv, authed } from "../worker/fixtures.mjs";

// B2: the device limit is settable. A create without a policy writes it inside its own batch,
// behind the create's claim; a PATCH writes it alone through the runtime's capacity chokepoint. A
// protected grant refuses a limit below its connected devices and says how many there are (ADR 0006).
const path = "/api/admin/entitlements";
const protectedGrant = { project: "APP", feature: "PRO", license_fingerprint: "a".repeat(64), customer_id: "owner", license_id: "license", enforcement_mode: "device_bound_v1" };
const legacyGrant = { project: "APP", feature: "LEGACY", license_fingerprint: "b".repeat(64), enforcement_mode: "legacy" };
const HOUR = 3600;

function fixture(t) {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  let now = 1_900_000_000, devices = 0;
  sql.function("unixepoch", () => now);
  sql.exec(readFileSync(new URL("../../../cloudflare-licensing-backend/schema.sql", import.meta.url), "utf8"));
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1,1);
    INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('license','owner','APP',1,1);
    INSERT INTO entitlement_policies(id,project,name,type,max_active_devices,created_at,updated_at) VALUES('policy','APP','Policy','node_locked',3,1,1);`);
  let beforeBatch = () => {};
  const prepare = (query, args = []) => ({ query, args,
    bind(...values) { return prepare(query, values); },
    async first(column) { const row = sql.prepare(query).get(...args); return column ? row?.[column] ?? null : row ?? null; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
    async run() { return this.all(); },
  });
  const db = { prepare, withSession() { return this; }, async batch(statements) {
    const hook = beforeBatch; beforeBatch = () => {}; await hook(statements);
    sql.exec("BEGIN");
    try { const result = statements.map((s) => ({ results: sql.prepare(s.query).all(...s.args) })); sql.exec("COMMIT"); return result; }
    catch (error) { sql.exec("ROLLBACK"); throw error; }
  } };
  const env = { ...baseEnv(db), POLICY_STAMP_MODE: "on" };
  return {
    sql,
    now: () => now,
    clock(value) { now = value; },
    race(fn) { beforeBatch = fn; },
    snapshot: () => ["entitlements", "entitlement_events", "mutation_idempotency"].map((table) => sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    send(body, key = crypto.randomUUID(), url = path, method = "POST") {
      const headers = key === null ? {} : { "idempotency-key": key };
      return worker.fetch(authed(url, { method, headers, body: JSON.stringify(body) }), env);
    },
    patch(id, body, key = crypto.randomUUID()) { return this.send(body, key, `${path}/${id}`, "PATCH"); },
    stored(grant = protectedGrant) {
      return sql.prepare("SELECT max_active_devices AS device_limit FROM entitlements WHERE project=? AND feature=? AND license_fingerprint=?")
        .get(grant.project, grant.feature, grant.license_fingerprint)?.device_limit;
    },
    connect(state, holdUntil, grant = protectedGrant) {
      devices += 1;
      sql.prepare("INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at) VALUES(?,?,?,?,'synthetic',1,1)")
        .run(`device-${devices}`, "owner", grant.project, `key-${devices}`);
      sql.prepare(`INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,state,hold_until,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,1,1)`).run(`binding-${devices}`, grant.project, grant.feature, grant.license_fingerprint, `device-${devices}`, state, holdUntil);
    },
  };
}

async function created(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data;
}

async function refused(response, status, code, data) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.deepEqual(body.data, data);
}

test("a create without a policy stores its own device limit in either mode, and a replay returns the same grant", async t => {
  for (const grant of [protectedGrant, legacyGrant]) {
    const f = fixture(t);
    const first = await f.send({ ...grant, max_active_devices: 3 }, "create");
    assert.equal(first.status, 200);
    const text = await first.text();
    assert.equal(JSON.parse(text).data.max_active_devices, 3);
    assert.equal(f.stored(grant), 3);
    assert.equal(JSON.parse(f.sql.prepare("SELECT next_json FROM entitlement_events").get().next_json).max_active_devices, 3, "the audit event records the limit");
    const replay = await f.send({ ...grant, max_active_devices: 3 }, "create");
    assert.equal(await replay.text(), text);
    // Without a replay key, the answer is the row the batch committed, not the pre-limit upsert.
    const other = { ...grant, feature: `${grant.feature.slice(0, 10)}2`, license_fingerprint: "c".repeat(64) };
    if (grant === protectedGrant) f.sql.exec("INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('license-2','owner','APP',1,1)");
    const unkeyed = await created(await f.send({ ...other, ...(grant === protectedGrant ? { license_id: "license-2" } : {}), max_active_devices: 7 }, null));
    assert.equal(unkeyed.max_active_devices, 7);
  }
});

test("a create that selects a policy cannot also set a device limit; the policy owns it", async t => {
  const f = fixture(t), before = f.snapshot();
  const response = await f.send({ ...protectedGrant, policy_id: "policy", max_active_devices: 5 });
  await refused(response, 400, "invalid_request", undefined);
  assert.deepEqual(f.snapshot(), before);
  assert.equal((await created(await f.send({ ...protectedGrant, policy_id: "policy" }))).max_active_devices, 3);
  // An empty policy_id selects no policy, so the create sets its own limit.
  const g = fixture(t);
  assert.equal((await created(await g.send({ ...protectedGrant, policy_id: "", max_active_devices: 5 }))).max_active_devices, 5);
});

test("a device limit outside 1 to 1,000,000 is refused before any write", async t => {
  const f = fixture(t);
  const grant = await created(await f.send(legacyGrant));
  const before = f.snapshot();
  for (const value of [0, -1, 1_000_001, 2.5, "3", null, true, [3], 1e21]) {
    await refused(await f.send({ ...protectedGrant, max_active_devices: value }), 400, "invalid_request", undefined);
    await refused(await f.send({ ...legacyGrant, max_active_devices: value }), 400, "invalid_request", undefined);
    await refused(await f.patch(grant.id, { max_active_devices: value }), 400, "invalid_request", undefined);
  }
  assert.deepEqual(f.snapshot(), before);
  for (const value of [1, 1_000_000]) {
    assert.equal((await created(await f.patch(grant.id, { max_active_devices: value }))).max_active_devices, value);
  }
});

test("a PATCH sets only the device limit, audits it, and honors the expected state", async t => {
  const f = fixture(t);
  const grant = await created(await f.send(protectedGrant));
  const url = `${path}/${grant.id}`;
  const before = f.snapshot();
  const expected = { expected_customer_id: "owner", expected_revocation_seq: grant.revocation_seq };
  await refused(await f.patch(grant.id, { max_active_devices: 5, ...expected, expected_revocation_seq: grant.revocation_seq + 7 }), 409, "stale_transition", undefined);
  // The device limit is its own audited capacity write, so it cannot share a PATCH with other fields.
  await refused(await f.patch(grant.id, { max_active_devices: 5, notes: "both" }), 400, "invalid_request", undefined);
  assert.deepEqual(f.snapshot(), before);

  const patched = await f.send({ max_active_devices: 5, ...expected }, "limit", url, "PATCH");
  assert.equal(patched.status, 200);
  const body = await patched.json();
  assert.equal(body.code, "entitlement_patched");
  assert.equal(body.data.max_active_devices, 5);
  assert.ok(body.data.revocation_seq > grant.revocation_seq);
  assert.equal(body.data.notes, grant.notes);
  assert.equal(f.stored(), 5);
  assert.equal(f.snapshot()[1].length, before[1].length + 1, "one audit event");
  assert.equal(JSON.parse(f.sql.prepare("SELECT next_json FROM entitlement_events ORDER BY id DESC").get().next_json).max_active_devices, 5);

  await created(await f.send({ reason: "done" }, "revoke", `${url}/revoke`, "POST"));
  await refused(await f.patch(grant.id, { max_active_devices: 6 }), 409, "revoked_entitlement_is_terminal", undefined);
  await refused(await f.patch(entitlementId("APP", "MISSING", "9".repeat(64)), { max_active_devices: 6 }), 404, "not_found", undefined);
});

test("a PATCH below the connected devices is refused with their count and changes nothing", async t => {
  const f = fixture(t);
  const grant = await created(await f.send({ ...protectedGrant, max_active_devices: 5 }));
  const now = f.now();
  // Occupied: both active bindings, and the retiring one whose hold has not ended.
  f.connect("active", 0);
  f.connect("active", now + HOUR);
  f.connect("retiring", now + HOUR);
  f.connect("retiring", now - 1);
  f.connect("released", now - HOUR);
  const before = f.snapshot();
  for (const key of ["shrink", "shrink"]) {
    await refused(await f.patch(grant.id, { max_active_devices: 2 }, key), 409, "capacity_in_use", { devices_in_use: 3 });
    assert.deepEqual(f.snapshot(), before, "a refused PATCH leaves no write, audit event, or replay record");
  }
  assert.equal((await created(await f.patch(grant.id, { max_active_devices: 3 }))).max_active_devices, 3);
  // Once the retiring hold ends, its slot is free again.
  f.clock(now + HOUR + 1);
  assert.equal((await created(await f.patch(grant.id, { max_active_devices: 2 }))).max_active_devices, 2);
});

test("a protected re-create without a policy cannot set a device limit below the connected devices", async t => {
  const f = fixture(t);
  await created(await f.send({ ...protectedGrant, max_active_devices: 3 }));
  f.connect("active", 0);
  f.connect("active", 0);
  const before = f.snapshot();
  await refused(await f.send({ ...protectedGrant, max_active_devices: 1 }), 409, "protected_creation_conflict", { reason: "invalid_capacity" });
  assert.deepEqual(f.snapshot(), before);
  assert.equal((await created(await f.send({ ...protectedGrant, max_active_devices: 2 }))).max_active_devices, 2);
});

test("a missing or incorrect device-limit side-write rolls back the preceding upsert", async t => {
  for (const missing of [true, false]) {
    const f = fixture(t), before = f.snapshot();
    f.race((statements) => {
      const write = statements.find((statement) => statement.query.startsWith("UPDATE entitlements SET max_active_devices"));
      assert.ok(write, "the device limit rides the create batch");
      if (missing) write.query = write.query.replace("WHERE project", "WHERE 0 AND project");
      else write.args[0] = 4;
    });
    // Every rule holds for the row the create meant to write; only the injected fault differs.
    await refused(await f.send({ ...protectedGrant, max_active_devices: 3 }), 409, "protected_creation_conflict", { reason: "unknown" });
    assert.deepEqual(f.snapshot(), before);
  }
});

// Ruling R26: the console's untouched create form sends no device limit, so re-creating an existing
// key keeps its stored limit, as every upsert did before B2. The body is built by the console's
// own normalizer, so a console that starts sending a default again fails here.
test("a console re-create of an existing key keeps its stored device limit", async t => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const consoleBody = (grant) => workflow.normalizeEntitlementForm({
    ...workflow.emptyEntitlementForm, enforcement_mode: grant.enforcement_mode, project: grant.project, feature: grant.feature,
    license_fingerprint: grant.license_fingerprint, customer_id: grant.customer_id ?? "", license_id: grant.license_id ?? "",
  });
  assert.equal(Object.hasOwn(consoleBody(protectedGrant), "max_active_devices"), false);
  const cases = [
    { name: "a legacy grant", grant: legacyGrant, create: { ...legacyGrant, max_active_devices: 5 }, devices: 0, limit: 5 },
    { name: "a protected grant with two connected devices", grant: protectedGrant, create: { ...protectedGrant, max_active_devices: 5 }, devices: 2, limit: 5 },
    { name: "a legacy grant stamped from a policy", grant: legacyGrant, create: { ...legacyGrant, policy_id: "policy" }, devices: 0, limit: 3 },
  ];
  for (const { name, grant, create, devices, limit } of cases) {
    const f = fixture(t);
    await created(await f.send(create));
    for (let n = 0; n < devices; n += 1) f.connect("active", 0);
    assert.equal(f.stored(grant), limit, name);
    const again = await created(await f.send(consoleBody(grant)));
    assert.equal(again.max_active_devices, limit, name);
    assert.equal(f.stored(grant), limit, name);
  }
});

// The PATCH body rule is stated once in OpenAPI: no other patchable field may accompany the limit.
// The Worker must refuse exactly those, and, like every PATCH, ignore keys it does not patch.
test("a device-limit PATCH refuses every other patchable field that OpenAPI names, and ignores the rest", async t => {
  const f = fixture(t);
  const grant = await created(await f.send(protectedGrant));
  const excluded = openApiDocument.components.schemas.EntitlementPatch.dependentSchemas.max_active_devices.not.anyOf.map((rule) => rule.required[0]);
  const samples = { device_hash: "", assertion_ttl_seconds: 300, valid_from: null, valid_until: null, notes: "kept", customer_id: "owner", license_id: "license" };
  assert.deepEqual([...excluded].sort(), Object.keys(samples).sort(), "every patchable field is excluded beside the limit");
  const before = f.snapshot();
  for (const field of excluded) {
    await refused(await f.patch(grant.id, { max_active_devices: 5, [field]: samples[field] }), 400, "invalid_request", undefined);
    assert.equal((await f.patch(grant.id, { [field]: samples[field] })).status, 200, `${field} alone is patchable`);
  }
  assert.equal(f.snapshot()[0][0].max_active_devices, before[0][0].max_active_devices);
  const ignored = await created(await f.patch(grant.id, { max_active_devices: 5, status: "disabled" }));
  assert.equal(ignored.max_active_devices, 5);
  assert.equal(ignored.status, "active", "status is not a PATCH field, so it is ignored");
});
