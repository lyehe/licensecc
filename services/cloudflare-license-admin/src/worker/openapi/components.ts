import { entitlementRecordSchema, entitlementCreateSchema, entitlementPatchSchema, entitlementSyncSchema } from "./entitlement-schema.js";
import { customerRowSchema } from "./customer-schema.js";
import type { LabeledComponentFragment } from "./assemble.js";
import {
  CATALOG_IMPORT_MAX_MUTABLE_ACTIONS,
  CATALOG_IMPORT_TOO_LARGE_GUIDANCE,
} from "@licensecc/licensing-domain/catalog/import_preview";
import { ENTITLEMENT_BATCH_MAX_IDS, ENTITLEMENT_BATCH_TOO_LARGE_CODE, ENTITLEMENT_BATCH_TOO_LARGE_GUIDANCE, MAX_DEVICE_LIMIT } from "../../shared/api.js";
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

export interface TransitionDataContract {
  /** Identity and transition-evidence fields the real handler always emits. */
  readonly required: readonly string[];
  /** The concrete state reached by a simple status transition, when the response emits one. */
  readonly expectedStatus?: string;
}

export function successResponse(
  description: string,
  dataSchema: Record<string, unknown>,
  codes: ReadonlyArray<string>,
): Record<string, unknown> {
  const codeSchema = codes.length === 1 ? { const: codes[0] } : { enum: codes };
  return {
    description,
    content: {
      "application/json": {
        schema: {
          allOf: [
            { $ref: "#/components/schemas/SuccessEnvelope" },
            {
              type: "object",
              required: ["data"],
              properties: { code: codeSchema, data: dataSchema },
            },
          ],
        },
      },
    },
  };
}

// The import capacity response carries required operational data. Its normal
// conflicts explicitly exclude that code, making the documented `oneOf`
// mutually exclusive instead of a generic ErrorEnvelope overlap.
export function catalogImportConflictResponse(description: string, ...codes: ReadonlyArray<string>): Record<string, unknown> {
  const ordinaryCodes = codes.filter((code) => code !== "catalog_import_too_large" && code !== "invalid_plan_config");
  return {
    description,
    content: {
      "application/json": {
        schema: {
          oneOf: [
            {
              allOf: [
                { $ref: "#/components/schemas/ErrorEnvelope" },
                {
                  type: "object",
                  required: ["code"],
                  properties: { code: { enum: ordinaryCodes } },
                },
              ],
            },
            { $ref: "#/components/schemas/CatalogImportInvalidPlanConfigError" },
            { $ref: "#/components/schemas/CatalogImportTooLargeError" },
          ],
        },
        examples: Object.fromEntries(codes.map((code) => [code, {
          value: code === "catalog_import_too_large"
            ? {
              ok: false,
              code,
              request_id: "1a2b3c-1",
              data: {
                max_mutable_actions: CATALOG_IMPORT_MAX_MUTABLE_ACTIONS,
                guidance: CATALOG_IMPORT_TOO_LARGE_GUIDANCE,
              },
            }
            : code === "invalid_plan_config"
              ? { ok: false, code, request_id: "1a2b3c-1", data: { policy_id: "policy_example" } }
            : { ok: false, code, request_id: "1a2b3c-1" },
        }])),
      },
    },
  };
}

// The entitlement batch capacity response is a public operation contract, not
// a generic `too_many` error: callers get the stable cap and recovery guidance
// before any D1 work has started. Exclude it from the generic envelope branch
// so the OpenAPI oneOf remains mutually exclusive.
export function entitlementBatchTooLargeResponse(description: string, ...codes: ReadonlyArray<string>): Record<string, unknown> {
  const ordinaryCodes = codes.filter((code) => code !== ENTITLEMENT_BATCH_TOO_LARGE_CODE);
  return {
    description,
    content: {
      "application/json": {
        schema: {
          oneOf: [
            {
              allOf: [
                { $ref: "#/components/schemas/ErrorEnvelope" },
                {
                  type: "object",
                  required: ["code"],
                  properties: { code: { enum: ordinaryCodes } },
                },
              ],
            },
            { $ref: "#/components/schemas/EntitlementBatchTooLargeError" },
          ],
        },
        examples: Object.fromEntries(codes.map((code) => [code, {
          value: code === ENTITLEMENT_BATCH_TOO_LARGE_CODE
            ? {
              ok: false,
              code,
              request_id: "1a2b3c-1",
              data: {
                max_ids: ENTITLEMENT_BATCH_MAX_IDS,
                guidance: ENTITLEMENT_BATCH_TOO_LARGE_GUIDANCE,
              },
            }
            : { ok: false, code, request_id: "1a2b3c-1" },
        }])),
      },
    },
  };
}

