// OpenAPI 3.1 "doc-of-existing" for the licensecc online verifier / licensing-backend Worker.
//
// This spec is authored to FAITHFULLY describe the routes the Worker's fetch handler dispatches in
// src/index.ts -- it is documentation OF the shipped code, not a contract the code is generated
// from. A zero-dep cross-check test (test/openapi-spec.test.mjs) PINS this spec to the source so a
// route added/removed in index.ts without a matching spec edit fails CI.
//
// Envelope: every client-facing response is the FLAT shape { ok: boolean, code?: string, ...fields }.
// Success bodies set ok:true; errors set ok:false with a `code` string and the documented HTTP
// status. (Note: /v1/verify and /v1/orders can return HTTP 200 with ok:false for a soft denial /
// cached replay -- documented per-endpoint.)
//
// The spec is a plain typed object (no runtime deps) so it serializes directly to /openapi.json.

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers: { url: string }[];
  tags: { name: string; description?: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Reusable error-envelope helper. Each error response is { ok:false, code:"<code>" }.
// ---------------------------------------------------------------------------
function errorResponse(description: string, code: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorEnvelope" },
        examples: { [code]: { value: { ok: false, code } } },
      },
    },
  };
}

function jsonBody(schemaRef: string, required = true): Record<string, unknown> {
  return {
    required,
    content: { "application/json": { schema: { $ref: schemaRef } } },
  };
}

// The five scoped lease/seat/report endpoints share the same auth + token-mode error set. Build it
// once so /v1/activate, /v1/renew, /v1/checkout, /v1/heartbeat, /v1/release, /v1/admin/report and
// every /v1/emergency/* override stay in lock-step with the handler.
const ACCOUNT_TOKEN_AUTH_ERRORS: Record<string, Record<string, unknown>> = {
  "401": errorResponse(
    "Unauthorized. off mode: LEASE_ISSUE_BEARER mismatch. soft/required mode: token missing, malformed, unknown, revoked, or expired. token_revoked: status!=active or revocation floor exceeded. token_expired: expires_at <= now.",
    "unauthorized",
  ),
  "403": errorResponse(
    "Forbidden. forbidden_scope: token scopes do not allow this operation on project:feature.",
    "forbidden_scope",
  ),
  "503": errorResponse(
    "config_error: ACCOUNT_TOKEN_PEPPERS absent/unparseable in soft/required mode (or required signing key missing); verification_error: D1 lookup/issuance errors.",
    "config_error",
  ),
};

const LEASE_SUCCESS: Record<string, unknown> = {
  description: "Signed v201 lease issued.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/LeaseSuccess" },
    },
  },
};

const SEAT_SUCCESS: Record<string, unknown> = {
  description: "Seat checked out / heartbeat refreshed. Returns a short-TTL lccoa1 assertion.",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/SeatSuccess" } },
  },
};

const REPORT_SUCCESS: Record<string, unknown> = {
  description: "Usage/analytics summary over the requested window.",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/ReportSuccess" } },
  },
};

// ---------------------------------------------------------------------------
// Path objects.
// ---------------------------------------------------------------------------

const openapiJsonPath: Record<string, unknown> = {
  get: {
    tags: ["meta"],
    summary: "This OpenAPI 3.1 document.",
    operationId: "getOpenApiJson",
    security: [],
    responses: {
      "200": {
        description: "The OpenAPI specification as JSON.",
        content: { "application/json": { schema: { type: "object" } } },
      },
    },
  },
};

const docsPath: Record<string, unknown> = {
  get: {
    tags: ["meta"],
    summary: "Self-contained HTML API documentation viewer.",
    operationId: "getDocs",
    security: [],
    responses: {
      "200": {
        description: "An HTML page that fetches /openapi.json and renders a grouped endpoint list.",
        content: { "text/html": { schema: { type: "string" } } },
      },
    },
  },
};

const healthPath: Record<string, unknown> = {
  get: {
    tags: ["meta"],
    summary: "Health check.",
    operationId: "getHealth",
    security: [],
    responses: {
      "200": {
        description: "Service healthy.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/HealthSuccess" },
            examples: { ok: { value: { ok: true, service: "licensecc-online-verifier" } } },
          },
        },
      },
    },
  },
};

