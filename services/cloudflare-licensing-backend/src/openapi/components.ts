import type { LabeledComponentFragment } from "./assemble.js";

// ---------------------------------------------------------------------------
// Reusable error-envelope helper. Each error response is { ok:false, code:"<code>" }.
// ---------------------------------------------------------------------------
export function errorResponse(description: string, code: string | readonly string[]): Record<string, unknown> {
  const codes = typeof code === "string" ? [code] : code;
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorEnvelope" },
        examples: Object.fromEntries(codes.map((value) => [value, { value: { ok: false, code: value } }])),
      },
    },
  };
}

export const INVALID_SECURITY_MODE_CONFIG_ERROR =
  "config_error: a nonempty ACCOUNT_TOKEN_MODE, REQUEST_SIGNATURE_MODE, DEVICE_PROOF_MODE, or ORDER_SIGNER_SCOPE_MODE is not an exact documented mode. The Worker rejects it before route authentication, body processing, persistence, or issuance.";

export function securityModeConfigErrorResponse(
  additionalDescription = "",
  additionalCodes: readonly string[] = [],
): Record<string, unknown> {
  return errorResponse(
    INVALID_SECURITY_MODE_CONFIG_ERROR + (additionalDescription.length > 0 ? " " + additionalDescription : ""),
    ["config_error", ...additionalCodes],
  );
}

export function jsonBody(schemaRef: string, required = true): Record<string, unknown> {
  return {
    required,
    content: { "application/json": { schema: { $ref: schemaRef } } },
  };
}

export const openApiComponents: LabeledComponentFragment = {
  label: "backend-components",
  namespaces: [
    ["securitySchemes", [
      ["orderKeyId", {
        type: "apiKey",
        in: "header",
        name: "X-LCC-Key-Id",
        description:
          "Identifier selecting the HMAC secret from ORDER_HMAC_SECRETS.",
      }],
      ["orderTimestamp", {
        type: "apiKey",
        in: "header",
        name: "X-LCC-Timestamp",
        description:
          "Canonical integer Unix timestamp bounded by ORDER_MAX_SKEW_SECONDS and included in the signed bytes.",
      }],
      ["orderSignature", {
        type: "apiKey",
        in: "header",
        name: "X-LCC-Signature",
        description:
          "Base64 HMAC-SHA256 over the request method, path, ORDER_INGEST_AUDIENCE, X-LCC-Timestamp, and exact raw request-body bytes.",
      }],
    ]],
    ["schemas", [
      ["ErrorEnvelope", {
        type: "object",
        required: ["ok", "code"],
        properties: {
          ok: { type: "boolean", enum: [false] },
          code: { type: "string", description: "Machine-readable error code." },
        },
        additionalProperties: true,
      }],
      ["HealthSuccess", {
        type: "object",
        required: ["ok", "service", "protected_device_ready"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          service: { type: "string", enum: ["licensecc-online-verifier"] },
          protected_device_ready: {
            type: "boolean",
            enum: [true],
            description: "The protected device registry, dedicated RSA-3072 signer pair, approval key ring and global rate limit all passed their local checks. No configuration value is returned.",
          },
          config_warnings: {
            type: "array",
            items: { type: "string" },
            description: "Optional names-only operator warnings for paired security material configured with a non-enforcing normalized mode.",
          },
        },
      }],
      ["HealthConfigError", {
        type: "object",
        required: ["ok", "service", "protected_device_ready"],
        dependentRequired: { code: ["invalid_config_modes"], invalid_config_modes: ["code"] },
        properties: {
          ok: { type: "boolean", enum: [false] },
          service: { type: "string", enum: ["licensecc-online-verifier"] },
          protected_device_ready: {
            type: "boolean",
            description: "False when the protected device configuration fails a local readiness check; the failing check is never named.",
          },
          code: { type: "string", enum: ["config_error"], description: "Present only with invalid_config_modes." },
          invalid_config_modes: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              enum: ["ACCOUNT_TOKEN_MODE", "REQUEST_SIGNATURE_MODE", "DEVICE_PROOF_MODE", "ORDER_SIGNER_SCOPE_MODE"],
            },
            description: "Invalid selector names only; raw values are never returned.",
          },
          config_warnings: {
            type: "array",
            items: { type: "string" },
            description: "Optional names-only consistency warnings; invalid configuration remains terminal readiness failure.",
          },
        },
      }],
      ["OrderRequest", {
        type: "object",
        required: ["event_id", "subscription_id", "project", "intent", "seq", "customer"],
        description:
          "Signed subscription order event (raw wire body <= 16384 bytes), strictly UTF-8 decoded only after raw-byte HMAC verification and normalized/validated per order_event.mjs. Every intent, revocations included, names customer.id. subscription.active creates or refreshes a protected (device_bound_v1) grant owned by that customer.",
        properties: {
          event_id: { type: "string", minLength: 1, maxLength: 255 },
          subscription_id: { type: "string", minLength: 1, maxLength: 255 },
          project: { type: "string", minLength: 1, maxLength: 127 },
          feature: { type: "string", minLength: 1, maxLength: 15, description: "Defaults to project when omitted." },
          license_fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Optional; auto-derived if omitted." },
          intent: {
            type: "string",
            enum: [
              "subscription.active",
              "subscription.renewed",
              "subscription.past_due",
              "subscription.paused",
              "subscription.payment_failed",
              "subscription.canceled_at_period_end",
              "subscription.resumed",
              "quantity.changed",
              "fraud.confirmed",
              "chargeback",
            ],
          },
          order_epoch: { type: "integer", minimum: 0, default: 0 },
          seq: { type: "integer", minimum: 0 },
          current_period_end: { type: "integer", minimum: 0, description: "Unix seconds." },
          occurred_at: { type: "integer", minimum: 0, description: "Unix seconds." },
          license_id: { type: "string", minLength: 1, maxLength: 255 },
          customer: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 255 },
              email: { type: "string", maxLength: 255 },
              name: { type: "string", maxLength: 255 },
              external_ref: { type: "string", minLength: 1, maxLength: 255 },
            },
            additionalProperties: false,
          },
          quantity: {
            type: "object",
            required: ["max_active_devices"],
            properties: {
              max_active_devices: { type: "integer", minimum: 0 },
            },
            additionalProperties: false,
          },
        },
        allOf: [{
          if: { properties: { intent: { const: "quantity.changed" } }, required: ["intent"] },
          then: { required: ["quantity"] },
        }],
        additionalProperties: false,
      }],
      ["OrderResult", {
        type: "object",
        required: ["ok", "code"],
        properties: {
          ok: { type: "boolean" },
          code: {
            type: "string",
            enum: ["applied", "superseded", "no_entitlement", "stale_ignored", "observed", "cached"],
          },
          license_fingerprint: { type: ["string", "null"] },
          fingerprint_origin: { type: "string" },
          entitlement: { type: "object", additionalProperties: true },
        },
        additionalProperties: true,
      }],
    ]],
  ],
};
