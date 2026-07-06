import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { createLocalSqliteDb, openDatabase } from "../../local-host/db-sqlite.mjs";

test("local SQLite adapter implements the D1 prepare/bind/first/all/run surface", async () => {
  const { db, adapter } = createLocalSqliteDb({ path: ":memory:", migrate: false });
  try {
    await adapter.prepare("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, optional TEXT)").run();

    const insert = await adapter
      .prepare("INSERT INTO sample (name, flag, optional) VALUES (?, ?, ?) RETURNING id, name, flag, optional")
      .bind("alpha", true, undefined)
      .first();
    assert.equal(insert.name, "alpha");
    assert.equal(insert.flag, 1);
    assert.equal(insert.optional, null);

    await adapter.prepare("INSERT INTO sample (name, flag, optional) VALUES (?, ?, ?)").bind("beta", false, "x").run();

    const first = await adapter.prepare("SELECT name FROM sample WHERE id = ?").bind(insert.id).first();
    assert.equal(first.name, "alpha");

    const missing = await adapter.prepare("SELECT name FROM sample WHERE id = ?").bind(999).first();
    assert.equal(missing, null);

    const listed = await adapter.prepare("SELECT name FROM sample ORDER BY id").all();
    assert.deepEqual(listed.results.map((row) => row.name), ["alpha", "beta"]);
    assert.equal(listed.success, true);
  } finally {
    db.close();
  }
});

test("local SQLite adapter batch is atomic and rolls back failed statement groups", async () => {
  const { db, adapter } = createLocalSqliteDb({ path: ":memory:", migrate: false });
  try {
    await adapter.prepare("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT UNIQUE)").run();

    const inserted = await adapter.batch([
      adapter.prepare("INSERT INTO sample (name) VALUES (?) RETURNING id, name").bind("alpha"),
      adapter.prepare("INSERT INTO sample (name) VALUES (?) RETURNING id, name").bind("beta"),
    ]);
    assert.deepEqual(inserted.map((result) => result.results[0].name), ["alpha", "beta"]);

    await assert.rejects(
      () => adapter.batch([
        adapter.prepare("INSERT INTO sample (name) VALUES (?)").bind("gamma"),
        adapter.prepare("INSERT INTO sample (name) VALUES (?)").bind("alpha"),
      ]),
      /UNIQUE constraint failed/,
    );

    const rows = await adapter.prepare("SELECT name FROM sample ORDER BY id").all();
    assert.deepEqual(rows.results.map((row) => row.name), ["alpha", "beta"]);
    assert.equal(adapter.withSession("first-primary"), adapter);
  } finally {
    db.close();
  }
});

test("local SQLite adapter applies real migrations and persists a file-backed database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "licensecc-local-sqlite-"));
  const dbPath = join(dir, "licensecc.sqlite");
  const migrationsDir = resolve("migrations");
  try {
    let opened = createLocalSqliteDb({ path: dbPath, migrationsDir });
    assert.ok(opened.migrations.applied.length > 0);
    await opened.adapter.prepare("CREATE TABLE local_backend_smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)").run();
    await opened.adapter.prepare("INSERT INTO local_backend_smoke (value) VALUES (?)").bind("persisted").run();
    opened.db.close();

    opened = createLocalSqliteDb({ path: dbPath, migrationsDir });
    assert.equal(opened.migrations.applied.length, 0);
    assert.ok(opened.migrations.skipped.length > 0);
    const row = await opened.adapter.prepare("SELECT value FROM local_backend_smoke WHERE id = 1").first();
    assert.equal(row.value, "persisted");
    const entitlements = await opened.adapter.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entitlements'").first();
    assert.equal(entitlements.name, "entitlements");
    opened.db.close();

    const readonly = openDatabase(dbPath, { readonly: true });
    try {
      const persisted = await readonly.adapter.prepare("SELECT value FROM local_backend_smoke WHERE id = 1").first();
      assert.equal(persisted.value, "persisted");
      await assert.rejects(() => readonly.adapter.prepare("INSERT INTO local_backend_smoke (value) VALUES ('blocked')").run());
    } finally {
      readonly.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