const verifyPath: Record<string, unknown> = {
  post: {
    tags: ["client"],
    summary:
      "Client-facing online license verification with optional ECDSA device proof. Rate-limited per client IP and per entitlement. Returns a signed RSA lccoa1 assertion or a denial.",
    operationId: "postVerify",
    security: [{ requestProof: [] }],
    description:
      "No account auth: the client presents a license fingerprint (and optionally an ECDSA request proof) and receives a signed lccoa1 assertion or a denial validated client-side by the C++ SDK. Request-signature mode (off/soft/required) governs proof acceptance. Body must be <= 4096 bytes.",
    requestBody: jsonBody("#/components/schemas/VerifyRequest"),
    responses: {
      "200": {
        description:
          "Assertion issued (ok:true, code:entitlement_ok) OR a soft denial (ok:false, code:entitlement_denied) -- both are HTTP 200.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/VerifySuccess" },
          },
        },
      },
      "400": errorResponse(
        "body_too_large (actual body over 4096 bytes), invalid_json (malformed JSON), or invalid_request (field validation failed).",
        "invalid_request",
      ),
      "401": errorResponse(
        "request_proof_required (required mode, proof missing), request_proof_stale (timestamp outside skew window), or request_proof_invalid (device unknown/disabled, invalid signature, malformed key, or replayed nonce).",
        "request_proof_invalid",
      ),
      "403": errorResponse(
        "entitlement_denied: not found, revoked, disabled, device mismatch, outside validity window, or rate limited.",
        "entitlement_denied",
      ),
      "413": errorResponse("body_too_large: Content-Length over 4096 bytes.", "body_too_large"),
      "429": errorResponse(
        "rate_limited. source: cloudflare-client | d1-client | d1-entitlement | d1-global.",
        "rate_limited",
      ),
      "500": errorResponse(
        "verification_error: D1 lookup failed, signing failed, or proof-nonce store unavailable.",
        "verification_error",
      ),
    },
  },
};

const ordersPath: Record<string, unknown> = {
  post: {
    tags: ["fulfillment"],
    summary:
      "Exactly-once subscription order fulfillment. HMAC-SHA256 signed, fingerprint-deduplicated, monotonic epoch/seq floor. Modes: off (404), soft (observe-only), required (mutate).",
    operationId: "postOrders",
    security: [{ orderHmac: [] }],
    description:
      "Authenticated by the Order-Signature header: HMAC-SHA256 over the raw body keyed by ORDER_HMAC_SECRETS[key_id], with a bounded timestamp (ORDER_MAX_SKEW_SECONDS) and the ORDER_INGEST_AUDIENCE folded into the signed bytes. Body must be <= 16384 bytes. Replay of a processed event_id with a matching payload digest returns HTTP 200 ok:false code:cached.",
    requestBody: jsonBody("#/components/schemas/OrderRequest"),
    responses: {
      "200": {
        description:
          "Applied/observed (ok:true, code: applied|superseded|no_entitlement|stale_ignored|observed) OR a replay of a processed/superseded/rejected event with matching digest (ok:false, code:cached).",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/OrderResult" } },
        },
      },
      "400": errorResponse(
        "invalid_order: malformed JSON, invalid normalize result, or Step 5 redrive failure.",
        "invalid_order",
      ),
      "401": errorResponse(
        "Auth failure: config_error (ORDER_HMAC_SECRETS absent/empty/unparseable), unknown_key_id, stale_timestamp, bad_signature, or replayed (nonce already consumed).",
        "bad_signature",
      ),
      "404": errorResponse("not_found: ORDER_INGEST_MODE=off.", "not_found"),
      "409": errorResponse(
        "Conflict: event_id_conflict (same event_id, different digest), fingerprint_owned (fingerprint belongs to a different subscription), or entitlement_revoked (targets a revoked terminal entitlement).",
        "event_id_conflict",
      ),
      "413": errorResponse(
        "payload_too_large: Content-Length over 16384 or utf-8 encoded body over 16384 bytes.",
        "payload_too_large",
      ),
      "503": errorResponse(
        "write_failed: DB batch unavailable, DB errors, or order_ingest_nonces store unavailable.",
        "write_failed",
      ),
    },
  },
};

