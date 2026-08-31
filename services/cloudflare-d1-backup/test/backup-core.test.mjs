import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  backupConfigFromEnv,
  backupObjectKey,
  parseReadyExportResponse,
  parseStartExportResponse,
  pollD1Export,
  pruneExpiredBackups,
  saveD1ExportToR2,
  SNAPSHOT_COUNTED_TABLES,
  snapshotInventoryFromSql,
  startD1Export,
  timingSafeTokenEqual,
} from "../dist/core.js";

const D1_EXPORT_SQL = `-- exact snapshot export
CREATE TABLE "entitlements" (id TEXT PRIMARY KEY, note TEXT);
INSERT INTO "entitlements" VALUES ('one', 'semicolon; inside value');
INSERT INTO "entitlements" VALUES ('two', 'quoted '' value'), ('three', NULL);
CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY);
`;

const config = backupConfigFromEnv({
  ACCOUNT_ID: "account-123",
  DATABASE_ID: "database-456",
  DATABASE_NAME: "licensecc-online-verifier",
  BACKUP_PREFIX: "d1/licensecc",
  BACKUP_RETENTION_DAYS: "30",
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class MockR2 {
  constructor(now = new Date("2026-06-05T00:00:00.000Z")) {
    this.now = now;
    this.objects = new Map();
    this.deleted = [];
    this.sizeDelta = 0;
    this.includeSha256 = false;
    this.sha256Override = undefined;
  }

  async put(key, value, options) {
    const bytes = typeof value === "string"
      ? Buffer.from(value)
      : Buffer.from(await new Response(value).arrayBuffer());
    this.objects.set(key, {
      value: typeof value === "string" ? value : bytes,
      options,
      uploaded: this.now,
    });
    const digest = this.sha256Override ?? Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
    return {
      key,
      version: `version:${key}`,
      size: bytes.byteLength + this.sizeDelta,
      etag: `etag:${key}`,
      uploaded: this.now,
      checksums: this.includeSha256 ? { sha256: digest } : {},
    };
  }

  async list(options = {}) {
    const prefix = options.prefix ?? "";
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, object]) => ({ key, uploaded: object.uploaded }));
    return { objects, truncated: false };
  }

  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      this.deleted.push(key);
      this.objects.delete(key);
    }
    return {};
  }
}

test("backup config validates required values and normalizes prefix", () => {
  assert.deepEqual(config, {
    accountId: "account-123",
    databaseId: "database-456",
    databaseName: "licensecc-online-verifier",
    prefix: "d1/licensecc",
    retentionDays: 30,
  });
  assert.throws(() => backupConfigFromEnv({ DATABASE_ID: "db" }), /ACCOUNT_ID_required/);
  assert.throws(() => backupConfigFromEnv({ ACCOUNT_ID: "acc", DATABASE_ID: "db", BACKUP_PREFIX: "../x" }), /BACKUP_PREFIX/);
});

test("D1 export responses parse expected Cloudflare envelopes", () => {
  assert.deepEqual(parseStartExportResponse({ success: true, result: { at_bookmark: "bookmark-1" } }), { bookmark: "bookmark-1" });
  assert.deepEqual(parseReadyExportResponse({ success: true, result: { signed_url: "https://dump.example/sql", filename: "dump.sql" } }), {
    signedUrl: "https://dump.example/sql",
    filename: "dump.sql",
  });
  assert.throws(() => parseReadyExportResponse({ success: true, result: { filename: "dump.sql" } }), /d1_export_not_ready/);
});

test("D1 export start and poll use the REST API payloads", async () => {
  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), body: init?.body, authorization: init?.headers?.get("Authorization") });
    if (calls.length === 1) {
      return jsonResponse({ success: true, result: { at_bookmark: "bookmark-1" } });
    }
    return jsonResponse({ success: true, result: { signed_url: "https://dump.example/sql", filename: "dump.sql" } });
  };

  const started = await startD1Export(fetcher, config, "token", Date.parse("2026-06-05T01:02:03.004Z"));
  assert.deepEqual(started, {
    bookmark: "bookmark-1",
    snapshotRequestedAt: "2026-06-05T01:02:03.004Z",
  });
  const ready = await pollD1Export(fetcher, config, "token", started.bookmark);
  assert.equal(ready.signedUrl, "https://dump.example/sql");
  assert.equal(calls[0].authorization, "Bearer token");
  assert.equal(calls[0].body, JSON.stringify({ output_format: "polling" }));
  assert.equal(calls[1].body, JSON.stringify({ current_bookmark: "bookmark-1" }));
  assert.match(calls[0].input, /accounts\/account-123\/d1\/database\/database-456\/export$/);
});

