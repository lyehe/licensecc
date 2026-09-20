import assert from "node:assert/strict";
import { test } from "node:test";
import app, { scheduled } from "../dist/app.js";

function recordingDb(statements = []) {
  return {
    prepare(sql) {
      statements.push(sql);
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [] };
        },
        async first() {
          return null;
        },
        async run() {
          return {};
        },
      };
    },
  };
}

const emptyCleanupSnapshot = () => ({measured_at:1000,approval_responses:null,ephemera_challenges:null,
  ephemera_attempts:null,recovery_responses:null,recovery_attempts:null,lease_leases:null});

test('scheduled backlog observations are independent of sweep counts and disclose only deadline metrics',async t=>{
  const logs=[];
  t.mock.method(console,'log',line=>logs.push(JSON.parse(line)));
  t.mock.method(console,'warn',line=>logs.push(JSON.parse(line)));
  const statements=[], db=recordingDb(statements), prepare=db.prepare;
  let primaryReads=0;
  db.withSession=mode=>{assert.equal(mode,'first-primary');return {prepare(sql){
    assert.ok(sql.includes('AS measured_at')); primaryReads++;
    return {async first(){return {...emptyCleanupSnapshot(),ephemera_challenges:1000,recovery_responses:500};}};
  }}}; // A saturated mutation count does not determine whether this read is clear.
  db.prepare=sql=>{const statement=prepare(sql);statement.run=async()=>({meta:{changes:1000}});return statement;};
  await scheduled({}, {DB:db});
  assert.equal(primaryReads,1);
  const observations=logs.filter(entry=>entry.event==='device.cleanup_backlog');
  assert.equal(observations.length,6);
  for(const row of observations){
    const deadline=row.source==='ephemera'&&row.target==='challenges'?1000:row.source==='recovery'&&row.target==='responses'?500:null;
    assert.deepEqual(row,{event:'device.cleanup_backlog',severity:deadline===null?'info':'warn',source:row.source,target:row.target,
      measured_at:1000,backlog_present:deadline!==null,oldest_expired_at:deadline,backlog_age_seconds:deadline===null?null:1000-deadline});
  }
  assert.equal(logs.filter(entry=>entry.event==='device.cleanup_limit_reached').length,6);
});

for(const failure of ['read','malformed','session']) test(`backlog ${failure} failure emits unknown with no partial clear samples`,async t=>{
  const logs=[],statements=[],db=recordingDb(statements);
  t.mock.method(console,'log',line=>logs.push(JSON.parse(line)));
  t.mock.method(console,'warn',line=>logs.push(JSON.parse(line)));
  db.withSession=()=>{
    if(failure==='session')throw new Error('private-session-detail');
    return {prepare(){return {async first(){
      if(failure==='read')throw new Error('private-read-detail');
      return {...emptyCleanupSnapshot(),lease_leases:'private-invalid-field'};
    }}}};
  };
  await scheduled({}, {DB:db});
  assert.deepEqual(logs.filter(entry=>entry.event.startsWith('device.cleanup_backlog')),[{event:'device.cleanup_backlog_failed',severity:'warn'}]);
  assert.ok(statements.some(sql=>sql.includes('DELETE FROM usage_events')));
  assert.doesNotMatch(JSON.stringify(logs),/private-/);
});

async function responseBody(response) {
  return response.json();
}

test("app returns the generic top-level 404 contract", async () => {
  const response = await app.fetch(new Request("https://example.test/not-a-route"), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await responseBody(response), { ok: false, code: "not_found" });
});

test("scheduled is directly callable and retains each best-effort retention sweep", async () => {
  const statements = [];
  await scheduled({ cron: "0 * * * *" }, { DB: recordingDb(statements) }, { waitUntil() {} });
  assert.ok(statements.some(sql => sql.includes("SET approval_ciphertext = NULL") && sql.includes("LIMIT 1000")));
  for (const table of ["usage_events", "lease_issuance", "usage_meters", "portal_otp", "portal_sessions", "device_bound_challenges", "device_bound_authorizations", "device_bound_leases"]) {
    assert.ok(statements.some((sql) => sql.includes(`DELETE FROM ${table}`)), `expected scheduled retention for ${table}`);
  }
  assert.equal(statements.some(sql=>/DELETE\s+FROM\s+device_bound_events/i.test(sql)),false);
});