function leasePath(op: "activate" | "renew", summary: string): Record<string, unknown> {
  return {
    post: {
      tags: ["lease"],
      summary,
      operationId: `post${op[0].toUpperCase()}${op.slice(1)}`,
      security: [{ accountToken: [] }, { leaseBearer: [] }],
      description:
        "Authenticated by an account token (Authorization: Bearer lcca_..., scoped to project+feature+" +
        op +
        ") or the legacy LEASE_ISSUE_BEARER (off mode only). Optional ECDSA device proof binds the lease to a registered device key; device-rebind cap (max_active_devices) enforced atomically. Idempotent on request_id.",
      requestBody: jsonBody("#/components/schemas/LeaseRequest"),
      responses: {
        "200": LEASE_SUCCESS,
        "400": errorResponse("invalid_request: malformed JSON or missing required fields.", "invalid_request"),
        "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
        "403": errorResponse(
          "forbidden_scope (token cannot " +
            op +
            " on project:feature), no_active_entitlement, expired_subscription, device_proof_required, device_proof_invalid, or device_limit_exceeded.",
          "no_active_entitlement",
        ),
        "500": errorResponse("lease_signing_error: crypto signing failed.", "lease_signing_error"),
        "503": errorResponse(
          "config_error (ACCOUNT_TOKEN_PEPPERS / LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM unavailable) or verification_error (D1 errors).",
          "verification_error",
        ),
      },
    },
  };
}

const checkoutPath: Record<string, unknown> = {
  post: {
    tags: ["seat"],
    summary:
      "Concurrent/floating seat checkout. Returns a short-TTL lccoa1 assertion. Live (heartbeat-gated) or borrowed (offline grace). Pool cap enforced atomically.",
    operationId: "postCheckout",
    security: [{ accountToken: [] }, { leaseBearer: [] }],
    description:
      "Authenticated by an account token (scoped to project+feature+checkout) or legacy LEASE_ISSUE_BEARER (off mode only). Optional ECDSA device proof binds the seat. Lazily reclaims lapsed seats on the hot path.",
    requestBody: jsonBody("#/components/schemas/SeatCheckoutRequest"),
    responses: {
      "200": {
        description: "Seat reserved (mode live or borrowed).",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/SeatCheckoutSuccess" } },
        },
      },
      "400": errorResponse("invalid_request: malformed JSON or missing required fields.", "invalid_request"),
      "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
      "403": errorResponse(
        "forbidden_scope, no_active_entitlement, floating_disabled (pool_size <= 0), device_proof_required, device_proof_invalid, or borrowing_disabled (borrow_seconds present but max_borrow_sec <= 0).",
        "floating_disabled",
      ),
      "409": errorResponse(
        "pool_exhausted: concurrent seat count at/above pool_size + allow_overdraft.",
        "pool_exhausted",
      ),
      "500": errorResponse("seat_signing_error: crypto signing failed.", "seat_signing_error"),
      "503": errorResponse(
        "config_error (ACCOUNT_TOKEN_PEPPERS / ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM unavailable) or verification_error (D1 errors).",
        "verification_error",
      ),
    },
  },
};

const heartbeatPath: Record<string, unknown> = {
  post: {
    tags: ["seat"],
    summary:
      "Renew a live seat's heartbeat deadline within the entitlement's valid_until window. Returns an updated assertion. Fails if the seat was reclaimed.",
    operationId: "postHeartbeat",
    security: [{ accountToken: [] }, { leaseBearer: [] }],
    description:
      "Authenticated by an account token (scoped to project+feature+heartbeat) or legacy LEASE_ISSUE_BEARER (off mode only). seat_id is REQUIRED.",
    requestBody: jsonBody("#/components/schemas/SeatHeartbeatRequest"),
    responses: {
      "200": SEAT_SUCCESS,
      "400": errorResponse(
        "invalid_request: malformed JSON, missing seat_id, or other required fields.",
        "invalid_request",
      ),
      "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
      "403": errorResponse(
        "forbidden_scope or no_active_entitlement (not found, status!=active, or outside validity window).",
        "no_active_entitlement",
      ),
      "410": errorResponse(
        "seat_reclaimed: seat not found, revoked, or heartbeat deadline expired.",
        "seat_reclaimed",
      ),
      "500": errorResponse("seat_signing_error: crypto signing failed.", "seat_signing_error"),
      "503": errorResponse(
        "config_error (ACCOUNT_TOKEN_PEPPERS / ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM unavailable) or verification_error (D1 errors).",
        "verification_error",
      ),
    },
  },
};

