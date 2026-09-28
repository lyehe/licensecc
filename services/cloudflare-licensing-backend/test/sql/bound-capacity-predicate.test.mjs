import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { boundOccupiedSql } from "@licensecc/cloudflare-runtime/device/bound_capacity";

// ADR 0006 states device-slot occupancy twice: as SQL in the schema triggers, and as the shared
// runtime predicate every query counts with (lease issue and commit here, the admin console's
// capacity answer). They must stay one rule, so an edit to either side fails here.
const collapse = (text) => text.replace(/\s+/g, " ");
const schema = collapse(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));

for (const trigger of ["tr_bound_capacity_decrease", "tr_bound_owner_change"]) {
  test(`${trigger} counts occupied device slots with the shared predicate`, () => {
    const start = schema.indexOf(`CREATE TRIGGER IF NOT EXISTS ${trigger} `);
    assert.ok(start >= 0, `${trigger} is missing from schema.sql`);
    const body = schema.slice(start, schema.indexOf(" END;", start));
    assert.ok(body.includes(boundOccupiedSql("b", "unixepoch()")), body);
  });
}

test("lease issue and commit count occupancy only through the shared predicate", () => {
  const literal = /state\s*=\s*'retiring'\s+AND\s+(?:\w+\.)?hold_until\s*>/;
  for (const module of ["bound_issue.mjs", "bound_store.mjs"]) {
    const source = readFileSync(new URL(`../../src/device/${module}`, import.meta.url), "utf8");
    assert.match(source, /boundOccupiedSql\(/, `${module} counts with the shared predicate`);
    assert.doesNotMatch(source, literal, `${module} still hand-copies the occupancy predicate`);
  }
});
