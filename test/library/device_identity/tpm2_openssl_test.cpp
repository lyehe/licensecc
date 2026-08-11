#ifdef LCC_TPM2_OPENSSL_PRODUCTION_TEST

#include "device_key_provider.hpp"
#include "openssl3_api.hpp"
#include "posix_storage_api.hpp"

#include <openssl/err.h>

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <sys/stat.h>
#include <unistd.h>

namespace {

using license::device_identity::OpenSsl3Api;
using license::device_identity::PosixStorageApi;
using license::device_identity::ProviderOpenRequest;

void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

class FakeOpenSsl3Api final : public OpenSsl3Api {
public:
    explicit FakeOpenSsl3Api(bool provide_tpm2 = false) : provide_tpm2_(provide_tpm2) {}

    OSSL_LIB_CTX* libctx_new() noexcept override {
        calls.push_back("libctx_new");
        return reinterpret_cast<OSSL_LIB_CTX*>(static_cast<std::uintptr_t>(1U));
    }
    void libctx_free(OSSL_LIB_CTX*) noexcept override { calls.push_back("libctx_free"); }
    OSSL_PROVIDER* provider_load(OSSL_LIB_CTX*, const char* name) noexcept override {
        calls.push_back(std::string("provider_load:") + name);
        if (std::string(name) == "default") {
            return reinterpret_cast<OSSL_PROVIDER*>(static_cast<std::uintptr_t>(2U));
        }
        if (provide_tpm2_ && std::string(name) == "tpm2") {
            return reinterpret_cast<OSSL_PROVIDER*>(static_cast<std::uintptr_t>(3U));
        }
        ERR_raise(ERR_LIB_USER, ERR_R_INTERNAL_ERROR);
        return nullptr;
    }
    int provider_unload(OSSL_PROVIDER* provider) noexcept override {
        calls.push_back(provider == reinterpret_cast<OSSL_PROVIDER*>(static_cast<std::uintptr_t>(2U)) ?
                            "provider_unload:default" :
                            provider == reinterpret_cast<OSSL_PROVIDER*>(static_cast<std::uintptr_t>(3U)) ?
                                "provider_unload:tpm2" : "provider_unload:unknown");
        return 1;
    }
    EVP_PKEY_CTX* pkey_ctx_new_from_name(OSSL_LIB_CTX*, const char*, const char*) noexcept override { return nullptr; }
    EVP_PKEY_CTX* pkey_ctx_new_from_pkey(OSSL_LIB_CTX*, EVP_PKEY*, const char*) noexcept override { return nullptr; }
    void pkey_ctx_free(EVP_PKEY_CTX*) noexcept override {}
    int pkey_keygen_init(EVP_PKEY_CTX*) noexcept override { return 0; }
    int pkey_ctx_set_params(EVP_PKEY_CTX*, const OSSL_PARAM*) noexcept override { return 0; }
    int pkey_generate(EVP_PKEY_CTX*, EVP_PKEY**) noexcept override { return 0; }
    int pkey_sign_init(EVP_PKEY_CTX*) noexcept override { return 0; }
    int pkey_verify_init(EVP_PKEY_CTX*) noexcept override { return 0; }
    int pkey_ctx_set_signature_md(EVP_PKEY_CTX*, const EVP_MD*) noexcept override { return 0; }
    int pkey_sign(EVP_PKEY_CTX*, unsigned char*, std::size_t*, const unsigned char*, std::size_t) noexcept override {
        return 0;
    }
    int pkey_verify(EVP_PKEY_CTX*, const unsigned char*, std::size_t, const unsigned char*, std::size_t) noexcept override {
        return 0;
    }
    EVP_MD* md_fetch(OSSL_LIB_CTX*, const char*, const char*) noexcept override { return nullptr; }
    void md_free(EVP_MD*) noexcept override {}
    void pkey_free(EVP_PKEY*) noexcept override {}
    const OSSL_PROVIDER* pkey_get0_provider(const EVP_PKEY*) noexcept override { return nullptr; }
    const char* provider_name(const OSSL_PROVIDER*) noexcept override { return nullptr; }
    int pkey_get_utf8_string_param(const EVP_PKEY*, const char*, char*, std::size_t, std::size_t*) noexcept override {
        return 0;
    }
    OSSL_ENCODER_CTX* encoder_new_for_pkey(const EVP_PKEY*, int, const char*, const char*, const char*) noexcept override {
        return nullptr;
    }
    int encoder_to_data(OSSL_ENCODER_CTX*, unsigned char**, std::size_t*) noexcept override { return 0; }
    void encoder_free(OSSL_ENCODER_CTX*) noexcept override {}
    OSSL_STORE_CTX* store_open_ex(const char*, OSSL_LIB_CTX*, const char*, const UI_METHOD*, void*) noexcept override {
        return nullptr;
    }
    int store_expect(OSSL_STORE_CTX*, int) noexcept override { return 0; }
    OSSL_STORE_INFO* store_load(OSSL_STORE_CTX*) noexcept override { return nullptr; }
    int store_eof(OSSL_STORE_CTX*) noexcept override { return 1; }
    int store_error(OSSL_STORE_CTX*) noexcept override { return 0; }
    int store_info_type(const OSSL_STORE_INFO*) noexcept override { return 0; }
    EVP_PKEY* store_info_get1_pkey(const OSSL_STORE_INFO*) noexcept override { return nullptr; }
    void store_info_free(OSSL_STORE_INFO*) noexcept override {}
    int store_close(OSSL_STORE_CTX*) noexcept override { return 1; }
    int rand_priv_bytes_ex(OSSL_LIB_CTX*, unsigned char*, std::size_t, unsigned int) noexcept override { return 0; }

