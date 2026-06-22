# Lease ring test material

This directory holds the lease platform's hot/cold key ring test support. It is
intentionally empty of key material: **no private keys are committed** (the
secret-hygiene gate forbids it, and private keys must stay git-ignored).

## How the golden test gets its hot key

When configured with `-DLCC_BUILD_LEASE_RING_TEST=ON`, `cmake/LeaseRing.cmake`
(`lcc_generate_test_lease_ring`) generates an **ephemeral** 3072-bit hot lease
keypair into `${CMAKE_BINARY_DIR}/lease_test_ring/` (the build tree, git-ignored),
derives the records via `scripts/build_lease_ring.py`, and passes the private-key
path and key-id to `test_lease_ring` as compile definitions. The key never enters
version control.

## Production manifest format

For a real project, a lease ring manifest lists the **public** DER of each hot
lease key (public keys are safe to commit) plus any retired key ids:

```json
{
  "additional": [
    { "der": "hot_lease_key.pkcs1.der" }
  ],
  "retired": [ "sha256:<64-hex of a dropped key>" ]
}
```

Apply it at configure time:

```
cmake .. -DLCC_LEASE_RING_MANIFEST=/path/to/ring.json
```

`scripts/build_lease_ring.py` reads the manifest, derives each key id
(`sha256:<hex of the PKCS#1 DER>`) and modulus bit length, enforces the 3072-bit
floor, and emits `LCC_ADDITIONAL_PUBLIC_KEY_RECORDS` / `LCC_RETIRED_PUBLIC_KEY_IDS`
into the build. The cold-root key is always the project's embedded `public_key.h`
key; the manifest only adds the hot lease key(s).