const releasePath: Record<string, unknown> = {
  post: {
    tags: ["seat"],
    summary:
      "Release a seat (mark heartbeat_deadline expired, record usage event). Idempotent: ok:true even if already reclaimed. Ownership-scoped in soft/required modes.",
    operationId: "postRelease",
    security: [{ accountToken: [] }, { leaseBearer: [] }],
    description:
      "Authenticated by an account token (scoped to project+feature+release) or legacy LEASE_ISSUE_BEARER (off mode only). seat_id is REQUIRED.",
    requestBody: jsonBody("#/components/schemas/SeatReleaseRequest"),
    responses: {
      "200": {
        description: "Seat released (idempotent).",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ReleaseSuccess" } },
        },
      },
      "400": errorResponse(
        "invalid_request: malformed JSON, missing seat_id, or other required fields.",
        "invalid_request",
      ),
      "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
      "403": errorResponse("forbidden_scope: token scopes do not allow release on project:feature.", "forbidden_scope"),
      "503": errorResponse(
        "config_error (ACCOUNT_TOKEN_PEPPERS absent/unparseable in soft/required mode) or verification_error (D1 errors).",
        "verification_error",
      ),
    },
  },
};

const reportPath: Record<string, unknown> = {
  get: {
    tags: ["report"],
    summary:
      "Generate a usage/analytics report from the usage_events log over a time window. truncated flag set if > 100000 rows. Scoped to the authenticated customer in soft/required modes.",
    operationId: "getAdminReport",
    security: [{ accountToken: [] }, { leaseBearer: [] }],
    description:
      "Authenticated by an account token (scoped to project+feature+report) or legacy LEASE_ISSUE_BEARER (off mode only). Aggregates peak_concurrent, unique_devices, denials, and rates.",
    parameters: [
      { name: "project", in: "query", required: true, schema: { type: "string" } },
      { name: "feature", in: "query", required: true, schema: { type: "string" } },
      { name: "license_fingerprint", in: "query", required: true, schema: { type: "string" } },
      { name: "from", in: "query", required: false, schema: { type: "integer", default: 0 }, description: "Unix seconds; default 0." },
      { name: "to", in: "query", required: false, schema: { type: "integer" }, description: "Unix seconds; default now." },
    ],
    responses: {
      "200": REPORT_SUCCESS,
      "400": errorResponse(
        "invalid_request: missing project, feature, or license_fingerprint query params.",
        "invalid_request",
      ),
      "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
      "403": errorResponse("forbidden_scope: token scopes do not allow report on project:feature.", "forbidden_scope"),
      "503": errorResponse(
        "config_error (ACCOUNT_TOKEN_PEPPERS absent/unparseable in soft/required mode) or verification_error (D1 errors).",
        "verification_error",
      ),
    },
  },
};

// ---------------------------------------------------------------------------
// /v1/emergency/* break-glass overrides. Same request/response shapes as the underlying scoped
// handler, but gated ONLY by EMERGENCY_OPERATOR_BEARER (constant-time): unset/empty => 404, mismatch
// => 401. Dispatched with ACCOUNT_TOKEN_MODE forced to off (non-isolated operator authority).
// ---------------------------------------------------------------------------
function emergencyNotFound(): Record<string, unknown> {
  return errorResponse("not_found: EMERGENCY_OPERATOR_BEARER unset/empty (the route does not exist).", "not_found");
}
function emergencyUnauthorized(): Record<string, unknown> {
  return errorResponse("unauthorized: operator bearer mismatch.", "unauthorized");
}

function emergencyLease(op: "activate" | "renew"): Record<string, unknown> {
  return {
    post: {
      tags: ["emergency"],
      summary: `Break-glass emergency override for lease ${op}. Non-isolated operator path (legacy SQL, ACCOUNT_TOKEN_MODE forced off). Logged at warn.`,
      operationId: `postEmergency${op[0].toUpperCase()}${op.slice(1)}`,
      security: [{ emergencyBearer: [] }],
      requestBody: jsonBody("#/components/schemas/LeaseRequest"),
      responses: {
        "200": LEASE_SUCCESS,
        "400": errorResponse("invalid_request: malformed JSON or missing required fields.", "invalid_request"),
        "401": emergencyUnauthorized(),
        "403": errorResponse(
          "no_active_entitlement, expired_subscription, device_proof_required, device_proof_invalid, or device_limit_exceeded.",
          "no_active_entitlement",
        ),
        "404": emergencyNotFound(),
        "500": errorResponse("lease_signing_error: crypto signing failed.", "lease_signing_error"),
        "503": errorResponse("verification_error or lease_signing_unavailable.", "verification_error"),
      },
    },
  };
}

