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
`project init --key-bits` accepts only 3072 or 4096. The runtime keeps
reading v200 licenses independently of this generator change.

`licensecc` also raised this vendored copy's OpenSSL floor to 3.0: its
`CMakeLists.txt` requests `find_package(OpenSSL 3.0 ...)` and no longer falls
back to Zlib for pre-3.0 OpenSSL, and `src/base_lib/openssl/crypto_helper_ssl.cpp`
no longer calls the legacy `ERR_load_ERR_strings`/`ERR_load_crypto_strings`/
`OpenSSL_add_all_algorithms` global init (unnecessary since OpenSSL 1.1.0 and
removed in OpenSSL 3.0) and uses `EVP_MD_CTX_new`/`EVP_MD_CTX_free` instead of
the deprecated `EVP_MD_CTX_create`/`EVP_MD_CTX_destroy`.
