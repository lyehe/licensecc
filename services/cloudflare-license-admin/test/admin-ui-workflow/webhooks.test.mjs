import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

test("admin UI workflow builds filtered webhook list + delivery paths", async () => {
  const workflow = await loadWorkflowModule("features/webhooks/workflow.ts");
  assert.equal(workflow.webhooksPath({ status: "" }), "/api/admin/webhooks");
  assert.equal(workflow.webhooksPath({ status: "active" }), "/api/admin/webhooks?status=active");
  assert.equal(workflow.webhooksPath({ status: "disabled" }), "/api/admin/webhooks?status=disabled");

  assert.equal(workflow.webhookDeliveriesPath({ endpoint_id: "", status: "" }), "/api/admin/webhooks/deliveries");
  assert.equal(
    workflow.webhookDeliveriesPath({ endpoint_id: "wh_1", status: "failed" }),
    "/api/admin/webhooks/deliveries?endpoint_id=wh_1&status=failed",
  );
  assert.equal(
    workflow.webhookDeliveriesPath({ endpoint_id: "", status: "pending" }),
    "/api/admin/webhooks/deliveries?status=pending",
  );
});

test("admin UI workflow builds webhook detail/transition/redrive paths with encoding", async () => {
  const workflow = await loadWorkflowModule("features/webhooks/workflow.ts");
  assert.equal(workflow.webhookPath("wh_1"), "/api/admin/webhooks/wh_1");
  assert.equal(workflow.webhookPath("wh/with space"), "/api/admin/webhooks/wh%2Fwith%20space");
  assert.equal(workflow.webhookTransitionPath("wh_1", "disable"), "/api/admin/webhooks/wh_1/disable");
  assert.equal(workflow.webhookTransitionPath("wh_1", "reenable"), "/api/admin/webhooks/wh_1/reenable");
  assert.equal(workflow.webhookRedrivePath("42"), "/api/admin/webhooks/deliveries/42/redrive");
  assert.equal(workflow.webhookRedrivePath("a/b"), "/api/admin/webhooks/deliveries/a%2Fb/redrive");
});

test("admin UI workflow webhook action rules match the disable/reenable invariants", async () => {
  const workflow = await loadWorkflowModule("features/webhooks/workflow.ts");
  assert.equal(workflow.canRunWebhookAction("active", "disable"), true);
  assert.equal(workflow.canRunWebhookAction("active", "reenable"), false);
  assert.equal(workflow.canRunWebhookAction("disabled", "disable"), false);
  assert.equal(workflow.canRunWebhookAction("disabled", "reenable"), true);
  assert.equal(workflow.canRunWebhookAction("unknown", "disable"), false);
});

test("admin UI workflow normalizes the webhook create form (mirrors the Worker validators)", async () => {
  const workflow = await loadWorkflowModule("features/webhooks/workflow.ts");
  const globalForm = { ...workflow.emptyWebhookForm, scope_kind: "global" };
  assert.deepEqual(
    workflow.normalizeWebhookForm({ ...globalForm, url: "https://hooks.example.com/lcc" }),
    { url: "https://hooks.example.com/lcc", event_types: "", description: "", scope_kind: "global", scope_project: "", scope_customer_id: "" },
  );
  const scoped = workflow.normalizeWebhookForm({
    ...workflow.emptyWebhookForm,
    url: "https://hooks.example.com/lcc",
    event_types: " revoke , , subscription.active ",
    description: "prod alerts",
    scope_kind: "project",
    scope_project: " DEFAULT ",
  });
  assert.equal(scoped.event_types, "revoke,subscription.active");
  assert.equal(scoped.scope_kind, "project");
  assert.equal(scoped.scope_project, "DEFAULT");
  assert.equal(scoped.scope_customer_id, "");

  assert.throws(() => workflow.normalizeWebhookForm({ ...globalForm, url: "http://x.example.com" }), /url_must_be_https/);
  assert.throws(() => workflow.normalizeWebhookForm({ ...globalForm, url: "" }), /url_must_be_a_single_https_url/);
  assert.throws(() => workflow.normalizeWebhookForm({ ...globalForm, url: "https://a b.example.com" }), /url_must_be_a_single_https_url/);
  assert.throws(
    () => workflow.normalizeWebhookForm({ ...globalForm, url: "https://x.example.com", event_types: "a b" }),
    /event_types_token_has_whitespace/,
  );
  // Only the event types the dispatcher emits: an unknown token never reaches the server.
  assert.throws(
    () => workflow.normalizeWebhookForm({ ...globalForm, url: "https://x.example.com", event_types: "create,entitlement.revoked" }),
    /invalid_event_types/,
  );
  assert.throws(
    () => workflow.normalizeWebhookForm({ ...globalForm, url: "https://x.example.com", description: "line1\nline2" }),
    /description_invalid/,
  );
  assert.throws(
    () => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://x.example.com", scope_kind: "project", scope_project: "a\nb" }),
    /scope_project_must_be_a_single_value/,
  );
  assert.throws(
    () => workflow.normalizeWebhookForm({ ...globalForm, url: "https://x.example.com", event_types: "a,\nb" }),
    /event_types_invalid/,
  );
});

