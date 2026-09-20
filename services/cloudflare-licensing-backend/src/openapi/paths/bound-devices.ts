import type { LabeledPathFragment } from "../assemble.js";

const recordId = { type: "string", pattern: "^[A-Za-z0-9_-]{21}[AQgw]$", description: "Opaque 16-byte record ID, canonical unpadded base64url." };
const secret = { type: "string", pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$", description: "32-byte value in canonical unpadded base64url." };
const integer = { type: "integer", minimum: 0, maximum: 9007199254740991, description: "Wire token must use unsigned decimal digits: 0 or a nonzero digit followed by digits. No fraction, exponent or negative zero." };
const project = { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,127}$" };
const callback = { type: "string", maxLength: 1024, description: "Exact registered HTTP loopback IP/path with an explicit nonzero port. Only 127.0.0.1 or [::1]. No query, fragment, userinfo, DNS host or URL normalization aliases." };
function object(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
const proof = object({ key_id: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, challenge_id: recordId,
  nonce: secret, expires_at: integer, signature: { type: "string", pattern: "^[A-Za-z0-9_-]{85}[AQgw]$", description: "Low-S P-256 IEEE P1363 signature over the canonical v2 proof input." } });
const exchange = object({ attempt_handle: secret, code: secret, code_verifier: secret, redirect_uri: callback, operation_id: secret, proof });
const renewal = object({ binding_id: recordId, generation: { ...integer, minimum: 1 }, operation_id: secret, proof });
const authorization = object({ client_id: project, project, public_key_spki: { type: "string", minLength: 1, maxLength: 512,
  pattern: "^[A-Za-z0-9_-]+$", description: "Canonical DER P-256 SPKI encoded in unpadded base64url; import/re-export equality is enforced." },
device_label: { type: "string", description: "Trimmed display-only Unicode label, 1–80 code points." }, redirect_uri: callback,
state: secret, code_challenge: secret, code_challenge_method: { const: "S256" } });
const challenge = { oneOf: [object({ purpose: { const: "exchange" }, attempt_handle: secret, operation_id: secret }),
  object({ purpose: { const: "renew" }, binding_id: recordId, operation_id: secret })] };
const lease = object({ device_id: recordId, binding_id: recordId, generation: { ...integer, minimum: 1 },
  entitlement: object({ project, feature: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,15}$" }, license_fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" } }),
  lease: { type: "string", maxLength: 8192, description: "Signed lccdl1 device lease. Verify signature and all expected claims in the native consumer; this string alone is not local authorization." },
  renew_after: integer, expires_at: integer, accept_until: { ...integer, description: "Server capacity hold deadline (expires_at + 120). Clients stop at expires_at, without this allowance." } });
const errors: Record<string, string[]> = {
  "400": ["invalid_request", "unsupported_protocol"], "401": ["proof_required", "invalid_proof"],
  "403": ["access_denied", "device_retired", "legacy_protocol_disabled"],
  "404": ["authorization_unavailable", "binding_unavailable"],
  "409": ["device_limit_reached", "revision_conflict", "idempotency_conflict"],
  "410": ["authorization_expired", "challenge_expired"], "429": ["rate_limited"], "503": ["temporarily_unavailable"],
};
function operation(operationId: string, summary: string, request: unknown, code: string, data: unknown) {
  const headers = { "Cache-Control": { schema: { const: "no-store" }, description: "Never cache protocol responses." } };
  const responses: Record<string, unknown> = { "200": { description: code, headers,
    content: { "application/json": { schema: object({ ok: { const: true }, code: { const: code }, request_id: { type: "string" }, data }) } } } };
  for (const [status, codes] of Object.entries(errors)) responses[status] = {
    description: status === "503" ? "Unknown outcome or unavailable configuration/service. Keep the key and exact operation; obtain a fresh challenge to reconcile."
      : "A denial describes this request/current authority; it does not prove an earlier concurrent or timed-out invocation never committed.",
    headers: status === "429" ? { ...headers, "Retry-After": { schema: { const: "60" }, description: "Wait before retrying, with backoff and jitter." } } : headers,
    content: { "application/json": { schema: object({ ok: { const: false }, code: { type: "string", enum: codes }, request_id: { type: "string" } }) } },
  };
  return { post: { tags: ["device"], operationId, summary, security: [],
    description: "Protected device protocol, independent of legacy proof/account-token switches. Requests are bounded to 16 KiB, fatal UTF-8 JSON objects with no duplicate/unknown fields or unpaired surrogates. Mandatory rate limits apply before parsing and key import. Exchange and renewal require fresh proof in the body; security: [] does not waive that proof. A stable operation ID identifies exact semantic intent; retry with fresh challenge/signature. Successful recovery returns the exact original response, including request_id and lease times. Native clients must preserve their original monotonic send anchor across retries.",
    requestBody: { required: true, content: { "application/json": { schema: request } } }, responses } };
}

export const boundDevicePaths: LabeledPathFragment = { label: "protected devices", entries: [
  ["/v2/device-authorizations", operation("createDeviceAuthorization", "Begin browser-authorized device enrollment.", authorization, "authorization_created",
    object({ attempt_handle: secret, authorization_url: { type: "string", format: "uri", description: "Fixed configured portal destination; secret attempt_handle is carried in the fragment, not query parameters." }, expires_at: integer,
      comparison_code:{type:"string",pattern:"^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$",description:"Display-only 48-bit enrollment comparison. The app recomputes it from its original enrollment transcript before showing it; never use as a credential or proof."} }))],
  ["/v2/device-challenges", operation("createDeviceChallenge", "Obtain a fresh, single-use device-proof challenge.", challenge, "challenge_created",
    object({ challenge_id: recordId, nonce: secret, expires_at: integer }))],
  ["/v2/device-authorizations/exchange", operation("exchangeDeviceAuthorization", "Exchange consent, PKCE and key proof for a device-bound lease.", exchange, "device_activated", lease)],
  ["/v2/device-leases/renew", operation("renewDeviceLease", "Renew an active binding with fresh device proof.", renewal, "device_renewed", lease)],
] };
