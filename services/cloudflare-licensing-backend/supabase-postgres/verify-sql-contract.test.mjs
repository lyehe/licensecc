import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { VERIFY_SQL, VERIFY_SQL_NAMES, VERIFY_SQL_STATEMENTS } from "../src/db/verify-statements.mjs";
import { PostgresDatabase } from "./db-postgres.mjs";
import { translateWorkerSqlToPg } from "./sql-translate.mjs";

const EXPECTED_NAMES = [
  "rateLimitUpsert",
  "rateLimitCleanup",
  "entitlementLookup",
  "entitlementDeviceLookup",
  "requestProofNonceConsume",
  "requestProofNonceCleanup",
];

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticMemberName(expression) {
  const member = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(member)) return member.name.text;
  if (ts.isElementAccessExpression(member) && member.argumentExpression) {
    const argument = unwrapExpression(member.argumentExpression);
    if (ts.isStringLiteralLike(argument)) return argument.text;
  }
  return undefined;
}

function memberReceiver(expression) {
  const member = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) {
    return unwrapExpression(member.expression);
  }
  return undefined;
}

function isEnvDbPrepareCall(node) {
  if (!ts.isCallExpression(node) || staticMemberName(node.expression) !== "prepare") return false;
  const database = memberReceiver(node.expression);
  if (!database || staticMemberName(database) !== "DB") return false;
  const root = memberReceiver(database);
  return root !== undefined && ts.isIdentifier(root) && root.text === "env";
}

function assertExactVerifyPrepareInventory(sourceText, fileName = "verify.ts") {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls = [];

  function visit(node) {
    if (isEnvDbPrepareCall(node)) {
      const [argument] = node.arguments;
      const isDirectInventoryMember = node.arguments.length === 1
        && argument !== undefined
        && ts.isPropertyAccessExpression(unwrapExpression(argument))
        && ts.isIdentifier(unwrapExpression(argument).expression)
        && unwrapExpression(argument).expression.text === "VERIFY_SQL";
      assert.equal(
        isDirectInventoryMember,
        true,
        `every env.DB.prepare call must take one direct VERIFY_SQL member: ${node.getText(source)}`,
      );
      calls.push(unwrapExpression(argument).name.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  assert.deepEqual(calls, EXPECTED_NAMES, "verify.ts must have exactly the six ordered inventory callsites");
}

test("the fenced verify path has one exact six-statement SQL inventory", () => {
  assert.deepEqual(VERIFY_SQL_NAMES, EXPECTED_NAMES);
  assert.equal(VERIFY_SQL_STATEMENTS.length, 6);
  assert.equal(new Set(VERIFY_SQL_STATEMENTS).size, 6);

  const verifySource = readFileSync(fileURLToPath(new URL("../src/routes/verify.ts", import.meta.url)), "utf8");
  assertExactVerifyPrepareInventory(verifySource);
});

test("the inventory ignores decoys and rejects any seventh or indirect prepare call", () => {
  const exactCalls = EXPECTED_NAMES.map((name) => `env.DB.prepare(VERIFY_SQL.${name});`).join("\n");
  const decoys = `
    // env.DB.prepare(VERIFY_SQL.commentDecoy)
    const stringDecoy = "env.DB.prepare(VERIFY_SQL.stringDecoy)";
    ${exactCalls}
  `;
  assert.doesNotThrow(() => assertExactVerifyPrepareInventory(decoys, "decoys.ts"));

  assert.throws(
    () => assertExactVerifyPrepareInventory(`${exactCalls}\nenv.DB.prepare(dynamicSql);`, "dynamic.ts"),
    /must take one direct VERIFY_SQL member/,
  );
  assert.throws(
    () => assertExactVerifyPrepareInventory(`${exactCalls}\nenv["DB"]["prepare"](VERIFY_SQL.extra);`, "seventh.ts"),
    /exactly the six ordered inventory callsites/,
  );
});

test("all six Worker statements translate to bounded PostgreSQL statements", () => {
  const translated = Object.fromEntries(
    Object.entries(VERIFY_SQL).map(([name, sql]) => [name, translateWorkerSqlToPg(sql)]),
  );
  for (const [name, sql] of Object.entries(translated)) {
    assert.doesNotMatch(sql, /\?/u, `${name} retains a D1 placeholder`);
  }
  assert.match(translated.rateLimitUpsert, /ON CONFLICT\s*\(namespace, rate_key, window_start\)/u);
  assert.match(translated.rateLimitUpsert, /rate_limit_counters\.request_count \+ 1/u);
  assert.match(translated.requestProofNonceConsume, /ON CONFLICT\s*\(project, feature, license_fingerprint, device_key_id, nonce\) DO NOTHING RETURNING nonce/u);
  assert.match(translated.requestProofNonceConsume, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8\)/u);
  assert.equal(translated.requestProofNonceCleanup, "DELETE FROM request_proof_nonces WHERE expires_at < $1");
});

test("workerSql mode rejects every statement outside the verified inventory", () => {
  const database = new PostgresDatabase({ unsafe: async () => [] }, true);
  for (const sql of VERIFY_SQL_STATEMENTS) assert.doesNotThrow(() => database.prepare(sql));
  assert.throws(
    () => database.prepare("SELECT 1"),
    /outside the six-statement inventory/,
  );
});
