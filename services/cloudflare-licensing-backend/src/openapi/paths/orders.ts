import type { LabeledPathFragment } from "../assemble.js";
import { ACCOUNT_TOKEN_AUTH_ERRORS, errorResponse, jsonBody, LEASE_SUCCESS, REPORT_SUCCESS, SEAT_SUCCESS } from "../components.js";

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

export const ordersPaths: LabeledPathFragment = {
  label: "orders",
  entries: [
    ["/v1/orders", ordersPath],
  ],
};
