import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseWranglerJson, runWrangler } from "../scripts/restore-drill.mjs";

test("local D1 SQL export restores protected holds and enforcement without lease history", t => {
  const directory = mkdtempSync(join(tmpdir(), "licensecc-bound-restore-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, "wrangler.jsonc");
  const input = join(directory, "seed.sql");
  const output = join(directory, "export.sql");
  const database = "licensecc-bound-restore-local";
  writeFileSync(config, JSON.stringify({ name: database, compatibility_date: "2026-08-01",
    d1_databases: [{ binding: "DB", database_name: database, database_id: "00000000-0000-0000-0000-000000000001" }] }));
  const seed = `
    INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Synthetic owner',1,1);
    INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,max_active_devices,enforcement_mode,created_at,updated_at)
      VALUES('APP','PRO','fingerprint','active','owner',2,'device_bound_v1',1,1);
    INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at) VALUES
      ('device-a','owner','APP','key-a','synthetic-public-a',1,1),
      ('device-b','owner','APP','key-b','synthetic-public-b',1,1);
    INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,state,generation,revision,hold_until,created_at,updated_at) VALUES
      ('binding-a','APP','PRO','fingerprint','device-a','active',3,4,4102444800,1,1),
      ('binding-b','APP','PRO','fingerprint','device-b','retiring',5,6,4102444900,1,1);
    INSERT INTO device_bound_events(invocation_id,binding_id,customer_id,event_type,actor,occurred_at)
      VALUES('retirement','binding-b','owner','retire','customer:owner',1);
  `;
  const migrations = new URL("../../cloudflare-licensing-backend/migrations/", import.meta.url);
  const schema = readdirSync(migrations).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort()
    .map(name => readFileSync(new URL(name, migrations), "utf8")).join("\n");
  writeFileSync(input, schema + seed);
  const common = ["--local", "--config", config, "--cwd", directory];
  runWrangler(["d1", "execute", database, "--file", input, ...common], "local protected restore seed");
  runWrangler(["d1", "export", database, "--output", output, ...common], "local protected restore export");
  const target = join(directory, "target");
  mkdirSync(target);
  const targetConfig = join(target, "wrangler.jsonc");
  writeFileSync(targetConfig, readFileSync(config));
  const targetArgs = ["--local", "--config", targetConfig, "--cwd", target];
  runWrangler(["d1", "execute", database, "--file", output, ...targetArgs], "local protected D1 import");
  const targetRows = parseWranglerJson(runWrangler(["d1", "execute", database, "--command",
    "SELECT id,state,generation,revision,hold_until FROM device_bound_bindings ORDER BY id", "--json", ...targetArgs],
  "local protected D1 hold verification").stdout)[0].results;
  const restored = new DatabaseSync(":memory:");
  t.after(() => restored.close());
  restored.exec("PRAGMA foreign_keys=ON");
  restored.exec(readFileSync(output, "utf8"));
  const expected = [
    { id: "binding-a", state: "active", generation: 3, revision: 4, hold_until: 4102444800 },
    { id: "binding-b", state: "retiring", generation: 5, revision: 6, hold_until: 4102444900 },
  ];
  assert.deepEqual(targetRows, expected);
  for (const command of [
    "UPDATE device_bound_bindings SET hold_until=0 WHERE id='binding-b'",
    "UPDATE device_bound_bindings SET state='released' WHERE id='binding-b'",
    "UPDATE entitlements SET max_active_devices=1",
    "DELETE FROM device_bound_bindings WHERE id='binding-b'",
  ]) {
    assert.throws(() => runWrangler(["d1", "execute", database, "--command", command, ...targetArgs],
      "local restored guard rejection"), /wrangler_command_failed:operation=local_restored_guard_rejection/);
  }
  const after = parseWranglerJson(runWrangler(["d1", "execute", database, "--command",
    "SELECT id,state,generation,revision,hold_until FROM device_bound_bindings ORDER BY id", "--json", ...targetArgs],
  "local protected D1 post-rejection verification").stdout)[0].results;
  assert.deepEqual(after, expected);
  assert.deepEqual(restored.prepare("SELECT id,state,generation,revision,hold_until FROM device_bound_bindings ORDER BY id").all().map(row => ({ ...row })), expected);
  assert.equal(restored.prepare("SELECT count(*) AS n FROM device_bound_leases").get().n, 0);
  assert.equal(restored.prepare("SELECT count(*) AS n FROM device_bound_events").get().n, 1);
  assert.throws(() => restored.exec("UPDATE device_bound_bindings SET hold_until=0 WHERE id='binding-b'"), /binding_hold_cannot_shrink/);
  assert.throws(() => restored.exec("UPDATE device_bound_bindings SET state='released' WHERE id='binding-b'"), /binding_hold_active/);
  assert.throws(() => restored.exec("UPDATE entitlements SET max_active_devices=1"), /capacity_in_use/);
  assert.throws(() => restored.exec("DELETE FROM device_bound_bindings WHERE id='binding-b'"), /binding_tombstone_required/);
  assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});
