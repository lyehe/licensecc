#!/usr/bin/env python3
"""Generate the project verification ring records from a checked-in manifest.

The hot/cold key split that the lease platform depends on is a property of the
*project verification ring* consumed by ``embedded_public_key_ring()`` in
``src/library/os/signature_verifier.hpp``:

    ring = [ embedded cold-root key ]  +  LCC_ADDITIONAL_PUBLIC_KEY_RECORDS

Before this script there was no producer for ``LCC_ADDITIONAL_PUBLIC_KEY_RECORDS``
/ ``LCC_RETIRED_PUBLIC_KEY_IDS`` — the only way to get a second (hot lease) key
into the ring was to hand-edit the generated, git-ignored ``public_key.h`` that a
rebuild clobbers (and which CLAUDE.md forbids touching). This makes the ring a
*regeneration-durable* artifact: it is produced deterministically from a
checked-in manifest of public-key DER files, so ``lccgen project initialize`` and
any rebuild reproduce the same 2-key ring.

It mirrors the existing config-attestation golden generator
(``test/vectors/config_attestation/_gen_embedded_golden.mjs``): same record shape
``license::os::SignaturePublicKey("sha256:<hex>", std::vector<uint8_t>{...}, bits)``
and the same CMake-string escaping, so the records flow through the
``target_compile_definitions`` wiring added in ``src/library/CMakeLists.txt``.

Manifest (JSON), paths relative to the manifest file's directory:

    {
      "additional": [
        { "der": "hot_key.pkcs1.der" }        // hot lease key(s); bits auto-derived
      ],
      "retired": [ "sha256:<64-hex>" ]         // key ids dropped from the ring
    }

Usage:
    python scripts/build_lease_ring.py --manifest <ring.json> --out <records.cmake>
"""

import argparse
import hashlib
import json
import os
import sys


def _read_len(der: bytes, i: int):
    """Read a DER length at offset i; return (length, next_offset)."""
    first = der[i]
    i += 1
    if first < 0x80:
        return first, i
    num = first & 0x7F
    if num == 0 or i + num > len(der):
        raise ValueError("malformed DER length")
    value = int.from_bytes(der[i : i + num], "big")
    return value, i + num


def rsa_public_key_bits(der: bytes) -> int:
    """Bit length of the RSA modulus in a PKCS#1 RSAPublicKey DER.

    RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER }
    """
    i = 0
    if der[i] != 0x30:
        raise ValueError("expected SEQUENCE")
    i += 1
    _seq_len, i = _read_len(der, i)
    if der[i] != 0x02:
        raise ValueError("expected modulus INTEGER")
    i += 1
    mod_len, i = _read_len(der, i)
    modulus = der[i : i + mod_len]
    # DER encodes a leading 0x00 when the high bit is set; strip it for the true size.
    while modulus and modulus[0] == 0x00:
        modulus = modulus[1:]
    return len(modulus) * 8


def key_id_for(der: bytes) -> str:
    return "sha256:" + hashlib.sha256(der).hexdigest()


def record_for(der: bytes) -> str:
    bits = rsa_public_key_bits(der)
    byte_list = ",".join(str(b) for b in der)
    return (
        f'license::os::SignaturePublicKey("{key_id_for(der)}", '
        f"std::vector<uint8_t>{{{byte_list}}}, {bits})"
    )


def escape_for_cmake_string(value: str) -> str:
    # Same escaping the config-attestation golden generator applies: backslash then quote.
    return value.replace("\\", "\\\\").replace('"', '\\"')


def main(argv) -> int:
    parser = argparse.ArgumentParser(description="Generate project ring records from a manifest.")
    parser.add_argument("--manifest", required=True, help="ring.json manifest path")
    parser.add_argument("--out", required=True, help="output .cmake file path")
    args = parser.parse_args(argv)

    manifest_dir = os.path.dirname(os.path.abspath(args.manifest))
    with open(args.manifest, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    records = []
    for entry in manifest.get("additional", []):
        der_path = os.path.join(manifest_dir, entry["der"])
        with open(der_path, "rb") as der_handle:
            der = der_handle.read()
        bits = rsa_public_key_bits(der)
        if bits < 3072:
            raise SystemExit(
                f"refusing ring record below the 3072-bit floor: {entry['der']} is {bits} bits"
            )
        records.append(record_for(der))

    retired = manifest.get("retired", [])
    for key_id in retired:
        if not key_id.startswith("sha256:") or len(key_id) != len("sha256:") + 64:
            raise SystemExit(f"retired key id must be 'sha256:<64-hex>': {key_id}")

    records_expr = escape_for_cmake_string(", ".join(records))
    retired_expr = escape_for_cmake_string(", ".join(f'"{k}"' for k in retired))

    lines = []
    if records:
        lines.append(
            f'set(LCC_ADDITIONAL_PUBLIC_KEY_RECORDS "{records_expr}" CACHE STRING '
            '"Additional project verification ring records (hot lease keys)" FORCE)'
        )
    if retired:
        lines.append(
            f'set(LCC_RETIRED_PUBLIC_KEY_IDS "{retired_expr}" CACHE STRING '
            '"Retired project verification ring key ids" FORCE)'
        )
    out = "\n".join(lines) + ("\n" if lines else "")

    with open(args.out, "w", encoding="utf-8", newline="\n") as out_handle:
        out_handle.write(out)

    print(
        f"build_lease_ring: {len(records)} additional record(s), {len(retired)} retired id(s) -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
