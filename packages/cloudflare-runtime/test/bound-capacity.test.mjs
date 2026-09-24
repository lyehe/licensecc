import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { boundOccupiedSql } from "@licensecc/cloudflare-runtime/device/bound_capacity";
import { buildDeviceLimitStatement } from "@licensecc/cloudflare-runtime/entitlements/policy_store";

// ADR 0006 occupancy: a binding holds one of its grant's device slots while it is active, and while
// it is retiring until its hold ends. The backend's lease issue and the admin console count with
// this one predicate; the backend pins it to the schema triggers that state the rule in SQL.
test("a binding occupies a device slot while active, and while retiring until its hold ends", () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec("CREATE TABLE device_bound_bindings(id TEXT PRIMARY KEY, state TEXT NOT NULL, hold_until INTEGER NOT NULL)");
  const insert = sql.prepare("INSERT INTO device_bound_bindings(id, state, hold_until) VALUES (?, ?, ?)");
  for (const row of [
    ["active-held", "active", 5000], ["active-lapsed", "active", 0],
    ["retiring-held", "retiring", 1001], ["retiring-at-now", "retiring", 1000], ["retiring-lapsed", "retiring", 10],
    ["released", "released", 5000],
  ]) insert.run(...row);
  const occupied = (now) => sql.prepare(`SELECT id FROM device_bound_bindings b WHERE ${boundOccupiedSql("b", "?")} ORDER BY id`)
    .all(now).map((row) => row.id);
  assert.deepEqual(occupied(1000), ["active-held", "active-lapsed", "retiring-held"]);
  assert.deepEqual(occupied(1001), ["active-held", "active-lapsed"]);
  sql.close();
});

test("the occupancy predicate is built only for an SQL alias", () => {
  assert.equal(boundOccupiedSql("b", "unixepoch()"), "(b.state = 'active' OR (b.state = 'retiring' AND b.hold_until > unixepoch()))");
  for (const alias of ["", "b.x", "b; DROP TABLE x", "1b", "b c"]) assert.throws(() => boundOccupiedSql(alias, "unixepoch()"), /alias/);
});

test("a create's own device limit is written only beside the create's claimed row", () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE entitlements(project TEXT, feature TEXT, license_fingerprint TEXT, max_active_devices INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(project, feature, license_fingerprint))`);
  const env = { DB: { prepare: (query) => ({ bind: (...args) => ({ query, args }) }) } };
  const key = { project: "APP", feature: "PRO", license_fingerprint: "f".repeat(64) };
  const limit = (value) => buildDeviceLimitStatement(env, key, value);
  const stored = () => sql.prepare("SELECT max_active_devices AS limit_value FROM entitlements").get().limit_value;

  const claimed = limit(3);
  assert.deepEqual(claimed.args, [3, key.project, key.feature, key.license_fingerprint]);
  assert.match(claimed.query, /\bchanges\(\) = 1\b/);
  sql.prepare("INSERT INTO entitlements(project, feature, license_fingerprint) VALUES (?, ?, ?)").run(key.project, key.feature, key.license_fingerprint);
  sql.prepare(claimed.query).run(...claimed.args);
  assert.equal(stored(), 3);

  // A lost claim changed no row, so its side-write writes nothing either.
  sql.prepare("UPDATE entitlements SET max_active_devices = max_active_devices WHERE 0").run();
  const lost = limit(9);
  sql.prepare(lost.query).run(...lost.args);
  assert.equal(stored(), 3);
  sql.close();
});
