import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const read = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const realScripts = [
  "services/cloudflare-licensing-backend/supabase-postgres/verify-worker-real-pg.mjs",
  "services/cloudflare-licensing-backend/supabase-postgres/smoke-worker-sql.mjs",
  "services/cloudflare-licensing-backend/supabase-postgres/smoke-real-pg.mjs",
  "services/cloudflare-licensing-backend/supabase-postgres/order-apply-smoke-real-pg.mjs",
];

function parseModule(sourceText, fileName) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(source.parseDiagnostics.length, 0, `${fileName} must parse as JavaScript`);
  return source;
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  return current;
}

function expressionPath(expression) {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isPropertyAccessExpression(value)) {
    const owner = expressionPath(value.expression);
    return owner === undefined ? undefined : `${owner}.${value.name.text}`;
  }
  if (ts.isElementAccessExpression(value) && value.argumentExpression) {
    const owner = expressionPath(value.expression);
    const key = unwrap(value.argumentExpression);
    return owner !== undefined && ts.isStringLiteralLike(key) ? `${owner}.${key.text}` : undefined;
  }
  return undefined;
}

function staticBoolean(expression) {
  const value = unwrap(expression);
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (ts.isNumericLiteral(value)) return Number(value.text) !== 0;
  if (ts.isStringLiteral(value)) return value.text.length > 0;
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = staticBoolean(value.operand);
    return operand === undefined ? undefined : !operand;
  }
  return undefined;
}

function statementAlwaysAbrupt(statement) {
  if (
    ts.isReturnStatement(statement)
    || ts.isThrowStatement(statement)
    || ts.isBreakStatement(statement)
    || ts.isContinueStatement(statement)
  ) return true;
  if (ts.isExpressionStatement(statement) && ts.isCallExpression(unwrap(statement.expression))) {
    return expressionPath(unwrap(statement.expression).expression) === "process.exit";
  }
  if (ts.isBlock(statement)) {
    return statement.statements.some((entry) => statementAlwaysAbrupt(entry));
  }
  if (ts.isIfStatement(statement)) {
    const condition = staticBoolean(statement.expression);
    if (condition === true) return statementAlwaysAbrupt(statement.thenStatement);
    if (condition === false) return statement.elseStatement !== undefined && statementAlwaysAbrupt(statement.elseStatement);
    return statement.elseStatement !== undefined
      && statementAlwaysAbrupt(statement.thenStatement)
      && statementAlwaysAbrupt(statement.elseStatement);
  }
  if (ts.isTryStatement(statement)) {
    if (statement.finallyBlock && statementAlwaysAbrupt(statement.finallyBlock)) return true;
    return statementAlwaysAbrupt(statement.tryBlock)
      && (!statement.catchClause || statementAlwaysAbrupt(statement.catchClause.block));
  }
  return false;
}

function followsAbruptCompletion(node, source) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const index = parent.statements.indexOf(current);
      if (index >= 0 && parent.statements.slice(0, index).some((statement) => statementAlwaysAbrupt(statement))) return true;
    }
    if (parent === source) break;
    current = parent;
  }
  return false;
}

function staticallyDisabled(node, source) {
  let current = node;
  while (current.parent && current.parent !== source) {
    const parent = current.parent;
    if (ts.isIfStatement(parent)) {
      const condition = staticBoolean(parent.expression);
      if ((condition === false && current === parent.thenStatement) || (condition === true && current === parent.elseStatement)) return true;
    }
    if (ts.isConditionalExpression(parent)) {
      const condition = staticBoolean(parent.condition);
      if ((condition === false && current === parent.whenTrue) || (condition === true && current === parent.whenFalse)) return true;
    }
    if (ts.isBinaryExpression(parent) && current === parent.right) {
      const left = staticBoolean(parent.left);
      if (
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && left === false)
        || (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && left === true)
      ) return true;
    }
    if ((ts.isWhileStatement(parent) || ts.isForStatement(parent)) && current === parent.statement) {
      const condition = parent.expression && staticBoolean(parent.expression);
      if (condition === false) return true;
    }
    current = parent;
  }
  return followsAbruptCompletion(node, source);
}

