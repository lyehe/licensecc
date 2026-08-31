import type { LabeledPathFragment } from "../assemble.js";
import { ACCOUNT_TOKEN_AUTH_ERRORS, errorResponse, jsonBody, LEASE_SUCCESS, REPORT_SUCCESS, SEAT_SUCCESS, securityModeConfigErrorResponse } from "../components.js";

const ordersPath: Record<string, unknown> = {
  post: {
    tags: ["fulfillment"],
    summary:
      "Exactly-once subscription order fulfillment. HMAC-SHA256 signed, fingerprint-deduplicated, monotonic epoch/seq floor. Modes: off (404), soft (observe-only), required (mutate).",
    operationId: "postOrders",
    security: [{ orderKeyId: [], orderTimestamp: [], orderSignature: [] }],
    description:
      "Requires X-LCC-Key-Id, X-LCC-Timestamp, and X-LCC-Signature. The signature is base64 HMAC-SHA256 over the method, path, ORDER_INGEST_AUDIENCE, canonical timestamp, and original raw wire bytes, keyed by ORDER_HMAC_SECRETS[key_id]. The timestamp is bounded by ORDER_MAX_SKEW_SECONDS. The raw-byte stream is capped at 16384 bytes, then strictly UTF-8 decoded before JSON parsing. An exact signed-request replay returns HTTP 401 code:replayed. A freshly signed delivery of an already-terminal event_id with a matching normalized payload digest returns the stored application result; code:cached is the truthful neutral fallback when terminal result finalization did not complete or a legacy terminal row has no stored result.",
    requestBody: jsonBody("#/components/schemas/OrderRequest"),
    responses: {
      "200": {
        description:
          "Applied/observed/cached (ok:true, code: applied|superseded|no_entitlement|stale_ignored|observed|cached), including the stored application result for a freshly signed matching replay of a processed/superseded event. cached is the neutral fallback when terminal result finalization did not complete or a legacy terminal row has no stored result.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/OrderResult" } },
        },
      },
      "400": errorResponse(
        "invalid_order: validly signed bytes that are malformed UTF-8, malformed JSON, invalid normalize result, a license id that conflicts with its immutable project/customer identity, an explicit customer/license id that contradicts the subscription's established identity, or Step 5 redrive failure. Omitting customer/license fields carries established entitlement values forward; it does not transfer them.",
        "invalid_order",
      ),
      "401": errorResponse(
        "Auth failure: unknown_key_id, stale_timestamp, bad_signature, or replayed (nonce already consumed).",
        ["unknown_key_id", "stale_timestamp", "bad_signature", "replayed"],
      ),
      "403": errorResponse(
        "signer_scope_forbidden: the authenticated signer is not authorized for the requested project while ORDER_SIGNER_SCOPE_MODE requires scope enforcement.",
        "signer_scope_forbidden",
      ),
      "404": errorResponse("not_found: ORDER_INGEST_MODE=off.", "not_found"),
      "409": errorResponse(
        "Conflict: event_id_conflict (same event_id, different digest), seq_conflict (same subscription epoch/sequence with a different payload), fingerprint_owned (fingerprint belongs to a different subscription), entitlement_revoked (targets a revoked terminal entitlement), or the original stored conflict result for a freshly signed matching replay of a rejected event.",
        ["event_id_conflict", "seq_conflict", "fingerprint_owned", "entitlement_revoked"],
      ),
      "413": errorResponse(
        "payload_too_large: declared Content-Length over 16384 or accumulated raw wire bytes over 16384. The stream is cancelled on rejection; Content-Length is only an early hint and cannot bypass the raw-byte cap.",
        "payload_too_large",
      ),
      "503": securityModeConfigErrorResponse(
        "config_error also covers unusable ORDER_HMAC_SECRETS or ORDER_INGEST_AUDIENCE, and a missing/invalid required ORDER_SIGNER_SCOPES map. write_failed: DB batch unavailable, DB errors, or order_ingest_nonces store unavailable.",
        ["write_failed"],
      ),
    },
  },
};

export const ordersPaths: LabeledPathFragment = {
  label: "orders",
  entries: [
    ["/v1/orders", ordersPath],
  ],
};
