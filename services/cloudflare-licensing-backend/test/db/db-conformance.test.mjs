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
    const catalogImportPreview = await opened.adapter.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalog_import_previews'",
    ).first();
    assert.equal(catalogImportPreview.name, "catalog_import_previews");
    const previewColumns = await opened.adapter.prepare("PRAGMA table_info(catalog_import_previews)").all();
    assert.deepEqual(
      previewColumns.results.map((column) => column.name),
      [
        "id",
        "actor_subject",
        "source_generation",
        "normalized_manifest_json",
        "manifest_digest",
        "preview_json",
        "actions_json",
        "effective_at",
        "expires_at",
        "claim_token",
        "claimed_at",
        "consumed_at",
        "applied_response_json",
        "created_at",
      ],
    );
    const previewExpiryIndex = await opened.adapter.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_catalog_import_previews_expiry'",
    ).first();
    assert.equal(previewExpiryIndex.name, "idx_catalog_import_previews_expiry");
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

test("the baseline seeds the catalog projection generation row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "licensecc-local-sqlite-seed-"));
  const dbPath = join(dir, "licensecc.sqlite");
  try {
    const opened = createLocalSqliteDb({ path: dbPath, migrationsDir: resolve("migrations") });
    try {
      // Plan preview/apply and the catalog import read this row and fail closed when it is absent,
      // so a fresh database must carry it without any operator step.
      const row = await opened.adapter
        .prepare("SELECT generation FROM license_plan_projection_generations WHERE scope = 'catalog'")
        .first();
      assert.ok(row, "the catalog projection generation row is missing");
      assert.equal(row.generation, 0);
    } finally {
      opened.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the baseline creates each table after the tables its foreign keys reference", () => {
  // A D1 SQL export replays tables, with their rows, in creation order, and D1 enforces foreign
  // keys during the import. A child table created before its parent makes every backup that holds
  // a child row fail to restore with "no such table".
  const { db } = createLocalSqliteDb({ path: ":memory:", migrationsDir: resolve("migrations") });
  try {
    const created = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
      .all()
      .map((row) => row.name);
    const position = new Map(created.map((name, index) => [name, index]));
    const outOfOrder = [];
    const edges = new Set();
    for (const table of created) {
      for (const { table: parent } of db.prepare(`PRAGMA foreign_key_list("${table}")`).all()) {
        edges.add(`${table} -> ${parent}`);
        if (parent !== table && !(position.get(parent) < position.get(table))) {
          outOfOrder.push(`${table} -> ${parent}`);
        }
      }
    }
    // Not vacuous: the guard really walked the baseline's foreign keys, including a composite one.
    assert.ok(edges.size >= 10, `only ${edges.size} foreign-key edges were checked`);
    assert.ok(edges.has("device_bound_bindings -> entitlements"), [...edges].join(", "));
    assert.deepEqual(outOfOrder, []);
  } finally {
    db.close();
  }
});