const emergencyCheckoutPath: Record<string, unknown> = {
  post: {
    tags: ["emergency"],
    summary:
      "Break-glass emergency override for seat checkout. Non-isolated operator path (ACCOUNT_TOKEN_MODE forced off).",
    operationId: "postEmergencyCheckout",
    security: [{ emergencyBearer: [] }],
    requestBody: jsonBody("#/components/schemas/SeatCheckoutRequest"),
    responses: {
      "200": {
        description: "Seat reserved (mode live or borrowed).",
        content: { "application/json": { schema: { $ref: "#/components/schemas/SeatCheckoutSuccess" } } },
      },
      "400": errorResponse("invalid_request: malformed JSON or missing required fields.", "invalid_request"),
      "401": emergencyUnauthorized(),
      "403": errorResponse(
        "no_active_entitlement, floating_disabled, device_proof_required, device_proof_invalid, or borrowing_disabled.",
        "no_active_entitlement",
      ),
      "404": emergencyNotFound(),
      "409": errorResponse("pool_exhausted: concurrent seat count at/above pool_size + allow_overdraft.", "pool_exhausted"),
      "500": errorResponse("seat_signing_error: crypto signing failed.", "seat_signing_error"),
      "503": errorResponse("verification_error or seat_signing_unavailable.", "verification_error"),
    },
  },
};

const emergencyHeartbeatPath: Record<string, unknown> = {
  post: {
    tags: ["emergency"],
    summary:
      "Break-glass emergency override for seat heartbeat. Non-isolated operator path (ACCOUNT_TOKEN_MODE forced off).",
    operationId: "postEmergencyHeartbeat",
    security: [{ emergencyBearer: [] }],
    requestBody: jsonBody("#/components/schemas/SeatHeartbeatRequest"),
    responses: {
      "200": SEAT_SUCCESS,
      "400": errorResponse("invalid_request: missing seat_id.", "invalid_request"),
      "401": emergencyUnauthorized(),
      "403": errorResponse("no_active_entitlement.", "no_active_entitlement"),
      "404": emergencyNotFound(),
      "410": errorResponse("seat_reclaimed: seat not found, revoked, or heartbeat deadline expired.", "seat_reclaimed"),
      "500": errorResponse("seat_signing_error: crypto signing failed.", "seat_signing_error"),
      "503": errorResponse("verification_error or seat_signing_unavailable.", "verification_error"),
    },
  },
};

const emergencyReleasePath: Record<string, unknown> = {
  post: {
    tags: ["emergency"],
    summary:
      "Break-glass emergency override for seat release. Non-isolated operator path (ACCOUNT_TOKEN_MODE forced off).",
    operationId: "postEmergencyRelease",
    security: [{ emergencyBearer: [] }],
    requestBody: jsonBody("#/components/schemas/SeatReleaseRequest"),
    responses: {
      "200": {
        description: "Seat released (idempotent).",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReleaseSuccess" } } },
      },
      "400": errorResponse("invalid_request: missing seat_id.", "invalid_request"),
      "401": emergencyUnauthorized(),
      "404": emergencyNotFound(),
      "503": errorResponse("verification_error.", "verification_error"),
    },
  },
};

const emergencyReportPath: Record<string, unknown> = {
  get: {
    tags: ["emergency"],
    summary:
      "Break-glass emergency override for usage report. Non-isolated operator path, full access to all entitlements.",
    operationId: "getEmergencyAdminReport",
    security: [{ emergencyBearer: [] }],
    parameters: [
      { name: "project", in: "query", required: true, schema: { type: "string" } },
      { name: "feature", in: "query", required: true, schema: { type: "string" } },
      { name: "license_fingerprint", in: "query", required: true, schema: { type: "string" } },
      { name: "from", in: "query", required: false, schema: { type: "integer", default: 0 } },
      { name: "to", in: "query", required: false, schema: { type: "integer" } },
    ],
    responses: {
      "200": REPORT_SUCCESS,
      "400": errorResponse("invalid_request: missing query params.", "invalid_request"),
      "401": emergencyUnauthorized(),
      "404": emergencyNotFound(),
      "503": errorResponse("verification_error.", "verification_error"),
    },
  },
};

