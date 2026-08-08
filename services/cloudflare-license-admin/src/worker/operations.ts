// Operation registry only: route groups retain their SQL, validation, and transition orchestration.
import type { Actor } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { decodeEntitlementId, entitlementId } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Env } from "./env.js";
import {
  listEntitlements,
  listEvents,
  handleMutation,
  handleBatchTransition,
  entitlementDetail,
} from "./groups/entitlements/operations.js";
import { summary, settings, report, reportTimeseries, auditVerify, reportExpiring } from "./groups/summary-reports/operations.js";
import { handleSync } from "./groups/sync/operations.js";
import {
  handlePlanProjection,
  listCatalogFeatures,
  getCatalogFeature,
  createCatalogFeature,
  patchCatalogFeature,
} from "./groups/catalog/operations.js";
import {
  transitionCatalogFeature,
  listCatalogPlans,
  getCatalogPlan,
  createCatalogPlan,
  patchCatalogPlan,
  transitionCatalogPlan,
  listCatalogPlanFeatures,
  createCatalogPlanFeature,
  transitionCatalogPlanFeature,
} from "./groups/catalog/plan-operations.js";
import {
  importCatalog,
  exportCatalogPlan,
} from "./groups/catalog/import-operations.js";
import { listCustomers, getCustomer, handleCustomerTransition, listLicenses, listOrders, globalSearch } from "./groups/customers/operations.js";
import { listPolicies, getPolicy, handlePolicyMutation } from "./groups/policies/operations.js";
import { handleReleaseSeats, handleDeviceList, handleMeterStatus, handleDeviceTransition } from "./groups/devices/operations.js";
import {
  getWebhook,
  handleWebhookMutation,
  listWebhookDeliveries,
  listWebhooks,
  validateWebhookInput,
  validateWebhookPatch,
} from "./webhooks.js";
import { validatePolicyInput, validatePolicyPatch } from "./policy_validation.js";
import { validateEntitlementInput, validateEntitlementPatch } from "./groups/entitlements/validation.js";

type BoundRun = (
  request: Request,
  env: Env,
  groups: string[],
  requestIdValue: string,
  actor: Actor,
) => Promise<Response>;