    std::vector<std::string> calls;

private:
    bool provide_tpm2_ = false;
};

class NullPosixStorageApi final : public PosixStorageApi {
public:
    int openat(int, const char*, int, mode_t) noexcept override { errno = ENOSYS; return -1; }
    int close(int) noexcept override { return 0; }
    int fstat(int, struct stat*) noexcept override { errno = ENOSYS; return -1; }
    int flock(int, int) noexcept override { errno = ENOSYS; return -1; }
    ssize_t write(int, const void*, std::size_t) noexcept override { errno = ENOSYS; return -1; }
    int fdatasync(int) noexcept override { errno = ENOSYS; return -1; }
    int fsync(int) noexcept override { errno = ENOSYS; return -1; }
    int unlinkat(int, const char*, int) noexcept override { errno = ENOSYS; return -1; }
    int linkat(int, const char*, int, const char*, int) noexcept override { errno = ENOSYS; return -1; }
    int renameat2_noreplace(int, const char*, const char*) noexcept override { errno = ENOSYS; return -1; }
    int clock_gettime(clockid_t, struct timespec*) noexcept override { errno = ENOSYS; return -1; }
    int nanosleep(const struct timespec*, struct timespec*) noexcept override { errno = ENOSYS; return -1; }
};

class LockReachPosixStorageApi final : public PosixStorageApi {
public:
    int openat(int, const char* path, int, mode_t) noexcept override {
        const std::string name = path == nullptr ? std::string() : std::string(path);
        calls.push_back("openat:" + name);
        if (name == "/") {
            return 100;
        }
        if (name == "safe") {
            return 101;
        }
        if (name.size() >= 5U && name.substr(name.size() - 5U) == ".lock") {
            lock_opened = true;
            return 102;
        }
        reference_checked = true;
        errno = ENOENT;
        return -1;
    }
    int close(int descriptor) noexcept override {
        calls.push_back("close:" + std::to_string(descriptor));
        return 0;
    }
    int fstat(int descriptor, struct stat* status) noexcept override {
        calls.push_back("fstat:" + std::to_string(descriptor));
        if (status == nullptr) {
            errno = EINVAL;
            return -1;
        }
        *status = {};
        status->st_uid = ::geteuid();
        status->st_dev = 1;
        status->st_ino = static_cast<ino_t>(descriptor);
        status->st_mode = descriptor == 101 ? S_IFDIR | 0700U : S_IFREG | 0600U;
        return 0;
    }
    int flock(int, int) noexcept override {
        calls.push_back("flock");
        lock_acquired = true;
        return 0;
    }
    ssize_t write(int, const void*, std::size_t) noexcept override { errno = ENOSYS; return -1; }
    int fdatasync(int) noexcept override { errno = ENOSYS; return -1; }
    int fsync(int) noexcept override { errno = ENOSYS; return -1; }
    int unlinkat(int, const char*, int) noexcept override { errno = ENOSYS; return -1; }
    int linkat(int, const char*, int, const char*, int) noexcept override { errno = ENOSYS; return -1; }
    int renameat2_noreplace(int, const char*, const char*) noexcept override { errno = ENOSYS; return -1; }
    int clock_gettime(clockid_t, struct timespec* value) noexcept override {
        calls.push_back("clock_gettime");
        if (value == nullptr) {
            errno = EINVAL;
            return -1;
        }
        value->tv_sec = 1;
        value->tv_nsec = 0;
        return 0;
    }
    int nanosleep(const struct timespec*, struct timespec*) noexcept override { return 0; }

