# Online-signing key rotation runbook (audit R4.5)

**Date:** 2026-07-01
**Scope:** rotating the RSA online-assertion signing key (`ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM` /
`ONLINE_SIGNING_KEY_ID`) that `POST /v1/verify` and the seat endpoints use to sign `lccoa1.` tokens,
with **zero downtime** — no client rejects a valid assertion during the overlap.

## Why this works without server-side dual-accept

The server **signs**; it never **verifies** assertions — the C++ library and the language SDKs verify
them. Both verifier sides already accept a **ring** of trusted keys and enforce a **retired-key list**:

- **C++:** `-DLCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS=...` is a *list* of `SignaturePublicKey` records;
  `-DLCC_ONLINE_ASSERTION_RETIRED_KEY_IDS=...` rejects a key-id before crypto
  (`src/library/os/signature_verifier.hpp`). Tokens are selected strictly by their `key-id` claim.
- **SDKs (audit R1.3):** `verify_online_assertion(..., retired_key_ids=...)` (Python) /
  `OnlineAssertionExpected.RetiredKeyIds` (.NET) reject a retired key-id before crypto, over a
  `trusted_keys` ring that may hold both the old and new key.

So a client that has BOTH the old and new public key in its ring accepts assertions signed by either.
Rotation is therefore: **publish the new key to clients first, then flip the server to sign with it,
then retire the old key once no old-signed assertion can still be cached.**

## The 5-step rotation (zero downtime)

Each `lccoa1.` assertion is cached client-side only until its `cache-until` (bounded by
`MAX_CACHE_TTL_SECONDS`, default 86400 = 24h). Call that window **T_cache**.

1. **Mint the new key.** From `services/cloudflare-licensing-backend/`:
   ```console
   npm run generate-online-key -- --out-dir .online-key-new
   ```
   Record the new PKCS#8 PEM, the printed `key id: sha256:<hex>`, and the emitted
   `-DLCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS=...` record.

2. **Ship the new PUBLIC key to every client, keeping the old one.** Add the new record to each
   consumer's `LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS` (C++ build) and to the SDK `trusted_keys`
   ring, alongside the current key. Roll this out and confirm clients are updated. Now every client
   accepts **both** the old and the new key-id. (Do NOT touch the server yet.)

3. **Flip the server to sign with the new key.** Set the Worker secrets
   `ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM` (new PKCS#8) and `ONLINE_SIGNING_KEY_ID` (new
   `sha256:<hex>`), then `npx wrangler deploy`. From this instant new assertions carry the new key-id;
   already-issued old-key assertions remain valid in caches until their `cache-until`.

4. **Wait out T_cache.** After `MAX_CACHE_TTL_SECONDS` (default 24h) no old-key assertion can still be
   cached anywhere — every live assertion is new-key-signed.

5. **Retire the old key.** Add the OLD key-id to `LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS` (C++) and the
   SDK retired set, and roll that out. You may drop the old public record from the ring at the same
   time. The old key-id now fails closed everywhere (a replayed old assertion is rejected pre-crypto).
   Destroy the old private key material.

## Rollback

If step 3 misbehaves, revert the two Worker secrets to the old key and re-deploy — clients still trust
the old key (you have not retired it), so this is safe. Never retire a key (step 5) before T_cache has
elapsed since step 3, or a still-cached assertion would be rejected mid-window.

## Config-attestation and lease keys

The **config-attestation** key (`lcccfg1.`, `LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS` /
`..._RETIRED_KEY_IDS`) rotates identically — signed offline by `config-sign.mjs`, so there is no
server flip in step 3; instead you switch which private key the signer uses after step 2. The
**lease** signing key follows the same publish-then-flip-then-retire discipline against its own ring.

## Notes / current limits

- `ALGORITHM = "rsa-pkcs1-sha256"` is fixed on both sides; an algorithm change is a coordinated
  signed-token version bump + golden-vector regen (the ABI landmine), not a routine rotation.
- An in-Worker active-keys *map* (sign-by-selectable-kid without redeploying) is an optional ergonomic
  enhancement; the publish-then-flip procedure above needs only a secret change + deploy and is
  zero-downtime as-is, so it is not required for safe rotation.