test("R2 save writes SQL stream and metadata manifest", async () => {
  const bucket = new MockR2(new Date("2026-06-05T01:03:04.005Z"));
  bucket.includeSha256 = true;
  const fetcher = async () => new Response(D1_EXPORT_SQL, { status: 200 });
  const started = { bookmark: "bookmark-1", snapshotRequestedAt: "2026-06-05T01:02:03.004Z" };
  const ready = { signedUrl: "https://dump.example/sql", filename: "../dump.sql" };
  const result = await saveD1ExportToR2(bucket, fetcher, config, started, ready);

  assert.equal(result.object_key, "d1/licensecc/2026-06-05T01-02-03-004Z/bookmark-1/dump.sql");
  assert.equal(result.manifest_key, `${result.object_key}.metadata.json`);
  assert.equal(bucket.objects.get(result.object_key).options.httpMetadata.contentType, "application/sql");
  const manifest = JSON.parse(bucket.objects.get(result.manifest_key).value);
  assert.equal(manifest.bookmark, "bookmark-1");
  assert.equal(manifest.object_key, result.object_key);
  assert.equal(manifest.snapshot_requested_at, "2026-06-05T01:02:03.004Z");
  assert.equal(manifest.created_at, "2026-06-05T01:03:04.005Z");
  assert.equal(result.snapshot_requested_at, manifest.snapshot_requested_at);
  assert.equal(result.created_at, manifest.created_at);
  const expectedDigest = createHash("sha256").update(D1_EXPORT_SQL).digest("hex");
  assert.deepEqual(manifest.content_integrity, {
    algorithm: "sha256",
    digest_hex: expectedDigest,
    size_bytes: Buffer.byteLength(D1_EXPORT_SQL),
    r2_etag: `etag:${result.object_key}`,
    r2_version: `version:${result.object_key}`,
    r2_size_bytes: Buffer.byteLength(D1_EXPORT_SQL),
    r2_sha256_hex: expectedDigest,
  });
  assert.deepEqual(result.content_integrity, manifest.content_integrity);
  assert.deepEqual(manifest.snapshot_inventory, {
    algorithm: "d1-export-sql-insert-count-v1",
    table_counts: { entitlements: 3, customers: 0 },
  });
  assert.deepEqual(result.snapshot_inventory, manifest.snapshot_inventory);
});

test("snapshot inventory parser is bounded to names and counts and fails closed on unsupported inserts", () => {
  assert.deepEqual(snapshotInventoryFromSql(D1_EXPORT_SQL), {
    algorithm: "d1-export-sql-insert-count-v1",
    table_counts: { entitlements: 3, customers: 0 },
  });
  assert.ok(SNAPSHOT_COUNTED_TABLES.includes("entitlements"));
  assert.throws(() => snapshotInventoryFromSql(`
    CREATE TABLE entitlements (id TEXT);
    INSERT INTO entitlements SELECT id FROM another_table;
  `), /snapshot_inventory_unsupported_insert/);
  assert.throws(() => snapshotInventoryFromSql("CREATE TABLE entitlements (id TEXT); INSERT INTO entitlements VALUES ('unterminated);"), /snapshot_inventory_invalid_sql_stream/);
});

test("snapshot inventory remains exact across arbitrary export-stream chunk boundaries", async () => {
  const bytes = new TextEncoder().encode(D1_EXPORT_SQL);
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) {
        controller.enqueue(Uint8Array.of(byte));
      }
      controller.close();
    },
  });
  const bucket = new MockR2(new Date("2026-06-05T01:03:04.005Z"));
  const result = await saveD1ExportToR2(
    bucket,
    async () => new Response(body, { status: 200 }),
    config,
    { bookmark: "bookmark-chunks", snapshotRequestedAt: "2026-06-05T01:02:03.004Z" },
    { signedUrl: "https://dump.example/chunks", filename: "chunks.sql" },
  );
  assert.deepEqual(result.snapshot_inventory.table_counts, { entitlements: 3, customers: 0 });
});

