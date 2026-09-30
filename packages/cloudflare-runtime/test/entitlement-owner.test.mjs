import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { observedExpectation } from "../src/d1/entitlement_guards.mjs";
import { createEntitlement, patchEntitlement, syncEntitlement } from "../src/d1/entitlement_mutation.mjs";

// Every grant has an owner: entitlements.customer_id is NOT NULL. The shared writers refuse a change
// that names none with their own invalid_patch error, before it reaches the database, rather than
// surfacing the raw constraint failure. These run on the real schema.
const schema = new URL("../../../services/cloudflare-licensing-backend/schema.sql", import.meta.url);
const key = { project: "APP", feature: "PRO", license_fingerprint: "a".repeat(64) };
const ctx = { actor: { subject: "operator", email: "", actorType: "access" }, requestId: "request", ip: "", idempotencyKey: null, source: "admin" };

function fixture(t) {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  sql.exec(readFileSync(schema, "utf8"));
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1,1);
    INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,created_at,updated_at)
      VALUES('${key.project}','${key.feature}','${key.license_fingerprint}','active','owner',1,1);`);
  const prepare = (query, args = []) => ({ query, args,
    bind(...values) { return prepare(query, values.map(value => value === undefined ? null : value)); },
    async first(column) { const row = sql.prepare(query).get(...args); return column ? row?.[column] ?? null : row ?? null; },
    async all() { return { results: sql.prepare(query).all(...args), success: true }; },
    async run() { return this.all(); },
  });
  const env = { DB: { prepare, async batch(statements) {
    sql.exec("BEGIN");
    try {
      const result = statements.map(statement => ({ success: true, results: sql.prepare(statement.query).all(...statement.args) }));
      sql.exec("COMMIT"); return result;
    } catch (error) { sql.exec("ROLLBACK"); throw error; }
  } } };
  const snapshot = () => ["entitlements", "entitlement_events", "mutation_idempotency"]
    .map(table => sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const observed = () => observedExpectation(sql.prepare("SELECT customer_id, revocation_seq FROM entitlements WHERE feature = ?").get(key.feature));
  return { env, snapshot, observed };
}

test("patchEntitlement refuses a null or empty owner with invalid_patch before the database", async t => {
  const f = fixture(t), before = f.snapshot();
  for (const owner of [null, ""]) {
    await assert.rejects(patchEntitlement(f.env, key, { customer_id: owner }, { ...ctx, expectedEntitlement: f.observed() }, null),
      /^Error: invalid_patch$/, JSON.stringify(owner));
    assert.deepEqual(f.snapshot(), before, JSON.stringify(owner));
  }
  const kept = await patchEntitlement(f.env, key, { notes: "owner kept" }, { ...ctx, expectedEntitlement: f.observed() }, null);
  assert.equal(kept.data.customer_id, "owner");
});

test("createEntitlement and an active syncEntitlement refuse an input without an owner with invalid_patch", async t => {
  const f = fixture(t), before = f.snapshot();
  for (const owner of [undefined, null, ""]) {
    const fresh = { ...key, feature: "NEW", status: "active", ...(owner === undefined ? {} : { customer_id: owner }) };
    await assert.rejects(createEntitlement(f.env, fresh, ctx), /^Error: invalid_patch$/, `create ${JSON.stringify(owner)}`);
    const existing = { ...key, status: "active", notes: "resync", ...(owner === undefined ? {} : { customer_id: owner }) };
    await assert.rejects(syncEntitlement(f.env, existing, "", { ...ctx, source: "sync" }, null), /^Error: invalid_patch$/, `sync ${JSON.stringify(owner)}`);
    assert.deepEqual(f.snapshot(), before, JSON.stringify(owner));
  }
});