function moduleFacts(sourceText, fileName) {
  const source = parseModule(sourceText, fileName);
  const imports = new Map();
  const functionScopes = new Map();
  function collectFunctionScopes(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functionScopes.set(node, node.name.text);
    }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      && ts.isVariableDeclaration(node.parent)
      && ts.isIdentifier(node.parent.name)
    ) {
      functionScopes.set(node, node.parent.name.text);
    }
    ts.forEachChild(node, collectFunctionScopes);
  }
  collectFunctionScopes(source);

  function ownerScope(node) {
    let current = node.parent;
    while (current && current !== source) {
      if (functionScopes.has(current)) return functionScopes.get(current);
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
        return `<anonymous:${current.pos}>`;
      }
      current = current.parent;
    }
    return "<module>";
  }

  const rawCalls = [];
  const rawNews = [];
  const rawFailIncrements = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = { default: node.importClause?.name?.text, named: [] };
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        names.named = bindings.elements.map((entry) => entry.name.text).sort();
      }
      imports.set(node.moduleSpecifier.text, names);
    }
    if (ts.isCallExpression(node)) {
      rawCalls.push({
        path: expressionPath(node.expression),
        args: node.arguments.map((argument) => argument.getText(source)),
        text: node.getText(source),
        owner: ownerScope(node),
        disabled: staticallyDisabled(node, source),
      });
    }
    if (ts.isNewExpression(node)) {
      rawNews.push({ path: expressionPath(node.expression), owner: ownerScope(node), disabled: staticallyDisabled(node, source) });
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node))
      && node.operator === ts.SyntaxKind.PlusPlusToken
      && ts.isIdentifier(node.operand)
      && node.operand.text === "fail"
    ) rawFailIncrements.push({ owner: ownerScope(node), disabled: staticallyDisabled(node, source) });
    ts.forEachChild(node, visit);
  }
  visit(source);

  const namedScopes = new Set(functionScopes.values());
  const edges = new Map();
  for (const call of rawCalls) {
    if (call.disabled || !namedScopes.has(call.path)) continue;
    const targets = edges.get(call.owner) ?? new Set();
    targets.add(call.path);
    edges.set(call.owner, targets);
  }
  const reachable = new Set(["<module>"]);
  const queue = ["<module>"];
  while (queue.length > 0) {
    const owner = queue.shift();
    for (const target of edges.get(owner) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }

  return {
    imports,
    calls: rawCalls.filter((call) => !call.disabled && reachable.has(call.owner)),
    news: rawNews.filter((entry) => !entry.disabled && reachable.has(entry.owner)).map((entry) => entry.path),
    failIncrements: rawFailIncrements.filter((entry) => !entry.disabled && reachable.has(entry.owner)).length,
  };
}

function compact(value) {
  return value.replace(/\s+/gu, "");
}

function requireImport(facts, moduleName, { defaultName, named = [] }) {
  const found = facts.imports.get(moduleName);
  assert.ok(found, `missing active import from ${moduleName}`);
  if (defaultName !== undefined) assert.equal(found.default, defaultName, `wrong default import from ${moduleName}`);
  for (const name of named) assert.ok(found.named.includes(name), `missing active ${name} import from ${moduleName}`);
}

function matchingCalls(facts, path, predicate = () => true) {
  return facts.calls.filter((call) => call.path === path && predicate(call.args.map(compact), compact(call.text)));
}

function requireCall(facts, path, predicate, message) {
  assert.ok(matchingCalls(facts, path, predicate).length > 0, message ?? `missing active ${path}(...) call`);
}

function requireFailureExit(facts) {
  requireCall(
    facts,
    "process.exit",
    (args) => args.length === 1 && args[0] === "fail>0?1:0",
    "driver must exit nonzero when any live assertion fails",
  );
  assert.ok(facts.failIncrements > 0, "driver must increment its active failure counter");
}