// ---------------------------------------------------------------------------
// The full document.
// ---------------------------------------------------------------------------
export const openApiSpec: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "licensecc online verifier / licensing-backend",
    version: "0.1.0",
    description:
      "Cloudflare Worker that issues signed online assertions (lccoa1) and hardware-bound v201 leases / floating seats, ingests signed subscription orders, and reports usage. All responses use a FLAT { ok, code, ... } envelope. This spec documents the routes the Worker's fetch handler dispatches.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "meta", description: "Health and documentation." },
    { name: "client", description: "Unauthenticated client-facing online verification." },
    { name: "fulfillment", description: "HMAC-signed subscription order ingest." },
    { name: "lease", description: "Account-token-scoped hardware-bound lease issuance (v201)." },
    { name: "seat", description: "Account-token-scoped floating/concurrent seat lifecycle." },
    { name: "report", description: "Account-token-scoped usage analytics." },
    { name: "emergency", description: "Break-glass operator overrides gated by EMERGENCY_OPERATOR_BEARER." },
  ],
  paths: {
    "/openapi.json": openapiJsonPath,
    "/docs": docsPath,
    "/health": healthPath,
    "/v1/verify": verifyPath,
    "/v1/orders": ordersPath,
    "/v1/activate": leasePath("activate", "Hardware-bound sliding-window lease issuance (v201)."),
    "/v1/renew": leasePath("renew", "Hardware-bound lease renewal (v201). Same auth/validation/issuance as /v1/activate on an existing lease."),
    "/v1/checkout": checkoutPath,
    "/v1/heartbeat": heartbeatPath,
    "/v1/release": releasePath,
    "/v1/admin/report": reportPath,
    "/v1/emergency/v1/activate": emergencyLease("activate"),
    "/v1/emergency/v1/renew": emergencyLease("renew"),
    "/v1/emergency/v1/checkout": emergencyCheckoutPath,
    "/v1/emergency/v1/heartbeat": emergencyHeartbeatPath,
    "/v1/emergency/v1/release": emergencyReleasePath,
    "/v1/emergency/v1/admin/report": emergencyReportPath,
  },
  components: {
    securitySchemes: {
      // /v1/verify: no account auth. The optional ECDSA request proof is carried in the JSON body
      // (request_proof fields), not a header -- documented here for completeness.
      requestProof: {
        type: "apiKey",
        in: "header",
        name: "x-no-auth",
        description:
          "No transport auth. /v1/verify is unauthenticated; an OPTIONAL ECDSA-P256-SHA256 request proof is supplied via the JSON body fields (request_signature_version/device_key_id/request_timestamp/request_signature_algorithm/request_signature) and validated server-side per REQUEST_SIGNATURE_MODE.",
      },
      orderHmac: {
        type: "apiKey",
        in: "header",
        name: "Order-Signature",
        description:
          "HMAC-SHA256 over the raw request body keyed by ORDER_HMAC_SECRETS[key_id], with a bounded timestamp (ORDER_MAX_SKEW_SECONDS) and ORDER_INGEST_AUDIENCE folded into the signed bytes.",
      },
      accountToken: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "lcca_<opaque>",
        description:
          "Per-customer account token (Authorization: Bearer lcca_...), scoped by projects/features/operations. Resolved by timing-safe HMAC under a pepper; never stored plaintext.",
      },
      leaseBearer: {
        type: "http",
        scheme: "bearer",
        description:
          "Legacy LEASE_ISSUE_BEARER (off mode only), compared constant-time. When unset the endpoint is open in off mode.",
      },
      emergencyBearer: {
        type: "http",
        scheme: "bearer",
        description:
          "EMERGENCY_OPERATOR_BEARER, compared constant-time. Gates /v1/emergency/* only; unset/empty => 404, mismatch => 401. Never logged.",
      },
    },
    schemas: {
      ErrorEnvelope: {
        type: "object",
        required: ["ok", "code"],
        properties: {
          ok: { type: "boolean", enum: [false] },
          code: { type: "string", description: "Machine-readable error code." },
        },
        additionalProperties: true,
      },
      HealthSuccess: {
        type: "object",
        required: ["ok", "service"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          service: { type: "string", enum: ["licensecc-online-verifier"] },
        },
      },
      RequestProofFields: {
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
      },
      VerifyRequest: {
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
      },
      VerifySuccess: {
        type: "object",
        required: ["ok", "code", "server_time"],
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["entitlement_ok", "entitlement_denied"] },
          assertion: { type: "string", description: "lccoa1 token (present when ok:true)." },
          server_time: { type: "integer", description: "Unix seconds." },
        },
        additionalProperties: true,
      },
      OrderRequest: {
        type: "object",
        required: ["subscription_id", "project", "feature", "intent", "event_id", "ts"],
        description:
          "Signed subscription order event (body <= 16384 bytes), normalized/validated per order_event.mjs.",
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
      },
      OrderResult: {
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
      },
      LeaseRequest: {
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
      },
      LeaseSuccess: {
        type: "object",
        required: ["ok", "lic", "server_time", "renew_by", "valid_to_epoch"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          lic: { type: "string", description: "v201 signed lease text." },
          server_time: { type: "integer" },
          renew_by: { type: "integer", description: "Unix seconds." },
          valid_to_epoch: { type: "integer", description: "Unix seconds (hard offline expiry)." },
        },
      },
      SeatCheckoutRequest: {
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
      },
      SeatCheckoutSuccess: {
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
      },
      SeatHeartbeatRequest: {
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
      },
      SeatSuccess: {
        type: "object",
        required: ["ok", "assertion", "server_time", "expires_at", "heartbeat_in"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          assertion: { type: "string", description: "lccoa1 token." },
          server_time: { type: "integer" },
          expires_at: { type: "integer" },
          heartbeat_in: { type: "integer" },
        },
      },
      SeatReleaseRequest: {
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
      },
      ReleaseSuccess: {
        type: "object",
        required: ["ok", "server_time"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          server_time: { type: "integer" },
        },
      },
      ReportSuccess: {
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
      },
    },
  },
};

