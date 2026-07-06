// Shared test scaffolding for the portal tests: a D1-like adapter over node:sqlite built from the
// SHARED backend migrations (the SAME DB the portal binds in prod), plus seed helpers and pepper
// fixtures. Nothing about the isolation/ownership SQL is mocked — every assertion reads back the
// state the real worker SQL produced. Requires node:sqlite (Node >= 22, --experimental-sqlite is
// auto-enabled on recent Node; npm test passes the flag).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "cloudflare-licensing-backend", "migrations");

// --- D1-like adapter over node:sqlite (ported from the backend account_isolation matrix) ---------

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...values) {
    const next = new PreparedStatement(this.db, this.sql);
    next.params = values.map(normalizeParam);
    return next;
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    this.db.prepare(this.sql).run(...this.params);
    return { success: true };
  }
}

function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export class D1Like {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new PreparedStatement(this.db, sql);
  }
  // A single in-process DB IS the primary, so the strong read returns self.
  withSession() {
    return this;
  }
  async batch(statements) {
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const stmt of statements) {
        out.push({ results: this.db.prepare(stmt.sql).all(...stmt.params), success: true });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return out;
  }
}

export function applyMigrations(db) {
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
}

export function freshDb() {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  return db;
}

// --- pepper fixtures ------------------------------------------------------------------------------

export function pepperB64(seed = 1) {
  return btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + seed) & 0xff)));
}

export const OTP_PEPPERS = JSON.stringify({ p1: pepperB64(3) });
export const SESSION_PEPPERS = JSON.stringify({ s1: pepperB64(11) });
export const ACCOUNT_PEPPERS = JSON.stringify({ a1: pepperB64(23) });

// --- seed helpers ---------------------------------------------------------------------------------

export const NOW = Math.floor(Date.now() / 1000);

export function seedCustomer(db, id, email, status = "active") {
  db.prepare(
    "INSERT INTO customers (id, name, email, metadata_json, created_at, updated_at, status, external_ref) VALUES (?, ?, ?, '{}', ?, ?, ?, '')",
  ).run(id, `cust-${id}`, email, NOW, NOW, status);
}

export function seedEntitlement(db, { project = "DEFAULT", feature = "DEFAULT", fingerprint, customerId, status = "active", poolSize = 5, validUntil = NOW + 365 * 86400 } = {}) {
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, " +
      "customer_id, max_active_devices, lease_seconds, rebind_window_sec, pool_size, " +
      "heartbeat_grace_sec, max_borrow_sec, allow_overdraft, created_at, updated_at) VALUES " +
      "(?, ?, ?, '', ?, 300, 300, 0, ?, ?, ?, 10, 2592000, 7776000, ?, 900, 0, 0, ?, ?)",
  ).run(project, feature, fingerprint, status, NOW - 86400, validUntil, customerId, poolSize, NOW, NOW);
}

// Build a portal Env wired to a fresh DB with all three pepper maps + required mode.
export function portalEnv(db, overrides = {}) {
  return {
    DB: new D1Like(db),
    ENVIRONMENT: "test",
    ACCOUNT_TOKEN_MODE: "required",
    ACCOUNT_TOKEN_ACTIVE_PEPPER_ID: "a1",
    PORTAL_PUBLIC_ORIGIN: "https://portal.test",
    BACKEND_ORIGIN: "https://backend.test",
    PORTAL_OTP_PEPPERS: OTP_PEPPERS,
    PORTAL_SESSION_PEPPERS: SESSION_PEPPERS,
    ACCOUNT_TOKEN_PEPPERS: ACCOUNT_PEPPERS,
    ...overrides,
  };
}

// A ctx whose waitUntil runs the work synchronously in-process (so emailed/awaited side effects
// settle during the test).
export const CTX = { waitUntil: (p) => { void Promise.resolve(p).catch(() => {}); } };
