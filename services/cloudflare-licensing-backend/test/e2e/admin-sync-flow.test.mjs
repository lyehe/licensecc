import assert from "node:assert/strict";
import { test } from "node:test";
import adminWorker from "../../../cloudflare-license-admin/dist-worker/worker/index.js";
import verifierWorker from "../../dist/index.js";

const fingerprint = "a".repeat(64);

function bytesToPem(bytes, label) {
  const b64 = Buffer.from(bytes).toString("base64");
  const lines = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function keyOf(project, feature, licenseFingerprint) {
  return `${project}\u0000${feature}\u0000${licenseFingerprint}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.db.first(this.sql, this.values);
  }

  async all() {
    return { results: [] };
  }

  async run() {
    return this.db.run(this.sql, this.values);
  }
}

class SharedD1 {
  constructor() {
    this.entitlements = new Map();
    this.events = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    const entitlementSnapshot = new Map([...this.entitlements.entries()].map(([key, value]) => [key, clone(value)]));
    const eventSnapshot = this.events.map(clone);
    try {
      const results = [];
      for (const statement of statements) {
        if (statement.sql.startsWith("INSERT INTO entitlements") || statement.sql.startsWith("UPDATE entitlements SET")) {
          const row = this.first(statement.sql, statement.values);
          results.push({ results: row === null ? [] : [row], meta: { changes: row === null ? 0 : 1 } });
        } else {
          results.push(this.run(statement.sql, statement.values));
        }
      }
      return results;
    } catch (error) {
      this.entitlements = entitlementSnapshot;
      this.events = eventSnapshot;
      throw error;
    }
  }

  maxEventSeq(project, feature, licenseFingerprint) {
    return this.events
      .filter((event) => event.project === project && event.feature === feature && event.license_fingerprint === licenseFingerprint)
      .reduce((max, event) => Math.max(max, event.revocation_seq), 0);
  }

  first(sql, values) {
    if (sql.startsWith("SELECT project, feature, license_fingerprint")) {
      const row = this.entitlements.get(keyOf(values[0], values[1], values[2]));
      return row === undefined ? null : clone(row);
    }
    if (sql.startsWith("INSERT INTO entitlements")) {
      const [
        project,
        feature,
        licenseFingerprint,
        deviceHash,
        status,
        assertionTtl,
        cacheTtl,
        _historyProject,
        _historyFeature,
        _historyFingerprint,
        validFrom,
        validUntil,
        notes,
        customerId,
        licenseId,
        createdAt,
        updatedAt,
      ] = values;
      const key = keyOf(project, feature, licenseFingerprint);
      const previous = this.entitlements.get(key);
      const row = {
        project,
        feature,
        license_fingerprint: licenseFingerprint,
        device_hash: deviceHash,
        status,
        assertion_ttl_seconds: assertionTtl,
        cache_ttl_seconds: cacheTtl,
        revocation_seq: Math.max(previous?.revocation_seq ?? 0, this.maxEventSeq(project, feature, licenseFingerprint)) + 1,
        valid_from: validFrom,
        valid_until: validUntil,
        notes,
        customer_id: customerId,
        license_id: licenseId,
        created_at: previous?.created_at ?? createdAt,
        updated_at: updatedAt,
      };
      this.entitlements.set(key, row);
      return clone(row);
    }
    if (sql.startsWith("UPDATE entitlements SET status")) {
      const key = keyOf(values[2], values[3], values[4]);
      const previous = this.entitlements.get(key);
      if (previous === undefined) {
        return null;
      }
      const row = {
        ...previous,
        status: values[0],
        revocation_seq: Math.max(previous.revocation_seq, this.maxEventSeq(previous.project, previous.feature, previous.license_fingerprint)) + 1,
        updated_at: values[1],
      };
      this.entitlements.set(key, row);
      return clone(row);
    }
    throw new Error(`unexpected first SQL: ${sql}`);
  }

  run(sql, values) {
    if (sql.startsWith("INSERT INTO entitlement_events")) {
      const row = this.entitlements.get(keyOf(values[11], values[12], values[13]));
      if (row === undefined) {
        return { meta: { changes: 0 } };
      }
      this.events.push({
        id: this.events.length + 1,
        project: row.project,
        feature: row.feature,
        license_fingerprint: row.license_fingerprint,
        event_type: values[0],
        status: row.status,
        revocation_seq: row.revocation_seq,
        actor_type: values[3],
        source: sql.includes("'sync'") ? "sync" : "admin",
        reason: values[8],
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`unexpected run SQL: ${sql}`);
  }
}

async function signingEnv(db) {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  return {
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: bytesToPem(new Uint8Array(pkcs8), "PRIVATE KEY"),
    ONLINE_SIGNING_KEY_ID: "sha256:e2e",
    MAX_ASSERTION_TTL_SECONDS: "300",
    DB: db,
  };
}

function adminEnv(db) {
  return {
    DB: db,
    ENVIRONMENT: "development",
    ADMIN_DEV_BEARER_ENABLED: "0",
    SYNC_API_TOKEN: "sync-secret",
  };
}

function syncRequest(body) {
  return new Request("https://admin.example/api/sync/entitlements", {
    method: "POST",
    headers: {
      authorization: "Bearer sync-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function verifyRequest() {
  return new Request("https://verifier.example/v1/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "DEFAULT",
      feature: "DEFAULT",
      license_fingerprint: fingerprint,
      device_hash: "",
      nonce: "b".repeat(64),
    }),
  });
}

test("user database sync projection feeds public online verifier", async () => {
  const db = new SharedD1();
  const verifierEnv = await signingEnv(db);

  const synced = await adminWorker.fetch(syncRequest({
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    status: "active",
    customer_id: "cus_e2e",
    license_id: "lic_e2e",
    reason: "subscription active",
  }), adminEnv(db));
  assert.equal(synced.status, 200);
  assert.equal((await synced.json()).code, "entitlement_synced");
  assert.equal(db.events.at(-1).source, "sync");

  const allowed = await verifierWorker.fetch(verifyRequest(), verifierEnv);
  assert.equal(allowed.status, 200);
  const allowedBody = await allowed.json();
  assert.equal(allowedBody.ok, true);
  assert.match(allowedBody.assertion, /^lccoa1\./);

  const revoked = await adminWorker.fetch(syncRequest({
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    status: "revoked",
    customer_id: "cus_e2e",
    license_id: "lic_e2e",
    reason: "subscription revoked",
  }), adminEnv(db));
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).data.status, "revoked");

  const denied = await verifierWorker.fetch(verifyRequest(), verifierEnv);
  assert.equal(denied.status, 200);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.ok, false);
  assert.equal(deniedBody.code, "entitlement_denied");
  assert.equal(typeof deniedBody.server_time, "number");
});
