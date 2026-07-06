import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backupConfigFromEnv,
  backupObjectKey,
  parseReadyExportResponse,
  parseStartExportResponse,
  pollD1Export,
  pruneExpiredBackups,
  saveD1ExportToR2,
  startD1Export,
  timingSafeTokenEqual,
} from "../dist/core.js";

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
  }

  async put(key, value, options) {
    this.objects.set(key, { value, options, uploaded: this.now });
    return {};
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

  const started = await startD1Export(fetcher, config, "token");
  const ready = await pollD1Export(fetcher, config, "token", started.bookmark);
  assert.equal(ready.signedUrl, "https://dump.example/sql");
  assert.equal(calls[0].authorization, "Bearer token");
  assert.equal(calls[0].body, JSON.stringify({ output_format: "polling" }));
  assert.equal(calls[1].body, JSON.stringify({ current_bookmark: "bookmark-1" }));
  assert.match(calls[0].input, /accounts\/account-123\/d1\/database\/database-456\/export$/);
});

test("R2 save writes SQL stream and metadata manifest", async () => {
  const bucket = new MockR2();
  const fetcher = async () => new Response("SQL DUMP", { status: 200 });
  const started = { bookmark: "bookmark-1" };
  const ready = { signedUrl: "https://dump.example/sql", filename: "../dump.sql" };
  const result = await saveD1ExportToR2(bucket, fetcher, config, started, ready, Date.parse("2026-06-05T01:02:03.004Z"));

  assert.equal(result.object_key, "d1/licensecc/2026-06-05T01-02-03-004Z/bookmark-1/dump.sql");
  assert.equal(result.manifest_key, `${result.object_key}.metadata.json`);
  assert.equal(bucket.objects.get(result.object_key).options.httpMetadata.contentType, "application/sql");
  const manifest = JSON.parse(bucket.objects.get(result.manifest_key).value);
  assert.equal(manifest.bookmark, "bookmark-1");
  assert.equal(manifest.object_key, result.object_key);
});

test("backup object key sanitizes path-like filenames", () => {
  assert.equal(
    backupObjectKey(config, { signedUrl: "https://dump.example/sql", filename: "../../bad name.sql" }, { bookmark: "bookmark-1" }, 0),
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
