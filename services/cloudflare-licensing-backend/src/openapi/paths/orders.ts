import type { LabeledPathFragment } from "../assemble.js";
import { errorResponse, jsonBody } from "../components.js";

const ordersPath: Record<string, unknown> = {
  post: {
    tags: ["fulfillment"],
    summary:
      "Exactly-once subscription order fulfillment. HMAC-SHA256 signed, fingerprint-deduplicated, monotonic epoch/seq floor, signer-scope authorized. Always enforced; no rollout selector.",
    operationId: "postOrders",
    security: [{ orderKeyId: [], orderTimestamp: [], orderSignature: [] }],
    description:
      "Requires X-LCC-Key-Id, X-LCC-Timestamp, and X-LCC-Signature. The signature is base64 HMAC-SHA256 over the method, path, ORDER_INGEST_AUDIENCE, canonical timestamp, and original raw wire bytes, keyed by ORDER_HMAC_SECRETS[key_id]. The timestamp is bounded by ORDER_MAX_SKEW_SECONDS. The raw-byte stream is capped at 16384 bytes, then strictly UTF-8 decoded before JSON parsing. An exact signed-request replay returns HTTP 401 code:replayed. A freshly signed delivery of an already-terminal event_id with a matching normalized payload digest returns the stored application result; code:cached is the truthful neutral fallback when terminal result finalization did not complete, so the terminal row has no stored result.",
    requestBody: jsonBody("#/components/schemas/OrderRequest"),
    responses: {
      "200": {
        description:
          "Applied/cached (ok:true, code: applied|superseded|no_entitlement|stale_ignored|cached), including the stored application result for a freshly signed matching replay of a processed/superseded event. cached is the neutral fallback when terminal result finalization did not complete and the terminal row has no stored result.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/OrderResult" } },
        },
      },
      "400": errorResponse(
        "invalid_order: validly signed bytes that are malformed UTF-8, malformed JSON, invalid normalize result (including a missing customer.id or a quantity field other than max_active_devices), a license id that conflicts with its immutable project/customer identity, a customer/license id that contradicts the subscription's established identity, or Step 5 redrive failure. Omitting license_id carries the established license forward; it does not transfer it.",
        "invalid_order",
      ),
      "401": errorResponse(
        "Auth failure: unknown_key_id, stale_timestamp, bad_signature, or replayed (nonce already consumed).",
        ["unknown_key_id", "stale_timestamp", "bad_signature", "replayed"],
      ),
      "403": errorResponse(
        "signer_scope_forbidden: the authenticated signer is not authorized for the requested project or customer per its ORDER_SIGNER_SCOPES entry.",
        "signer_scope_forbidden",
      ),
      "409": errorResponse(
        "Conflict: event_id_conflict (same event_id, different digest), seq_conflict (same subscription epoch/sequence with a different payload), fingerprint_owned (fingerprint belongs to a different subscription), entitlement_owner_mismatch (an entitlement already exists for the fingerprint and is owned by another customer or by no one; refused for every intent, withdrawals included. A refusal before admission writes nothing; one at apply records the event as rejected and advances the subscription cursor, without touching the entitlement), entitlement_revoked (targets a revoked terminal entitlement), customer_email_conflict (the order names a customer id that does not exist yet, and its email already belongs to another customer as a contact email, a password login or a Google/GitHub sign-in; the order is recorded as rejected and the subscription cursor advances, with no customer, grant or audit row written. An order for an existing customer id, or a withdrawal, is never refused for its email; a withdrawal for a customer id with no customer row creates that customer without an email), capacity_in_use (a quantity.changed or subscription.active order would set the device limit below the devices holding a slot on the grant, active or retiring until their hold ends; the order is recorded as rejected and the subscription cursor advances, with the grant, its floor and its audit untouched. A resend of the same event only returns the stored refusal: disconnect devices, then have the store send a new order event with a higher seq. A refusal caused only by a disconnecting device's hold clears once that hold ends, but still needs a new event), or the original stored conflict result for a freshly signed matching replay of a rejected event. Resending the same event never turns a 409 into success; a refusal recorded at apply (entitlement_owner_mismatch, entitlement_revoked, customer_email_conflict or capacity_in_use) is returned from the stored result without running the write again.",
        ["event_id_conflict", "seq_conflict", "fingerprint_owned", "entitlement_owner_mismatch", "entitlement_revoked", "customer_email_conflict", "capacity_in_use"],
      ),
      "413": errorResponse(
        "payload_too_large: declared Content-Length over 16384 or accumulated raw wire bytes over 16384. The stream is cancelled on rejection; Content-Length is only an early hint and cannot bypass the raw-byte cap.",
        "payload_too_large",
      ),
      "503": errorResponse(
        "config_error: unusable ORDER_HMAC_SECRETS or ORDER_INGEST_AUDIENCE, or a missing/malformed required ORDER_SIGNER_SCOPES map. The Worker rejects these before route authentication, body processing, persistence, or issuance. write_failed: DB batch unavailable, DB errors, or order_ingest_nonces store unavailable.",
        ["config_error", "write_failed"],
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
