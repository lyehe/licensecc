#include <openssl/core_names.h>
#include <openssl/crypto.h>
#include <openssl/encoder.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/opensslv.h>
#include <openssl/params.h>
#include <openssl/provider.h>
#include <openssl/x509.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

namespace {

using LibraryContext = std::unique_ptr<OSSL_LIB_CTX, decltype(&OSSL_LIB_CTX_free)>;
using PkeyContext = std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)>;
using Pkey = std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)>;
using MessageDigest = std::unique_ptr<EVP_MD, decltype(&EVP_MD_free)>;
using EncoderContext = std::unique_ptr<OSSL_ENCODER_CTX, decltype(&OSSL_ENCODER_CTX_free)>;

class Provider final {
public:
    explicit Provider(OSSL_PROVIDER* provider) : provider_(provider) {}
    ~Provider() {
        if (provider_ != nullptr) {
            (void)OSSL_PROVIDER_unload(provider_);
        }
    }

    Provider(const Provider&) = delete;
    Provider& operator=(const Provider&) = delete;

    OSSL_PROVIDER* get() const noexcept { return provider_; }

private:
    OSSL_PROVIDER* provider_ = nullptr;
};

constexpr std::array<std::uint8_t, 32> kDigest = {{
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80,
    0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0xf0, 0x01}};

constexpr std::array<std::uint8_t, 32> kP256Order = {{
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84,
    0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51}};

void print_errors(const char* operation) {
    std::cerr << operation << " failed";
    bool first = true;
    for (unsigned long error = ERR_get_error(); error != 0U; error = ERR_get_error()) {
        char buffer[256]{};
        ERR_error_string_n(error, buffer, sizeof(buffer));
        std::cerr << (first ? ": " : "; ") << buffer;
        first = false;
    }
    std::cerr << '\n';
}

bool require(bool condition, const char* message) {
    if (!condition) {
        std::cerr << message << '\n';
    }
    return condition;
}

bool scalar_in_range(const std::uint8_t* scalar) {
    bool nonzero = false;
    for (std::size_t index = 0U; index < 32U; ++index) {
        nonzero = nonzero || scalar[index] != 0U;
    }
    if (!nonzero) {
        return false;
    }
    for (std::size_t index = 0U; index < 32U; ++index) {
        if (scalar[index] < kP256Order[index]) {
            return true;
        }
        if (scalar[index] > kP256Order[index]) {
            return false;
        }
    }
    return false;
}

bool read_der_integer(const std::uint8_t* der,
                      std::size_t size,
                      std::size_t& offset,
                      const std::uint8_t*& value,
                      std::size_t& value_size) {
    if (offset + 2U > size || der[offset++] != 0x02U) {
        return false;
    }
    const std::size_t encoded_size = der[offset++];
    if (encoded_size == 0U || encoded_size >= 0x80U || offset + encoded_size > size) {
        return false;
    }
    value = der + offset;
    offset += encoded_size;
    if ((value[0] & 0x80U) != 0U) {
        return false;
    }
    if (value[0] == 0U) {
        if (encoded_size == 1U || (value[1] & 0x80U) == 0U) {
            return false;
        }
        ++value;
        value_size = encoded_size - 1U;
    } else {
        value_size = encoded_size;
    }
    return value_size != 0U && value_size <= 32U;
}

bool der_to_p1363(const std::vector<std::uint8_t>& der, std::array<std::uint8_t, 64>& out) {
    if (der.size() < 8U || der.size() > 72U || der[0] != 0x30U || der[1] >= 0x80U ||
        static_cast<std::size_t>(der[1]) + 2U != der.size()) {
        return false;
    }
    std::size_t offset = 2U;
    const std::uint8_t* r = nullptr;
    const std::uint8_t* s = nullptr;
    std::size_t r_size = 0U;
    std::size_t s_size = 0U;
    if (!read_der_integer(der.data(), der.size(), offset, r, r_size) ||
        !read_der_integer(der.data(), der.size(), offset, s, s_size) || offset != der.size()) {
        return false;
    }
    out.fill(0U);
    std::memcpy(out.data() + 32U - r_size, r, r_size);
    std::memcpy(out.data() + 64U - s_size, s, s_size);
    return scalar_in_range(out.data()) && scalar_in_range(out.data() + 32U);
}

std::string provider_param(const OSSL_PROVIDER* provider, const char* name) {
    char* value = nullptr;
    OSSL_PARAM params[] = {
        OSSL_PARAM_construct_utf8_ptr(name, &value, 0U),
        OSSL_PARAM_construct_end()};
    if (OSSL_PROVIDER_get_params(const_cast<OSSL_PROVIDER*>(provider), params) != 1) {
        return {};
    }
    return value == nullptr ? std::string() : std::string(value);
}