function assertVerifyWorkerContract(sourceText, fileName) {
  const facts = moduleFacts(sourceText, fileName);
  requireImport(facts, "node:assert/strict", { defaultName: "assert" });
  requireImport(facts, "../dist/index.js", { defaultName: "worker" });
  requireImport(facts, "../test/contexts/fixtures.mjs", { named: ["requestProofFixture", "testKeyEnv", "validBody"] });
  requireImport(facts, "./db-postgres.mjs", { named: ["closePool", "createPostgresDatabase"] });
  requireCall(facts, "createPostgresDatabase", (args) => args[1] === "{workerSql:true}", "Worker DB must enable the fenced SQL translator");
  requireCall(facts, "worker.fetch", (args) => args.length === 2, "compiled Worker fetch must execute against the PostgreSQL DB");
  for (const expected of [
    "fresh.status,200",
    "(awaitfresh.json()).ok,true",
    "nonceRows.length,1",
    "nonceRows[0].nonce,proof.body.nonce",
  ]) {
    requireCall(facts, "assert.equal", (args) => args.join(",") === expected, `missing active assertion ${expected}`);
  }
  requireCall(
    facts,
    "assert.deepEqual",
    (args) => args[0] === "awaitreplay.json()" && args[1].includes('code:"request_proof_invalid"'),
    "replayed proof must be asserted as denied",
  );
  assert.ok(matchingCalls(facts, "send").length >= 2, "fresh and replay requests must both execute");
  requireCall(facts, "closePool", (args) => args.length === 0, "live Worker driver must close its pool");
}

function assertWorkerSqlContract(sourceText, fileName) {
  const facts = moduleFacts(sourceText, fileName);
  requireImport(facts, "./db-postgres.mjs", { named: ["closePool", "createPostgresDatabase"] });
  requireImport(facts, "../src/db/verify-statements.mjs", { named: ["VERIFY_SQL"] });
  requireCall(facts, "createPostgresDatabase", (args) => args[1] === "{workerSql:true}", "Worker SQL smoke must enable translation");
  const inventory = matchingCalls(facts, "DB.prepare")
    .map((call) => call.args[0])
    .filter((argument) => argument.startsWith("VERIFY_SQL."));
  assert.deepEqual(inventory, [
    "VERIFY_SQL.rateLimitUpsert",
    "VERIFY_SQL.rateLimitUpsert",
    "VERIFY_SQL.rateLimitCleanup",
    "VERIFY_SQL.entitlementLookup",
    "VERIFY_SQL.entitlementLookup",
    "VERIFY_SQL.entitlementDeviceLookup",
    "VERIFY_SQL.requestProofNonceConsume",
    "VERIFY_SQL.requestProofNonceConsume",
    "VERIFY_SQL.requestProofNonceCleanup",
  ], "live Worker SQL smoke must execute every inventory member and both replay-sensitive writes");
  assert.ok(matchingCalls(facts, "check").length >= 10, "Worker SQL smoke must execute its outcome assertions");
  requireFailureExit(facts);
  requireCall(facts, "closePool", (args) => args.length === 0, "Worker SQL smoke must close its pool");
}

