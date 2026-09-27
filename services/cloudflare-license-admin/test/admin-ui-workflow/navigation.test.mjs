import assert from "node:assert/strict";
import test from "node:test";
import { entitlementId } from "@licensecc/licensing-domain/entitlements/contracts";

import { loadWorkflowModule } from "./helpers.mjs";

test("admin navigation resolves root and every supported domain without side effects", async () => {
  const navigation = await loadWorkflowModule("app/navigationState.ts");
  for (const hash of ["", "#", "#/"]) {
    assert.deepEqual(navigation.parseAdminHash(hash), { route: { tab: "overview", filter: {} }, invalid: false });
  }
  for (const tab of ["overview", "entitlements", "policies", "plans", "webhooks", "events", "customers", "licenses", "fulfillment", "reports"]) {
    const route = navigation.routeForTab(tab);
    assert.deepEqual(navigation.parseAdminHash(navigation.hashForRoute(route)), { route, invalid: false });
  }
});

test("admin customer addresses round trip full opaque identifiers and supported sections", async () => {
  const navigation = await loadWorkflowModule("app/navigationState.ts");
  for (const section of ["overview", "access", "licenses", "tokens", "orders", "history"]) {
    const route = { tab: "customers", customerId: "cus/space é?&#", section, filter: { status: "disabled" } };
    const hash = navigation.hashForRoute(route);
    assert.match(hash, /^#\/customers\/cus%2Fspace%20%C3%A9%3F%26%23\?/u);
    assert.deepEqual(navigation.parseAdminHash(hash), { route, invalid: false });
  }
});

test("admin navigation rejects malformed addresses and ambiguous customer sections safely", async () => {
  const navigation = await loadWorkflowModule("app/navigationState.ts");
  for (const hash of ["#outside", "#/unknown", "#/customers/", "#/customers/a/b", "#/customers/%ZZ", "#/customers/%C3%28", "#/customers/%00", "#/customers/a?section=unknown", "#/customers?section=access", "#/plans?view=unknown", "#/entitlements?status=active&status=revoked", "#/reports?x=1?y=2"]) {
    assert.deepEqual(navigation.parseAdminHash(hash), { route: { tab: "overview", filter: {} }, invalid: true }, hash);
  }
});

test("admin URL adapter excludes private queries, draft content, and credential material", async () => {
  const navigation = await loadWorkflowModule("app/navigationState.ts");
  const target = { tab: "entitlements", filter: { project: "DEMO", feature: "pro", status: "active", q: "person@example.com", license_fingerprint: "credential", token: "secret", json: "private draft" } };
  assert.equal(navigation.hashForTarget(target), "#/entitlements?project=DEMO&feature=pro&status=active");
  assert.equal(target.filter.q, "person@example.com", "the in-memory navigation target is preserved");
  assert.deepEqual(navigation.parseAdminHash("#/entitlements?project=DEMO&q=person%40example.com&token=secret").route.filter, { project: "DEMO" });
  assert.deepEqual(navigation.parseAdminHash("#/customers?status=untrusted").route.filter, {});
});

test("a deep-linked entitlement id and its customer_id are session-only; the URL never carries the fingerprint it encodes", async () => {
  const navigation = await loadWorkflowModule("app/navigationState.ts");
  const fingerprint = "a".repeat(64);
  const id = entitlementId("DEFAULT", "pro", fingerprint);
  const target = { tab: "entitlements", filter: { id, customer_id: "cus_1", project: "", feature: "", status: "" } };
  const hash = navigation.hashForTarget(target);
  assert.equal(hash, "#/entitlements");
  assert.ok(!hash.includes(fingerprint), "the id encodes the fingerprint; it must never reach the URL");
  assert.ok(!hash.includes("id="));
  assert.ok(!hash.includes("customer_id="));
  // license_id is an ordinary browsing filter (like project/feature/status), not a deep-link secret,
  // so it stays in the URL and survives a refresh.
  assert.equal(
    navigation.hashForTarget({ tab: "entitlements", filter: { license_id: "lic_1", project: "", feature: "", status: "" } }),
    "#/entitlements?license_id=lic_1",
  );
  assert.deepEqual(navigation.parseAdminHash("#/entitlements?license_id=lic_1&id=x&customer_id=y").route.filter, { license_id: "lic_1" });
});

test("a 'History' deep-linked entitlement_id on the events tab is session-only; the URL never carries the fingerprint it encodes", async () => {
  const navigation = await loadWorkflowModule("app/navigationState.ts");
  const fingerprint = "a".repeat(64);
  const id = entitlementId("DEFAULT", "pro", fingerprint);
  const target = { tab: "events", filter: { entitlement_id: id, project: "", feature: "", event_type: "", actor: "", since: "", until: "" } };
  const hash = navigation.hashForTarget(target);
  assert.equal(hash, "#/events");
  assert.ok(!hash.includes(fingerprint), "entitlement_id encodes the fingerprint; it must never reach the URL");
  assert.ok(!hash.includes("entitlement_id="));
  // The ordinary browsing filters are normal URL filters and survive a refresh.
  assert.equal(
    navigation.hashForTarget({ tab: "events", filter: { project: "DEFAULT", feature: "", event_type: "disable", actor: "", since: "", until: "" } }),
    "#/events?project=DEFAULT&event_type=disable",
  );
  assert.deepEqual(navigation.parseAdminHash("#/events?project=DEFAULT&entitlement_id=x").route.filter, { project: "DEFAULT" });
});

test("admin catalog URLs expose only the supported Plans, Features, and Import views", async () => {
  const navigation = await loadWorkflowModule("app/navigationState.ts");
  for (const view of ["plans", "features", "import"]) {
    const target = { tab: "plans", catalogView: view, filter: {} };
    const route = navigation.routeForTarget(target);
    assert.deepEqual(navigation.parseAdminHash(navigation.hashForTarget(target)), { route, invalid: false });
  }
});

test("admin environment labels require the validated settings contract", async () => {
  const environment = await loadWorkflowModule("app/environment.ts");
  const settings = { environment: "staging", public_verifier_url: "", auth: "cloudflare-access" };
  assert.equal(environment.hasAdminSettings(settings), true);
  assert.equal(environment.environmentLabel(settings.environment), "Staging");
  assert.equal(environment.environmentLabel("preview-unrecognized"), null);
  assert.equal(environment.environmentLabel("STAGING"), null);
  for (const value of [null, [], {}, { ...settings, environment: "" }, { ...settings, environment: 1 }, { ...settings, auth: "admin" }, { ...settings, public_verifier_url: null }]) {
    assert.equal(environment.hasAdminSettings(value), false);
  }
});