test("the webhook form sends an explicit scope: a chosen kind and only that kind's value", async () => {
  const workflow = await loadWorkflowModule("features/webhooks/workflow.ts");
  const form = { ...workflow.emptyWebhookForm, url: "https://hooks.example.com/lcc" };
  // A new endpoint starts with no scope; the operator must choose one.
  assert.equal(workflow.emptyWebhookForm.scope_kind, "");
  assert.throws(() => workflow.normalizeWebhookForm(form), /scope_kind_required/);
  assert.throws(() => workflow.normalizeWebhookForm({ ...form, scope_kind: "project", scope_project: "  " }), /scope_project_required/);
  assert.throws(() => workflow.normalizeWebhookForm({ ...form, scope_kind: "customer" }), /scope_customer_id_required/);
  // A value typed for another kind is never sent: the chosen kind decides.
  const scope = (value) => {
    const body = workflow.normalizeWebhookForm({ ...form, scope_project: "DEFAULT", scope_customer_id: "cus_1", ...value });
    return [body.scope_kind, body.scope_project, body.scope_customer_id];
  };
  assert.deepEqual(scope({ scope_kind: "global" }), ["global", "", ""]);
  assert.deepEqual(scope({ scope_kind: "project" }), ["project", "DEFAULT", ""]);
  assert.deepEqual(scope({ scope_kind: "customer" }), ["customer", "", "cus_1"]);

  assert.deepEqual(workflow.WEBHOOK_SCOPE_OPTIONS.map((option) => [option.kind, option.label]), [
    ["global", "Every event (operator-wide)"],
    ["project", "One project"],
    ["customer", "One customer"],
  ]);
  assert.equal(workflow.webhookScopeLabel({ scope_kind: "global", scope_project: null, scope_customer_id: null }), "operator-wide");
  assert.equal(workflow.webhookScopeLabel({ scope_kind: "project", scope_project: "DEFAULT", scope_customer_id: null }), "project:DEFAULT");
  assert.equal(workflow.webhookScopeLabel({ scope_kind: "customer", scope_project: null, scope_customer_id: "cus_1" }), "customer:cus_1");
});

test("an edited webhook PATCHes only what changed, and its scope as a whole", async () => {
  const workflow = await loadWorkflowModule("features/webhooks/workflow.ts");
  const baseline = workflow.webhookFormFromEndpoint({
    id: "wh_1", url: "https://hooks.example.com/lcc", event_types: "create", status: "active", description: "",
    scope_kind: "project", scope_project: "DEFAULT", scope_customer_id: null, created_at: 1, updated_at: 1,
  });
  assert.deepEqual(baseline, { url: "https://hooks.example.com/lcc", event_types: "create", description: "", scope_kind: "project", scope_project: "DEFAULT", scope_customer_id: "" });
  assert.deepEqual(workflow.normalizeWebhookPatch(baseline, baseline), {});
  assert.deepEqual(workflow.normalizeWebhookPatch({ ...baseline, event_types: "create,update" }, baseline), { event_types: "create,update" });
  // Moving to another kind names the kind and both values, so the old value is cleared.
  assert.deepEqual(
    workflow.normalizeWebhookPatch({ ...baseline, scope_kind: "customer", scope_customer_id: "cus_1" }, baseline),
    { scope_kind: "customer", scope_project: "", scope_customer_id: "cus_1" },
  );
  assert.deepEqual(
    workflow.normalizeWebhookPatch({ ...baseline, scope_project: "OTHER" }, baseline),
    { scope_kind: "project", scope_project: "OTHER", scope_customer_id: "" },
  );
  assert.deepEqual(
    workflow.normalizeWebhookPatch({ ...baseline, scope_kind: "global" }, baseline),
    { scope_kind: "global", scope_project: "", scope_customer_id: "" },
  );
});

