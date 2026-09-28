// POST /api/admin/customers/{id}/licenses creates the `licenses` row a protected entitlement
// references, so onboarding needs no hand-written SQL. Real SQLite (the backend schema) end to end
// through the compiled Worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { accessAuthed, accessEnv, accessFixture, accessToken, authed, baseEnv, worker } from "../worker/fixtures.mjs";

function fixture(t) {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  sql.exec(readFileSync(new URL("../../../cloudflare-licensing-backend/schema.sql", import.meta.url), "utf8"));
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1,1);
    INSERT INTO customers(id,name,status,created_at,updated_at) VALUES('suspended','Suspended','disabled',1,1);`);
  let beforeBatch = () => {};
  const prepare = (query, args = []) => ({ query, args,
    bind(...values) { return prepare(query, values); },
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
    async run() { return this.all(); },
  });
  const db = { prepare, async batch(statements) {
    const hook = beforeBatch; beforeBatch = () => {}; hook();
    sql.exec("BEGIN");
    try { const result = statements.map(s => ({ results: sql.prepare(s.query).all(...s.args) })); sql.exec("COMMIT"); return result; }
    catch (error) { sql.exec("ROLLBACK"); throw error; }
  } };
  const env = baseEnv(db);
  const send = (body, { key = "license-1", customer = "owner", request = authed, environment = env } = {}) =>
    worker.fetch(request(`/api/admin/customers/${encodeURIComponent(customer)}/licenses`, {
      method: "POST", headers: key === null ? {} : { "idempotency-key": key }, body: typeof body === "string" ? body : JSON.stringify(body),
    }), environment);
  const count = table => sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  return { sql, db, send, count, race(fn) { beforeBatch = fn; } };
}

test("admin creates a license record for an active customer and replays it for the same key", async t => {
  const f = fixture(t);
  const first = await f.send({ project: "APP", label: "  Seat pack  " });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const text = await first.text(), body = JSON.parse(text);
  assert.equal(body.ok, true); assert.equal(body.code, "license_created");
  assert.match(body.data.id, /^lic_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(body.data).sort(), ["created_at", "customer_id", "id", "label", "project"]);
  assert.equal(body.data.customer_id, "owner"); assert.equal(body.data.project, "APP"); assert.equal(body.data.label, "Seat pack");
  assert.ok(Number.isSafeInteger(body.data.created_at));
  const row = f.sql.prepare("SELECT * FROM licenses WHERE id=?").get(body.data.id);
  assert.equal(row.customer_id, "owner"); assert.equal(row.project, "APP"); assert.equal(row.label, "Seat pack");
  assert.equal(row.created_at, body.data.created_at); assert.equal(row.updated_at, body.data.created_at);
  assert.deepEqual(JSON.parse(row.metadata_json), { created_by: "dev", created_request_id: body.request_id, source: "admin" });

  const replay = await f.send({ project: "APP", label: "  Seat pack  " });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("x-idempotent-replay"), "1");
  assert.equal(replay.headers.get("cache-control"), "no-store");
  assert.equal(await replay.text(), text, "the same key replays the original response byte for byte");
  assert.equal(f.count("licenses"), 1, "a replay never writes a second license");
  assert.equal(f.count("mutation_idempotency"), 1);

  const second = await (await f.send({ project: "APP" }, { key: "license-2" })).json();
  assert.equal(second.code, "license_created"); assert.notEqual(second.data.id, body.data.id);
  assert.equal(second.data.label, "", "an omitted label defaults to empty");
  assert.equal(f.count("licenses"), 2);
});

test("license creation requires an idempotency key and a protected project and label", async t => {
  const f = fixture(t);
  for (const key of [null, ""]) {
    const response = await f.send({ project: "APP" }, { key });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_idempotency_key");
  }
  const invalid = [
    {}, [], "null", { project: "" }, { project: "A".repeat(128) }, { project: "APP SPACE" }, { project: "APP\n" }, { project: "应用" },
    { project: 7 }, { project: "APP", label: "x".repeat(129) }, { project: "APP", label: "line\nbreak" }, { project: "APP", label: "nul\u0000" },
    { project: "APP", label: "del\u007f" }, { project: "APP", label: 7 }, { project: "APP", label: null },
  ];
  for (const [index, body] of invalid.entries()) {
    const response = await f.send(body, { key: `invalid-${index}` });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, "invalid_request", JSON.stringify(body));
  }
  const malformed = await f.send("{", { key: "malformed" });
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).code, "invalid_json");
  assert.equal((await f.send({ project: "A".repeat(127), label: `  ${"y".repeat(128)}  ` }, { key: "longest" })).status, 200);
  assert.equal(f.count("licenses"), 1); assert.equal(f.count("mutation_idempotency"), 1);
});

test("an unknown customer is 404 and a suspended customer is 409 customer_inactive, leaving no row or replay", async t => {
  const f = fixture(t);
  const missing = await f.send({ project: "APP" }, { customer: "nobody" });
  assert.equal(missing.status, 404); assert.equal((await missing.json()).code, "not_found");
  const suspended = await f.send({ project: "APP" }, { customer: "suspended", key: "suspended-key" });
  assert.equal(suspended.status, 409); assert.equal((await suspended.json()).code, "customer_inactive");
  assert.equal(f.count("licenses"), 0); assert.equal(f.count("mutation_idempotency"), 0);
  f.sql.exec("UPDATE customers SET status='active' WHERE id='suspended'");
  const retried = await f.send({ project: "APP" }, { customer: "suspended", key: "suspended-key" });
  assert.equal(retried.status, 200, "a refused attempt caches nothing, so the same key can succeed later");
  assert.equal((await retried.json()).data.customer_id, "suspended");
});

test("a suspension that lands after the replay read still refuses the write atomically", async t => {
  const f = fixture(t);
  f.race(() => f.sql.exec("UPDATE customers SET status='disabled' WHERE id='owner'"));
  const response = await f.send({ project: "APP" });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "customer_inactive");
  assert.equal(f.count("licenses"), 0); assert.equal(f.count("mutation_idempotency"), 0);
});

test("a same-key winner that commits during the batch is replayed instead of writing a second license", async t => {
  const f = fixture(t); let winner;
  f.race(() => {
    f.sql.prepare("INSERT INTO licenses(id,customer_id,project,label,created_at,updated_at) VALUES('lic_winner','owner','APP','',5,5)").run();
    winner = { ok: true, code: "license_created", request_id: "winner", data: { id: "lic_winner", customer_id: "owner", project: "APP", label: "", created_at: 5 } };
    f.sql.prepare("INSERT INTO mutation_idempotency(scope,idempotency_key,response_json,created_at) VALUES(?,?,?,5)")
      .run("POST:/api/admin/customers/owner/licenses:dev", "license-1", JSON.stringify(winner));
  });
  const response = await f.send({ project: "APP" });
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-idempotent-replay"), "1");
  assert.deepEqual(await response.json(), winner);
  assert.deepEqual(f.sql.prepare("SELECT id FROM licenses").all().map(row => row.id), ["lic_winner"]);
});

test("a reader cannot create a license record", async t => {
  const f = fixture(t), access = await accessFixture(t);
  const env = accessEnv(f.db, access);
  const reader = await accessToken(access, "reader@example.com");
  const response = await f.send({ project: "APP" }, { environment: env, request: (path, options) => accessAuthed(path, reader, options) });
  assert.equal(response.status, 403); assert.equal((await response.json()).code, "admin_role_required");
  assert.equal(f.count("licenses"), 0);
});
