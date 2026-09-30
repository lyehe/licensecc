import test from "node:test";
import assert from "node:assert/strict";
// Runs against compiled output of the webhooks domain module. tsconfig.worker.json's outDir
// preserves the src/worker/ path, so the module lands at dist-worker/worker/webhooks.js. These
// lock the create and PATCH validator contracts.
import { validateWebhookInput, validateWebhookPatch } from "../dist-worker/worker/webhooks.js";
import { INVALID_EVENT_TYPES, safeWebhookEventTypes } from "../dist-worker/worker/webhook_event_types.js";

const GLOBAL = { url: "https://example.com/hook", scope_kind: "global" };

test("validateWebhookInput accepts a minimal operator-wide https endpoint and normalizes optionals", () => {
  const result = validateWebhookInput(GLOBAL);
  assert.deepEqual(result, {
    url: "https://example.com/hook",
    event_types: "",
    description: "",
    scope_kind: "global",
    scope_project: "",
    scope_customer_id: "",
  });
});

test("validateWebhookInput canonicalizes a csv event_types filter", () => {
  const result = validateWebhookInput({ ...GLOBAL, event_types: " create , update ,, disable " });
  assert.equal(result?.event_types, "create,update,disable");
});

test("validateWebhookInput rejects a token outside the known entitlement/customer/order set", () => {
  assert.equal(validateWebhookInput({ ...GLOBAL, event_types: "not_a_real_event_type" }), "invalid_event_types");
  assert.equal(validateWebhookInput({ ...GLOBAL, event_types: "create,bogus" }), "invalid_event_types");
  // Matching is exact: never a prefix or a case-insensitive match.
  assert.equal(validateWebhookInput({ ...GLOBAL, event_types: "Create" }), "invalid_event_types");
  assert.equal(validateWebhookInput({ ...GLOBAL, event_types: "subscription" }), "invalid_event_types");
});

test("validateWebhookInput accepts a mix of valid entitlement/customer/order tokens", () => {
  const result = validateWebhookInput({ ...GLOBAL, event_types: "create,disable,subscription.active" });
  assert.equal(result?.event_types, "create,disable,subscription.active");
});

test("validateWebhookInput reports a non-https url as invalid_url", () => {
  assert.equal(validateWebhookInput({ ...GLOBAL, url: "http://example.com/hook" }), "invalid_url");
  assert.equal(validateWebhookInput({ ...GLOBAL, url: "ftp://example.com/hook" }), "invalid_url");
});

test("validateWebhookInput reports an IP-literal url as invalid_url", () => {
  assert.equal(validateWebhookInput({ ...GLOBAL, url: "https://127.0.0.1/" }), "invalid_url");
});

test("validateWebhookInput returns invalid_url for an unparseable url", () => {
  assert.equal(validateWebhookInput({ ...GLOBAL, url: "not a url" }), "invalid_url");
});

test("validateWebhookInput rejects a non-object body", () => {
  assert.equal(validateWebhookInput(null), null);
  assert.equal(validateWebhookInput("https://example.com"), null);
  assert.equal(validateWebhookInput([GLOBAL]), null);
});

test("validateWebhookInput rejects an event_types token carrying internal whitespace", () => {
  assert.equal(validateWebhookInput({ ...GLOBAL, event_types: "a b" }), null);
});

test("validateWebhookInput requires an explicit scope_kind naming exactly its own scope value", () => {
  // No kind, or a kind outside global/project/customer, names no audience.
  for (const scope of [{}, { scope_kind: "" }, { scope_kind: null }, { scope_kind: "all" }, { scope_kind: 1 }, { scope_project: "proj" }]) {
    assert.equal(validateWebhookInput({ url: "https://example.com", ...scope }), null, JSON.stringify(scope));
  }
  // Each kind names its own value and never the other one.
  for (const scope of [
    { scope_kind: "global", scope_project: "proj" },
    { scope_kind: "global", scope_customer_id: "cust" },
    { scope_kind: "project" },
    { scope_kind: "project", scope_project: "" },
    { scope_kind: "project", scope_project: "proj", scope_customer_id: "cust" },
    { scope_kind: "customer" },
    { scope_kind: "customer", scope_customer_id: "" },
    { scope_kind: "customer", scope_customer_id: "cust", scope_project: "proj" },
  ]) {
    assert.equal(validateWebhookInput({ url: "https://example.com", ...scope }), null, JSON.stringify(scope));
  }
});

