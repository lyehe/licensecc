import type { LabeledComponentFragment } from "./assemble.js";
import { DEFAULT_PAGINATION_OPTIONS } from "../query.js";
import type { PaginationOptions } from "../query.js";

// ── Reusable building blocks ────────────────────────────────────────────────

// A reusable error envelope response: { ok:false, code, request_id }. The OpenAPI
// status key it is filed under tells you the HTTP code; `code` is the machine string.
export function errorResponse(description: string, ...codes: ReadonlyArray<string>): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorEnvelope" },
        ...(codes.length > 0
          ? { examples: Object.fromEntries(codes.map((code) => [code, { value: { ok: false, code, request_id: "1a2b3c-1" } } as const])) }
          : {}),
      },
    },
  };
}

// A success envelope response carrying `data` of the referenced schema.
export function okResponse(description: string, dataRef: string, ...codes: ReadonlyArray<string>): Record<string, unknown> {
  const codeSchema = codes.length === 1 ? { const: codes[0] } : { enum: codes };
  return {
    description,
    content: {
      "application/json": {
        schema: {
          allOf: [
            { $ref: "#/components/schemas/SuccessEnvelope" },
            { type: "object", properties: { code: codeSchema, data: { $ref: dataRef } } },
          ],
        },
      },
    },
  };
}

export const idempotencyKeyHeader = {
  name: "idempotency-key",
  in: "header",
  required: false,
  description: "Optional idempotency key (max 128 chars). Mutations with the same scope+key+actor are cached and replayed from D1. An invalid (over-long/empty) value returns 400 invalid_idempotency_key.",
  schema: { type: "string", maxLength: 128 },
} as const;

export const idParam = {
  name: "id",
  in: "path",
  required: true,
  description: "Resource identifier from the URL path. For entitlements this is the encoded entitlement id; for customers it is the URI-decoded customer id.",
  schema: { type: "string" },
} as const;

export const deviceKeyIdParam = {
  name: "deviceKeyId",
  in: "path",
  required: true,
  description: "The relay-resistance device key id, form `sha256:<64-hex>` (URL-encoded in the path).",
  schema: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
} as const;

export const featureKeyParam = {
  name: "featureKey",
  in: "path",
  required: true,
  description: "Catalog feature key configured on a plan.",
  schema: { type: "string", maxLength: 15 },
} as const;

export type LimitCursorOptions = PaginationOptions;

export function limitCursorParams(options: LimitCursorOptions = DEFAULT_PAGINATION_OPTIONS): ReadonlyArray<Record<string, unknown>> {
  const defaultLimit = options.defaultLimit ?? DEFAULT_PAGINATION_OPTIONS.defaultLimit;
  const maxLimit = options.maxLimit ?? DEFAULT_PAGINATION_OPTIONS.maxLimit;
  const allowEmptyValue = options.allowEmptyValue ?? true;
  const defaultWhen = allowEmptyValue ? "when omitted or empty" : "when omitted";
  const params: Array<Record<string, unknown>> = [
    {
      name: "limit",
      in: "query",
      required: false,
      allowEmptyValue,
      description: `Page size (default ${defaultLimit} ${defaultWhen}; explicit values must be safe integers from 1 through ${maxLimit}; malformed values return 400 invalid_request).`,
      schema: { type: "integer", default: defaultLimit, minimum: 1, maximum: maxLimit },
    },
  ];
  if (options.includeCursor !== false) {
    params.push({
      name: "cursor",
      in: "query",
      required: false,
      allowEmptyValue,
      description: `Non-negative safe integer offset cursor (default 0 ${defaultWhen}; use \`next_cursor\` from the previous page; malformed values return 400 invalid_request).`,
      schema: { type: "string", default: "0", pattern: "^[0-9]+$" },
    });
  }
  return params;
}

export function paginationErrorDescription(options: LimitCursorOptions = DEFAULT_PAGINATION_OPTIONS): string {
  const parameter = options.includeCursor === false ? "limit" : "limit or cursor";
  const allowEmptyValue = options.allowEmptyValue ?? true;
  const defaultRule = allowEmptyValue ? "omitted or empty values use documented defaults" : "omitted values use documented defaults";
  return `invalid ${parameter} query parameter (${defaultRule}; explicit values must be safe integers within the documented bounds).`;
}

export function invalidPaginationResponse(options: LimitCursorOptions = DEFAULT_PAGINATION_OPTIONS): Record<string, unknown> {
  const description = paginationErrorDescription(options);
  return errorResponse(`${description[0]!.toUpperCase()}${description.slice(1)}`, "invalid_request");
}

// CSV export rides the existing list path: `?format=csv` streams a text/csv attachment of
// the rows the JSON list would return (SAME filters), capped at 10000 rows. No new route.
export const formatCsvParam = {
  name: "format",
  in: "query",
  required: false,
  description: "When `csv`, the endpoint returns a text/csv attachment (Content-Disposition) of the rows the JSON list would return, using the SAME filters, capped at 10000 rows (a trailing comment row marks truncation). Omit (or any other value) for the default JSON envelope.",
  schema: { type: "string", enum: ["csv"] },
} as const;

// The shared text/csv export response documented on every list endpoint that accepts ?format=csv.
export const csvExportResponse = {
  description: "CSV export (returned only when ?format=csv). text/csv attachment of up to 10000 rows; a trailing comment row marks a truncated export.",
  content: { "text/csv": { schema: { type: "string" } } },
} as const;

