import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Migration 0043 rebuilds webhook_events because SQLite cannot widen a CHECK in place. The rebuild
// must keep every existing audit row with its id, the endpoint index and the cascade from
// webhook_endpoints, and only then accept the new test_send event type.
test("upgrade through migration 0043 keeps webhook_events rows, index and cascade and accepts test_send", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  const directory = new URL("../../migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  const boundary = migrations.indexOf("0043_allow_webhook_test_send_event.sql");
  assert.equal(boundary, 42, "migration 0043 directly follows 0042");
  const apply = names => { for (const name of names) db.exec(readFileSync(new URL(name, directory), "utf8")); };
  apply(migrations.slice(0, boundary));
  db.exec(`
    INSERT INTO webhook_endpoints(id,url,status,created_at,updated_at) VALUES
      ('wh_keep','https://keep.example.com/h','disabled',10,20),
      ('wh_drop','https://drop.example.com/h','active',11,21);
    INSERT INTO webhook_events(endpoint_id,event_type,prev_status,next_status,actor,actor_type,source,reason,request_id,created_at) VALUES
      ('wh_keep','disable','active','disabled','ops@example.com','access','admin','rotating','rid-1',100),
      ('wh_drop','disable','active','disabled','dev.local','dev','admin','noisy','rid-2',101),
      ('wh_drop','reenable','disabled','active','dev.local','dev','admin','','rid-3',102);
  `);
  assert.throws(() => db.prepare(
    "INSERT INTO webhook_events(endpoint_id,event_type,prev_status,next_status,created_at) VALUES ('wh_keep','test_send','disabled','disabled',103)",
  ).run(), /CHECK constraint failed/, "before 0043 the CHECK refuses test_send");
  const query = "SELECT id,endpoint_id,event_type,prev_status,next_status,actor,actor_type,source,reason,request_id,created_at FROM webhook_events ORDER BY id";
  const before = db.prepare(query).all();
  const indexSql = () => db.prepare("SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_webhook_events_endpoint'").get();
  const indexBefore = indexSql();

  apply(migrations.slice(boundary));

  assert.deepEqual(db.prepare(query).all(), before, "every audit row survives with its id");
  assert.deepEqual(indexSql(), indexBefore, "the endpoint index is recreated unchanged");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'webhook_events_new'").get().n, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check(webhook_events)").all(), []);

  const insert = db.prepare(
    "INSERT INTO webhook_events(endpoint_id,event_type,prev_status,next_status,actor,actor_type,source,reason,request_id,created_at) " +
      "VALUES ('wh_keep',?,'disabled','disabled','ops@example.com','access','admin','2xx','rid-4',104)",
  );
  const added = insert.run("test_send");
  assert.equal(Number(added.lastInsertRowid), 4, "new rows continue after the preserved ids");
  assert.throws(() => insert.run("unknown"), /CHECK constraint failed/, "the CHECK still refuses an unknown type");
  assert.throws(() => db.prepare(
    "INSERT INTO webhook_events(endpoint_id,event_type,prev_status,next_status,created_at) VALUES ('wh_missing','test_send','active','active',105)",
  ).run(), /FOREIGN KEY constraint failed/, "the endpoint foreign key survives the rebuild");

  db.prepare("DELETE FROM webhook_endpoints WHERE id = 'wh_drop'").run();
  assert.deepEqual(db.prepare("SELECT DISTINCT endpoint_id FROM webhook_events").all().map(row => row.endpoint_id), ["wh_keep"],
    "deleting an endpoint still cascades to its audit rows");
});
