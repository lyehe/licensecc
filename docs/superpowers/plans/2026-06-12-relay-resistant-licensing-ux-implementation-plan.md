# Relay-Resistant Licensing With Low-Friction UX Implementation Plan

Date: 2026-06-12

Scope: harden `licensecc` for a world where client binaries can be patched,
hooked, or rewritten quickly. The design treats the local app as hostile,
keeps the online verifier authoritative, and avoids turning legitimate users
into support tickets.

## Design Principle

The client may be tampered with. Local checks should provide friction and
telemetry, not final trust. The server should make entitlement decisions from
signed license identity, device/account policy, revocation state, and optional
client posture signals.

The product experience should remain predictable:

- No surprise permanent lockouts from one failed probe.
- No mandatory reactivation after ordinary app updates.
- No hard dependency on fragile machine fingerprints alone.
- Clear recovery path for device replacement, OS reinstall, and corporate
  proxy environments.
- Privacy-preserving logs: short fingerprints and posture summaries, not raw
  hardware identifiers.

## Current Baseline

Already present or recently added:

- Core-generated nonce for each online request.
- Signed online assertions.
- Assertion binding to project, feature, license fingerprint, optional device
  hash, nonce, time window, and `revocation_seq`.
- Required online verification through `lcc_acquire_license_decision()`.
- Persisted revocation-floor callbacks in the production-shaped example.
- HTTPS-first example transport with explicit test-only HTTP override.
- `client_hardening` telemetry that is intentionally not treated as proof.

This blocks simple captured-response replay. It does not fully block live
request relay or a patched local decision branch.

## Target Architecture

Add device proof-of-possession on top of the current nonce-signed assertion
flow.

1. On first activation, the client generates a device key pair.
2. The client stores the private key in the best available platform key store.
3. The public key is registered with the verifier for the license/account.
4. Each online request signs a canonical request payload containing:
   - project
   - feature
   - license fingerprint
   - device hash, if configured
   - nonce
   - request timestamp
   - client hardening bitset
   - request schema version
5. The verifier checks entitlement, revocation state, device policy, and the
   request signature before returning a signed assertion.
6. The client continues to verify the returned assertion exactly as it does
   today, including nonce and revocation-floor checks.

This makes a copied request body or forged local callback materially less
useful because the server requires possession of the registered device private
key before issuing an allow assertion.

## Non-Goals

- Do not claim the app is tamper-proof.
- Do not require customers to manually manage keys.
- Do not break existing integrations by default.
- Do not make offline use impossible unless the product chooses strict online
  policy.
- Do not store private signing material in the app bundle.

## Phase 0: Policy Surface And Compatibility

Goal: introduce the policy model without changing default behavior.

Changes:

- Add verifier-side policy fields:
  - `device_binding_mode`: `off`, `soft`, `required`
  - `request_signature_mode`: `off`, `soft`, `required`
  - `max_registered_devices`
  - `activation_grace_seconds`
  - `offline_grace_seconds`
- Keep existing unsigned request compatibility when policy is `off`.
- In `soft` mode, allow the request but log a structured warning when proof is
  missing or invalid.
- In `required` mode, deny missing or invalid proof with a stable error code.

UX guardrails:

- Default new deployments to `soft`, not `required`.
- Provide clear server logs for why a request would have been denied.
- Avoid generic "tamper detected" wording for account/device policy issues.

Acceptance:

- Existing C++ online tests still pass with proof disabled.
- Verifier tests cover all policy modes.
- Docs state that `soft` mode is the recommended rollout mode.

## Phase 1: Request Proof Schema

Goal: define a stable canonical payload that can be signed by the device key.

New request fields:

- `request_signature_version`
- `device_key_id`
- `request_timestamp`
- `request_signature_algorithm`
- `request_signature`

Canonical payload:

```text
purpose=licensecc-online-request
version=1
project=<project>
feature=<feature>
license-fingerprint=<hex>
device-hash=<hex-or-empty>
nonce=<hex>
request-timestamp=<unix-seconds>
client-hardening=<uint32>
device-key-id=<stable-key-id>
```

Rules:

- Use byte-exact canonical formatting like the existing assertion payload.
- Include the nonce so a captured signature cannot be reused for another
  online request.
- Include `client_hardening` for telemetry consistency, but do not treat it as
  proof of a clean client.
- Reject malformed signatures before entitlement lookup where practical.

Acceptance:

- Golden fixture tests for canonical request payloads.
- Server rejects reordered, duplicated, missing, or unknown canonical fields.
- Server rejects stale request timestamps outside a small skew window.

## Phase 2: Device Key Lifecycle

Goal: support proof-of-possession without forcing users through manual setup.

Client behavior:

- Generate a key pair silently on first activation or first online check.
- Prefer platform-backed storage:
  - Windows: CNG/DPAPI-backed key storage.
  - macOS: Keychain/Secure Enclave where available.
  - Linux: Secret Service/libsecret when available, file fallback with strict
    permissions for CLI/server environments.
- If secure storage is unavailable, fall back according to host policy:
  - developer/test builds may allow file storage;
  - production examples should warn and continue only if policy permits.

Server behavior:

- Register public keys against license/account/device records.
- Support key rotation with overlap:
  - old key remains valid during a short grace period;
  - new key becomes active immediately after a successful registration flow.
- Record last-seen time, short key id, and posture summary.

UX guardrails:

- One automatic key repair attempt before showing a failure.
- Device replacement flow should be explicit and account/admin controlled.
- Do not consume an additional device slot for routine key rotation on the same
  device when the prior key can authorize rotation.

Acceptance:

- Device key generation is non-interactive in the example host.
- Key loss produces a recoverable error, not an ambiguous tamper failure.
- Rotation tests cover old-key authorization and grace expiry.

