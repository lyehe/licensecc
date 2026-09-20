import assert from "node:assert/strict";
import { test } from "node:test";
import admin from "../../../cloudflare-license-admin/dist-worker/worker/index.js";
import { baseFixture, call } from "../../../cloudflare-customer-portal/test/portal-worker-fixtures.mjs";

test("admin-created portal users can sign in, change their password, and have no inherited licenses", async () => {
  const { db, env } = baseFixture({ PORTAL_PASSWORD_ENABLED: "1" });
  db.exec("PRAGMA foreign_keys=ON");
  const password = "An initial provisioning passphrase!";
  const created = await admin.fetch(new Request("https://admin.test/api/admin/customers", {
    method: "POST", headers: { authorization: "Bearer local-provisioning-test", "content-type": "application/json", "idempotency-key": "provision-user-e2e" },
    body: JSON.stringify({ name: "Portal user", email: "portal-user@example.test", password }),
  }), { DB: env.DB, ENVIRONMENT: "development", ADMIN_DEV_BEARER_ENABLED: "1", ADMIN_DEV_BEARER: "local-provisioning-test" });
  assert.equal(created.status, 200); const user = (await created.json()).data;
  const login = async value => call(env, "POST", "/portal/v1/auth/password/login", { body: { email: "portal-user@example.test", password: value } });
  const session = await login(password); assert.equal(session.status, 200);
  const cookie = session.res.headers.get("set-cookie").split(";")[0];
  assert.equal((await call(env, "GET", "/api/portal/me", { cookie })).body.data.customer_id, user.id);
  assert.deepEqual((await call(env, "GET", "/api/portal/entitlements", { cookie })).body.data.items, []);
  const settings = await call(env, "GET", "/portal/v1/auth/password", { cookie });
  assert.equal(settings.body.data.email_verified, false);
  const next = "A changed personal passphrase!";
  assert.equal((await call(env, "POST", "/portal/v1/auth/password", { cookie, body: { current_password: password, password: next } })).status, 200);
  assert.equal((await login(password)).status, 401); assert.equal((await login(next)).status, 200);
});
