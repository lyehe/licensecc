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

// The five scoped lease/seat/report endpoints share the same auth + token-mode error set. Build it
// once so /v1/activate, /v1/renew, /v1/checkout, /v1/heartbeat, /v1/release, /v1/admin/report and
// every /v1/emergency/* override stay in lock-step with the handler.
export const ACCOUNT_TOKEN_AUTH_ERRORS: Record<string, Record<string, unknown>> = {
  "401": errorResponse(
    "Unauthorized. off mode: LEASE_ISSUE_BEARER mismatch. soft/required mode: token missing, malformed, unknown, revoked, or expired. token_revoked: status!=active or revocation floor exceeded. token_expired: expires_at <= now.",
    "unauthorized",
  ),
  "403": errorResponse(
    "Forbidden. forbidden_scope: token scopes do not allow this operation on project:feature.",
    "forbidden_scope",
  ),
  "503": securityModeConfigErrorResponse(
    "Other route-specific 503 codes include unavailable account-token material and verification_error for D1 lookup/issuance failures.",
    ["verification_error"],
  ),
};

export const LEASE_SUCCESS: Record<string, unknown> = {
  description: "Signed v201 lease issued.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/LeaseSuccess" },
    },
  },
};

export const SEAT_SUCCESS: Record<string, unknown> = {
  description: "Seat checked out / heartbeat refreshed. Returns a short-TTL lccoa1 assertion.",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/SeatSuccess" } },
  },
};

export const REPORT_SUCCESS: Record<string, unknown> = {
  description: "Usage/analytics summary over the requested window.",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/ReportSuccess" } },
  },
};