test("disable-webhook confirm copy echoes the endpoint URL and clarifies queued deliveries", async () => {
  const workflow = await loadWorkflowModule("features/webhooks/workflow.ts");
  const copy = workflow.disableWebhookConfirm({ url: "https://hooks.example.com/lcc" });
  assert.match(copy, /Disable webhook endpoint https:\/\/hooks\.example\.com\/lcc/);
  assert.match(copy, /queued or failed deliveries already recorded are unaffected/);
});

// "Send test event": the backend reports only a status class. The operator sees a sentence; the
// code and request id stay under Technical details, and an unknown code never becomes the text.
function uiEnvelope(httpStatus, body) {
  return Object.defineProperties({ ...body }, {
    __httpOk: { value: httpStatus >= 200 && httpStatus < 300, enumerable: false },
    __httpStatus: { value: httpStatus, enumerable: false },
    __rawBody: { value: body, enumerable: false },
  });
}

test("webhook test path encodes the endpoint id", async () => {
  const testEvent = await loadWorkflowModule("features/webhooks/testEvent.ts");
  assert.equal(testEvent.webhookTestPath("wh_1"), "/api/admin/webhooks/wh_1/test");
  assert.equal(testEvent.webhookTestPath("wh/1 x"), "/api/admin/webhooks/wh%2F1%20x/test");
});

test("each status class becomes a sentence that names the class, with the request id kept as a detail", async () => {
  const testEvent = await loadWorkflowModule("features/webhooks/testEvent.ts");
  const expected = {
    "2xx": ["success", /^The endpoint answered with a 2xx success\./],
    "3xx": ["warning", /^The endpoint answered with a 3xx redirect\. Deliveries never follow redirects/],
    "4xx": ["warning", /^The endpoint answered with a 4xx client error\./],
    "5xx": ["warning", /^The endpoint answered with a 5xx server error\./],
    network_error: ["warning", /^The endpoint could not be reached, or did not answer within 5 seconds\./],
  };
  for (const [statusClass, [tone, sentence]] of Object.entries(expected)) {
    const outcome = testEvent.webhookTestOutcome(uiEnvelope(200, { ok: true, code: "webhook_test_sent", request_id: "rid-1", data: { status_class: statusClass } }));
    assert.equal(outcome.tone, tone, statusClass);
    assert.match(outcome.sentence, sentence);
    assert.equal(outcome.code, "webhook_test_sent");
    assert.equal(outcome.requestId, "rid-1");
    assert.equal(outcome.sentence.includes("rid-1"), false);
  }
});

test("refusals get human copy; a rate limit says how long to wait", async () => {
  const testEvent = await loadWorkflowModule("features/webhooks/testEvent.ts");
  const limited = testEvent.webhookTestOutcome(uiEnvelope(429, { ok: false, code: "rate_limited", request_id: "rid-2", data: { retry_after: 42 } }));
  assert.equal(limited.tone, "error");
  assert.equal(limited.sentence, "A test event was sent to this endpoint less than a minute ago. Try again in 42 seconds.");
  assert.equal(testEvent.webhookTestOutcome(uiEnvelope(429, { ok: false, code: "rate_limited", request_id: "r", data: { retry_after: 1 } })).sentence,
    "A test event was sent to this endpoint less than a minute ago. Try again in 1 second.");
  assert.equal(testEvent.webhookTestOutcome(uiEnvelope(429, { ok: false, code: "rate_limited", request_id: "r" })).sentence,
    "A test event was sent to this endpoint less than a minute ago. Try again in a minute.");
  const copy = {
    not_found: "This endpoint no longer exists or is disabled, so no test event was sent.",
    invalid_url: "This endpoint's saved URL is no longer accepted (it must be a public https:// host name, with no IP address, credentials, or internal name like localhost or .internal), so no test event was sent. Edit the URL first.",
    webhook_signing_unconfigured: "Webhook signing is not configured on the licensing backend, so no test event was sent.",
    webhook_operator_not_configured: "Sending test events is not set up for this admin console yet. Connect it to the licensing backend first.",
    admin_role_required: "Only administrators can send test events.",
    temporarily_unavailable: "The test event could not be sent. Try again shortly.",
  };
  for (const [code, sentence] of Object.entries(copy)) {
    const outcome = testEvent.webhookTestOutcome(uiEnvelope(code === "admin_role_required" ? 403 : 503, { ok: false, code, request_id: "rid-3" }));
    assert.equal(outcome.sentence, sentence, code);
    assert.equal(outcome.tone, "error");
    assert.equal(outcome.code, code);
    assert.equal(outcome.requestId, "rid-3");
  }
});

