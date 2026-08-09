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
  assert.deepEqual(
    workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://hooks.example.com/lcc" }),
    { url: "https://hooks.example.com/lcc", event_types: "", description: "", scope_project: "", scope_customer_id: "" },
  );
  const scoped = workflow.normalizeWebhookForm({
    ...workflow.emptyWebhookForm,
    url: "https://hooks.example.com/lcc",
    event_types: " entitlement.revoked , , customer.disabled ",
    description: "prod alerts",
    scope_project: "DEFAULT",
  });
  assert.equal(scoped.event_types, "entitlement.revoked,customer.disabled");
  assert.equal(scoped.scope_project, "DEFAULT");
  assert.equal(scoped.scope_customer_id, "");

  assert.throws(() => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "http://x.example.com" }), /url_must_be_https/);
  assert.throws(() => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "" }), /url_must_be_a_single_https_url/);
  assert.throws(() => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://a b.example.com" }), /url_must_be_a_single_https_url/);
  assert.throws(
    () => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://x.example.com", event_types: "a b" }),
    /event_types_token_has_whitespace/,
  );
  assert.throws(
    () => workflow.normalizeWebhookForm({
      ...workflow.emptyWebhookForm,
      url: "https://x.example.com",
      scope_project: "DEFAULT",
      scope_customer_id: "cus_1",
    }),
    /scope_set_project_or_customer_not_both/,
  );
  assert.throws(
    () => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://x.example.com", description: "line1\nline2" }),
    /description_invalid/,
  );
  assert.throws(
    () => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://x.example.com", scope_project: "a\nb" }),
    /scope_project_invalid/,
  );
  assert.throws(
    () => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://x.example.com", event_types: "a,\nb" }),
    /event_types_invalid/,
  );
});

test("disable-webhook confirm copy echoes the endpoint URL and clarifies queued deliveries", async () => {
  const workflow = await loadWorkflowModule("features/webhooks/workflow.ts");
  const copy = workflow.disableWebhookConfirm({ url: "https://hooks.example.com/lcc" });
  assert.match(copy, /Disable webhook endpoint https:\/\/hooks\.example\.com\/lcc/);
  assert.match(copy, /queued or failed deliveries already recorded are unaffected/);
});