// Self-contained docs page: no external CDN, no network beyond /openapi.json. Fetches the spec and
// renders a grouped, collapsible endpoint list. Kept deliberately minimal and dependency-free.
export const docsHtml: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>licensecc licensing-backend API</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 0 1rem 4rem; max-width: 960px; }
  h1 { font-size: 1.5rem; }
  .tag-group { margin: 1.5rem 0; }
  .tag-group > h2 { font-size: 1.1rem; border-bottom: 1px solid #8884; padding-bottom: .25rem; }
  details { border: 1px solid #8884; border-radius: 6px; margin: .4rem 0; padding: .25rem .6rem; }
  summary { cursor: pointer; display: flex; gap: .6rem; align-items: baseline; }
  summary::-webkit-details-marker { display: none; }
  .method { font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; padding: .1rem .4rem; border-radius: 4px; min-width: 3.2rem; text-align: center; color: #fff; }
  .m-get { background: #2f855a; } .m-post { background: #2b6cb0; } .m-put { background: #b7791f; } .m-delete { background: #c53030; }
  .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
  .summary-text { color: #888; flex: 1; }
  .detail-body { margin-top: .6rem; }
  .sec { font-size: .8rem; color: #888; margin: .3rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; margin: .4rem 0; }
  th, td { text-align: left; border: 1px solid #8884; padding: .2rem .45rem; vertical-align: top; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #8882; padding: 0 .25rem; border-radius: 3px; }
  .err-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .loading, .error { color: #888; padding: 2rem 0; }
</style>
</head>
<body>
<h1>licensecc licensing-backend API</h1>
<p class="sec">OpenAPI 3.1 doc-of-existing. Source of truth: <a href="/openapi.json">/openapi.json</a>.</p>
<div id="app"><p class="loading">Loading spec…</p></div>
<script>
(function () {
  var app = document.getElementById("app");
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function methodClass(m) { return "method m-" + m.toLowerCase(); }
  function render(spec) {
    app.innerHTML = "";
    var info = spec.info || {};
    var head = document.createElement("p");
    head.className = "sec";
    head.textContent = (info.title || "") + " v" + (info.version || "");
    app.appendChild(head);
    var paths = spec.paths || {};
    var groups = {};
    var order = [];
    Object.keys(paths).forEach(function (p) {
      Object.keys(paths[p]).forEach(function (method) {
        var op = paths[p][method];
        var tag = (op.tags && op.tags[0]) || "other";
        if (!groups[tag]) { groups[tag] = []; order.push(tag); }
        groups[tag].push({ path: p, method: method.toUpperCase(), op: op });
      });
    });
    order.forEach(function (tag) {
      var g = document.createElement("div");
      g.className = "tag-group";
      var h = document.createElement("h2");
      h.textContent = tag;
      g.appendChild(h);
      groups[tag].forEach(function (e) {
        g.appendChild(renderEndpoint(e, spec));
      });
      app.appendChild(g);
    });
  }
  function refName(ref) { return ref ? ref.split("/").pop() : ""; }
  function renderEndpoint(e, spec) {
    var d = document.createElement("details");
    var s = document.createElement("summary");
    s.innerHTML = '<span class="' + methodClass(e.method) + '">' + esc(e.method) + '</span>' +
      '<span class="path">' + esc(e.path) + '</span>' +
      '<span class="summary-text">' + esc(e.op.summary || "") + '</span>';
    d.appendChild(s);
    var body = document.createElement("div");
    body.className = "detail-body";
    var html = "";
    if (e.op.description) html += '<p>' + esc(e.op.description) + '</p>';
    var sec = (e.op.security || []).map(function (o) { return Object.keys(o)[0]; }).filter(Boolean);
    html += '<p class="sec">Security: ' + (sec.length ? sec.map(esc).join(" OR ") : "none") + '</p>';
    if (e.op.parameters && e.op.parameters.length) {
      html += '<p class="sec">Parameters</p><table><tr><th>name</th><th>in</th><th>required</th><th>type</th></tr>';
      e.op.parameters.forEach(function (p) {
        var t = (p.schema && (p.schema.type || (p.schema.$ref ? refName(p.schema.$ref) : ""))) || "";
        html += '<tr><td><code>' + esc(p.name) + '</code></td><td>' + esc(p.in) + '</td><td>' +
          (p.required ? "yes" : "no") + '</td><td>' + esc(t) + '</td></tr>';
      });
      html += '</table>';
    }
    if (e.op.requestBody) {
      var rb = e.op.requestBody.content && e.op.requestBody.content["application/json"];
      var ref = rb && rb.schema && rb.schema.$ref ? refName(rb.schema.$ref) : "(json)";
      html += '<p class="sec">Request body: <code>' + esc(ref) + '</code></p>';
      html += renderSchema(spec, ref);
    }
    html += '<p class="sec">Responses</p><table><tr><th>status</th><th>description</th></tr>';
    Object.keys(e.op.responses || {}).forEach(function (code) {
      html += '<tr><td class="err-code">' + esc(code) + '</td><td>' +
        esc((e.op.responses[code] && e.op.responses[code].description) || "") + '</td></tr>';
    });
    html += '</table>';
    body.innerHTML = html;
    d.appendChild(body);
    return d;
  }
  function renderSchema(spec, name) {
    var schemas = (spec.components && spec.components.schemas) || {};
    var sc = schemas[name];
    if (!sc || !sc.properties) return "";
    var req = sc.required || [];
    var html = '<table><tr><th>field</th><th>type</th><th>required</th></tr>';
    Object.keys(sc.properties).forEach(function (k) {
      var p = sc.properties[k];
      var t = p.type;
      if (Array.isArray(t)) t = t.join("|");
      if (p.enum) t = (t || "enum") + " (" + p.enum.join(", ") + ")";
      html += '<tr><td><code>' + esc(k) + '</code></td><td>' + esc(t || "") + '</td><td>' +
        (req.indexOf(k) >= 0 ? "yes" : "no") + '</td></tr>';
    });
    html += '</table>';
    return html;
  }
  fetch("/openapi.json").then(function (r) { return r.json(); }).then(render).catch(function (err) {
    app.innerHTML = '<p class="error">Failed to load /openapi.json: ' + esc(err && err.message) + '</p>';
  });
})();
</script>
</body>
</html>`;