function assertEntitlementCliContract(sourceText, fileName) {
  const facts = moduleFacts(sourceText, fileName);
  requireImport(facts, "pg", { defaultName: "pg" });
  requireImport(facts, "./pg-sql.mjs", { named: ["pgSqlFor"] });
  assert.ok(facts.news.includes("pg.Pool"), "entitlement smoke must create the real node-postgres pool");
  requireCall(facts, "pgSqlFor", (args) => args.length === 2, "entitlement smoke must execute the production SQL builder");
  const commands = matchingCalls(facts, "runCommand").map((call) => call.args[0]).filter((value) => /^"/u.test(value));
  for (const command of ['"upsert"', '"disable"', '"revoke"', '"reenable"', '"device-upsert"']) {
    assert.ok(commands.includes(command), `entitlement smoke must execute ${command}`);
  }
  assert.ok(matchingCalls(facts, "check").length >= 7, "entitlement smoke must execute its outcome assertions");
  requireFailureExit(facts);
  requireCall(facts, "pool.end", (args) => args.length === 0, "entitlement smoke must close its pool");
}

function assertOrderTransactionContract(sourceText, fileName) {
  const facts = moduleFacts(sourceText, fileName);
  requireImport(facts, "./order-apply-pg.mjs", {
    named: ["pgAcceptBatch", "pgCapacityStatement", "pgCreateStatement", "pgOrderEventStatement", "pgPatchStatement", "pgProcessedMark", "pgReclaimStatement", "runApplyTransaction"],
  });
  requireImport(facts, "./db-postgres.mjs", { named: ["closePool", "createPool"] });
  requireCall(
    facts,
    "runApplyTransaction",
    (args) => args.join(",") === "pool,statements",
    "order smoke must call the production transaction runner",
  );
  requireCall(facts, "pool.begin", (args) => args.length === 1, "order accept batch must run in a real transaction");
  for (const builder of ["pgAcceptBatch", "pgCreateStatement", "pgPatchStatement", "pgCapacityStatement", "pgReclaimStatement", "pgProcessedMark"]) {
    requireCall(facts, builder, () => true, `order smoke must execute ${builder}`);
  }
  assert.ok(matchingCalls(facts, "check").length >= 7, "order smoke must execute its transaction outcome assertions");
  requireFailureExit(facts);
  requireCall(facts, "closePool", (args) => args.length === 0, "order smoke must close its pool");
}

const contracts = [
  assertVerifyWorkerContract,
  assertWorkerSqlContract,
  assertEntitlementCliContract,
  assertOrderTransactionContract,
];

function wrapExecutableBody(sourceText, wrapper) {
  const source = parseModule(sourceText, "wrapper-source.mjs");
  const imports = source.statements.filter(ts.isImportDeclaration).map((statement) => statement.getText(source)).join("\n");
  const body = source.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) => statement.getText(source)).join("\n");
  return `${imports}\n${wrapper(body)}\n`;
}

test("the live PostgreSQL command has syntax-valid exact implementation drivers", () => {
  for (const path of realScripts) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", resolve(repositoryRoot, path)]));
  }

  const backend = JSON.parse(read("services/cloudflare-licensing-backend/package.json"));
  assert.equal(
    backend.scripts["test:pg:real"],
    "npm run build && node supabase-postgres/verify-worker-real-pg.mjs && node supabase-postgres/smoke-worker-sql.mjs && node supabase-postgres/smoke-real-pg.mjs && node supabase-postgres/order-apply-smoke-real-pg.mjs",
  );

  realScripts.forEach((path, index) => contracts[index](read(path), path));
});

test("comment and string decoys cannot stand in for any live PostgreSQL driver", () => {
  realScripts.forEach((path, index) => {
    const original = read(path);
    const decoy = `// ${original.replaceAll("\n", "\n// ")}\nconst decoy = ${JSON.stringify(original)};\n`;
    assert.throws(() => contracts[index](decoy, `${path}.decoy`), /missing active|must execute|must create/u);
  });
});

test("dead branches and uncalled functions cannot stand in for a live PostgreSQL driver", () => {
  realScripts.forEach((path, index) => {
    const original = read(path);
    const disabled = wrapExecutableBody(original, (body) => `if (false) {\n${body}\n}`);
    const uncalled = wrapExecutableBody(original, (body) => `async function neverCalled() {\n${body}\n}`);
    const shortCircuited = wrapExecutableBody(original, (body) => `async function dormantDriver() {\n${body}\n}\nfalse && dormantDriver();`);
    const afterReturn = wrapExecutableBody(original, (body) => `async function dormantDriver() {\nreturn;\n${body}\n}\nawait dormantDriver();`);
    assert.throws(() => contracts[index](disabled, `${path}.disabled`));
    assert.throws(() => contracts[index](uncalled, `${path}.uncalled`));
    assert.throws(() => contracts[index](shortCircuited, `${path}.short-circuited`));
    assert.throws(() => contracts[index](afterReturn, `${path}.after-return`));
  });
});