    std::vector<std::string> calls;
    bool lock_opened = false;
    bool lock_acquired = false;
    bool reference_checked = false;
};

ProviderOpenRequest request_for(const std::string& storage) {
    ProviderOpenRequest request;
    request.backend = LCC_DEVICE_BACKEND_TPM2_OPENSSL;
    request.scope = LCC_DEVICE_SCOPE_USER;
    request.lock_timeout_ms = 5U;
    request.storage_directory = storage;
    require(license::device_identity::derive_namespace_v1(
                "licensecc.test.tpm2-shim", "DEFAULT", request.scope, request.device_namespace),
            "namespace derivation");
    return request;
}

void test_provider_load_order_and_unavailable_mapping() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>();
    auto provider = license::device_identity::make_tpm2_openssl_provider(
        openssl, std::make_shared<NullPosixStorageApi>());
    const ProviderOpenRequest request = request_for("/var/lib/licensecc");
    ERR_raise(ERR_LIB_USER, ERR_R_INTERNAL_ERROR);
    const unsigned long before = ERR_peek_last_error();
    require(provider->open(request) == LCC_DEVICE_PROVIDER_UNAVAILABLE, "missing tpm2 provider mapping");
    require(ERR_peek_last_error() == before, "OpenSSL error queue was not preserved");
    require(openssl->calls.size() == 5U, "provider load/unload call count");
    require(openssl->calls[0] == "libctx_new", "libctx allocation order");
    require(openssl->calls[1] == "provider_load:default", "default provider must load first");
    require(openssl->calls[2] == "provider_load:tpm2", "tpm2 provider must load second");
    require(openssl->calls[3] == "provider_unload:default", "default provider unload order");
    require(openssl->calls[4] == "libctx_free", "library context unload order");
}

void test_error_queue_preserved_when_initially_empty() {
    ERR_clear_error();
    auto provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(), std::make_shared<NullPosixStorageApi>());
    require(provider->open(request_for("/var/lib/licensecc")) == LCC_DEVICE_PROVIDER_UNAVAILABLE,
            "empty-queue provider error mapping");
    require(ERR_peek_error() == 0U, "provider error leaked into an initially empty queue");
}

