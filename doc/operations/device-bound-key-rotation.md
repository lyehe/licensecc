# Rotate protected-device keys

This runbook covers the staged device-bound protocol. It specifies required
release evidence; it does not claim that a remote rotation has been qualified.
The backend owner controls signing and approval secrets. The application release
owner controls native public trust. Coordinate both before changing a signer.

## Separate key purposes

| Material | Authority | Rotation constraint |
| --- | --- | --- |
| `BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM` and matching public SPKI | Backend signs new protected leases with RSA-3072/SHA-256 | One active pair; key ID derives from SPKI. No fallback to legacy signing keys. |
| Application public trust keys | Native lease and checkpoint verification | Public API accepts at most eight trusted keys. Trust comes from the application release, never from a token or an end-user setting. |
| `BOUND_APPROVAL_ENCRYPTION_KEYS` | Backend encrypts browser approval recovery | AES-GCM ring with one active key and at most three total keys; independent of lease signing. |
| Device private key | Application/user identity | Signer rotation does not replace this key, enroll again or surrender a slot. |

The standalone Windows example accepts one primary public key and optional
`LCC_BOUND_ADDITIONAL_SIGNING_SPKIS` for overlap, up to eight keys in total.
See `examples/device_bound/README.md` in the repository for configuration instructions.
A production integration must ship both keys through the native trust array
before switching issuance; merely configuring the backend is insufficient.

## Routine lease-signer rotation

1. Inventory supported application releases, both checkpoint slots, active backend
   versions, exact-response recovery, offline leases and rollback artifacts.
   Record public key IDs and version IDs only. Keep private material in the
   authorized secret store, outside source, client artifacts and command output.
2. Prepare a new independently generated RSA-3072 pair and verify that signing
   with the private key verifies against its public SPKI. Keep the old signer
   active while distributing an application release that trusts both public keys.
   Prove this release can open old checkpoints, renew and save new checkpoints.
   Both public trust entries must have `retired=0`: native `retired=1` rejects
   leases and saved checkpoints; it is not a verification-only setting.
3. Require the supported client cohort to have the overlap release before
   switching server issuance. Old clients trusting only the old key cannot accept
   new-key leases. The server has no client-version-based signer selection or
   automatic legacy fallback; do not assume gradual traffic routing solves this.
   Native owners copy trust when created. Installing an overlap build does not
   update an already-open owner; require reopening under the overlap release.
4. Prepare a backend version with the new matched private/public pair. Qualify
   exchange, renewal and response-loss recovery with the overlap client before
   routing the cohort to it. A mismatched pair is rejected before lease commit;
   sequential live edits can therefore create an outage. Treat the pair as one
   reviewed deployment configuration and preserve the rollback version's pairing.
5. Stop old-key issuance on every serving version and record that boundary.
   Establish this after old-version and in-flight issuance drains, rather than
   treating the traffic-switch timestamp as the final old-key issuance time.
   Exercise an old-key operation retry: authenticated recovery returns its exact
   stored response, not a freshly signed replacement. Clients must still verify
   that response using the old public key. Never rewrite operation history or
   shorten binding holds to accelerate retirement.
6. Retire private signing capability only after the rollback/support decision
   permits it. Retire public trust separately: old-key checkpoints can remain on
   disk beyond lease expiry and still need signature verification before online
   renewal. A 24-hour lease drain or 48-hour response-retention interval alone
   does not justify removing the public key. Require checkpoint migration or an
   explicitly supported recovery path for the affected cohort first.

Both checkpoint slots must migrate. An untrusted old slot prevents loading even
when the other slot contains a newer valid token. A signer change does not itself
make a checkpoint newer: distinct tokens with equal revision and issuance time
conflict. Preserve stored state and obtain a fresh, later-issued renewal; never
delete a slot or reset its revision floor to force migration. `MIRROR_PENDING`
or `COMMIT_UNKNOWN` does not establish completed migration of both slots.

Native checkpoint loading validates persisted signatures; a missing trusted key
fails closed. No automatic re-enrollment, key deletion or unsigned-checkpoint
bootstrap is provided. The eight-key limit therefore requires a real checkpoint
migration/support policy before repeated rotations exhaust the trust set.

## Approval-encryption rotation

Add the new AES key as a decryptor and distribute that ring to every serving and
rollback-capable version before any version makes it active for new ciphertext.
Then activate it and retain preceding keys for eligible recovery. Verify that old ciphertext still
opens after the switch and new ciphertext uses the new key ID. Do not change an
existing key ID's bytes or reuse that ID for another key.

Remove an old decryptor only after every relevant serving/rollback version has
stopped using it and all affected approval recovery deadlines have ended.
Use persisted code/attempt deadlines and current authority checks; do not infer
this from a successful cleanup sweep. Restored backups retain their original
deadlines and must not revive expired recovery. Denial recovery uses the generic
mutation-idempotency store, not this AES ring. Record any backup recovery need
for historical decryptors in the restricted secret inventory; do not retain
secrets merely to bypass logical expiry. Keep the ring within its three-key limit.

## Compromise and rollback

Compromise requires an incident decision, not routine overlap with the compromised
key. Stop compromised signing and distribute corrected client trust. Removing a
server secret cannot invalidate signatures already accepted offline; account
disable or retirement stops future issuance but does not immediately revoke
offline authority. Re-establishing trust in old checkpoints needs a reviewed
recovery path. Do not promise immediate revocation to offline clients.

Rollback must preserve protected enforcement mode, generations, device identities
and slot holds. Roll back only to a version whose signer pair and approval ring
are available and compatible with the supported client trust. An old backup or
old Worker version is not by itself sufficient rollback evidence.

## Required evidence

Record source and deployed version IDs, public key IDs, supported client versions,
the final old-key issuance boundary, and the decision for private-key retirement
and public-trust removal. Demonstrate old/new verification, mixed-pair rejection,
old-checkpoint restart followed by new-key renewal, both checkpoint-slot migration,
exact old-response recovery, approval overlap, and compatible rollback. Include
negative tests for an unknown key and a removed key. State which checks used a
real native client and deployed backend. Keep secrets, tokens and customer rows
out of the report. Link evidence from the production-readiness gate; a written
procedure alone does not qualify rotation.