const HANDLERS: Record<string, BoundRun> = {
  "GET /api/admin/summary": (_r, env, _g, rid) => summary(env, rid),
  "GET /api/admin/report": (_r, env, _g, rid) => report(env, rid),
  "GET /api/admin/report/timeseries": (request, env, _g, rid) => reportTimeseries(request, env, rid),
  "GET /api/admin/report/expiring": (request, env, _g, rid) => reportExpiring(request, env, rid),
  "GET /api/admin/audit/verify": (_r, env, _g, rid) => auditVerify(env, rid),
  "GET /api/admin/customers": (request, env, _g, rid) => listCustomers(request, env, rid),
  "GET /api/admin/customers/{id}": (_r, env, g, rid) => getCustomer(env, decodeURIComponent(g[0] ?? ""), rid),
  "POST /api/admin/customers/{id}/disable": (request, env, g, rid, actor) => handleCustomerTransition(request, env, actor, decodeURIComponent(g[0] ?? ""), "disable", rid),
  "POST /api/admin/customers/{id}/reenable": (request, env, g, rid, actor) => handleCustomerTransition(request, env, actor, decodeURIComponent(g[0] ?? ""), "reenable", rid),
  "GET /api/admin/licenses": (request, env, _g, rid) => listLicenses(request, env, rid),
  "GET /api/admin/orders": (request, env, _g, rid) => listOrders(request, env, rid),
  "GET /api/admin/search": (request, env, _g, rid) => globalSearch(request, env, rid),
  "GET /api/admin/settings": (_r, env, _g, rid) => settings(env, rid),
  "GET /api/admin/policies": (request, env, _g, rid) => listPolicies(request, env, rid),
  "POST /api/admin/policies": (request, env, _g, rid, actor) => handlePolicyMutation(request, env, actor, rid),
  "GET /api/admin/policies/{id}": (_r, env, g, rid) => getPolicy(env, decodeURIComponent(g[0] ?? ""), rid),
  "PATCH /api/admin/policies/{id}": (request, env, _g, rid, actor) => handlePolicyMutation(request, env, actor, rid),
  "POST /api/admin/policies/{id}/disable": (request, env, _g, rid, actor) => handlePolicyMutation(request, env, actor, rid),
  "POST /api/admin/policies/{id}/reenable": (request, env, _g, rid, actor) => handlePolicyMutation(request, env, actor, rid),
  "GET /api/admin/catalog/features": (request, env, _g, rid) => listCatalogFeatures(request, env, rid),
  "POST /api/admin/catalog/features": (request, env, _g, rid, actor) => createCatalogFeature(request, env, actor, rid),
  "GET /api/admin/catalog/features/{id}": (_r, env, g, rid) => getCatalogFeature(env, decodeURIComponent(g[0] ?? ""), rid),
  "PATCH /api/admin/catalog/features/{id}": (request, env, g, rid, actor) => patchCatalogFeature(request, env, actor, decodeURIComponent(g[0] ?? ""), rid),
  "POST /api/admin/catalog/features/{id}/disable": (request, env, g, rid, actor) => transitionCatalogFeature(request, env, actor, decodeURIComponent(g[0] ?? ""), "disable", rid),
  "POST /api/admin/catalog/features/{id}/reenable": (request, env, g, rid, actor) => transitionCatalogFeature(request, env, actor, decodeURIComponent(g[0] ?? ""), "reenable", rid),
  "GET /api/admin/catalog/plans": (request, env, _g, rid) => listCatalogPlans(request, env, rid),
  "POST /api/admin/catalog/plans": (request, env, _g, rid, actor) => createCatalogPlan(request, env, actor, rid),
  "POST /api/admin/catalog/import": (request, env, _g, rid, actor) => importCatalog(request, env, actor, rid),
  "GET /api/admin/catalog/plans/{id}": (_r, env, g, rid) => getCatalogPlan(env, decodeURIComponent(g[0] ?? ""), rid),
  "PATCH /api/admin/catalog/plans/{id}": (request, env, g, rid, actor) => patchCatalogPlan(request, env, actor, decodeURIComponent(g[0] ?? ""), rid),
  "POST /api/admin/catalog/plans/{id}/disable": (request, env, g, rid, actor) => transitionCatalogPlan(request, env, actor, decodeURIComponent(g[0] ?? ""), "disable", rid),
  "POST /api/admin/catalog/plans/{id}/reenable": (request, env, g, rid, actor) => transitionCatalogPlan(request, env, actor, decodeURIComponent(g[0] ?? ""), "reenable", rid),
  "GET /api/admin/catalog/plans/{id}/export": (_r, env, g, rid) => exportCatalogPlan(env, decodeURIComponent(g[0] ?? ""), rid),
  "GET /api/admin/catalog/plans/{id}/features": (request, env, g, rid) => listCatalogPlanFeatures(request, env, decodeURIComponent(g[0] ?? ""), rid),
  "POST /api/admin/catalog/plans/{id}/features": (request, env, g, rid, actor) => createCatalogPlanFeature(request, env, actor, decodeURIComponent(g[0] ?? ""), rid),
  "POST /api/admin/catalog/plans/{id}/features/{featureKey}/disable": (request, env, g, rid, actor) => transitionCatalogPlanFeature(request, env, actor, decodeURIComponent(g[0] ?? ""), decodeURIComponent(g[1] ?? ""), "disable", rid),
  "POST /api/admin/catalog/plans/{id}/features/{featureKey}/reenable": (request, env, g, rid, actor) => transitionCatalogPlanFeature(request, env, actor, decodeURIComponent(g[0] ?? ""), decodeURIComponent(g[1] ?? ""), "reenable", rid),
  "POST /api/admin/license-plans/preview": (request, env, _g, rid, actor) => handlePlanProjection(request, env, actor, rid, "preview"),
  "POST /api/admin/license-plans/apply": (request, env, _g, rid, actor) => handlePlanProjection(request, env, actor, rid, "apply"),
  "GET /api/admin/webhooks": (request, env, _g, rid) => listWebhooks(request, env, rid),
  "POST /api/admin/webhooks": (request, env, _g, rid, actor) => handleWebhookMutation(request, env, actor, rid),
  "GET /api/admin/webhooks/deliveries": (request, env, _g, rid) => listWebhookDeliveries(request, env, rid),
  "POST /api/admin/webhooks/deliveries/{id}/redrive": (request, env, _g, rid, actor) => handleWebhookMutation(request, env, actor, rid),
  "GET /api/admin/webhooks/{id}": (_r, env, g, rid) => getWebhook(env, decodeURIComponent(g[0] ?? ""), rid),
  "PATCH /api/admin/webhooks/{id}": (request, env, _g, rid, actor) => handleWebhookMutation(request, env, actor, rid),
  "POST /api/admin/webhooks/{id}/disable": (request, env, _g, rid, actor) => handleWebhookMutation(request, env, actor, rid),
  "POST /api/admin/webhooks/{id}/reenable": (request, env, _g, rid, actor) => handleWebhookMutation(request, env, actor, rid),
  "GET /api/admin/entitlements": (request, env, _g, rid) => listEntitlements(request, env, rid),
  "POST /api/admin/entitlements": (request, env, _g, rid, actor) => handleMutation(request, env, actor, rid),
  "POST /api/admin/entitlements/batch": (request, env, _g, rid, actor) => handleBatchTransition(request, env, actor, rid),
  "POST /api/admin/entitlements/{id}/release-seats": (request, env, g, rid, actor) => handleReleaseSeats(request, env, actor, g[0] ?? "", rid),
  "GET /api/admin/entitlements/{id}": (_r, env, g, rid) => entitlementDetail(env, g[0] ?? "", rid),
  "PATCH /api/admin/entitlements/{id}": (request, env, _g, rid, actor) => handleMutation(request, env, actor, rid),
  "POST /api/admin/entitlements/{id}/disable": (request, env, _g, rid, actor) => handleMutation(request, env, actor, rid),
  "POST /api/admin/entitlements/{id}/reenable": (request, env, _g, rid, actor) => handleMutation(request, env, actor, rid),
  "POST /api/admin/entitlements/{id}/revoke": (request, env, _g, rid, actor) => handleMutation(request, env, actor, rid),
  "GET /api/admin/entitlements/{id}/devices": (_r, env, g, rid) => handleDeviceList(env, g[0] ?? "", rid),
  "GET /api/admin/entitlements/{id}/meter": (_r, env, g, rid) => handleMeterStatus(env, g[0] ?? "", rid),
  "POST /api/admin/entitlements/{id}/devices/{deviceKeyId}/revoke": (request, env, g, rid, actor) => handleDeviceTransition(request, env, actor, g[0] ?? "", g[1] ?? "", "revoke", rid),
  "POST /api/admin/entitlements/{id}/devices/{deviceKeyId}/disable": (request, env, g, rid, actor) => handleDeviceTransition(request, env, actor, g[0] ?? "", g[1] ?? "", "disable", rid),
  "POST /api/admin/entitlements/{id}/devices/{deviceKeyId}/reenable": (request, env, g, rid, actor) => handleDeviceTransition(request, env, actor, g[0] ?? "", g[1] ?? "", "reenable", rid),
  "GET /api/admin/events": (request, env, _g, rid) => listEvents(request, env, rid),
  // Served from the fetch handler via handleSync (its own auth); listed here so the binding
  // inventory equals the canonical route table. Never dispatched through handleApi's loop
  // (handleApi only sees /api/admin/ paths).
  "POST /api/sync/entitlements": (request, env) => handleSync(request, env),
};


// Kept for the OpenAPI/route inventory crosscheck. Group descriptors call invokeOperation
// directly, so this is no longer a second routing layer.
export const API_BINDING_KEYS: readonly string[] = Object.keys(HANDLERS);

export async function invokeOperation(
  key: string,
  request: Request,
  env: Env,
  groups: string[],
  requestIdValue: string,
  actor: Actor,
): Promise<Response> {
  const run = HANDLERS[key];
  if (run === undefined) {
    throw new Error(`route descriptor without operation: ${key}`);
  }
  return run(request, env, groups, requestIdValue, actor);
}

export const adminInternalsForTests = {
  entitlementId,
  decodeEntitlementId,
  validateEntitlementInput,
  validateEntitlementPatch,
  validatePolicyInput,
  validatePolicyPatch,
  validateWebhookInput,
  validateWebhookPatch,
};