// A success envelope response carrying `data` of the referenced schema. `data` is deliberately
// required at the operation level: `envelope()` also serves error responses and keeps data optional.
export function okResponse(description: string, dataRef: string, ...codes: ReadonlyArray<string>): Record<string, unknown> {
  return successResponse(description, { $ref: dataRef }, codes);
}

// A state-transition success has to prove more than `{ ok: true }`: require the stable identity
// fields plus the state/evidence that the real handler returns. This remains operation-local so a
// read or create response is not tightened beyond its own runtime behavior.
export function transitionOkResponse(
  description: string,
  dataRef: string,
  contract: TransitionDataContract,
  ...codes: ReadonlyArray<string>
): Record<string, unknown> {
  const required = contract.expectedStatus === undefined
    ? [...contract.required]
    : [...new Set([...contract.required, "status"])];
  const evidence = {
    type: "object",
    required,
    ...(contract.expectedStatus === undefined ? {} : { properties: { status: { const: contract.expectedStatus } } }),
  };
  return successResponse(description, { allOf: [{ $ref: dataRef }, evidence] }, codes);
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

// The precondition every grant mutation requires, shared by paths/entitlements.ts and BatchTransitionInput below.
export const EXPECTED_ENTITLEMENT_PROPERTIES = { expected_customer_id: { type: "string", minLength: 1, maxLength: 128, description: "The owner observed on the grant. Every grant has a real one, so null or an empty, blank or padded value returns 400 invalid_request." }, expected_revocation_seq: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } };

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
        required: ["project", "feature", "license_fingerprint"],
        description: "The grant fields a create and a sync share. Each route refuses a body naming any field it does not read with 400 invalid_request.",
        properties: {
          project: { type: "string", maxLength: 127 },
          feature: { type: "string", maxLength: 15 },
          license_fingerprint: { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "64-char hex." },
          status: { type: "string", enum: ["active", "disabled", "revoked"], default: "active" },
          valid_from: { type: ["integer", "null"], minimum: 0, default: null, description: "Epoch seconds; must be < valid_until when both set." },
          valid_until: { type: ["integer", "null"], minimum: 0, default: null, description: "Epoch seconds; must be > valid_from when both set." },
          notes: { type: "string", maxLength: 1000, default: "" },
          customer_id: { type: "string", minLength: 1, maxLength: 128, description: "The customer who owns the grant. Every grant has a real one; a body naming none, or null or an empty, blank or padded value, returns 400 invalid_request." },
          license_id: { type: ["string", "null"], maxLength: 128, default: null },
        },
      }],
      ["EntitlementPatch", entitlementPatchSchema],
      ["EntitlementSyncInput", entitlementSyncSchema],
      ["PlanProjectionInput", {
        type: "object",
        required: ["project", "license_id", "license_fingerprint"],
        description:
          "Plan assignment/projection request. `plan_id` or `plan_key` is required. The plan is expanded into concrete feature entitlements; runtime checks do not read tier names.",
        properties: {
          project: { type: "string", maxLength: 127 },
          license_id: { type: "string", maxLength: 128 },
          license_fingerprint: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
          customer_id: { type: ["string", "null"], maxLength: 128, description: "The license's owner. Every grant needs one: without it, Preview blocks each grant it would write (reason owner_required) and Apply returns 400 invalid_request." },
          plan_id: { type: ["string", "null"], maxLength: 128, description: "Catalog plan id. Required when plan_key is omitted." },
          plan_key: { type: ["string", "null"], maxLength: 128, description: "Catalog plan key. Required when plan_id is omitted." },
          support_until: { type: ["integer", "null"], minimum: 0, maximum: 253_402_300_799, description: "Optional support/subscription window override stamped onto desired entitlements. Must be a safe epoch second no later than 9999-12-31T23:59:59Z." },
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
          license_mode: { type: "string", enum: ["trial", "node_locked"], description: "Every grant is protected: a trial or node-locked." },
          status: { type: "string", enum: ["active", "disabled", "revoked"] },
          valid_from: { type: ["integer", "null"] },
          valid_until: { type: ["integer", "null"] },
          max_active_devices: { type: "integer", description: "Device limit: a protected grant's only capacity." },
          reason: { type: "string", description: "A blocked item's reason: revoked_entitlement (a revoked grant is terminal; Apply returns 409 plan_projection_blocked) or owner_required (the input names no customer; Apply returns 400 invalid_request). A disabled item names not_in_plan." },
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
          max_active_devices: { type: ["integer", "null"], description: "Device limit override; null takes the limit from the policy (or 1 without one)." },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
        },
      }],
      ["CatalogPlanFeatureInput", {
        type: "object",
        additionalProperties: false,
        description: "A plan feature grants a protected grant its device limit, directly or through its policy. A body naming any other field (a seat pool, borrowing, a meter or an assertion TTL) returns 400 invalid_request.",
        required: ["project", "feature_key"],
        properties: {
          project: { type: "string", maxLength: 127 },
          feature_key: { type: "string", maxLength: 15 },
          feature_inclusion: { type: "string", enum: ["included", "addon"], default: "included" },
          addon_key: { type: ["string", "null"], maxLength: 128 },
          policy_id: { type: ["string", "null"], maxLength: 128 },
          status: { type: "string", enum: ["active", "disabled"], default: "active" },
          display_order: { type: "integer", minimum: 0, default: 0 },
          max_active_devices: { type: ["integer", "null"], minimum: 0, maximum: MAX_DEVICE_LIMIT },
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
      ["CatalogImportEffectTarget", {
        type: "object",
        required: ["entity", "project"],
        properties: {
          entity: { type: "string", enum: ["feature", "plan", "plan_feature"] },
          project: { type: "string" },
          feature_key: { type: "string" },
          plan_key: { type: "string" },
          plan_id: { type: "string" },
        },
      }],
      ["CatalogImportEffect", {
        type: "object",
        required: ["target", "effect", "before", "after"],
        properties: {
          target: { $ref: "#/components/schemas/CatalogImportEffectTarget" },
          effect: { type: "string", enum: ["create", "update", "disable", "reenable", "unchanged"] },
          before: { type: ["object", "null"], additionalProperties: true },
          after: { type: "object", additionalProperties: true },
        },
      }],
      ["CatalogImportEffectCounter", {
        type: "object",
        required: ["create", "update", "disable", "reenable", "unchanged"],
        properties: {
          create: { type: "integer", minimum: 0 },
          update: { type: "integer", minimum: 0 },
          disable: { type: "integer", minimum: 0 },
          reenable: { type: "integer", minimum: 0 },
          unchanged: { type: "integer", minimum: 0 },
        },
      }],
      ["CatalogImportEffects", {
        type: "object",
        required: ["features", "plans", "plan_features", "summary"],
        properties: {
          features: { type: "array", items: { $ref: "#/components/schemas/CatalogImportEffect" } },
          plans: { type: "array", items: { $ref: "#/components/schemas/CatalogImportEffect" } },
          plan_features: { type: "array", items: { $ref: "#/components/schemas/CatalogImportEffect" } },
          summary: {
            type: "object",
            required: ["features", "plans", "plan_features"],
            properties: {
              features: { $ref: "#/components/schemas/CatalogImportEffectCounter" },
              plans: { $ref: "#/components/schemas/CatalogImportEffectCounter" },
              plan_features: { $ref: "#/components/schemas/CatalogImportEffectCounter" },
            },
          },
        },
      }],
      ["CatalogImportTooLargeData", {
        type: "object",
        additionalProperties: false,
        required: ["max_mutable_actions", "guidance"],
        properties: {
          max_mutable_actions: { const: CATALOG_IMPORT_MAX_MUTABLE_ACTIONS },
          guidance: { const: CATALOG_IMPORT_TOO_LARGE_GUIDANCE },
        },
      }],
      ["CatalogImportInvalidPlanConfigData", {
        type: "object",
        additionalProperties: false,
        required: ["policy_id"],
        properties: { policy_id: { type: "string" } },
      }],
      ["CatalogImportInvalidPlanConfigError", {
        allOf: [
          { $ref: "#/components/schemas/ErrorEnvelope" },
          {
            type: "object",
            required: ["code", "data"],
            properties: {
              code: { const: "invalid_plan_config" },
              data: { $ref: "#/components/schemas/CatalogImportInvalidPlanConfigData" },
            },
          },
        ],
      }],
      ["CatalogImportTooLargeError", {
        allOf: [
          { $ref: "#/components/schemas/ErrorEnvelope" },
          {
            type: "object",
            required: ["code", "data"],
            properties: {
              code: { const: "catalog_import_too_large" },
              data: { $ref: "#/components/schemas/CatalogImportTooLargeData" },
            },
          },
        ],
      }],
      ["CatalogImportPreviewResponse", {
        type: "object",
        required: ["preview_id", "manifest_digest", "manifest", "effects", "effective_at", "expires_at", "source_generation"],
        properties: {
          preview_id: { type: "string", maxLength: 128, pattern: "^civ_[A-Za-z0-9_-]{1,124}$", description: "Opaque, short-lived, actor-bound catalog import capability. Apply accepts this value only." },
          manifest_digest: { type: "string", pattern: "^[0-9a-f]{64}$", description: "SHA-256 digest of the normalized manifest held by the server." },
          manifest: { $ref: "#/components/schemas/CatalogImportManifest" },
          effects: { $ref: "#/components/schemas/CatalogImportEffects" },
          effective_at: { type: "integer", minimum: 0, description: "Single timestamp used for every imported catalog row and audit transition." },
          expires_at: { type: "integer", minimum: 0 },
          source_generation: { type: "integer", minimum: 0, description: "Conservative catalog generation that must still match at Apply." },
        },
      }],
      ["CatalogImportApplyInput", {
        type: "object",
        additionalProperties: false,
        required: ["preview_id"],
        description: "Apply exactly one server-persisted catalog import preview. A manifest in an Apply request is rejected with preview_required.",
        properties: {
          preview_id: { type: "string", maxLength: 128, pattern: "^civ_[A-Za-z0-9_-]{1,124}$" },
        },
      }],
      ["EntitlementRecord", entitlementRecordSchema],
      ["EntitlementCreateInput", entitlementCreateSchema],
      ["Policy", {
        type: "object",
        description: "A license-policy template (entitlement_policies row). Frozen at stamp time onto a new entitlement.",
        properties: {
          id: { type: "string" },
          project: { type: "string", maxLength: 127 },
          name: { type: "string", maxLength: 127 },
          type: { type: "string", enum: ["trial", "node_locked", "subscription"] },
          status: { type: "string", enum: ["active", "disabled"] },
          valid_from_offset_sec: { type: ["integer", "null"] },
          duration_sec: { type: ["integer", "null"] },
          max_active_devices: { type: "integer", minimum: 0, description: "Device limit the policy stamps onto a protected grant: its only capacity." },
          expiry_strategy: { type: "string", enum: ["fixed_window", "non_expiring"] },
          trial_expiration_basis: { type: "string", enum: ["from_issue", "from_first_activation", "from_first_use"] },
          trial_duration_sec: { type: "integer", minimum: 0 },
          trial_one_per_device: { type: "integer", enum: [0, 1] },
          notes: { type: "string", maxLength: 1000 },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
        },
      }],
      ["PolicyInput", {
        type: "object",
        additionalProperties: false,
        required: ["project", "name", "type"],
        description: "Create body. project/name/type required; every other field takes the column default. A policy stamps a protected grant, so a body naming any other field (a seat pool, borrowing, a meter, an assertion TTL or device proof) returns 400 invalid_request.",
        properties: {
          project: { type: "string", maxLength: 127 },
          name: { type: "string", maxLength: 127, description: "Unique per project (case-insensitive). A duplicate returns 409 policy_name_conflict." },
          type: { type: "string", enum: ["trial", "node_locked", "subscription"] },
          valid_from_offset_sec: { type: ["integer", "null"], default: null },
          duration_sec: { type: ["integer", "null"], default: null },
          max_active_devices: { type: "integer", minimum: 0, default: 1 },
          expiry_strategy: { type: "string", enum: ["fixed_window", "non_expiring"], default: "fixed_window" },
          trial_expiration_basis: { type: "string", enum: ["from_issue", "from_first_activation", "from_first_use"], default: "from_issue" },
          trial_duration_sec: { type: "integer", minimum: 0, default: 0 },
          trial_one_per_device: { type: "integer", enum: [0, 1], default: 0 },
          notes: { type: "string", maxLength: 1000, default: "" },
        },
      }],
      ["PolicyPatch", {
        type: "object",
        additionalProperties: false,
        description: "All fields optional; only provided fields are updated. project/name/type/status are NOT patchable (status flips only via disable/reenable), and a body naming them or any other field (a seat pool, borrowing, a meter, an assertion TTL or device proof) returns 400 invalid_request.",
        properties: {
          valid_from_offset_sec: { type: ["integer", "null"] },
          duration_sec: { type: ["integer", "null"] },
          max_active_devices: { type: "integer", minimum: 0 },
          expiry_strategy: { type: "string", enum: ["fixed_window", "non_expiring"] },
          trial_expiration_basis: { type: "string", enum: ["from_issue", "from_first_activation", "from_first_use"] },
          trial_duration_sec: { type: "integer", minimum: 0 },
          trial_one_per_device: { type: "integer", enum: [0, 1] },
          notes: { type: "string", maxLength: 1000 },
        },
      }],
      ["WebhookEndpoint", {
        type: "object", description: "A webhook endpoint config row (webhook_endpoints). The signing secret is NEVER stored here — it lives only in the Worker-env WEBHOOK_SIGNING_SECRETS map.",
        properties: {
          id: { type: "string" },
          url: { type: "string", maxLength: 2048, description: "Delivery URL. Must be https on a public host name; a URL rejected by that rule is refused at create/patch with 400 invalid_url (see WebhookEndpointInput.url)." },
          event_types: { type: "string", maxLength: 1024, description: "CSV filter of known event types; empty string means all event types." },
          status: { type: "string", enum: ["active", "disabled"] },
          description: { type: "string", maxLength: 500 },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
          scope_kind: { type: "string", enum: ["global", "project", "customer"], description: "Which events the endpoint receives: global = every event (operator-wide); project = only the entitlement/order events of scope_project; customer = only the customer events of scope_customer_id." },
          scope_project: { type: ["string", "null"], maxLength: 128, description: "The project a project-scoped endpoint receives events for; null for every other kind." },
          scope_customer_id: { type: ["string", "null"], maxLength: 128, description: "The customer a customer-scoped endpoint receives events for; null for every other kind." },
        },
      }],
      ["WebhookEndpointInput", {
        type: "object", additionalProperties: false, required: ["url", "scope_kind"],
        description: "Create body. `url` (https) and `scope_kind` are required; a body without scope_kind, whose scope values do not match its kind, or naming any other field returns 400 invalid_request. event_types / description take the column default ('').",
        properties: {
          url: { type: "string", maxLength: 2048, description: "One https:// URL on a public host name: no username or password, no IP-literal host, no single-label or internal host name (localhost, .local, .internal, .home.arpa), and no trailing dot. A URL that fails this rule, or cannot be parsed, returns 400 invalid_url." },
          event_types: { type: "string", maxLength: 1024, default: "", description: "CSV event-type filter; '' = all. Each token must be one of the entitlement/customer/order event types the dispatcher actually emits (else 400 invalid_event_types with data.allowed)." },
          description: { type: "string", maxLength: 500, default: "" },
          scope_kind: { type: "string", enum: ["global", "project", "customer"], description: "global names no scope value; project requires scope_project; customer requires scope_customer_id." },
          scope_project: { type: "string", maxLength: 128, default: "", description: "Required for scope_kind project; must be absent or '' for every other kind." },
          scope_customer_id: { type: "string", maxLength: 128, default: "", description: "Required for scope_kind customer; must be absent or '' for every other kind." },
        },
      }],
      ["WebhookEndpointPatch", {
        type: "object", additionalProperties: false, description: "All fields optional; only provided fields are updated. status / id (or any other field) are NOT patchable (status flips only via disable/reenable). The row the PATCH leaves must still name a valid scope (else 400 invalid_request) and only known event types, including a stored event_types value the PATCH leaves out (else 400 invalid_event_types).",
        properties: {
          url: { type: "string", maxLength: 2048, description: "One https:// URL on a public host name: no username or password, no IP-literal host, no single-label or internal host name (localhost, .local, .internal, .home.arpa), and no trailing dot. A URL that fails this rule, or cannot be parsed, returns 400 invalid_url." },
          event_types: { type: "string", maxLength: 1024, description: "CSV event-type filter; '' = all. Each token must be one of the entitlement/customer/order event types the dispatcher actually emits (else 400 invalid_event_types with data.allowed)." },
          description: { type: "string", maxLength: 500 },
          scope_kind: { type: "string", enum: ["global", "project", "customer"], description: "Moving to another kind requires sending the old kind's value as '' in the same PATCH; otherwise 400 invalid_request." },
          scope_project: { type: "string", maxLength: 128, description: "'' clears it." },
          scope_customer_id: { type: "string", maxLength: 128, description: "'' clears it." },
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
      ["CustomerRow", customerRowSchema],
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
              login_email: { type: ["string", "null"], description: "Password login address; not proof of email ownership." },
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
                source: { type: "string" }, request_id: { type: "string" }, reason: { type: ["string", "null"] }, detail: { type: "string" }, created_at: { type: "integer" },
              },
            },
          },
          next_cursor: { type: ["string", "null"], description: "Opaque keyset page token; pass back as `cursor` for the next page. null on the last page." },
        },
      }],
      ["BatchTransitionInput", {
        type: "object", required: ["action", "rows"],
        description: `Bulk transition body. \`reason\` is required (non-empty) for disable/revoke. \`rows\` names the entitlements to transition (1..${ENTITLEMENT_BATCH_MAX_IDS}), each with the same owner/revocation-sequence precondition the single-row routes require; a larger batch is rejected before any D1 query or mutation, with recovery guidance in the error data.`,
        properties: {
          action: { type: "string", enum: ["disable", "reenable", "revoke"] },
          reason: { type: "string", maxLength: 1000, description: "Required (non-empty) for disable/revoke; ignored for reenable." },
          rows: { type: "array", minItems: 1, maxItems: ENTITLEMENT_BATCH_MAX_IDS, items: {
            type: "object", required: ["id", "expected_customer_id", "expected_revocation_seq"], description: "One entitlement to transition, with the precondition observed for it.", properties: { id: { type: "string", description: "Encoded entitlement id." }, ...EXPECTED_ENTITLEMENT_PROPERTIES },
          } },
        },
      }],
      ["EntitlementBatchTooLargeData", {
        type: "object",
        additionalProperties: false,
        required: ["max_ids", "guidance"],
        properties: {
          max_ids: { const: ENTITLEMENT_BATCH_MAX_IDS },
          guidance: { const: ENTITLEMENT_BATCH_TOO_LARGE_GUIDANCE },
        },
      }],
      ["EntitlementBatchTooLargeError", {
        allOf: [
          { $ref: "#/components/schemas/ErrorEnvelope" },
          {
            type: "object",
            required: ["code", "data"],
            properties: {
              code: { const: ENTITLEMENT_BATCH_TOO_LARGE_CODE },
              data: { $ref: "#/components/schemas/EntitlementBatchTooLargeData" },
            },
          },
        ],
      }],
      ["BatchResultData", {
        type: "object",
        required: ["results"],
        properties: {
          results: {
            type: "array",
            minItems: 1,
            description: "One entry per input id (in input order). `ok:false` rows carry a per-row failure code (not_found, revoked_entitlement_is_terminal, stale_transition, invalid_entitlement_id, mutation_failed).",
            items: {
              type: "object",
              required: ["id", "ok", "code"],
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
          "Refused connections and fulfillment events bucketed over [from,to). `buckets` is a dense, fixed-length array (zero-filled gaps); each bucket counts the protected device-limit refusals (device_bound_denials by ts) and order_events (by received_at), and nothing else.",
        properties: {
          from: { type: "integer", description: "Window start (epoch seconds)." },
          to: { type: "integer", description: "Window end (epoch seconds, exclusive)." },
          bucket_seconds: { type: "integer", description: "Nominal bucket width; the last bucket absorbs any integer remainder of the span." },
          buckets: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["start", "denials", "fulfillment_events"],
              properties: {
                start: { type: "integer", description: "Bucket start (epoch seconds)." },
                denials: { type: "integer", description: "Protected refusals in this bucket: connections refused because the grant's device limit was reached." },
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
              required: ["id", "project", "feature", "license_fingerprint", "valid_until", "days_left"],
              properties: {
                id: { type: "string", description: "The entitlement's canonical id (project+feature+license_fingerprint), for deep-linking the exact record." },
                project: { type: "string" },
                feature: { type: "string" },
                license_fingerprint: { type: "string" },
                customer_id: { type: "string" },
                customer_name: { type: ["string", "null"] },
                valid_until: { type: "integer", description: "Epoch seconds the entitlement expires at (an activated activation-basis trial reports its trial deadline here instead)." },
                days_left: { type: "integer", description: "ceil((valid_until - now)/86400); >=1 for a still-future expiry." },
              },
            },
          },
          next_cursor: { type: ["string", "null"] },
        },
      }],
    ]],
  ],
};
