import test from "node:test";
import assert from "node:assert/strict";
// Runs against compiled output of the extracted webhooks domain module (Task 2).
// tsconfig.worker.json's outDir preserves the src/worker/ path, so the module lands
// at dist-worker/worker/webhooks.js. These lock the validator contracts that moved
// verbatim out of index.ts, proving the extraction preserved behavior.
import { validateWebhookInput, validateWebhookPatch } from "../dist-worker/worker/webhooks.js";
import { safeWebhookEventTypesShape, webhookEventTypesUnknownTokens } from "../dist-worker/worker/webhook_event_types.js";

test("validateWebhookInput accepts a minimal https endpoint and normalizes optionals", () => {
  const result = validateWebhookInput({ url: "https://example.com/hook" });
  assert.deepEqual(result, {
    url: "https://example.com/hook",
    event_types: "",
    description: "",
    scope_project: "",
    scope_customer_id: "",
  });
});

test("validateWebhookInput canonicalizes a csv event_types filter", () => {
  const result = validateWebhookInput({
    url: "https://example.com/hook",
    event_types: " create , update ,, disable ",
  });
  assert.equal(result?.event_types, "create,update,disable");
});

test("validateWebhookInput rejects a token outside the known entitlement/customer/order set", () => {
  assert.equal(
    validateWebhookInput({ url: "https://example.com/hook", event_types: "not_a_real_event_type" }),
    "invalid_event_types",
  );
  assert.equal(
    validateWebhookInput({ url: "https://example.com/hook", event_types: "create,bogus" }),
    "invalid_event_types",
  );
});

test("validateWebhookInput accepts a mix of valid entitlement/customer/order tokens", () => {
  const result = validateWebhookInput({
    url: "https://example.com/hook",
    event_types: "create,disable,subscription.active",
  });
  assert.equal(result?.event_types, "create,disable,subscription.active");
});

test("validateWebhookInput reports a non-https url as invalid_url", () => {
  assert.equal(validateWebhookInput({ url: "http://example.com/hook" }), "invalid_url");
  assert.equal(validateWebhookInput({ url: "ftp://example.com/hook" }), "invalid_url");
});

test("validateWebhookInput returns invalid_url for an unparseable url", () => {
  assert.equal(validateWebhookInput({ url: "not a url" }), "invalid_url");
});

test("validateWebhookInput rejects a non-object body", () => {
  assert.equal(validateWebhookInput(null), null);
  assert.equal(validateWebhookInput("https://example.com"), null);
});

test("validateWebhookInput rejects an event_types token carrying internal whitespace", () => {
  assert.equal(validateWebhookInput({ url: "https://example.com", event_types: "a b" }), null);
});

test("validateWebhookInput rejects setting both project and customer scope", () => {
  assert.equal(
    validateWebhookInput({
      url: "https://example.com",
      scope_project: "proj",
      scope_customer_id: "cust",
    }),
    null,
  );
});

test("validateWebhookInput accepts a single scope dimension", () => {
  const scoped = validateWebhookInput({ url: "https://example.com", scope_project: "proj" });
  assert.equal(scoped?.scope_project, "proj");
  assert.equal(scoped?.scope_customer_id, "");
});

test("validateWebhookPatch accepts an empty patch", () => {
  assert.deepEqual(validateWebhookPatch({}), {});
});

test("validateWebhookPatch collects only the provided mutable fields", () => {
  const patch = validateWebhookPatch({
    url: "https://example.com/new",
    event_types: "create",
    description: "renamed",
  });
  assert.deepEqual(patch, {
    url: "https://example.com/new",
    event_types: "create",
    description: "renamed",
  });
});

test("validateWebhookPatch accepts a shape-valid event_types token even outside the known set (membership is checked separately, against the stored row)", () => {
  // webhook_endpoints.event_types has no database CHECK, so an existing row can already hold a
  // legacy token. validateWebhookPatch only validates SHAPE; handleWebhookPatch enforces
  // membership itself, and only for a value that actually changes from what's stored.
  assert.deepEqual(validateWebhookPatch({ event_types: "not_a_real_event_type" }), { event_types: "not_a_real_event_type" });
});

test("validateWebhookPatch still rejects a malformed event_types shape (internal whitespace, oversized)", () => {
  assert.equal(validateWebhookPatch({ event_types: "a b" }), null);
  assert.equal(validateWebhookPatch({ event_types: "x".repeat(1025) }), null);
});

test("safeWebhookEventTypesShape canonicalizes csv without checking membership", () => {
  assert.equal(safeWebhookEventTypesShape(" legacy_type , create ,, "), "legacy_type,create");
  assert.equal(safeWebhookEventTypesShape(undefined), "");
  assert.equal(safeWebhookEventTypesShape("a b"), null);
});

test("webhookEventTypesUnknownTokens names every token WEBHOOK_EVENT_TYPES does not define", () => {
  assert.deepEqual(webhookEventTypesUnknownTokens(""), []);
  assert.deepEqual(webhookEventTypesUnknownTokens("create,disable"), []);
  assert.deepEqual(webhookEventTypesUnknownTokens("create,legacy_type,also_bogus"), ["legacy_type", "also_bogus"]);
});

test("validateWebhookPatch rejects attempts to patch immutable fields", () => {
  assert.equal(validateWebhookPatch({ status: "disabled" }), null);
  assert.equal(validateWebhookPatch({ id: "wh-1" }), null);
  assert.equal(validateWebhookPatch({ created_at: "2026-01-01" }), null);
  assert.equal(validateWebhookPatch({ updated_at: "2026-01-01" }), null);
});

test("validateWebhookPatch reports a non-https url patch as invalid_url", () => {
  assert.equal(validateWebhookPatch({ url: "http://example.com" }), "invalid_url");
});

test("validateWebhookPatch rejects a scope value containing a comma", () => {
  assert.equal(validateWebhookPatch({ scope_project: "a,b" }), null);
});