test("approval maintenance bounds backlog work, stops after draining and isolates failures", async t => {
  const logs=[];
  t.mock.method(console,"warn",(...args)=>logs.push(args.join(" ")));
  for (const [changes,expected] of [[[1000],10],[[1000,3],2],[[0],1],[["failure"],1]]) {
    const statements=[],db=recordingDb(statements),prepare=db.prepare;let calls=0;
    db.prepare=sql=>{
      const statement=prepare(sql);
      if(sql.includes("SET approval_ciphertext = NULL")) statement.run=async()=>{
        const changed=changes[Math.min(calls++,changes.length-1)];
        if(changed==="failure") throw new Error("private database detail");
        return {meta:{changes:changed}};
      };
      return statement;
    };
    await scheduled({}, {DB:db});
    assert.equal(calls,expected);
    assert.ok(statements.some(sql=>sql.includes("DELETE FROM usage_events")));
  }
  assert.ok(logs.some(line=>JSON.parse(line).event==="device.approval_cleanup_failed"));
  assert.equal(logs.some(line=>line.includes("private database detail")),false);
});

test("cleanup pressure logs distinguish limits from completion without row data",async t=>{
  const logs=[];
  t.mock.method(console,'log',line=>logs.push(JSON.parse(line)));
  t.mock.method(console,'warn',line=>logs.push(JSON.parse(line)));
  for (const [changes,expected,event] of [[0,0,'device.cleanup_completed'],[7,7,'device.cleanup_completed'],[1000,10000,'device.cleanup_limit_reached']]) {
    logs.length=0;
    const statements=[],db=recordingDb(statements),prepare=db.prepare;
    db.prepare=sql=>{const statement=prepare(sql);statement.run=async()=>({meta:{changes},results:[{customer_id:'private-customer',token:'private-token'}]});return statement;};
    await scheduled({}, {DB:db});
    const sweeps=logs.filter(entry=>entry.event===event);
    assert.deepEqual(sweeps.map(entry=>`${entry.source}.${entry.target}`),[
      'approval.responses','ephemera.challenges','ephemera.attempts','recovery.responses','recovery.attempts','lease.leases',
    ]);
    for(const entry of sweeps) assert.deepEqual(entry,{event,severity:changes===1000?'warn':'info',source:entry.source,target:entry.target,affected_rows:expected,limit_reached:changes===1000});
    assert.equal(JSON.stringify(logs).includes('private-'),false);
  }
});

for(const [source,query] of [['ephemera','DELETE FROM device_bound_challenges'],['recovery',"SET response_json=''"],['lease','DELETE FROM device_bound_leases']])
test(`${source} cleanup failure does not stop other scheduled retention or disclose database details`,async t=>{
  const logs=[],statements=[],db=recordingDb(statements),prepare=db.prepare;
  t.mock.method(console,'warn',(...args)=>logs.push(args.join(' ')));
  db.prepare=sql=>{
    const statement=prepare(sql);
    if(sql.includes(query))statement.run=async()=>{throw new Error('private cleanup detail');};
    return statement;
  };
  await scheduled({}, {DB:db});
  assert.ok(statements.some(sql=>sql.includes('DELETE FROM usage_events')));
  assert.ok(logs.some(line=>JSON.parse(line).event===`device.${source}_cleanup_failed`));
  assert.equal(logs.some(line=>line.includes('private cleanup detail')),false);
});

test("app dispatches the live orders and meter routes before their handler-specific guards", async () => {
  const orders = await app.fetch(
    new Request("https://example.test/v1/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { DB: recordingDb(), ORDER_INGEST_MODE: "required" },
  );
  assert.equal(orders.status, 503);
  assert.deepEqual(await responseBody(orders), { ok: false, code: "config_error" });

  const meter = await app.fetch(
    new Request("https://example.test/v1/meter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { DB: recordingDb() },
  );
  assert.equal(meter.status, 400);
  assert.deepEqual(await responseBody(meter), { ok: false, code: "invalid_request" });
});

test("emergency prefix delegates each of its seven scoped operations", async () => {
  const cases = [
    ["POST", "/v1/emergency/v1/activate", 503, "lease_signing_unavailable"],
    ["POST", "/v1/emergency/v1/renew", 503, "lease_signing_unavailable"],
    ["POST", "/v1/emergency/v1/checkout", 503, "seat_signing_unavailable"],
    ["POST", "/v1/emergency/v1/heartbeat", 503, "seat_signing_unavailable"],
    ["POST", "/v1/emergency/v1/release", 400, "invalid_request"],
    ["POST", "/v1/emergency/v1/meter", 400, "invalid_request"],
    ["GET", "/v1/emergency/v1/admin/report", 400, "invalid_request"],
  ];
  for (const [method, path, status, code] of cases) {
    const response = await app.fetch(
      new Request(`https://example.test${path}`, {
        method,
        headers: { authorization: "Bearer emergency", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
      }),
      { DB: recordingDb(), EMERGENCY_OPERATOR_BEARER: "emergency" },
    );
    assert.equal(response.status, status, `${method} ${path}`);
    assert.deepEqual(await responseBody(response), { ok: false, code }, `${method} ${path}`);
  }
});
