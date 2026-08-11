#include "p256_crypto.hpp"

#include <openssl/ec.h>
#include <openssl/evp.h>
#include <openssl/obj_mac.h>
#include <openssl/opensslv.h>
#include <openssl/x509.h>
#if OPENSSL_VERSION_NUMBER >= 0x30000000L
#include <openssl/core_names.h>
#endif

#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace license {
namespace device_identity {
namespace {

using PkeyPtr = std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)>;
using PkeyContextPtr = std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)>;

PkeyPtr parse_public_key(const P256Spki& spki) {
    const unsigned char* cursor = spki.data();
    EVP_PKEY* raw = d2i_PUBKEY(nullptr, &cursor, static_cast<long>(spki.size()));
    PkeyPtr key(raw, EVP_PKEY_free);
    if (!key || cursor != spki.data() + spki.size() || EVP_PKEY_base_id(key.get()) != EVP_PKEY_EC ||
        EVP_PKEY_bits(key.get()) != 256) {
        return PkeyPtr(nullptr, EVP_PKEY_free);
    }
    return key;
}

bool has_p256_group(EVP_PKEY* key) {
#if OPENSSL_VERSION_NUMBER >= 0x30000000L
    char group_name[64]{};
    std::size_t written = 0U;
    if (EVP_PKEY_get_utf8_string_param(key, OSSL_PKEY_PARAM_GROUP_NAME, group_name, sizeof(group_name), &written) !=
        1) {
        return false;
    }
    const std::string group(group_name, written);
    return group == "prime256v1" || group == "secp256r1" || group == "P-256";
#else
    EC_KEY* ec = EVP_PKEY_get1_EC_KEY(key);
    if (ec == nullptr) {
        return false;
    }
    const EC_GROUP* group = EC_KEY_get0_group(ec);
    const bool result = group != nullptr && EC_GROUP_get_curve_name(group) == NID_X9_62_prime256v1;
    EC_KEY_free(ec);
    return result;
#endif
}

}  // namespace

bool sha256(const std::uint8_t* data, std::size_t size, P256Digest& out) noexcept {
    if (data == nullptr && size != 0U) {
        return false;
    }
    SensitiveArray<32> candidate;
    unsigned int written = 0U;
    const unsigned char empty = 0U;
    if (EVP_Digest(size == 0U ? &empty : data,
                   size,
                   candidate.value.data(),
                   &written,
                   EVP_sha256(),
                   nullptr) != 1 ||
        written != candidate.value.size()) {
        return false;
    }
    out = candidate.value;
    return true;
}

namespace detail {

bool platform_validate_p256_spki(const P256Spki& spki) noexcept {
    try {
        PkeyPtr key = parse_public_key(spki);
        if (!key || !has_p256_group(key.get())) {
            return false;
        }
        PkeyContextPtr context(EVP_PKEY_CTX_new(key.get(), nullptr), EVP_PKEY_CTX_free);
        return context && EVP_PKEY_public_check(context.get()) == 1;
    } catch (...) {
        return false;
    }
}

bool platform_verify_p256_p1363(const P256Spki& spki,
                                const P256Digest& digest,
                                const P256Signature& signature) noexcept {
    try {
        PkeyPtr key = parse_public_key(spki);
        if (!key || !has_p256_group(key.get())) {
            return false;
        }
        SensitiveVector der;
        if (!p1363_signature_to_der(signature, der.value)) {
            return false;
        }
        PkeyContextPtr context(EVP_PKEY_CTX_new(key.get(), nullptr), EVP_PKEY_CTX_free);
        if (!context || EVP_PKEY_verify_init(context.get()) <= 0 ||
            EVP_PKEY_CTX_set_signature_md(context.get(), EVP_sha256()) <= 0) {
            return false;
        }
        return EVP_PKEY_verify(
                   context.get(), der.value.data(), der.value.size(), digest.data(), digest.size()) == 1;
    } catch (...) {
        return false;
    }
}

}  // namespace detail
}  // namespace device_identity
}  // namespace license
