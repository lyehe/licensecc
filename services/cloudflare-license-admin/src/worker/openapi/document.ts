// OpenAPI 3.1 "doc-of-existing" for the Cloudflare License Admin Worker.
// This document assembles bounded-context fragments; handler code remains the source of truth.

import { assembleComponents, assemblePaths, assertUniqueOperationIds } from "./assemble.js";
import { ADMIN_SECURITY, openApiComponents } from "./components.js";
import { catalogPaths } from "./paths/catalog.js";
import { customerPaths, searchPaths } from "./paths/customers.js";
import { devicePaths } from "./paths/devices.js";
import { entitlementPaths } from "./paths/entitlements.js";
import { metaPaths } from "./paths/meta.js";
import { policyPaths } from "./paths/policies.js";
import { settingsPaths, summaryReportPaths } from "./paths/summary-reports.js";
import { syncPaths } from "./paths/sync.js";
import { webhookPaths } from "./paths/webhooks.js";

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string; readonly description?: string };
  readonly servers: ReadonlyArray<{ readonly url: string; readonly description?: string }>;
  readonly tags?: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
  readonly security?: ReadonlyArray<Record<string, ReadonlyArray<string>>>;
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components: {
    readonly securitySchemes: Readonly<Record<string, unknown>>;
    readonly schemas: Readonly<Record<string, unknown>>;
    readonly parameters?: Readonly<Record<string, unknown>>;
    readonly responses?: Readonly<Record<string, unknown>>;
  };
}

const paths = assemblePaths(
  metaPaths,
  summaryReportPaths,
  customerPaths,
  settingsPaths,
  policyPaths,
  catalogPaths,
  webhookPaths,
  entitlementPaths,
  devicePaths,
  searchPaths,
  syncPaths,
);
assertUniqueOperationIds(paths);

export const openApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Cloudflare License Admin API",
    version: "0.1.0-rc.1",
    description:
      "Operator back-office API for managing entitlements, customers, licenses, and orders. " +
      "All /api/admin/* routes require Cloudflare Access JWT (reader or admin RBAC); mutations require the admin role. " +
      "/api/sync/entitlements uses a separate bearer token (SYNC_API_TOKEN). " +
      "Every response is the flat envelope { ok, code, request_id, data? }.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "meta", description: "Spec + docs (unauthenticated)." },
    { name: "admin:reports", description: "Aggregate reads: summary, report, settings." },
    { name: "admin:customers", description: "Customer reads and kill-switch." },
    { name: "admin:licenses", description: "License reads." },
    { name: "admin:orders", description: "Order-event reads." },
    { name: "admin:entitlements", description: "Entitlement reads, mutations, and audit events." },
    { name: "admin:policies", description: "License-policy template CRUD (frozen stamp-time templates)." },
    { name: "admin:plans", description: "Product catalog plan projection into concrete entitlement rows." },
    { name: "admin:webhooks", description: "Webhook endpoint CRUD + delivery outbox status/redrive (signing secret lives only in the env, never D1)." },
    { name: "sync", description: "External-system entitlement sync (separate bearer token)." },
  ],
  security: ADMIN_SECURITY,
  paths,
  components: assembleComponents(openApiComponents),
};

// Serialized once at module load — the /openapi.json route returns this verbatim.
export const openApiJson: string = JSON.stringify(openApiDocument);
