// doc/operations/customer-account-deletion.md is a manual runbook of D1 SQL. This runs its SQL
// block and its check query against a database built from the shared migrations, with foreign keys
// enforced as D1 enforces them, so a schema change that breaks the runbook fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { freshDb, seedCustomer, NOW } from "./helpers.mjs";

const RUNBOOK = readFileSync(new URL("../../../doc/operations/customer-account-deletion.md", import.meta.url), "utf8");
const SQL_BLOCKS = [...RUNBOOK.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
const CHECK = /--command "([^"]+)"/.exec(RUNBOOK)?.[1];
const KEPT = ["customer_events", "portal_bootstrap_events", "entitlement_events", "order_events"];

function seed() {
  const db = freshDb();
  seedCustomer(db, "cust_x", "alice@example.com", "disabled");
  seedCustomer(db, "cust_y", "bob@example.com");
  db.prepare("UPDATE customers SET name = 'Alice Example', metadata_json = '{\"tier\":\"vip\"}', external_ref = 'crm-42' WHERE id = 'cust_x'").run();
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  for (const [customer, login] of [["cust_x", "alice-login@example.com"], ["cust_y", "bob-login@example.com"]]) {
    run("INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) VALUES (?, ?, 'hash', ?, ?)", customer, login, NOW, NOW);
    run("INSERT INTO portal_identities (provider, subject, customer_id, email, created_at) VALUES ('google', ?, ?, ?, ?)", `g-${customer}`, customer, login, NOW);
    run("INSERT INTO portal_otp (id, customer_id, email_lower, secret_hmac, code_hmac, pepper_key_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'p1', ?, ?)", `otp-${customer}`, customer, login, `s-${customer}`, `c-${customer}`, NOW + 600, NOW);
    run("INSERT INTO portal_sessions (id, customer_id, session_hmac, pepper_key_id, status, created_at, expires_at, auth_method, user_agent) VALUES (?, ?, ?, 's1', 'active', ?, ?, 'oauth', 'Browser/1.0')", `psess-${customer}`, customer, `h-${customer}`, NOW, NOW + 86400);
    run("INSERT INTO device_bound_devices (id, customer_id, project, key_id, public_key_spki, label, created_at, last_proof_at) VALUES (?, ?, 'DEFAULT', ?, 'spki', ?, ?, ?)", `dev-${customer}`, customer, `key-${customer}`, `${customer} laptop`, NOW, NOW);
  }
  run("INSERT INTO portal_oauth_states (state_hash, provider, browser_hash, nonce, link_session_id, expires_at) VALUES ('state-x', 'github', 'b', 'n', 'psess-cust_x', ?)", NOW + 600);
  const action = (token, purpose, email, customer) => run("INSERT INTO portal_password_actions (token_hash, purpose, email_lower, customer_id, credential_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", token, purpose, email, customer, purpose === "reset" ? "hash" : null, NOW, NOW + 900);
  action("reset-x", "reset", "alice-login@example.com", "cust_x");
  action("register-x", "register", "alice@example.com", "cust_unused");
  // Another customer's reset link to the same address is not this customer's to delete.
  action("reset-y", "reset", "alice@example.com", "cust_y");
  action("register-other", "register", "carol@example.com", "cust_unused2");
  for (const key of ["request:email:alice@example.com", "request:email:alice-login@example.com", "request:email:bob@example.com"]) {
    run("INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES ('portal', ?, ?, 1, ?, ?)", key, NOW, NOW + 1800, NOW);
  }
  const cached = (scope, data) => run("INSERT INTO mutation_idempotency (scope, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)", scope, `k-${scope}`, typeof data === "string" ? data : JSON.stringify({ ok: true, code: "customer_created", request_id: "r", data }), NOW);
  cached("POST:/api/admin/customers:op@example.com:invite", { id: "cust_x", name: "Alice Example", email: "", login_email: "alice-login@example.com" });
  cached("POST:/api/admin/customers/cust_x/disable:op@example.com", { id: "cust_x", name: "Alice Example", email: "alice@example.com", status: "disabled" });
  cached("POST:/api/admin/customers:op@example.com", { id: "cust_y", name: "Bob", email: "", login_email: "bob-login@example.com" });
  cached("POST:/api/admin/customers:legacy", "not json");
  run("INSERT INTO device_bound_authorizations (handle_hash, client_id, project, key_id, public_key_spki, device_label, redirect_uri, client_state, pkce_challenge, requested_feature, status, customer_id, feature, license_fingerprint, code_hash, code_expires_at, created_at, expires_at) VALUES ('handle-x', 'app', 'DEFAULT', 'key-cust_x', 'spki', 'Alice laptop', 'http://127.0.0.1/cb', 'st', 'pk', 'DEFAULT', 'approved', 'cust_x', 'DEFAULT', ?, 'code', ?, ?, ?)", "a".repeat(64), NOW + 60, NOW, NOW + 600);
  run("INSERT INTO customer_events (customer_id, event_type, prev_status, next_status, actor, reason, created_at) VALUES ('cust_x', 'disable', 'active', 'disabled', 'op@example.com', 'TICKET-1', ?)", NOW);
  run("INSERT INTO portal_bootstrap_events (id, customer_id, email_lower, actor, created_at) VALUES ('pb-x', 'cust_x', 'alice@example.com', 'operator', ?)", NOW);
  run("INSERT INTO entitlement_events (project, feature, license_fingerprint, event_type, status, revocation_seq, actor, ip, created_at) VALUES ('DEFAULT', 'DEFAULT', ?, 'revoke', 'revoked', 1, 'cust_x', '203.0.113.9', ?)", "a".repeat(64), NOW);
  run("INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, received_at) VALUES ('ev1', 'sub1', 'DEFAULT', 'DEFAULT', 1, 1, 'subscription.created', 'k', 'd', '{\"customer\":{\"email\":\"alice@example.com\"}}', 'processed', ?)", NOW);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function runbook(db, customerId) {
  assert.equal(SQL_BLOCKS.length, 1, "the runbook has exactly one SQL block");
  db.exec("BEGIN");
  db.exec(SQL_BLOCKS[0].replaceAll("REPLACE_WITH_CUSTOMER_ID", customerId));
  db.exec("COMMIT");
}
const rows = (db, sql, ...values) => db.prepare(sql).all(...values).map((row) => ({ ...row }));
const snapshot = (db, tables) => Object.fromEntries(tables.map((table) => [table, rows(db, `SELECT * FROM ${table}`)]));
const EVERY_TABLE = ["customers", "portal_passwords", "portal_identities", "portal_otp", "portal_sessions", "portal_oauth_states", "portal_password_actions", "rate_limit_counters", "mutation_idempotency", "device_bound_devices", "device_bound_authorizations", ...KEPT];

test("the account deletion runbook clears a disabled customer's personal data and keeps audit rows", () => {
  const db = seed();
  const kept = snapshot(db, KEPT);
  const other = (table) => rows(db, `SELECT * FROM ${table} WHERE customer_id = 'cust_y'`);
  const before = Object.fromEntries(["portal_passwords", "portal_identities", "portal_otp", "portal_sessions", "device_bound_devices"].map((table) => [table, other(table)]));
  runbook(db, "cust_x");
  assert.deepEqual(rows(db, "SELECT name, email, metadata_json, external_ref, status FROM customers WHERE id = 'cust_x'"),
    [{ name: "Deleted customer", email: "", metadata_json: "{}", external_ref: "", status: "disabled" }]);
  assert.equal(rows(db, "SELECT name FROM customers WHERE id = 'cust_y'")[0].name, "cust-cust_y");
  for (const table of ["portal_passwords", "portal_identities", "portal_otp", "portal_sessions"]) {
    assert.deepEqual(rows(db, `SELECT * FROM ${table} WHERE customer_id = 'cust_x'`), [], `${table} keeps nothing of the customer`);
    assert.deepEqual(other(table), before[table], `${table} keeps the other customer's rows`);
  }
  assert.deepEqual(rows(db, "SELECT state_hash FROM portal_oauth_states"), [], "a pending link flow goes with its session");
  assert.deepEqual(rows(db, "SELECT token_hash FROM portal_password_actions ORDER BY token_hash").map((row) => row.token_hash), ["register-other", "reset-y"]);
  assert.deepEqual(rows(db, "SELECT rate_key FROM rate_limit_counters").map((row) => row.rate_key), ["request:email:bob@example.com"]);
  assert.deepEqual(rows(db, "SELECT scope FROM mutation_idempotency ORDER BY scope").map((row) => row.scope), ["POST:/api/admin/customers:legacy", "POST:/api/admin/customers:op@example.com"]);
  assert.deepEqual(rows(db, "SELECT customer_id, label FROM device_bound_devices ORDER BY customer_id"), [{ customer_id: "cust_x", label: "" }, { customer_id: "cust_y", label: "cust_y laptop" }]);
  assert.deepEqual(rows(db, "SELECT device_label FROM device_bound_authorizations"), [{ device_label: "" }]);
  assert.deepEqual(snapshot(db, KEPT), kept, "audit rows are kept unchanged");
  assert.ok(CHECK, "the runbook has a check query");
  assert.deepEqual(rows(db, CHECK.replace("<customer-id>", "cust_x")),
    [{ name: "Deleted customer", email: "", metadata_json: "{}", external_ref: "", status: "disabled", sign_in_rows: 0 }]);
});

test("the account deletion runbook changes nothing for an active customer or an unknown ID", () => {
  for (const customerId of ["cust_y", "cust_missing", "REPLACE_WITH_CUSTOMER_ID"]) {
    const db = seed();
    const before = snapshot(db, EVERY_TABLE);
    runbook(db, customerId);
    assert.deepEqual(snapshot(db, EVERY_TABLE), before, customerId);
  }
});