test("an unknown code, malformed success or lost response never shows a raw code as the sentence", async () => {
  const testEvent = await loadWorkflowModule("features/webhooks/testEvent.ts");
  const unknown = testEvent.webhookTestOutcome(uiEnvelope(500, { ok: false, code: "some_new_backend_code", request_id: "rid-4" }));
  assert.equal(unknown.sentence, "The test event could not be sent. Try again shortly.");
  assert.equal(unknown.code, "some_new_backend_code");
  assert.equal(unknown.requestId, "rid-4");
  const malformed = testEvent.webhookTestOutcome(uiEnvelope(200, { ok: true, code: "webhook_test_sent", request_id: "rid-5", data: { status_class: "200" } }));
  assert.equal(malformed.tone, "error");
  assert.equal(malformed.sentence, "The test event could not be sent. Try again shortly.");
  assert.equal(malformed.code, "invalid_api_response");
  assert.equal(malformed.requestId, "rid-5");
  const lost = testEvent.webhookTestOutcome(uiEnvelope(0, {}));
  assert.equal(lost.sentence, "The test event could not be sent. Try again shortly.");
  assert.equal(lost.requestId, "missing_request_id");
});

test("each webhook validation code names the field it belongs to, and whole-form codes name none", async () => {
  const [workflow, messages] = await Promise.all([loadWorkflowModule("features/webhooks/workflow.ts"), loadWorkflowModule("shared/messages.ts")]);
  const codeFor = (patch) => {
    try {
      workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://hooks.example.com/lcc", scope_kind: "global", ...patch });
    } catch (error) {
      return error.message;
    }
    assert.fail(`${JSON.stringify(patch)} should be refused`);
  };
  const cases = [
    [{ url: "http://hooks.example.com/lcc" }, "url", "The URL must start with https://."],
    [{ url: "https://a b.example.com" }, "url", "Enter a single https:// URL without spaces."],
    [{ description: "a\nb" }, "description", "Use one line of at most 500 characters."],
    [{ scope_kind: "" }, "scope_kind", "Choose which events this endpoint receives."],
    [{ scope_kind: "project", scope_project: "" }, "scope_project", "Enter the project this endpoint receives events for."],
    [{ scope_kind: "customer", scope_customer_id: "" }, "scope_customer_id", "Enter the customer ID this endpoint receives events for."],
    [{ scope_kind: "project", scope_project: "a,b" }, "scope_project", "Enter one value of at most 128 characters, without commas or line breaks."],
    [{ scope_kind: "customer", scope_customer_id: "a\nb" }, "scope_customer_id", "Enter one value of at most 128 characters, without commas or line breaks."],
    [{ event_types: "a b" }, "event_types", "An event type can't contain spaces."],
    [{ event_types: "a,\nb" }, "event_types", "The event type list is too long or contains a line break."],
    [{ event_types: "create,bogus" }, "event_types", "One or more event types aren't recognized. Choose from the listed event types."],
  ];
  for (const [patch, field, text] of cases) {
    const code = codeFor(patch);
    assert.equal(workflow.webhookFieldForCode(code), field, code);
    assert.equal(messages.describeCode(code)?.text, text, code);
  }
  assert.equal(workflow.webhookFieldForCode("invalid_url"), "url");
  assert.equal(workflow.webhookFieldForCode("invalid_event_types"), "event_types");
  for (const code of ["invalid_request", "mutation_failed", "constructor", "definitely_not_a_code"]) {
    assert.equal(workflow.webhookFieldForCode(code), null, code);
  }
});