bool export_public_spki(OSSL_LIB_CTX* libctx, EVP_PKEY* key, Pkey& out) {
    EncoderContext encoder(OSSL_ENCODER_CTX_new_for_pkey(
                               key, EVP_PKEY_PUBLIC_KEY, "DER", "SubjectPublicKeyInfo", nullptr),
                           OSSL_ENCODER_CTX_free);
    if (!encoder) {
        print_errors("OSSL_ENCODER_CTX_new_for_pkey");
        return false;
    }
    unsigned char* encoded = nullptr;
    std::size_t encoded_size = 0U;
    if (OSSL_ENCODER_to_data(encoder.get(), &encoded, &encoded_size) != 1 || encoded == nullptr ||
        encoded_size != 91U) {
        OPENSSL_free(encoded);
        print_errors("OSSL_ENCODER_to_data");
        return false;
    }
    const unsigned char* cursor = encoded;
    EVP_PKEY* public_key = d2i_PUBKEY_ex(nullptr, &cursor, static_cast<long>(encoded_size), libctx, "provider=default");
    const bool complete = public_key != nullptr && cursor == encoded + encoded_size;
    OPENSSL_free(encoded);
    if (!complete) {
        EVP_PKEY_free(public_key);
        print_errors("d2i_PUBKEY_ex");
        return false;
    }
    out.reset(public_key);
    return true;
}

bool sign_digest(OSSL_LIB_CTX* libctx,
                 EVP_PKEY* key,
                 const std::array<std::uint8_t, 32>& digest,
                 std::vector<std::uint8_t>& signature) {
    PkeyContext context(EVP_PKEY_CTX_new_from_pkey(libctx, key, "provider=tpm2"), EVP_PKEY_CTX_free);
    MessageDigest sha256(EVP_MD_fetch(libctx, "SHA256", "provider=default"), EVP_MD_free);
    if (!context || EVP_PKEY_sign_init(context.get()) <= 0 ||
        !sha256 || EVP_PKEY_CTX_set_signature_md(context.get(), sha256.get()) <= 0) {
        print_errors("EVP_PKEY_sign_init");
        return false;
    }
    std::size_t signature_size = 0U;
    if (EVP_PKEY_sign(context.get(), nullptr, &signature_size, digest.data(), digest.size()) <= 0 ||
        signature_size < 8U || signature_size > 72U) {
        print_errors("EVP_PKEY_sign size");
        return false;
    }
    signature.resize(signature_size);
    if (EVP_PKEY_sign(context.get(), signature.data(), &signature_size, digest.data(), digest.size()) <= 0 ||
        signature_size < 8U || signature_size > signature.size()) {
        print_errors("EVP_PKEY_sign");
        return false;
    }
    signature.resize(signature_size);
    return true;
}

bool verify_digest(OSSL_LIB_CTX* libctx,
                   EVP_PKEY* public_key,
                   const std::vector<std::uint8_t>& signature,
                   const std::array<std::uint8_t, 32>& digest,
                   int expected) {
    PkeyContext context(EVP_PKEY_CTX_new_from_pkey(libctx, public_key, "provider=default"), EVP_PKEY_CTX_free);
    MessageDigest sha256(EVP_MD_fetch(libctx, "SHA256", "provider=default"), EVP_MD_free);
    if (!context || EVP_PKEY_verify_init(context.get()) <= 0 ||
        !sha256 || EVP_PKEY_CTX_set_signature_md(context.get(), sha256.get()) <= 0) {
        print_errors("EVP_PKEY_verify_init");
        return false;
    }
    const int result = EVP_PKEY_verify(context.get(), signature.data(), signature.size(), digest.data(), digest.size());
    return require(result == expected, expected == 1 ? "original digest verification failed" :
                                                    "double-hashed digest was accepted");
}

