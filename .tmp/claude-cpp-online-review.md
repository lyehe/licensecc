# Online Verifier Review — Findings

## Critical

### C1. Revocation rollback: `revocation_seq` never compared to a persisted floor — `OnlineVerification.cpp:212-274`
`validate_claims` checks purpose/version/alg/status, every binding, hex fields, the time window, max-cache window, and nonce — but never compares `claims.revocation_seq` to a stored minimum. That field exists precisely to let a newer assertion advance a monotonic revocation counter so the client rejects anything older. With no persisted floor:
- A client that accepted seq=N can later accept a replayed seq<N assertion.
- Because the cache paths (H1) tolerate nonce mismatch and expiry, an attacker can retain an assertion captured *before* a license/feature was revoked and replay it for the entire cache window.

Revocation is the only server-side kill switch in an offline-tolerant protocol, and it is currently **non-binding on the client**. Highest impact.

## High

### H1. Cache acceptance bypasses freshness on two paths — `:257-260` and `:267-269`
- `:257-260` accepts a cached assertion despite **nonce mismatch** when `allow_cache && cache_until >= now`.
- `:267-269` accepts an **expired** assertion under the same condition.

Each is defensible as offline grace — a cached assertion can't echo a fresh nonce, and `cache_until` is meant to extend use past `exp`. The danger is that freshness is now delegated *entirely* to `cache_until` with **no revocation floor (C1)** behind it; the *combination* is what enables the rollback. Two things must hold, neither confirmable from this evidence:
1. `cache_until` is inside the signed payload (client cannot forge/extend it).
2. The max-cache-window check anchors `cache_until` to `issued_at`, not to a client-suppliable/far-future `exp` — otherwise a long-dated `exp` yields unbounded grace.

### H2. Canonical payload duplicated across languages, no conformance test — `:357-371` vs Worker `canonicalPayload` TS:282-298
The signed byte string is produced by two hand-maintained serializers that must stay byte-identical, with no shared schema and no cross-implementation test. Any drift — added field, ordering, integer/whitespace/escaping differences — silently breaks verification in production, or invites a "fix" that loosens verification. Made invisible by M1.

## Medium

### M1. C++ verifier only ever tested against self-signed assertions — test gap
C++ tests sign via `assertion_for`/`build_assertion_envelope`/`sign_payload` then verify; Worker tests only decode/check prefix/status/nonce. Nothing verifies a **Worker-signed** assertion in C++. The verifier is tested against its own canonicalization, so a C++/Worker divergence (H2) passes CI and fails only against real traffic — removing the safety net for the most fragile part of the protocol.

---

# Fixes

**Revocation floor (C1).** Persist the max observed `revocation_seq` per project/feature in tamper-resistant local storage. In `validate_claims`, after signature validation, reject `revocation_seq < floor` with a dedicated revocation/replay event; advance `floor = max(floor, revocation_seq)` only on full success. Run this on **all** accept paths, including the cache branches at `:257-269`, which currently reach acceptance without it. Keep this state internal (see ABI note).

**Bound the cache grace (H1).** Make cache acceptance explicit and ordered: require (a) valid signature, (b) `revocation_seq >= floor`, (c) `cache_until` present in the signed payload and `>= now`, (d) `cache_until <= issued_at + LCC_MAX_CACHE_WINDOW`. Confirm the window anchors on `issued_at`. Comment that nonce is intentionally not required in cache mode and freshness derives from `cache_until` + the revocation floor.

**Single source of truth for canonicalization (H2).** Prefer generating both serializers from one schema/spec. Minimum viable: commit canonical-byte golden vectors and assert C++ output equals them byte-for-byte, covering edge cases (empty optionals, unicode, large/zero ints, field ordering, boolean rendering).

**ABI-safe wrapper.** `acquire_license_ex` is ABI-pinned — keep it so. The revocation floor and cache state are internal; do **not** widen public structs to carry them. If revocation/cache status must reach callers, append fields at the end of a *versioned* struct guarded by a `size`/`flags`/version member, never reorder or resize existing fields, and never pass C++ types (`std::string`, containers) across the C boundary.

---

# Missing tests

1. **Rollback (C1):** assertion with `revocation_seq` below the persisted floor is rejected — on both fresh and cached paths; floor advances only after full success.
2. **Worker golden fixture (M1/H2):** Worker-signed envelopes committed as fixtures and verified by C++ in CI; symmetrically, Worker verifies C++ canonical bytes.
3. **Canonicalization byte-equality (H2):** C++ output vs committed expected strings across the edge cases above.
4. **Cache boundaries (H1):** `cache_until` at now-1/now/now+1; expired `exp` + valid `cache_until` accepted; expired `exp` + past `cache_until` rejected; far-future `exp` does not extend beyond `issued_at + MAX_CACHE_WINDOW`.
5. **Nonce semantics:** fresh-mode mismatch rejected; cache-mode mismatch accepted (documented expectation).
6. **Wrong-key/tamper:** extend self-signing tests to assert rejection under wrong key and mutated payload/signature.

---

# Unverifiable from this evidence (confirm before sign-off)
- Whether `revocation_seq` and a storage location for a floor already exist — C1's fix may require adding both.
- Whether `cache_until` is in the signed payload, and how the max-cache-window is anchored — these two facts decide H1's true severity.

**Bottom line:** C1 is a shippable-blocker — revocation is currently unenforceable on the client. H1 is the amplifier and H2/M1 mean a canonicalization break would reach production untested. Fix the floor first, gate all cache paths through it, then add the Worker-signed golden fixture.