## Phase 3: Verifier Enforcement

Goal: make the server the authoritative policy point.

Changes:

- Extend entitlement schema with registered device public keys or a companion
  `entitlement_devices` table.
- Verify request signatures before issuing signed assertions when mode is
  `required`.
- Bind assertions to the same `device_key_id` when present. This is optional
  for the client initially, but useful for audit and future policy.
- Add rate limits by license fingerprint, device key id, and source IP.
- Add nonce reuse detection for short windows.

UX guardrails:

- Rate-limit responses should be temporary and distinguishable from license
  denial.
- Corporate NATs should not cause account-wide lockouts.
- Device limits should return an actionable code that an app can map to a
  support or account-management flow.

Acceptance:

- Valid signed request returns a signed assertion.
- Missing signature in `soft` mode allows and logs.
- Missing signature in `required` mode denies.
- Invalid signature denies without signing an allow assertion.
- Reused nonce is logged and denied or challenged according to policy.

## Phase 4: C++ API And Example Integration

Goal: make secure integration copyable without bloating the minimal path.

Public API additions should be versioned and opt-in:

- `LccDeviceKeyProvider`
- `LccRequestProofOptions`
- `lcc_init_request_proof_options()`
- optional fields in `LccLicenseDecisionOptions` for request proof

Production example updates:

- Extend `examples/production_decision_host` to:
  - create/load a device key;
  - sign the online request;
  - send proof fields to the verifier;
  - handle recoverable device-registration errors;
  - keep `--allow-insecure-http-for-test` test-only.

UX guardrails:

- Keep `examples/minimal` minimal.
- Keep `online_callback` useful for transport/failover demonstration.
- Make `production_decision_host` the recommended copyable secure path.
- Do not make the app block forever on first-run key setup; fail with a clear
  error when the selected policy requires a key and storage fails.

Acceptance:

- Installed package smoke builds a consumer that uses request proof options.
- Existing ABI compatibility tests pass.
- Docs clearly separate minimal, online, and production-shaped examples.

## Phase 5: Offline And Grace Policy

Goal: support reasonable real-world operation without making replay easy.

Recommended defaults:

- Online assertion TTL: short, for example 5 minutes.
- Offline grace: product-specific, for example 24-72 hours for desktop apps.
- Grace requires:
  - previously accepted assertion;
  - matching license fingerprint;
  - matching registered device key id where available;
  - revocation floor not below the saved maximum.

Rules:

- Never extend grace from an expired or unsigned local blob.
- Do not allow local clock rollback to extend grace.
- If time confidence is weak, degrade gracefully according to product policy:
  - warn in soft mode;
  - deny in strict mode.

UX guardrails:

- Communicate "cannot verify license right now" separately from "license
  revoked" or "tamper detected."
- Allow admins to configure longer grace for enterprise offline environments.
- Log enough detail for support without exposing secrets.

Acceptance:

- Tests cover valid grace, expired grace, clock rollback, and revoked floor.
- Strict mode fails closed.
- Soft mode can warn while preserving compatibility.

## Phase 6: Telemetry And Admin Experience

Goal: give operators enough signal to respond without punishing normal users.

Telemetry:

- request proof mode and result
- short license fingerprint
- short device key id
- `client_hardening`
- verifier decision code
- rate-limit outcome
- nonce reuse signal
- revocation sequence

Admin workflows:

- list registered devices for an entitlement
- revoke one device without revoking the whole license
- rotate device key
- reset device slot with audit event
- export support bundle with redacted identifiers

UX guardrails:

- Default logs should be privacy-preserving.
- Admin actions must increment `revocation_seq`.
- Revoked devices must not be silently re-enabled by an upsert.

Acceptance:

- SQL tests prove revocation sequence monotonicity.
- Admin/e2e tests cover device revoke, reset, and key rotation.
- Logs never include raw private keys, request signatures, or full hardware
  identifiers.

## Phase 7: Rollout Strategy

Recommended rollout:

1. Ship server support with `request_signature_mode=off`.
2. Add C++ client proof generation behind an opt-in option.
3. Enable `soft` mode for internal builds and examples.
4. Monitor missing-proof, invalid-proof, and key-loss rates.
5. Enable `soft` mode for new production entitlements.
6. Enable `required` mode only for products/features that can tolerate online
   authorization and have a support path for device recovery.

Do not flip existing customers directly to required proof without an activation
or migration flow.

## Test Matrix

Core C++:

- canonical request proof payload
- device key id formatting
- request signing success
- missing key in optional mode
- missing key in required mode
- malformed proof fields
- installed consumer smoke

Verifier:

- policy modes: off, soft, required
- valid request signature
- invalid signature
- unknown device key
- disabled/revoked device
- nonce reuse
- timestamp skew
- device limit exceeded
- key rotation

Integration:

- first activation registers a key
- app update preserves key
- key loss produces recoverable error
- backup verifier endpoint still works
- revocation floor still blocks rollback

Docs:

- production guide explains request proof without promising tamper-proofing
- troubleshooting guide distinguishes network, policy, revoked, and tamper
  outcomes
- examples show secure defaults without noisy prompts

## Recommended First Implementation Slice

Start with the smallest useful end-to-end path:

1. Add verifier schema and TypeScript request validation for proof fields.
2. Add canonical request payload builder and verifier tests.
3. Add server-side public-key registration helpers for tests/admin CLI.
4. Add `soft` and `required` request-signature policy.
5. Add C++ request-proof payload builder tests.
6. Extend `production_decision_host` with a file-backed development key
   provider first, then platform key stores.
7. Add docs and installed consumer smoke coverage.

This produces a real security improvement while keeping default behavior
compatible and giving product teams a measured rollout path.
