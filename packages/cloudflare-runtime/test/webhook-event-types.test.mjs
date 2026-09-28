import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WEBHOOK_EVENT_TYPES } from "../src/webhooks/event_types.mjs";
import { ORDER_INTENTS } from "@licensecc/licensing-domain/orders/intents";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const schemaPath = join(repoRoot, "services", "cloudflare-licensing-backend", "schema.sql");

/**
 * Pull the exact quoted string list out of a table's `event_type ... CHECK (event_type IN (...))`
 * column definition, scoped to that ONE table's own `CREATE TABLE ... );` block (several tables
 * declare an `event_type` CHECK, so the search must not spill into a different table).
 */
function eventTypeCheckList(schemaText, tableName) {
  const tableRe = new RegExp(`CREATE TABLE IF NOT EXISTS "?${tableName}"?\\s*\\([\\s\\S]*?\\);`, "m");
  const tableMatch = tableRe.exec(schemaText);
  assert.ok(tableMatch, `schema.sql must define table ${tableName}`);
  const checkRe = /event_type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*event_type\s+IN\s*\(([^)]*)\)\s*\)/;
  const checkMatch = checkRe.exec(tableMatch[0]);
  assert.ok(checkMatch, `schema.sql ${tableName} must declare an event_type CHECK`);
  return checkMatch[1].split(",").map((token) => token.trim().replace(/^'(.*)'$/, "$1"));
}

test("WEBHOOK_EVENT_TYPES groups are frozen", () => {
  assert.ok(Object.isFrozen(WEBHOOK_EVENT_TYPES));
  assert.ok(Object.isFrozen(WEBHOOK_EVENT_TYPES.entitlement));
  assert.ok(Object.isFrozen(WEBHOOK_EVENT_TYPES.customer));
  assert.ok(Object.isFrozen(WEBHOOK_EVENT_TYPES.order));
});

test("WEBHOOK_EVENT_TYPES.order is exactly the order-ingest ORDER_INTENTS closed set", () => {
  assert.deepEqual(WEBHOOK_EVENT_TYPES.order, ORDER_INTENTS);
});

test("WEBHOOK_EVENT_TYPES.customer is exactly disable/reenable", () => {
  assert.deepEqual(WEBHOOK_EVENT_TYPES.customer, ["disable", "reenable"]);
});

// Schema-parity: entitlement_events.event_type and customer_events.event_type CHECK constraints
// (schema.sql) are the ground truth. If either drifts, this test fails loudly instead of the
// admin webhook validator silently falling out of sync with what the dispatcher can ever emit.
test("WEBHOOK_EVENT_TYPES.entitlement matches the entitlement_events CHECK exactly (schema.sql)", () => {
  const schemaText = readFileSync(schemaPath, "utf8");
  const checkList = eventTypeCheckList(schemaText, "entitlement_events");
  assert.deepEqual(WEBHOOK_EVENT_TYPES.entitlement, checkList);
});

test("WEBHOOK_EVENT_TYPES.customer matches the customer_events CHECK exactly (schema.sql)", () => {
  const schemaText = readFileSync(schemaPath, "utf8");
  const checkList = eventTypeCheckList(schemaText, "customer_events");
  assert.deepEqual(WEBHOOK_EVENT_TYPES.customer, checkList);
});