export const ADMIN_SECURITY: ReadonlyArray<Record<string, ReadonlyArray<string>>> = [{ cloudflareAccess: [] }, { devBearer: [] }];
export const SYNC_SECURITY: ReadonlyArray<Record<string, ReadonlyArray<string>>> = [{ syncBearer: [] }];

// Error responses shared by every authenticated admin endpoint (the auth gate runs first).
export const ADMIN_AUTH_ERRORS = {
  "401": errorResponse("Authentication failed.", "missing_access_jwt", "admin_auth_not_configured"),
  "403": errorResponse("Authorization failed.", "invalid_access_jwt", "admin_role_denied"),
} as const;

// Error responses shared by every admin MUTATION endpoint (auth + RBAC + body limits + idempotency).
export const ADMIN_MUTATION_AUTH_ERRORS = {
  "401": errorResponse("Authentication failed.", "missing_access_jwt", "admin_auth_not_configured"),
  "403": errorResponse("Authorization failed (RBAC / invalid JWT / admin role required).", "invalid_access_jwt", "admin_role_denied", "admin_role_required"),
} as const;

export const openApiComponents: LabeledComponentFragment = {
  label: "admin-components",
  namespaces: [
    ["securitySchemes", [
      ["cloudflareAccess", {
        type: "apiKey",
        in: "header",
        name: "cf-access-jwt-assertion",
        description:
          "Cloudflare Access JWT, verified against the configured issuer/audience/JWKS. The email claim is mapped to a role via ADMIN_ACCESS_ADMIN_EMAILS / ADMIN_ACCESS_READER_EMAILS. Reads allow reader or admin; mutations require admin.",
      }],
      ["devBearer", {
        type: "http",
        scheme: "bearer",
        description:
          "Development-only bearer token (ADMIN_DEV_BEARER, gated by ADMIN_DEV_BEARER_ENABLED). Grants the admin role. Returns 500 dev_bearer_forbidden_in_environment if enabled outside ENVIRONMENT=development. Not for production use.",
      }],
      ["syncBearer", {
        type: "http",
        scheme: "bearer",
        description:
          "Bearer token for /api/sync/entitlements, compared (timing-safe) against SYNC_API_TOKEN. Independent of Cloudflare Access; no reader/admin distinction.",
      }],
    ]],
    ["schemas", [
      ["SuccessEnvelope", {
        type: "object",
        required: ["ok", "code", "request_id"],
        properties: {
          ok: { const: true },
          code: { type: "string", description: "Machine-readable success code (endpoint-specific)." },
          request_id: { type: "string", description: "From cf-ray, else a generated UUID." },
          data: { description: "Endpoint-specific payload." },
        },
      }],
      ["ErrorEnvelope", {
        type: "object",
        required: ["ok", "code", "request_id"],
        properties: {
          ok: { const: false },
          code: { type: "string", description: "Machine-readable error code." },
          request_id: { type: "string" },
        },
      }],
      ["EmptyBody", { type: "object", description: "Empty JSON object (`{}`). An empty request body is also accepted.", additionalProperties: false }],
      ["ReasonRequiredBody", {
        type: "object",

        required: ["reason"],
        properties: {
          reason: { type: "string", maxLength: 1000, description: "Required audit reason. Must not contain newlines or NUL. Empty/missing returns 400 reason_required." },
        },
      }],
      ["EntitlementInput", {
        type: "object",
        required: ["project", "feature", "license_fingerprint", "device_hash"],
        properties: {
          project: { type: "string", maxLength: 127 },
          feature: { type: "string", maxLength: 15 },
          license_fingerprint: { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "64-char hex." },
          device_hash: { type: "string", description: "64-char hex, or empty string for unbound.", oneOf: [{ pattern: "^[0-9a-fA-F]{64}$" }, { const: "" }] },
          status: { type: "string", enum: ["active", "disabled", "revoked"], default: "active" },
          assertion_ttl_seconds: { type: "integer", minimum: 1, maximum: 3600, default: 300 },
          valid_from: { type: ["integer", "null"], minimum: 0, default: null, description: "Epoch seconds; must be < valid_until when both set." },
          valid_until: { type: ["integer", "null"], minimum: 0, default: null, description: "Epoch seconds; must be > valid_from when both set." },
          notes: { type: "string", maxLength: 1000, default: "" },
          customer_id: { type: ["string", "null"], maxLength: 128, default: null },
          license_id: { type: ["string", "null"], maxLength: 128, default: null },
          policy_id: {
            type: "string",
            maxLength: 128,
            description:
              "Optional. When present (and non-empty), the entitlement is STAMPED from this policy template instead of validated directly. Requires POLICY_STAMP_MODE=on (else 400 policy_stamping_disabled); the policy must exist and be active (else 404 policy_not_found). Body fields above act as per-field overrides on the stamp.",
          },
        },
      }],
      ["EntitlementPatch", {
        type: "object",
        description: "All fields optional; only provided fields are updated. project/feature/license_fingerprint/status are NOT patchable.",
        properties: {
          device_hash: { type: "string", description: "64-char hex, or empty string." },
          assertion_ttl_seconds: { type: "integer", minimum: 1, maximum: 3600 },
          valid_from: { type: ["integer", "null"], minimum: 0 },
          valid_until: { type: ["integer", "null"], minimum: 0 },
          notes: { type: "string", maxLength: 1000 },
          customer_id: { type: ["string", "null"], maxLength: 128 },
          license_id: { type: ["string", "null"], maxLength: 128 },
        },
      }],
      ["EntitlementSyncInput", {
        allOf: [
          { $ref: "#/components/schemas/EntitlementInput" },
          { type: "object", properties: { reason: { type: "string", maxLength: 1000, description: "Optional; required (non-empty) when status is disabled or revoked." } } },
        ],
      }],
      ["PlanProjectionInput", {
        type: "object",
        required: ["project", "license_id", "license_fingerprint"],
        description:
          "Plan assignment/projection request. `plan_id` or `plan_key` is required. The plan is expanded into concrete feature entitlements; runtime checks do not read tier names.",
        properties: {
          project: { type: "string", maxLength: 127 },
          license_id: { type: "string", maxLength: 128 },
          license_fingerprint: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
          customer_id: { type: ["string", "null"], maxLength: 128 },
          plan_id: { type: ["string", "null"], maxLength: 128, description: "Catalog plan id. Required when plan_key is omitted." },
          plan_key: { type: ["string", "null"], maxLength: 128, description: "Catalog plan key. Required when plan_id is omitted." },
          support_until: { type: ["integer", "null"], minimum: 0, description: "Optional support/subscription window override stamped onto desired entitlements." },
          addons: { type: "array", maxItems: 100, items: { type: "string", maxLength: 128 }, default: [], description: "Optional add-on keys exposed by the selected plan." },
          notes: { type: "string", maxLength: 1000, default: "" },
        },
      }],
      ["PlanProjectionItem", {
        type: "object",
        properties: {
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string" },
          policy_id: { type: ["string", "null"] },
          source: { type: "string", enum: ["included", "addon"] },
          addon_key: { type: ["string", "null"] },
          license_mode: { type: "string", enum: ["trial", "floating", "node_locked"] },
          status: { type: "string", enum: ["active", "disabled", "revoked"] },
          valid_from: { type: ["integer", "null"] },
          valid_until: { type: ["integer", "null"] },
          assertion_ttl_seconds: { type: "integer" },
          pool_size: { type: "integer" },
          max_active_devices: { type: "integer" },
          max_borrow_sec: { type: "integer" },
          meter_quota: { type: "integer" },
          meter_period_sec: { type: "integer" },
          reason: { type: "string" },
          previous_status: { type: "string" },
        },
      }],
      ["PlanProjectionPreview", {
        type: "object",
        properties: {
          plan: { type: "object", additionalProperties: true },
          assignment: {
            type: "object",
            properties: {
              project: { type: "string" },
              license_id: { type: "string" },
              license_fingerprint: { type: "string" },
              customer_id: { type: ["string", "null"] },
              plan_id: { type: "string" },
              plan_key: { type: "string" },
              support_until: { type: ["integer", "null"] },
              addons: { type: "array", items: { type: "string" } },
            },
          },
          desired: { type: "array", items: { $ref: "#/components/schemas/PlanProjectionItem" } },
          will_create: { type: "array", items: { $ref: "#/components/schemas/PlanProjectionItem" } },
          will_update: { type: "array", items: { $ref: "#/components/schemas/PlanProjectionItem" } },
          will_disable: { type: "array", items: { $ref: "#/components/schemas/PlanProjectionItem" } },
          blocked: { type: "array", items: { $ref: "#/components/schemas/PlanProjectionItem" } },
          unchanged: { type: "array", items: { $ref: "#/components/schemas/PlanProjectionItem" } },
          summary: {
            type: "object",
            properties: {
              create: { type: "integer" },
              update: { type: "integer" },
              disable: { type: "integer" },
              blocked: { type: "integer" },
              unchanged: { type: "integer" },
            },
          },
        },
      }],
      ["PlanProjectionPreviewResponse", {
        allOf: [
          { $ref: "#/components/schemas/PlanProjectionPreview" },
          {
            type: "object",
            required: ["preview_id", "effective_at", "expires_at", "source_generation"],
            properties: {
              preview_id: { type: "string", description: "Opaque, short-lived server-bound preview capability. Apply accepts this value only." },
              effective_at: { type: "integer", minimum: 0, description: "Single timestamp used to derive time-relative policy fields." },
              expires_at: { type: "integer", minimum: 0 },
              source_generation: { type: "integer", minimum: 0, description: "Conservative catalog-projection dependency generation bound to this preview." },
            },
          },
        ],
      }],
      ["PlanProjectionApplyInput", {
        type: "object",
        required: ["preview_id"],
        additionalProperties: false,
        description: "Apply exactly one server-persisted preview. Catalog/form fields are intentionally not accepted here.",
        properties: {
          preview_id: { type: "string", maxLength: 128, pattern: "^ppv_[A-Za-z0-9_-]{1,124}$" },
        },
      }],
      ["PlanProjectionApplyResult", {
        allOf: [
          { $ref: "#/components/schemas/PlanProjectionPreviewResponse" },
          {
            type: "object",
            properties: {
              applied: {
                type: "object",
                properties: {
                  created: { type: "array", items: { $ref: "#/components/schemas/EntitlementRecord" } },
                  updated: { type: "array", items: { $ref: "#/components/schemas/EntitlementRecord" } },
                  disabled: { type: "array", items: { $ref: "#/components/schemas/EntitlementRecord" } },
                  assignment: { type: ["object", "null"], additionalProperties: true },
                },
              },
            },
          },
        ],
      }],
      ["CatalogFeature", {
        type: "object",
        properties: {
          id: { type: "string" },
          project: { type: "string" },
          feature_key: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          category: { type: "string" },
          status: { type: "string", enum: ["active", "disabled"] },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
        },
      }],
      ["CatalogFeatureInput", {
        type: "object",
        additionalProperties: false,
        required: ["project", "feature_key", "name"],
        properties: {
          project: { type: "string", maxLength: 127 },
          feature_key: { type: "string", maxLength: 15 },
          name: { type: "string", maxLength: 127 },
          description: { type: "string", maxLength: 1000, default: "" },
          category: { type: "string", maxLength: 127, default: "" },
          status: { type: "string", enum: ["active", "disabled"], default: "active" },
        },
      }],
      ["CatalogFeaturePatch", {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", maxLength: 127 },
          description: { type: "string", maxLength: 1000 },
          category: { type: "string", maxLength: 127 },
        },
      }],
      ["CatalogPlan", {
        type: "object",
        properties: {
          id: { type: "string" },
          project: { type: "string" },
          plan_key: { type: "string" },
          name: { type: "string" },
          status: { type: "string", enum: ["active", "disabled"] },
          version: { type: "integer" },
          description: { type: "string" },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
        },
      }],
      ["CatalogPlanInput", {
        type: "object",
        additionalProperties: false,
        required: ["project", "plan_key", "name"],
        properties: {
          project: { type: "string", maxLength: 127 },
          plan_key: { type: "string", maxLength: 128 },
          name: { type: "string", maxLength: 127 },
          status: { type: "string", enum: ["active", "disabled"], default: "active" },
          version: { type: "integer", minimum: 1, default: 1 },
          description: { type: "string", maxLength: 1000, default: "" },
        },
      }],
      ["CatalogPlanPatch", {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", maxLength: 127 },
          description: { type: "string", maxLength: 1000 },
        },
      }],
      ["CatalogPlanFeature", {
        type: "object",
        properties: {
          project: { type: "string" },
          plan_id: { type: "string" },
          plan_key: { type: "string" },
          feature_key: { type: "string" },
          feature_name: { type: "string" },
          feature_inclusion: { type: "string", enum: ["included", "addon"] },
          addon_key: { type: ["string", "null"] },
          policy_id: { type: ["string", "null"] },
          status: { type: "string", enum: ["active", "disabled"] },
          display_order: { type: "integer" },
          assertion_ttl_seconds: { type: ["integer", "null"] },
          pool_size: { type: ["integer", "null"] },
          max_active_devices: { type: ["integer", "null"] },
          max_borrow_sec: { type: ["integer", "null"] },
          meter_quota: { type: ["integer", "null"] },
          meter_period_sec: { type: ["integer", "null"] },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
        },
      }],
      ["CatalogPlanFeatureInput", {
        type: "object",
        additionalProperties: false,
        required: ["project", "feature_key"],
        properties: {
          project: { type: "string", maxLength: 127 },
          feature_key: { type: "string", maxLength: 15 },
          feature_inclusion: { type: "string", enum: ["included", "addon"], default: "included" },
          addon_key: { type: ["string", "null"], maxLength: 128 },
          policy_id: { type: ["string", "null"], maxLength: 128 },
          status: { type: "string", enum: ["active", "disabled"], default: "active" },
          display_order: { type: "integer", minimum: 0, default: 0 },
          assertion_ttl_seconds: { type: ["integer", "null"], minimum: 0 },
          pool_size: { type: ["integer", "null"], minimum: 0 },
          max_active_devices: { type: ["integer", "null"], minimum: 0 },
          max_borrow_sec: { type: ["integer", "null"], minimum: 0 },
          meter_quota: { type: ["integer", "null"], minimum: 0 },
          meter_period_sec: { type: ["integer", "null"], minimum: 0 },
        },
      }],
      ["CatalogPlanImport", {
        type: "object",
        additionalProperties: false,
        required: ["project", "plan_key", "name"],
        properties: {
          project: { type: "string", maxLength: 127 },
          plan_key: { type: "string", maxLength: 128 },
          name: { type: "string", maxLength: 127 },
          status: { type: "string", enum: ["active", "disabled"], default: "active" },
          version: { type: "integer", minimum: 1, default: 1 },
          description: { type: "string", maxLength: 1000, default: "" },
          features: { type: "array", maxItems: 500, items: { $ref: "#/components/schemas/CatalogPlanFeatureInput" } },
        },
      }],
      ["CatalogImportManifest", {
        type: "object",
        additionalProperties: false,
        required: ["features", "plans"],
        properties: {
          format_version: { type: "integer", enum: [1], default: 1 },
          features: { type: "array", maxItems: 200, items: { $ref: "#/components/schemas/CatalogFeatureInput" } },
          plans: { type: "array", maxItems: 200, items: { $ref: "#/components/schemas/CatalogPlanImport" } },
        },
      }],
      ["CatalogImportCounter", {
        type: "object",
        properties: {
          created: { type: "integer", minimum: 0 },
          updated: { type: "integer", minimum: 0 },
          unchanged: { type: "integer", minimum: 0 },
        },
      }],
      ["CatalogImportResult", {
        type: "object",
        properties: {
          features: { $ref: "#/components/schemas/CatalogImportCounter" },
          plans: { $ref: "#/components/schemas/CatalogImportCounter" },
          plan_features: { $ref: "#/components/schemas/CatalogImportCounter" },
        },
      }],
      ["EntitlementRecord", {
        type: "object",
        properties: {
          id: { type: "string", description: "Encoded entitlement id (project/feature/license_fingerprint)." },
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string" },
          device_hash: { type: "string" },
          status: { type: "string", enum: ["active", "disabled", "revoked"] },
          assertion_ttl_seconds: { type: "integer" },
          revocation_seq: { type: "integer" },
          valid_from: { type: ["integer", "null"] },
          valid_until: { type: ["integer", "null"] },
          notes: { type: "string" },
          customer_id: { type: ["string", "null"] },
          license_id: { type: ["string", "null"] },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
          policy_id: { type: ["string", "null"], description: "Advisory provenance: the policy this row was stamped from (frozen; no live link)." },
          is_trial: { type: "integer", description: "1 when stamped from a trial policy, else 0. Frozen on the row." },
          trial_expiration_basis: { type: ["string", "null"], enum: ["from_issue", "from_first_activation", "from_first_use", null] },
          trial_duration_sec: { type: "integer" },
          trial_one_per_device: { type: "integer", enum: [0, 1] },
          trial_require_device_proof: { type: "integer", enum: [0, 1] },
          trial_started_at: { type: ["integer", "null"] },
          trial_device_hash: { type: ["string", "null"] },
        },
      }],
      ["Policy", {
        type: "object",
        description: "A license-policy template (entitlement_policies row). Frozen at stamp time onto a new entitlement.",
        properties: {
          id: { type: "string" },
          project: { type: "string", maxLength: 127 },
          name: { type: "string", maxLength: 127 },
          type: { type: "string", enum: ["trial", "node_locked", "floating", "subscription"] },
          status: { type: "string", enum: ["active", "disabled"] },
          valid_from_offset_sec: { type: ["integer", "null"] },
          duration_sec: { type: ["integer", "null"] },
          assertion_ttl_seconds: { type: "integer", minimum: 1, maximum: 3600 },
          pool_size: { type: "integer", minimum: 0 },
          max_active_devices: { type: "integer", minimum: 0 },
          max_borrow_sec: { type: "integer", minimum: 0 },
          meter_quota: { type: "integer", minimum: 0, description: "Per-period consumption quota (0 = unlimited/count-only). A stamped entitlement inherits it." },
          meter_period_sec: { type: "integer", minimum: 0, description: "Rolling metering period length in seconds (0 -> the 30d default)." },
          expiry_strategy: { type: "string", enum: ["fixed_window", "non_expiring"] },
          trial_expiration_basis: { type: "string", enum: ["from_issue", "from_first_activation", "from_first_use"] },
          trial_duration_sec: { type: "integer", minimum: 0 },
          trial_one_per_device: { type: "integer", enum: [0, 1] },
          trial_require_device_proof: { type: "integer", enum: [0, 1] },
          notes: { type: "string", maxLength: 1000 },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },

        },
      }],
      ["PolicyInput", {
        type: "object",
        required: ["project", "name", "type"],
        description: "Create body. project/name/type required; every other field takes the column default. Explicit node_locked policies require pool_size=0; explicit floating policies require pool_size>0.",
        properties: {
          project: { type: "string", maxLength: 127 },
          name: { type: "string", maxLength: 127, description: "Unique per project (case-insensitive). A duplicate returns 409 policy_name_conflict." },
          type: { type: "string", enum: ["trial", "node_locked", "floating", "subscription"] },
          valid_from_offset_sec: { type: ["integer", "null"], default: null },
          duration_sec: { type: ["integer", "null"], default: null },
          assertion_ttl_seconds: { type: "integer", minimum: 1, maximum: 3600, default: 300 },
          pool_size: { type: "integer", minimum: 0, default: 0, description: "Capacity source of truth. node_locked requires 0; floating requires a value greater than 0." },
          max_active_devices: { type: "integer", minimum: 0, default: 1 },
          max_borrow_sec: { type: "integer", minimum: 0, default: 0 },
          meter_quota: { type: "integer", minimum: 0, default: 0, description: "Per-period consumption quota (0 = unlimited/count-only)." },
          meter_period_sec: { type: "integer", minimum: 0, default: 2592000, description: "Rolling metering period length in seconds." },
          expiry_strategy: { type: "string", enum: ["fixed_window", "non_expiring"], default: "fixed_window" },
          trial_expiration_basis: { type: "string", enum: ["from_issue", "from_first_activation", "from_first_use"], default: "from_issue" },
          trial_duration_sec: { type: "integer", minimum: 0, default: 0 },
          trial_one_per_device: { type: "integer", enum: [0, 1], default: 0 },
          trial_require_device_proof: { type: "integer", enum: [0, 1], default: 0 },
          notes: { type: "string", maxLength: 1000, default: "" },
        },
      }],
      ["PolicyPatch", {
        type: "object",
        description: "All fields optional; only provided fields are updated. project/name/type/status are NOT patchable (status flips only via disable/reenable). A pool_size patch must preserve the existing policy type's node_locked/floating invariant.",
        properties: {
          valid_from_offset_sec: { type: ["integer", "null"] },
          duration_sec: { type: ["integer", "null"] },
          assertion_ttl_seconds: { type: "integer", minimum: 1, maximum: 3600 },
          pool_size: { type: "integer", minimum: 0, description: "Capacity source of truth. node_locked policies cannot be patched above 0; floating policies cannot be patched to 0." },
          max_active_devices: { type: "integer", minimum: 0 },
          max_borrow_sec: { type: "integer", minimum: 0 },
          meter_quota: { type: "integer", minimum: 0, description: "Per-period consumption quota (0 = unlimited/count-only). A stamped entitlement inherits it." },
          meter_period_sec: { type: "integer", minimum: 0, description: "Rolling metering period length in seconds (0 -> the 30d default)." },
          expiry_strategy: { type: "string", enum: ["fixed_window", "non_expiring"] },
          trial_expiration_basis: { type: "string", enum: ["from_issue", "from_first_activation", "from_first_use"] },
          trial_duration_sec: { type: "integer", minimum: 0 },
          trial_one_per_device: { type: "integer", enum: [0, 1] },
          trial_require_device_proof: { type: "integer", enum: [0, 1] },
          notes: { type: "string", maxLength: 1000 },
        },
      }],
      ["WebhookEndpoint", {
        type: "object",
        description: "A webhook endpoint config row (webhook_endpoints). The signing secret is NEVER stored here — it lives only in the Worker-env WEBHOOK_SIGNING_SECRETS map.",
        properties: {
          id: { type: "string" },
          url: { type: "string", maxLength: 2048, description: "Delivery URL. Always https (a non-https URL is rejected at create/patch with 400 invalid_url)." },
          event_types: { type: "string", maxLength: 1024, description: "CSV event-type filter; empty string means all event types." },
          status: { type: "string", enum: ["active", "disabled"] },
          description: { type: "string", maxLength: 500 },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
          scope_project: { type: ["string", "null"], maxLength: 128, description: "Per-tenant scope (audit R2.2). null/'' = global; matches entitlement/order events. Set one dimension, not both." },
          scope_customer_id: { type: ["string", "null"], maxLength: 128, description: "Per-tenant scope (audit R2.2). null/'' = global; matches customer events. Set one dimension, not both." },
        },
      }],
      ["WebhookEndpointInput", {
        type: "object",
        required: ["url"],
        description: "Create body. `url` is required and MUST be https. event_types / description / scope_* take the column default ('').",
        properties: {
          url: { type: "string", maxLength: 2048, description: "https URL. A non-https or unparseable URL returns 400 invalid_url." },
          event_types: { type: "string", maxLength: 1024, default: "", description: "CSV event-type filter; '' = all." },
          description: { type: "string", maxLength: 500, default: "" },
          scope_project: { type: "string", maxLength: 128, default: "", description: "Per-tenant scope (audit R2.2). '' = global. Set one dimension, not both." },
          scope_customer_id: { type: "string", maxLength: 128, default: "", description: "Per-tenant scope (audit R2.2). '' = global. Set one dimension, not both." },
        },
      }],
      ["WebhookEndpointPatch", {
        type: "object",
        description: "All fields optional; only provided fields are updated. status / id are NOT patchable (status flips only via disable/reenable).",
        properties: {
          url: { type: "string", maxLength: 2048, description: "https URL. A non-https URL returns 400 invalid_url." },
          event_types: { type: "string", maxLength: 1024 },
          description: { type: "string", maxLength: 500 },
          scope_project: { type: "string", maxLength: 128, description: "Per-tenant scope (audit R2.2). '' clears it (global)." },
          scope_customer_id: { type: "string", maxLength: 128, description: "Per-tenant scope (audit R2.2). '' clears it (global)." },
        },
      }],
      ["WebhookDelivery", {
        type: "object",
        description: "A row in the webhook_deliveries outbox (drained by the backend cron). The payload body is not surfaced; only delivery metadata.",
        properties: {
          id: { type: "integer" },
          endpoint_id: { type: "string" },
          event_source: { type: "string", enum: ["entitlement", "customer", "order"] },
          event_id: { type: "integer" },
          event_type: { type: "string" },
          status: { type: "string", enum: ["pending", "delivered", "failed"] },
          attempts: { type: "integer" },
          last_status: { type: "integer", description: "HTTP status of the last attempt (0 if never attempted)." },
          last_error: { type: "string" },
          next_attempt_at: { type: "integer" },
          created_at: { type: "integer" },
          delivered_at: { type: ["integer", "null"] },
        },
      }],
      ["CustomerRow", {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          status: { type: "string", enum: ["active", "disabled"] },
          external_ref: { type: ["string", "null"] },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
        },
      }],
      ["CustomerListItem", {
        allOf: [
          { $ref: "#/components/schemas/CustomerRow" },
          { type: "object", properties: { entitlement_count: { type: "integer" }, active_entitlement_count: { type: "integer" } } },
        ],
      }],
      ["SummaryData", {
        type: "object",
        properties: {
          entitlements: {
            type: "object",
            properties: { total: { type: "integer" }, active: { type: "integer" }, revoked: { type: "integer" }, disabled: { type: "integer" } },
          },
        },
      }],
      ["ReportData", {
        type: "object",
        properties: {
          generated_at: { type: "integer" },
          entitlements: { type: "object", properties: { total: { type: "integer" }, active: { type: "integer" }, revoked: { type: "integer" }, disabled: { type: "integer" } } },
          customers: { type: "object", properties: { total: { type: "integer" }, active: { type: "integer" }, disabled: { type: "integer" } } },
          account_tokens: { type: "object", properties: { active: { type: "integer" } } },
          licenses: { type: "object", properties: { total: { type: "integer" } } },
          fulfillment: {
            type: "object",
            properties: {
              accepted: { type: "integer" }, processed: { type: "integer" }, superseded: { type: "integer" }, rejected: { type: "integer" },
              stale_accepted: { type: "integer" }, events_24h: { type: "integer" }, events_7d: { type: "integer" },
            },
          },
          customer_suspensions_7d: { type: "integer" },
        },
      }],
      ["SettingsData", {
        type: "object",
        properties: {
          environment: { type: "string" },
          public_verifier_url: { type: "string" },
          auth: { type: "string", enum: ["dev-bearer", "cloudflare-access"] },
        },
      }],
      ["CustomersListData", {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/CustomerListItem" } },
          next_cursor: { type: ["string", "null"] },
        },
      }],
      ["CustomerDetailData", {
        type: "object",
        properties: {
          customer: {
            type: "object",
            properties: {
              id: { type: "string" }, name: { type: "string" }, email: { type: "string" }, status: { type: "string" },
              external_ref: { type: ["string", "null"] }, metadata_json: { type: ["string", "null"] },
              created_at: { type: "integer" }, updated_at: { type: "integer" },
            },
          },
          entitlements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                project: { type: "string" }, feature: { type: "string" }, license_fingerprint: { type: "string" }, status: { type: "string" },
                valid_from: { type: ["integer", "null"] }, valid_until: { type: ["integer", "null"] }, revocation_seq: { type: "integer" }, updated_at: { type: "integer" },
              },
            },
          },
          account_tokens: {
            type: "array",
            description: "token_hmac and pepper_key_id are deliberately never returned.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, token_prefix: { type: "string" }, name: { type: "string" }, status: { type: "string" },
                scopes_json: { type: ["string", "null"] }, expires_at: { type: ["integer", "null"] }, last_used_at: { type: ["integer", "null"] }, created_at: { type: "integer" },
              },
            },
          },
          licenses: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, project: { type: "string" }, label: { type: ["string", "null"] }, created_at: { type: "integer" }, updated_at: { type: "integer" } } },
          },
          orders: {
            type: "array",
            items: {
              type: "object",
              properties: {
                subscription_id: { type: "string" }, project: { type: "string" }, feature: { type: "string" }, license_fingerprint: { type: "string" },
                last_seq: { type: "integer" }, order_epoch: { type: "integer" }, updated_at: { type: "integer" },
              },
            },
          },
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" }, event_type: { type: "string" }, prev_status: { type: ["string", "null"] }, next_status: { type: ["string", "null"] },
                actor: { type: "string" }, actor_type: { type: "string" }, reason: { type: ["string", "null"] }, created_at: { type: "integer" },
              },
            },
          },
        },
      }],
      ["LicensesListData", {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, customer_id: { type: ["string", "null"] }, project: { type: "string" }, label: { type: ["string", "null"] }, created_at: { type: "integer" }, updated_at: { type: "integer" } } },
          },
          next_cursor: { type: ["string", "null"] },
        },
      }],
      ["OrdersListData", {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                event_id: { type: "string" }, subscription_id: { type: "string" }, project: { type: "string" }, feature: { type: "string" },
                order_epoch: { type: "integer" }, seq: { type: "integer" }, intent: { type: "string" }, key_id: { type: ["string", "null"] }, status: { type: "string" },
                received_at: { type: "integer" }, processed_at: { type: ["integer", "null"] }, stale: { type: "boolean" },
              },
            },
          },
          summary: {
            type: "object",
            properties: { accepted: { type: "integer" }, processed: { type: "integer" }, superseded: { type: "integer" }, rejected: { type: "integer" }, stale_accepted: { type: "integer" } },
          },
          stale_secs: { type: "integer" },
          next_cursor: { type: ["string", "null"] },
        },
      }],
      ["EntitlementsListData", {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/EntitlementRecord" } },
          next_cursor: { type: ["string", "null"] },
        },
      }],
      ["PoliciesListData", {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/Policy" } },
          next_cursor: { type: ["string", "null"] },
        },
      }],
      ["CatalogFeaturesListData", {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/CatalogFeature" } },
          next_cursor: { type: ["string", "null"] },
        },
      }],
      ["CatalogPlansListData", {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/CatalogPlan" } },
          next_cursor: { type: ["string", "null"] },
        },
      }],
      ["CatalogPlanFeaturesListData", {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/CatalogPlanFeature" } },
        },
      }],
      ["WebhooksListData", {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/WebhookEndpoint" } },
          next_cursor: { type: ["string", "null"] },
        },
      }],
      ["WebhookDeliveriesListData", {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/WebhookDelivery" } },
          next_cursor: { type: ["string", "null"] },
        },
      }],
      ["WebhookDetailData", {
        type: "object",
        properties: {
          endpoint: { $ref: "#/components/schemas/WebhookEndpoint" },
          deliveries: { type: "array", items: { $ref: "#/components/schemas/WebhookDelivery" }, description: "The endpoint's 50 most-recent deliveries (newest first)." },
        },
      }],
      ["EventsListData", {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" }, project: { type: "string" }, feature: { type: "string" }, license_fingerprint: { type: "string" },
                event_type: { type: "string" }, status: { type: "string" }, revocation_seq: { type: "integer" }, actor: { type: "string" }, actor_type: { type: "string" },
                source: { type: "string" }, request_id: { type: "string" }, reason: { type: ["string", "null"] }, created_at: { type: "integer" },
              },
            },
          },
        },
      }],
      ["BatchTransitionInput", {
        type: "object",
        required: ["action", "ids"],
        description: "Bulk transition body. `reason` is required (non-empty) for disable/revoke. `ids` is the encoded entitlement ids (1..100).",
        properties: {
          action: { type: "string", enum: ["disable", "reenable", "revoke"] },
          reason: { type: "string", maxLength: 1000, description: "Required (non-empty) for disable/revoke; ignored for reenable." },
          ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", description: "Encoded entitlement id." } },
        },
      }],
      ["BatchResultData", {
        type: "object",
        properties: {
          results: {
            type: "array",
            description: "One entry per input id (in input order). `ok:false` rows carry a per-row failure code (not_found, revoked_entitlement_is_terminal, invalid_entitlement_id, mutation_failed).",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                ok: { type: "boolean" },
                code: { type: "string", description: "Per-row success or failure code." },
              },
            },
          },

        },
      }],
      ["SearchData", {
        type: "object",
        properties: {
          results: {
            type: "array",
            description: "Mixed-type results across customers/licenses/entitlements/orders. `type` + `id` let the UI deep-link.",
            items: {
              type: "object",
              required: ["type", "id", "label"],
              properties: {
                type: { type: "string", enum: ["customer", "license", "entitlement", "order"] },
                id: { type: "string", description: "Deep-link key: customer id, license id, encoded entitlement id, or subscription id." },
                label: { type: "string" },
                project: { type: "string" },
                feature: { type: "string" },
                license_fingerprint: { type: "string" },
                email: { type: "string" },
                status: { type: "string" },
                external_ref: { type: ["string", "null"] },
                customer_id: { type: ["string", "null"] },
              },
            },
          },
        },
      }],
      ["TimeseriesData", {
        type: "object",
        description:
          "Bucketed usage-analytics over [from,to). `buckets` is a dense, fixed-length array (zero-filled gaps); each bucket aggregates usage_events (by ts) + order_events (by received_at).",
        properties: {
          from: { type: "integer", description: "Window start (epoch seconds)." },
          to: { type: "integer", description: "Window end (epoch seconds, exclusive)." },
          bucket_seconds: { type: "integer", description: "Nominal bucket width; the last bucket absorbs any integer remainder of the span." },
          buckets: {
            type: "array",
            items: {
              type: "object",
              required: ["start", "checkouts", "releases", "denials", "denial_rate", "fulfillment_events"],
              properties: {
                start: { type: "integer", description: "Bucket start (epoch seconds)." },
                checkouts: { type: "integer", description: "usage_events event_type='checkout' in this bucket." },
                releases: { type: "integer", description: "usage_events event_type IN ('release','reclaim') in this bucket." },
                denials: { type: "integer", description: "usage_events event_type='denied' in this bucket." },
                denial_rate: { type: "number", description: "denials / (checkouts + denials); 0 when the bucket saw no attempts (the upsell signal)." },
                fulfillment_events: { type: "integer", description: "order_events received_at in this bucket." },
              },
            },
          },
        },
      }],
      ["AuditChainData", {
        type: "object",
        properties: {
          audit_chain: {
            type: "object",
            required: ["ok", "checked"],
            properties: {
              ok: { type: "boolean", description: "True when the hash chain over entitlement_events verifies intact." },
              checked: { type: "integer", description: "Number of digest segments verified." },
              brokenAt: { type: "integer", description: "audit_digests.id of the segment that diverged (present when ok=false)." },
              reason: { type: "string", description: "prev_digest_mismatch | event_count_mismatch | digest_mismatch (present when ok=false)." },
            },
          },
        },
      }],
      ["ExpiringData", {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["project", "feature", "license_fingerprint", "valid_until", "days_left"],
              properties: {
                project: { type: "string" },
                feature: { type: "string" },
                license_fingerprint: { type: "string" },
                customer_id: { type: ["string", "null"] },
                valid_until: { type: "integer", description: "Epoch seconds the entitlement expires at." },
                days_left: { type: "integer", description: "ceil((valid_until - now)/86400); >=1 for a still-future expiry." },
              },
            },
          },
          next_cursor: { type: ["string", "null"] },
        },
      }],
      ["ReleaseSeatsData", {
        type: "object",
        required: ["released", "seat_ids"],
        properties: {
          released: { type: "integer", description: "Count of LIVE seats reclaimed (0 is a valid idempotent success)." },
          seat_ids: { type: "array", items: { type: "string" }, description: "The reclaimed seat_ids (sorted)." },
        },
      }],
      ["EntitlementDevice", {
        type: "object",
        description: "A registered relay-resistance device key (entitlement_devices). The public key is not surfaced here.",
        required: ["project", "feature", "license_fingerprint", "device_key_id", "status", "created_at", "updated_at"],
        properties: {
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string" },
          device_key_id: { type: "string", description: "sha256:<64-hex>." },
          status: { type: "string", enum: ["active", "revoked", "disabled"] },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
          last_seen_at: { type: ["integer", "null"], description: "Last time this device presented a valid request proof (null if never)." },
          notes: { type: "string" },
        },
      }],
      ["DevicesListData", {
        type: "object",
        required: ["items"],
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/EntitlementDevice" }, description: "The entitlement's device keys, newest-touched first (max 200)." },
        },
      }],
      ["MeterStatusData", {
        type: "object",
        required: ["meter_quota", "meter_period_sec", "period_start", "period_end", "units_consumed", "server_time"],
        properties: {
          meter_quota: { type: "integer", description: "Per-period quota (0 = unlimited/count-only)." },
          meter_period_sec: { type: "integer", description: "Rolling period length in seconds." },
          period_start: { type: "integer", description: "Unix seconds; start of the current period." },
          period_end: { type: "integer", description: "Unix seconds; period_start + meter_period_sec." },
          units_consumed: { type: "integer", description: "Units consumed in the current period (0 if none yet). Reading this does NOT increment it." },
          server_time: { type: "integer" },
        },
      }],
    ]],
  ],
};