bool run_capability() {
    std::cout << "openssl=" << OpenSSL_version(OPENSSL_VERSION) << '\n';

    LibraryContext libctx(OSSL_LIB_CTX_new(), OSSL_LIB_CTX_free);
    if (!require(static_cast<bool>(libctx), "OSSL_LIB_CTX_new failed")) {
        print_errors("OSSL_LIB_CTX_new");
        return false;
    }

    Provider default_provider(OSSL_PROVIDER_load(libctx.get(), "default"));
    if (!require(default_provider.get() != nullptr, "default provider load failed")) {
        print_errors("OSSL_PROVIDER_load default");
        return false;
    }
    Provider tpm2_provider(OSSL_PROVIDER_load(libctx.get(), "tpm2"));
    if (!require(tpm2_provider.get() != nullptr, "tpm2 provider load failed")) {
        print_errors("OSSL_PROVIDER_load tpm2");
        return false;
    }
    std::cout << "provider=" << OSSL_PROVIDER_get0_name(tpm2_provider.get())
              << " version=" << provider_param(tpm2_provider.get(), OSSL_PROV_PARAM_VERSION) << '\n';
    std::cout << "provider_load_order=default,tpm2\n";

    PkeyContext generation(EVP_PKEY_CTX_new_from_name(libctx.get(), "EC", "provider=tpm2"), EVP_PKEY_CTX_free);
    if (!require(static_cast<bool>(generation), "EVP_PKEY_CTX_new_from_name failed")) {
        print_errors("EVP_PKEY_CTX_new_from_name");
        return false;
    }
    if (!require(EVP_PKEY_keygen_init(generation.get()) > 0, "EVP_PKEY_keygen_init failed")) {
        print_errors("EVP_PKEY_keygen_init");
        return false;
    }
    char group[] = "prime256v1";
    char digest_name[] = "SHA256";
    unsigned int parent = 0x40000001U; /* TPM2_RH_OWNER */
    OSSL_PARAM generation_params[] = {
        OSSL_PARAM_construct_utf8_string(OSSL_PKEY_PARAM_GROUP_NAME, group, 0U),
        OSSL_PARAM_construct_utf8_string(OSSL_PKEY_PARAM_DIGEST, digest_name, 0U),
        OSSL_PARAM_construct_uint("parent", &parent),
        OSSL_PARAM_construct_end()};
    if (!require(EVP_PKEY_CTX_set_params(generation.get(), generation_params) > 0,
                 "TPM2 P-256 owner generation parameters rejected")) {
        print_errors("EVP_PKEY_CTX_set_params");
        return false;
    }
    EVP_PKEY* generated_raw = nullptr;
    if (!require(EVP_PKEY_generate(generation.get(), &generated_raw) > 0 && generated_raw != nullptr,
                 "TPM2 P-256 owner key generation failed")) {
        print_errors("EVP_PKEY_generate");
        EVP_PKEY_free(generated_raw);
        return false;
    }
    Pkey generated(generated_raw, EVP_PKEY_free);
    const OSSL_PROVIDER* owning_provider = EVP_PKEY_get0_provider(generated.get());
    if (!require(owning_provider != nullptr &&
                     std::string(OSSL_PROVIDER_get0_name(owning_provider)) == "tpm2",
                 "generated key is not owned by the tpm2 provider")) {
        return false;
    }
    std::cout << "key_provider=tpm2\n";
    std::array<char, 32> actual_group{};
    std::size_t actual_group_size = 0U;
    if (!require(EVP_PKEY_get_utf8_string_param(generated.get(),
                                                OSSL_PKEY_PARAM_GROUP_NAME,
                                                actual_group.data(),
                                                actual_group.size(),
                                                &actual_group_size) > 0 &&
                     std::string(actual_group.data(), actual_group_size) == "prime256v1",
                 "generated key does not report prime256v1")) {
        return false;
    }
    std::cout << "key_group=prime256v1\n";

    Pkey public_key(nullptr, EVP_PKEY_free);
    if (!export_public_spki(libctx.get(), generated.get(), public_key)) {
        return false;
    }
    std::cout << "spki_der_len=91\n";
    std::vector<std::uint8_t> signature_der;
    if (!sign_digest(libctx.get(), generated.get(), kDigest, signature_der)) {
        return false;
    }
    std::array<std::uint8_t, 64> signature_p1363{};
    if (!require(der_to_p1363(signature_der, signature_p1363), "provider returned non-canonical ECDSA DER")) {
        return false;
    }
    std::cout << "signature_der_bytes=" << signature_der.size() << " signature_p1363_bytes="
              << signature_p1363.size() << '\n';
    std::cout << "evp_pkey_sign_input_len=" << kDigest.size() << '\n';

    if (!verify_digest(libctx.get(), public_key.get(), signature_der, kDigest, 1)) {
        return false;
    }
    std::cout << "verify_original_digest=PASS\n";
    std::array<std::uint8_t, 32> double_hash{};
    std::size_t double_hash_size = 0U;
    if (!require(EVP_Q_digest(libctx.get(),
                              "SHA256",
                              "provider=default",
                              kDigest.data(),
                              kDigest.size(),
                              double_hash.data(),
                              &double_hash_size) == 1 &&
                     double_hash_size == double_hash.size(),
                 "SHA-256(digest) calculation failed")) {
        return false;
    }
    /* SHA256(digest) is deliberately the negative control for exact signing. */
    if (!verify_digest(libctx.get(), public_key.get(), signature_der, double_hash, 0)) {
        return false;
    }
    std::cout << "verify_sha256_of_digest=REJECTED\n";
    return true;
}

}  // namespace

int main() {
    if (std::getenv("LCC_TPM2_CAPABILITY_PREREQUISITE") == nullptr) {
        std::cerr << "TPM2 capability prerequisite marker absent; skipping\n";
        return 77;
    }
    try {
        if (!run_capability()) {
            return 1;
        }
        std::cout << "raw_digest_probe=PASS\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "TPM2 capability test exception: " << error.what() << '\n';
        return 1;
    } catch (...) {
        std::cerr << "TPM2 capability test unknown exception\n";
        return 1;
    }
}
