import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { META_ROUTES, PUBLIC_ROUTES, SESSION_ROUTES } from "../dist-worker/worker/routes.js";
import { DIRECT_ROUTE_TESTS as publicRoutes } from "./portal-worker-public.test.mjs";
import { DIRECT_ROUTE_TESTS as authRoutes } from "./portal-worker-auth.test.mjs";
import { DIRECT_ROUTE_TESTS as sessionRoutes } from "./portal-worker-session.test.mjs";
import { DIRECT_ROUTE_TESTS as selfServiceRoutes } from "./portal-worker-self-service.test.mjs";

const GROUPS = Object.freeze({
  public: publicRoutes,
  auth: authRoutes,
  session: sessionRoutes,
  selfService: selfServiceRoutes,
});
const ROUTE_OWNER_TABLE = Object.freeze({
  "GET /openapi.json": "public",
  "GET /docs": "public",
  "GET /health": "public",
  "POST /portal/v1/auth/request": "auth",
  "POST /portal/v1/auth/verify": "auth",
  "GET /portal/v1/auth/magic": "auth",
  "POST /portal/v1/auth/magic-redeem": "auth",
  "POST /portal/v1/auth/logout": "session",
  "POST /portal/v1/admin/bootstrap-otp": "auth",
  "GET /api/portal/me": "selfService",
  "GET /api/portal/entitlements": "selfService",
  "GET /api/portal/devices": "selfService",
  "POST /api/portal/devices/release": "selfService",
  "GET /api/portal/usage": "selfService",
  "POST /api/portal/checkout": "selfService",
  "POST /api/portal/heartbeat": "selfService",
  "POST /api/portal/release": "selfService",
  "POST /api/portal/download": "selfService",
});

const routeKey = (route) => `${route.method} ${route.path}`;
const inventory = [...META_ROUTES, ...PUBLIC_ROUTES, ...SESSION_ROUTES].map(routeKey);

test("every META/PUBLIC/SESSION route has one explicit direct group-test owner", () => {
  assert.deepEqual(new Set(Object.keys(ROUTE_OWNER_TABLE)), new Set(inventory), "owner table must equal the canonical 18-route inventory");

  for (const [key, group] of Object.entries(ROUTE_OWNER_TABLE)) {
    assert.ok(Object.hasOwn(GROUPS, group), `${key} names an unknown test group ${group}`);
    const matchingGroups = Object.entries(GROUPS).filter(([, routes]) => routes.includes(key));
    assert.deepEqual(matchingGroups.map(([name]) => name), [group], `${key} must be listed by exactly its declared direct group`);
  }

  for (const [group, routes] of Object.entries(GROUPS)) {
    assert.equal(new Set(routes).size, routes.length, `${group} direct route table contains duplicates`);
    for (const key of routes) {
      assert.equal(ROUTE_OWNER_TABLE[key], group, `${key} is listed by ${group} without a matching owner-table entry`);
    }
  }
});

test("module-worker entrypoint has exactly one app edge", () => {
  const source = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
  assert.match(source, /export \{ default, PORTAL_ROUTE_KEYS, portalInternalsForTests \} from ["']\.\/app\.js["'];/);
  assert.match(source, /export type \{ Env \} from ["']\.\/app\.js["'];/);
  assert.doesNotMatch(source, /from ["']\.\/env\.js["']/);
});