test("validateWebhookInput accepts each scope kind with its own value", () => {
  const project = validateWebhookInput({ url: "https://example.com", scope_kind: "project", scope_project: "proj" });
  assert.equal(project?.scope_kind, "project");
  assert.equal(project?.scope_project, "proj");
  assert.equal(project?.scope_customer_id, "");
  const customer = validateWebhookInput({ url: "https://example.com", scope_kind: "customer", scope_customer_id: "cust", scope_project: "" });
  assert.equal(customer?.scope_kind, "customer");
  assert.equal(customer?.scope_project, "");
  assert.equal(customer?.scope_customer_id, "cust");
});

test("validateWebhookInput refuses a body naming a field create does not read", () => {
  for (const field of ["status", "id", "created_at", "updated_at", "secret", "scope"]) {
    assert.equal(validateWebhookInput({ ...GLOBAL, [field]: "x" }), null, field);
  }
});

test("validateWebhookPatch accepts an empty patch", () => {
  assert.deepEqual(validateWebhookPatch({}), {});
});

test("validateWebhookPatch collects only the provided mutable fields", () => {
  const patch = validateWebhookPatch({
    url: "https://example.com/new",
    event_types: "create",
    description: "renamed",
    scope_kind: "project",
    scope_project: "proj",
    scope_customer_id: "",
  });
  assert.deepEqual(patch, {
    url: "https://example.com/new",
    event_types: "create",
    description: "renamed",
    scope_kind: "project",
    scope_project: "proj",
    scope_customer_id: "",
  });
});

test("validateWebhookPatch checks event_types membership as well as shape", () => {
  assert.equal(validateWebhookPatch({ event_types: "not_a_real_event_type" }), "invalid_event_types");
  assert.equal(validateWebhookPatch({ event_types: "create,bogus" }), "invalid_event_types");
  assert.equal(validateWebhookPatch({ event_types: "a b" }), null);
  assert.equal(validateWebhookPatch({ event_types: "x".repeat(1025) }), null);
});

test("validateWebhookPatch refuses a scope_kind outside global/project/customer", () => {
  for (const kind of ["", null, "all", 1]) {
    assert.equal(validateWebhookPatch({ scope_kind: kind }), null, JSON.stringify(kind));
  }
});

test("safeWebhookEventTypes checks shape and membership in one pass", () => {
  assert.equal(safeWebhookEventTypes(undefined), "");
  assert.equal(safeWebhookEventTypes(""), "");
  assert.equal(safeWebhookEventTypes(" create , disable ,, "), "create,disable");
  assert.equal(safeWebhookEventTypes("create,retired_type"), INVALID_EVENT_TYPES);
  assert.equal(safeWebhookEventTypes('create,"'), INVALID_EVENT_TYPES);
  assert.equal(safeWebhookEventTypes("a b"), null);
  assert.equal(safeWebhookEventTypes(42), null);
});

test("validateWebhookPatch rejects attempts to patch immutable or unknown fields", () => {
  assert.equal(validateWebhookPatch({ status: "disabled" }), null);
  assert.equal(validateWebhookPatch({ id: "wh-1" }), null);
  assert.equal(validateWebhookPatch({ created_at: "2026-01-01" }), null);
  assert.equal(validateWebhookPatch({ updated_at: "2026-01-01" }), null);
  assert.equal(validateWebhookPatch({ description: "x", secret: "s" }), null);
});

test("validateWebhookPatch reports a non-https url patch as invalid_url", () => {
  assert.equal(validateWebhookPatch({ url: "http://example.com" }), "invalid_url");
});

test("validateWebhookPatch rejects a scope value containing a comma", () => {
  assert.equal(validateWebhookPatch({ scope_project: "a,b" }), null);
});
