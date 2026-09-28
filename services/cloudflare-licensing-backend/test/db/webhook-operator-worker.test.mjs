// The real Worker composition for "Send test event": the admin Worker calls the backend's
// WebhookOperator entrypoint over a service binding, and the backend's outbound fetch is routed to
// a receiver Worker that records what arrived in D1. Proves the named entrypoint is exported, the
// RPC result crosses the binding as only a status class, the signature verifies, workerd does not
// follow the redirect, the second send within 60 s is refused, and only the sends that reached the
// receiver leave a webhook_events audit row.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { loadSecretMap } from "@licensecc/cloudflare-runtime/auth/secret_map";
import { verifyWebhookSignature } from "@licensecc/cloudflare-runtime/webhooks/webhook";

const require = createRequire(import.meta.url), wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");

const SECRETS = JSON.stringify({ hooks: Buffer.alloc(32, 9).toString("base64") });

async function bundle(relativePath) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))], bundle: true, external: ["cloudflare:workers", "node:crypto"],
    write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent" });
  return result.outputFiles[0].text;
}

test("the admin Worker sends a signed test event through the backend WebhookOperator entrypoint", async (t) => {
  const [backend, admin] = await Promise.all([bundle("../../src/index.ts"), bundle("../../../cloudflare-license-admin/src/worker/index.ts")]);
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: "backend", modules: true, script: backend, compatibilityDate: "2026-08-01", compatibilityFlags: ["global_fetch_strictly_public"], d1Databases: { DB: "hooks" }, outboundService: "receiver",
      bindings: { WEBHOOK_SIGNING_SECRETS: SECRETS, WEBHOOK_SIGNING_KEY_ID: "hooks" } },
    // Test-only receiver: records every request it is sent, then answers by path.
    { name: "receiver", modules: true, compatibilityDate: "2026-08-01", d1Databases: { DB: "hooks" },
      script: `export default { async fetch(request, env) {
        const url = new URL(request.url);
        await env.DB.prepare("INSERT INTO captured_requests (url, method, signature, source, body) VALUES (?, ?, ?, ?, ?)")
          .bind(request.url, request.method, request.headers.get("licensecc-signature"), request.headers.get("licensecc-event-source"), await request.text()).run();
        if (url.pathname === "/moved") return new Response(null, { status: 302, headers: { location: "https://hooks.example.test/after-redirect" } });
        return new Response("accepted", { status: 200 });
      } };` },
    { name: "admin", modules: true, compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"], script: admin, d1Databases: { DB: "hooks" },
      serviceBindings: { WEBHOOK_OPERATOR: { name: "backend", entrypoint: "WebhookOperator" } },
      bindings: { ENVIRONMENT: "development", ADMIN_DEV_BEARER_ENABLED: "1", ADMIN_DEV_BEARER: "local-test-admin" } },
  ] }));
  t.after(() => mf.dispose());

  const db = await mf.getD1Database("DB");
  const parser = new DatabaseSync(":memory:");
  let ddl;
  try {
    parser.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
    ddl = parser.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid").all();
  } finally {
    parser.close();
  }
  for (const row of ddl) await db.prepare(row.sql).run();
  await db.prepare("CREATE TABLE captured_requests (id INTEGER PRIMARY KEY, url TEXT, method TEXT, signature TEXT, source TEXT, body TEXT)").run();
  for (const [id, path, status] of [["ok", "/ok", "active"], ["moved", "/moved", "active"], ["off", "/off", "disabled"]]) {
    await db.prepare("INSERT INTO webhook_endpoints (id, url, event_types, status, description, created_at, updated_at) VALUES (?, ?, '', ?, '', 1, 1)")
      .bind(id, `https://hooks.example.test${path}`, status).run();
  }

  const adminWorker = await mf.getWorker("admin");
  async function sendTest(id) {
    const response = await adminWorker.fetch(`https://admin.example.test/api/admin/webhooks/${id}/test`, {
      method: "POST", headers: { authorization: "Bearer local-test-admin", "content-type": "application/json" }, body: "{}" });
    return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() };
  }
  const captured = async () => (await db.prepare("SELECT url, method, signature, source, body FROM captured_requests ORDER BY id").all()).results;

  const sent = await sendTest("ok");
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.code, "webhook_test_sent");
  assert.deepEqual(sent.body.data, { status_class: "2xx" });
  const [delivery] = await captured();
  assert.equal(delivery.url, "https://hooks.example.test/ok");
  assert.equal(delivery.method, "POST");
  assert.equal(delivery.source, "test");
  const payload = JSON.parse(delivery.body);
  assert.deepEqual(Object.keys(payload), ["type", "endpoint_id", "sent_at"]);
  assert.equal(payload.type, "test");
  assert.equal(payload.endpoint_id, "ok");
  assert.equal(await verifyWebhookSignature(delivery.body, delivery.signature, loadSecretMap(SECRETS), payload.sent_at), true);
  assert.equal(JSON.stringify(sent.body).includes(delivery.signature), false);

  const limited = await sendTest("ok");
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.ok(Number(limited.retryAfter) >= 1 && Number(limited.retryAfter) <= 60);
  assert.equal((await captured()).length, 1, "the limited call reached no receiver");

  const moved = await sendTest("moved");
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.data, { status_class: "3xx" });
  assert.deepEqual((await captured()).map((row) => row.url), ["https://hooks.example.test/ok", "https://hooks.example.test/moved"], "the redirect target was never requested");

  const disabled = await sendTest("off");
  assert.equal(disabled.status, 404);
  assert.equal(disabled.body.code, "not_found");
  assert.equal((await captured()).length, 2);

  // Each send that reached the receiver left one audit row in the shared D1; the rate-limited and
  // refused sends left none.
  const audit = (await db.prepare("SELECT endpoint_id, event_type, prev_status, next_status, actor, actor_type, source, reason, request_id FROM webhook_events ORDER BY id").all()).results;
  assert.deepEqual(audit, [
    { endpoint_id: "ok", event_type: "test_send", prev_status: "active", next_status: "active", actor: "dev.local", actor_type: "dev", source: "admin", reason: "2xx", request_id: sent.body.request_id },
    { endpoint_id: "moved", event_type: "test_send", prev_status: "active", next_status: "active", actor: "dev.local", actor_type: "dev", source: "admin", reason: "3xx", request_id: moved.body.request_id },
  ]);
});