export const openApiComponents: LabeledComponentFragment = {
  label: "backend-components",
  namespaces: [
    ["securitySchemes", [
      ["requestProof", {
        type: "apiKey",
        in: "header",
        name: "x-no-auth",
        description:
          "No transport auth. /v1/verify is unauthenticated; an OPTIONAL ECDSA-P256-SHA256 request proof is supplied via the JSON body fields (request_signature_version/device_key_id/request_timestamp/request_signature_algorithm/request_signature) and validated server-side per REQUEST_SIGNATURE_MODE.",
      }],
      ["orderHmac", {
        type: "apiKey",
        in: "header",
        name: "Order-Signature",
        description:
          "HMAC-SHA256 over the raw request body keyed by ORDER_HMAC_SECRETS[key_id], with a bounded timestamp (ORDER_MAX_SKEW_SECONDS) and ORDER_INGEST_AUDIENCE folded into the signed bytes.",
      }],
      ["accountToken", {
        type: "http",
        scheme: "bearer",
        bearerFormat: "lcca_<opaque>",
        description:
          "Per-customer account token (Authorization: Bearer lcca_...), scoped by projects/features/operations. Resolved by timing-safe HMAC under a pepper; never stored plaintext.",
      }],
      ["leaseBearer", {
        type: "http",
        scheme: "bearer",
        description:
          "Legacy LEASE_ISSUE_BEARER (off mode only), compared constant-time. When unset the endpoint is open in off mode.",
      }],
      ["emergencyBearer", {
        type: "http",
        scheme: "bearer",
        description:
          "EMERGENCY_OPERATOR_BEARER, compared constant-time. Gates /v1/emergency/* only; unset/empty => 404, mismatch => 401. Never logged.",
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
        required: ["ok", "service", "account_token_mode"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          service: { type: "string", enum: ["licensecc-online-verifier"] },
          account_token_mode: {
            type: "string",
            enum: ["off", "soft", "required"],
            description: "Normalized ACCOUNT_TOKEN_MODE; raw configuration values are never returned.",
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
        required: ["ok", "service", "code", "account_token_mode", "invalid_config_modes"],
        properties: {
          ok: { type: "boolean", enum: [false] },
          service: { type: "string", enum: ["licensecc-online-verifier"] },
          code: { type: "string", enum: ["config_error"] },
          account_token_mode: {
            type: "string",
            enum: ["off", "soft", "required", "invalid"],
            description: "Normalized ACCOUNT_TOKEN_MODE; invalid indicates this selector is one of invalid_config_modes.",
          },
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
      ["RequestProofFields", {
        type: "object",
        description:
          "Optional flat ECDSA request-proof fields. Present together or omitted; when present all must validate.",
        properties: {
          device_key_id: { type: "string", description: "sha256:<64-hex> device key id." },
          request_signature_version: { type: "integer", enum: [1] },
          request_timestamp: { type: "integer", description: "Unix seconds." },
          request_signature_algorithm: { type: "string", enum: ["ecdsa-p256-sha256"] },
          request_signature: { type: "string", description: "Base64, <= 512 chars." },
        },
      }],
      ["VerifyRequest", {
        type: "object",
        required: ["project", "feature", "license_fingerprint", "nonce"],
        properties: {
          project: { type: "string", maxLength: 127 },
          feature: { type: "string", maxLength: 15 },
          license_fingerprint: { type: "string", description: "64-hex." },
          device_hash: { type: "string", description: "64-hex or empty." },
          nonce: { type: "string", description: "64-hex." },
          client_version: { type: "string", maxLength: 64 },
          client_hardening: { type: "integer", minimum: 0, maximum: 65535 },
          device_key_id: { type: "string", description: "sha256:<64-hex> (request proof)." },
          request_signature_version: { type: "integer", enum: [1] },
          request_timestamp: { type: "integer", description: "Unix seconds (request proof)." },
          request_signature_algorithm: { type: "string", enum: ["ecdsa-p256-sha256"] },
          request_signature: { type: "string", description: "Base64, <= 512 chars (request proof)." },
        },
      }],
      ["VerifySuccess", {
        type: "object",
        required: ["ok", "code", "server_time"],
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["entitlement_ok", "entitlement_denied"] },
          assertion: { type: "string", description: "lccoa1 token (present when ok:true)." },
          server_time: { type: "integer", description: "Unix seconds." },
        },
        additionalProperties: true,
      }],
      ["OrderRequest", {
        type: "object",
        required: ["subscription_id", "project", "feature", "intent", "event_id", "ts"],
        description:
          "Signed subscription order event (raw wire body <= 16384 bytes), strictly UTF-8 decoded only after raw-byte HMAC verification and normalized/validated per order_event.mjs.",
        properties: {
          subscription_id: { type: "string" },
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string", description: "Optional; auto-derived if omitted." },
          intent: {
            type: "string",
            enum: [
              "subscription.active",
              "subscription.canceled",
              "subscription.failed",
              "subscription.paused",
              "subscription.pending",
              "subscription.unpaused",
              "quantity.changed",
              "subscription.paid",
              "subscription.past_due",
              "subscription.unpaid",
            ],
          },
          event_id: { type: "string", format: "uuid" },
          ts: { type: "integer", description: "Unix seconds." },
          order_epoch: { type: "integer" },
          seq: { type: "integer" },
          license_id: { type: "string" },
          customer: {
            type: "object",
            properties: {
              id: { type: "string" },
              email: { type: "string" },
              name: { type: "string" },
              external_ref: { type: "string" },
            },
          },
          quantity: {
            type: "object",
            properties: {
              pool_size: { type: "integer" },
              max_active_devices: { type: "integer" },
              lease_seconds: { type: "integer" },
              rebind_window_sec: { type: "integer" },
              heartbeat_grace_sec: { type: "integer" },
              max_borrow_sec: { type: "integer" },
              allow_overdraft: { type: "integer" },
            },
          },
        },
        additionalProperties: true,
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
      ["LeaseRequest", {
        type: "object",
        required: ["project", "feature", "license_fingerprint", "device_key_id"],
        properties: {
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string" },
          device_key_id: { type: "string", description: "sha256:<64-hex>." },
          hw_id: { type: "string" },
          client_signature_source_strength: { type: "integer" },
          start_version: { type: "integer" },
          end_version: { type: "integer" },
          request_id: { type: "string", description: "Idempotency key." },
          nonce: { type: "string", description: "Required when a request proof is present." },
          request_signature_version: { type: "integer", enum: [1] },
          request_timestamp: { type: "integer", description: "Unix seconds." },
          request_signature_algorithm: { type: "string", enum: ["ecdsa-p256-sha256"] },
          request_signature: { type: "string", description: "Base64." },
        },
        additionalProperties: true,
      }],
      ["LeaseSuccess", {
        type: "object",
        required: ["ok", "lic", "server_time", "renew_by", "valid_to_epoch"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          lic: { type: "string", description: "v201 signed lease text." },
          server_time: { type: "integer" },
          renew_by: { type: "integer", description: "Unix seconds." },
          valid_to_epoch: { type: "integer", description: "Unix seconds (hard offline expiry)." },
          // UNSIGNED trial telemetry (Stage 4). Present only for trial entitlements; NOT part of the
          // signed v201 canonical payload. trial=true marks the lease as a trial; trial_expires_at_epoch
          // is the server-computed trial deadline (for from_first_activation/from_first_use the clock
          // starts at the first activation), clamped to the subscription end. Omitted for non-trials.
          trial: { type: "boolean", enum: [true], description: "Present (true) only for trial entitlements." },
          trial_expires_at_epoch: {
            type: "integer",
            description: "Unix seconds. Server-computed trial deadline, clamped to valid_until. Omitted when the trial has no finite deadline.",
          },
        },
      }],
      ["SeatCheckoutRequest", {
        type: "object",
        required: ["project", "feature", "license_fingerprint", "client_instance_id", "nonce"],
        properties: {
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string" },
          client_instance_id: { type: "string" },
          nonce: { type: "string" },
          seat_id: { type: "string" },
          borrow_seconds: { type: "integer", minimum: 1, description: "Positive; returns mode=borrowed." },
          device_key_id: { type: "string", description: "sha256:<64-hex> (optional)." },
          request_signature_version: { type: "integer", enum: [1] },
          request_timestamp: { type: "integer" },
          request_signature_algorithm: { type: "string", enum: ["ecdsa-p256-sha256"] },
          request_signature: { type: "string", description: "Base64." },
        },
        additionalProperties: true,
      }],
      ["SeatCheckoutSuccess", {
        type: "object",
        required: ["ok", "assertion", "seat_id", "mode", "server_time", "expires_at", "heartbeat_in"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          assertion: { type: "string", description: "lccoa1 token." },
          seat_id: { type: "string", format: "uuid" },
          mode: { type: "string", enum: ["live", "borrowed"] },
          server_time: { type: "integer" },
          expires_at: { type: "integer", description: "Unix seconds." },
          heartbeat_in: { type: "integer", description: "Seconds until next heartbeat." },
        },
      }],
      ["SeatHeartbeatRequest", {
        type: "object",
        required: ["project", "feature", "license_fingerprint", "client_instance_id", "nonce", "seat_id"],
        properties: {
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string" },
          client_instance_id: { type: "string" },
          nonce: { type: "string" },
          seat_id: { type: "string", description: "REQUIRED." },
          device_key_id: { type: "string", description: "sha256:<64-hex> (optional)." },
          request_signature_version: { type: "integer", enum: [1] },
          request_timestamp: { type: "integer" },
          request_signature_algorithm: { type: "string", enum: ["ecdsa-p256-sha256"] },
          request_signature: { type: "string", description: "Base64." },
        },
        additionalProperties: true,
      }],
      ["SeatSuccess", {
        type: "object",
        required: ["ok", "assertion", "server_time", "expires_at", "heartbeat_in"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          assertion: { type: "string", description: "lccoa1 token." },
          server_time: { type: "integer" },
          expires_at: { type: "integer" },
          heartbeat_in: { type: "integer" },
        },
      }],
      ["SeatReleaseRequest", {
        type: "object",
        required: ["project", "feature", "license_fingerprint", "client_instance_id", "nonce", "seat_id"],
        properties: {
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string" },
          client_instance_id: { type: "string" },
          nonce: { type: "string" },
          seat_id: { type: "string", description: "REQUIRED." },
          device_key_id: { type: "string", description: "Optional." },
          request_signature_version: { type: "integer", enum: [1] },
          request_timestamp: { type: "integer" },
          request_signature_algorithm: { type: "string", enum: ["ecdsa-p256-sha256"] },
          request_signature: { type: "string", description: "Base64 (optional)." },

        },
        additionalProperties: true,
      }],
      ["ReleaseSuccess", {
        type: "object",
        required: ["ok", "server_time"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          server_time: { type: "integer" },
        },
      }],
      ["MeterRequest", {
        type: "object",
        required: ["project", "feature", "license_fingerprint"],
        properties: {
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string" },
          units: { type: "integer", minimum: 1, description: "Positive integer; defaults to 1 when omitted." },
        },
        additionalProperties: true,
      }],
      ["MeterSuccess", {
        type: "object",
        required: ["ok", "server_time", "units_consumed", "quota", "period_start", "period_end"],
        properties: {
          ok: { type: "boolean" },
          server_time: { type: "integer" },
          units_consumed: { type: "integer", description: "Cumulative units for the current period after this call." },
          quota: { type: "integer", description: "meter_quota (0 = unlimited / count-only)." },
          period_start: { type: "integer", description: "Unix seconds; start of the current rolling period." },
          period_end: { type: "integer", description: "Unix seconds; period_start + meter_period_sec." },
        },
      }],
      ["ReportSuccess", {
        type: "object",
        required: [
          "ok",
          "project",
          "feature",
          "from",
          "to",
          "server_time",
          "truncated",
          "peak_concurrent",
          "unique_devices",
          "denials",
          "peak_concurrent_at",
          "denial_rate_per_day",
        ],
        properties: {
          ok: { type: "boolean", enum: [true] },
          project: { type: "string" },
          feature: { type: "string" },
          from: { type: "integer", description: "Unix seconds." },
          to: { type: "integer", description: "Unix seconds." },
          server_time: { type: "integer" },
          truncated: { type: "boolean", description: "True if > 100000 rows in the window." },
          peak_concurrent: { type: "integer" },
          unique_devices: { type: "integer" },
          denials: { type: "integer" },
          peak_concurrent_at: { type: "integer", description: "Unix seconds." },
          denial_rate_per_day: { type: "number" },
        },
      }],
    ]],
  ],
};