test("R2 save fails closed before manifest creation on returned size or SHA-256 mismatch", async () => {
  const started = { bookmark: "bookmark-1", snapshotRequestedAt: "1970-01-01T00:00:00.000Z" };
  const ready = { signedUrl: "https://dump.example/sql", filename: "dump.sql" };
  const fetcher = async () => new Response(D1_EXPORT_SQL, { status: 200 });

  const wrongSize = new MockR2();
  wrongSize.sizeDelta = 1;
  await assert.rejects(
    saveD1ExportToR2(wrongSize, fetcher, config, started, ready),
    /r2_put_size_mismatch/,
  );
  assert.equal([...wrongSize.objects.keys()].some((key) => key.endsWith(".metadata.json")), false);

  const wrongDigest = new MockR2();
  wrongDigest.includeSha256 = true;
  wrongDigest.sha256Override = new Uint8Array(32).buffer;
  await assert.rejects(
    saveD1ExportToR2(wrongDigest, fetcher, config, started, ready),
    /r2_put_sha256_mismatch/,
  );
  assert.equal([...wrongDigest.objects.keys()].some((key) => key.endsWith(".metadata.json")), false);
});

test("R2 save rejects an empty export without publishing a manifest", async () => {
  const bucket = new MockR2();
  await assert.rejects(
    saveD1ExportToR2(
      bucket,
      async () => new Response("", { status: 200 }),
      config,
      { bookmark: "bookmark-1", snapshotRequestedAt: "1970-01-01T00:00:00.000Z" },
      { signedUrl: "https://dump.example/sql", filename: "dump.sql" },
    ),
    /d1_export_empty/,
  );
  assert.equal([...bucket.objects.keys()].some((key) => key.endsWith(".metadata.json")), false);
});

test("R2 save rejects object metadata that predates the requested snapshot", async () => {
  const bucket = new MockR2(new Date("2026-06-05T00:00:00.000Z"));
  await assert.rejects(
    saveD1ExportToR2(
      bucket,
      async () => new Response(D1_EXPORT_SQL, { status: 200 }),
      config,
      { bookmark: "bookmark-1", snapshotRequestedAt: "2026-06-05T00:05:00.001Z" },
      { signedUrl: "https://dump.example/sql", filename: "dump.sql" },
    ),
    /r2_put_uploaded_at_before_snapshot/,
  );
  assert.equal([...bucket.objects.keys()].some((key) => key.endsWith(".metadata.json")), false);
});

test("backup object key sanitizes path-like filenames", () => {
  assert.equal(
    backupObjectKey(
      config,
      { signedUrl: "https://dump.example/sql", filename: "../../bad name.sql" },
      { bookmark: "bookmark-1", snapshotRequestedAt: "1970-01-01T00:00:00.000Z" },
    ),
    "d1/licensecc/1970-01-01T00-00-00-000Z/bookmark-1/bad_name.sql",
  );
});

test("retention pruning removes expired R2 objects", async () => {
  const bucket = new MockR2(new Date("2026-06-05T00:00:00.000Z"));
  await bucket.put("d1/licensecc/old.sql", "old");
  bucket.objects.get("d1/licensecc/old.sql").uploaded = new Date("2026-04-01T00:00:00.000Z");
  await bucket.put("d1/licensecc/new.sql", "new");
  await bucket.put("other/old.sql", "old");
  bucket.objects.get("other/old.sql").uploaded = new Date("2026-04-01T00:00:00.000Z");

  const deleted = await pruneExpiredBackups(bucket, config, Date.parse("2026-06-05T00:00:00.000Z"));
  assert.equal(deleted, 1);
  assert.deepEqual(bucket.deleted, ["d1/licensecc/old.sql"]);
  assert.equal(bucket.objects.has("d1/licensecc/new.sql"), true);
  assert.equal(bucket.objects.has("other/old.sql"), true);
});

test("timing-safe token comparison preserves equality semantics", async () => {
  assert.equal(await timingSafeTokenEqual("secret", "secret"), true);
  assert.equal(await timingSafeTokenEqual("secret", "other"), false);
  assert.equal(await timingSafeTokenEqual("secret", "secret "), false);
});