void test_storage_path_validation_precedes_provider_access() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>();
    auto provider = license::device_identity::make_tpm2_openssl_provider(
        openssl, std::make_shared<NullPosixStorageApi>());
    ProviderOpenRequest request = request_for("relative");
    require(provider->open(request) == LCC_DEVICE_INVALID_ARGUMENT, "relative storage path accepted");
    require(openssl->calls.empty(), "invalid storage path reached OpenSSL");
    request = request_for("/var/../lib");
    require(provider->open(request) == LCC_DEVICE_INVALID_ARGUMENT, "traversal storage path accepted");
}

void test_create_reaches_namespace_lock_after_directory_open() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>(true);
    auto storage = std::make_shared<LockReachPosixStorageApi>();
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    const ProviderOpenRequest request = request_for("/safe");
    require(provider->create(request) == LCC_DEVICE_INTERNAL_ERROR, "fake key generation result changed");
    require(storage->lock_opened, "create did not open the namespace lock");
    require(storage->lock_acquired, "create did not acquire the namespace lock");
    require(storage->reference_checked, "create did not check the stored reference after locking");
}

int run_shim() {
    test_provider_load_order_and_unavailable_mapping();
    test_error_queue_preserved_when_initially_empty();
    test_storage_path_validation_precedes_provider_access();
    test_create_reaches_namespace_lock_after_directory_open();
    std::cout << "PASS: OpenSSL TPM2 provider shim contract\n";
    return 0;
}

int run_real(const char* storage_directory) {
    const char* marker = std::getenv("LCC_TPM2_CAPABILITY_PREREQUISITE");
    if (marker == nullptr || std::string(marker) != "1") {
        std::cerr << "TPM2 capability prerequisite marker absent; skipping\n";
        return 77;
    }
    ProviderOpenRequest request = request_for(storage_directory);
    auto provider = license::device_identity::make_tpm2_openssl_provider();
    require(provider != nullptr, "TPM2 provider factory");
    require(provider->create(request) == LCC_DEVICE_OK, "TPM2 provider create");
    license::device_identity::P256Spki spki{};
    require(provider->public_spki(spki) == LCC_DEVICE_OK, "TPM2 public SPKI");
    const std::string key_id = license::device_identity::device_key_id(spki);
    require(key_id.size() == LCC_DEVICE_KEY_ID_MAX, "TPM2 key id");
    license::device_identity::P256Digest digest{};
    require(license::device_identity::sha256(spki.data(), spki.size(), digest), "TPM2 digest");
    license::device_identity::P256Signature signature{};
    require(provider->sign_digest(digest, signature) == LCC_DEVICE_OK, "TPM2 sign");
    require(license::device_identity::verify_p256_p1363(spki, digest, signature), "TPM2 verify");
    provider.reset();
    for (unsigned int cycle = 0U; cycle < 1000U; ++cycle) {
        auto reopened = license::device_identity::make_tpm2_openssl_provider();
        require(reopened != nullptr && reopened->open(request) == LCC_DEVICE_OK, "TPM2 reopen cycle");
        license::device_identity::P256Spki current{};
        require(reopened->public_spki(current) == LCC_DEVICE_OK && current == spki, "TPM2 stable SPKI");
        require(reopened->sign_digest(digest, signature) == LCC_DEVICE_OK, "TPM2 cycle sign");
        require(license::device_identity::verify_p256_p1363(current, digest, signature), "TPM2 cycle verify");
    }
    auto deleter = license::device_identity::make_tpm2_openssl_provider();
    require(deleter != nullptr && deleter->delete_with_expected_id(request, key_id) == LCC_DEVICE_OK,
            "TPM2 expected-id delete");
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    try {
        if (argc == 2 && std::string(argv[1]) == "--shim") {
            return run_shim();
        }
        if (argc == 3 && std::string(argv[1]) == "--real") {
            return run_real(argv[2]);
        }
        std::cerr << "usage: " << argv[0] << " --shim | --real <storage-directory>\n";
        return 2;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << "\n";
        return 1;
    }
}

#else

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

#endif
