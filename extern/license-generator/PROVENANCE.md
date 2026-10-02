# Vendored generator provenance

This is ordinary source owned and reviewed in the `licensecc` repository; it
is not a Git submodule and no build or bootstrap command fetches it.

It was imported on 2026-08-10 from
[`open-license-manager/lcc-license-generator`](https://github.com/open-license-manager/lcc-license-generator)
at reviewed commit `74996a7d345df7b9a7cb46a08d423cb738217ed1`.

The upstream BSD 3-Clause license is retained verbatim in [LICENSE](LICENSE).
Future changes are reviewed and committed with `licensecc`; an intentional
upstream refresh must preserve this provenance and license notice.

`licensecc` removed v200 license issuance and the weak-key CLI options
(`--legacy-rsa1024`, `--allow-insecure-key-size`, `project migrate-weak-key`)
from this vendored copy: `license issue` now always emits v201, and
`project init --key-bits` accepts only 3072 or 4096. The `licensecc` runtime
likewise accepts only v201 license files.

`licensecc` also raised this vendored copy's OpenSSL floor to 3.0: its
`CMakeLists.txt` requests `find_package(OpenSSL 3.0 ...)` and no longer falls
back to Zlib for pre-3.0 OpenSSL, and
`src/base_lib/openssl/crypto_helper_ssl.cpp` removed the pre-3.0 OpenSSL
initialisation calls (unnecessary since OpenSSL 1.1.0 and removed outright in
OpenSSL 3.0) and switched the digest context to the OpenSSL 3.0 allocation
API.

`licensecc` also changed the `license issue` command's text: its help gives
dates as `YYYY-MM-DD` (the compact `YYYYMMDD` form is still accepted) and says
an omitted `--valid-from` leaves the license without a start date, and a
license written to a file is reported with its path and a one-line summary of
the project, features, `valid-from` and `valid-to`, and client-signature
binding.

The test fixtures that carry golden values use the 3072-bit
`test/data/private_key_3072.rsa`: the crypto-helper public key and signature
in `test/cryptohelper_test.cpp`, and the v201 payloads under `test/data/v201/`,
which `scripts/generate-v201-golden-vectors.mjs` in `licensecc` writes together
with the runtime's `test/vectors/v201/`. The 1024-bit `test/data/private_key.rsa`
remains only to prove that issuance refuses a weak project key; the unused
1024-bit `test/data/public_key.rsa` was removed.
