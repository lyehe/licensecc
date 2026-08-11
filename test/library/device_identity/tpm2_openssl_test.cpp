#ifdef LCC_TPM2_OPENSSL_PRODUCTION_TEST

#include "device_key_provider.hpp"
#include "providers/openssl3_api.hpp"
#include "providers/posix_storage_api.hpp"

#include <openssl/crypto.h>
#include <openssl/core_names.h>
#include <openssl/err.h>
#include <openssl/ui.h>

#include <cerrno>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <sys/stat.h>
#include <unistd.h>

#include <fcntl.h>

namespace license {
namespace device_identity {
LCC_DEVICE_RESULT tpm2_openssl_map_error_for_test(int saved_errno,
                                                  const char* reason,
                                                  bool loading_reference);
bool tpm2_openssl_accepts_tss2_private_pem_for_test(const unsigned char* data, std::size_t size) noexcept;
bool tpm2_openssl_accepts_der_signature_for_test(const unsigned char* data, std::size_t size) noexcept;
bool tpm2_openssl_decode_der_signature_for_test(const unsigned char* data,
                                                std::size_t size,
                                                unsigned char* output,
                                                std::size_t output_size) noexcept;
bool tpm2_openssl_nested_error_scope_preserves_for_test() noexcept;
bool tpm2_openssl_error_queue_round_trip_for_test() noexcept;
bool tpm2_openssl_error_queue_segments_for_test() noexcept;
}  // namespace device_identity
}  // namespace license

namespace {

using license::device_identity::OpenSsl3Api;
using license::device_identity::PosixStorageApi;
using license::device_identity::ProviderOpenRequest;

void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

std::string private_pem_label(bool tss2) {
    const std::string private_key = std::string("PRIVATE") + std::string(" KEY");
    return tss2 ? std::string("TSS2 ") + private_key : private_key;
}

std::string private_pem(const std::string& label) {
    return std::string("-----BEGIN ") + label + "-----\nYWJj\n-----END " + label + "-----\n";
}

class FakeOpenSsl3Api final : public OpenSsl3Api {
public:
    explicit FakeOpenSsl3Api(bool provide_tpm2 = false,
                             bool layered_tpm2_error = false,
                             bool full_state_machine = false)
        : provide_tpm2_(provide_tpm2),
          layered_tpm2_error_(layered_tpm2_error),
          full_state_machine_(full_state_machine),
          pem_(private_pem(private_pem_label(true))) {}

    OSSL_LIB_CTX* libctx_new() noexcept override {
        calls.push_back("libctx_new");
        return reinterpret_cast<OSSL_LIB_CTX*>(static_cast<std::uintptr_t>(1U));
    }
    void libctx_free(OSSL_LIB_CTX*) noexcept override {
        calls.push_back("libctx_free");
        ++libctx_free_count;
    }
    OSSL_PROVIDER* provider_load(OSSL_LIB_CTX*, const char* name) noexcept override {
        calls.push_back(std::string("provider_load:") + name);
        if (std::string(name) == "default") {
            return reinterpret_cast<OSSL_PROVIDER*>(static_cast<std::uintptr_t>(2U));
        }
        if (provide_tpm2_ && std::string(name) == "tpm2") {
            return reinterpret_cast<OSSL_PROVIDER*>(static_cast<std::uintptr_t>(3U));
        }
        if (layered_tpm2_error_ && std::string(name) == "tpm2") {
            ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", "tcti:IO failure");
            ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", "provider_init:init fail name=tpm2");
            return nullptr;
        }
        if (std::string(name) == "tpm2" && !tpm2_failure_reason.empty()) {
            ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", tpm2_failure_reason.c_str());
            return nullptr;
        }
        if (std::string(name) == "tpm2") {
            ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", "provider module not found");
            return nullptr;
        }
        ERR_raise(ERR_LIB_USER, ERR_R_INTERNAL_ERROR);
        return nullptr;
    }
    int provider_unload(OSSL_PROVIDER* provider) noexcept override {
        calls.push_back(provider == reinterpret_cast<OSSL_PROVIDER*>(static_cast<std::uintptr_t>(2U)) ?
                            "provider_unload:default" :
                            provider == reinterpret_cast<OSSL_PROVIDER*>(static_cast<std::uintptr_t>(3U)) ?
                                "provider_unload:tpm2" : "provider_unload:unknown");
        ++provider_unload_count;
        return 1;
    }
    EVP_PKEY_CTX* pkey_ctx_new_from_name(OSSL_LIB_CTX* context,
                                          const char* name,
                                          const char* properties) noexcept override {
        if (!full_state_machine_) {
            return nullptr;
        }
        stage = 1;
        keygen_libctx = context;
        keygen_name = name == nullptr ? std::string() : std::string(name);
        keygen_properties = properties == nullptr ? std::string() : std::string(properties);
        return reinterpret_cast<EVP_PKEY_CTX*>(static_cast<std::uintptr_t>(4U));
    }
    EVP_PKEY_CTX* pkey_ctx_new_from_pkey(OSSL_LIB_CTX* context,
                                         EVP_PKEY*,
                                         const char* properties) noexcept override {
        if (!full_state_machine_) {
            return nullptr;
        }
        stage = 2;
        verify_libctx = context;
        verify_properties = properties == nullptr ? std::string() : std::string(properties);
        return reinterpret_cast<EVP_PKEY_CTX*>(static_cast<std::uintptr_t>(5U));
    }
    void pkey_ctx_free(EVP_PKEY_CTX*) noexcept override {}
    int pkey_keygen_init(EVP_PKEY_CTX*) noexcept override {
        return full_state_machine_ && !fail_keygen ? 1 : 0;
    }
    int pkey_ctx_set_params(EVP_PKEY_CTX*, const OSSL_PARAM* params) noexcept override {
        if (!full_state_machine_ || params == nullptr) {
            return 0;
        }
        stage = 3;
        for (const OSSL_PARAM* current = params; current->key != nullptr; ++current) {
            if (std::string(current->key) == OSSL_PKEY_PARAM_GROUP_NAME && current->data != nullptr) {
                group_param = static_cast<const char*>(current->data);
            } else if (std::string(current->key) == OSSL_PKEY_PARAM_DIGEST && current->data != nullptr) {
                digest_param = static_cast<const char*>(current->data);
            } else if (std::string(current->key) == "parent" && current->data != nullptr &&
                       current->data_size >= sizeof(unsigned int)) {
                std::memcpy(&parent_param, current->data, sizeof(parent_param));
            }
        }
        return 1;
    }
    int pkey_generate(EVP_PKEY_CTX*, EVP_PKEY** key) noexcept override {
        if (!full_state_machine_ || key == nullptr) {
            return 0;
        }
        if (parent_auth_failure != 0) {
            ERR_raise_data(ERR_LIB_USER,
                           ERR_R_INTERNAL_ERROR,
                           "%s",
                           parent_auth_failure == 1 ?
                               "cannot create primary 0 tpm: missing parent authorization" :
                               "cannot create primary 2466 tpm:session(1):authorization failure without DA implications");
            return 0;
        }
        if (fail_keygen) {
            return 0;
        }
        *key = reinterpret_cast<EVP_PKEY*>(static_cast<std::uintptr_t>(6U));
        generated = true;
        stage = 4;
        return 1;
    }
    int pkey_sign_init(EVP_PKEY_CTX*) noexcept override {
        return full_state_machine_ && !fail_sign ? 1 : 0;
    }
    int pkey_verify_init(EVP_PKEY_CTX*) noexcept override { return full_state_machine_ ? 1 : 0; }
    int pkey_ctx_set_signature_md(EVP_PKEY_CTX*, const EVP_MD*) noexcept override {
        return full_state_machine_ && !fail_sign ? 1 : 0;
    }
    int pkey_sign(EVP_PKEY_CTX*, unsigned char* signature, std::size_t* signature_size, const unsigned char*, std::size_t) noexcept override {
        if (!full_state_machine_ || signature_size == nullptr || fail_sign) {
            return 0;
        }
        stage = 12;
        static constexpr unsigned char kMalformedDer[] = {0x30U, 0x03U, 0x02U, 0x01U, 0x01U};
        constexpr unsigned char kDer[] = {0x30U, 0x06U, 0x02U, 0x01U, 0x01U, 0x02U, 0x01U, 0x02U};
        const unsigned char* result = fail_malformed_der ? kMalformedDer : kDer;
        const std::size_t result_size = fail_malformed_der ? sizeof(kMalformedDer) : sizeof(kDer);
        if (signature == nullptr) {
            *signature_size = result_size;
            return 1;
        }
        if (*signature_size < result_size) {
            return 0;
        }
        std::memcpy(signature, result, result_size);
        *signature_size = result_size;
        return 1;
    }
    int pkey_verify(EVP_PKEY_CTX*, const unsigned char*, std::size_t, const unsigned char*, std::size_t) noexcept override {
        stage = 13;
        return !full_state_machine_ || fail_verify ? (fail_verify ? -1 : 0) : 1;
    }
    EVP_MD* md_fetch(OSSL_LIB_CTX* context, const char* name, const char* properties) noexcept override {
        if (!full_state_machine_) {
            return nullptr;
        }
        stage = 7;
        digest_libctx = context;
        digest_name = name == nullptr ? std::string() : std::string(name);
        digest_properties = properties == nullptr ? std::string() : std::string(properties);
        return reinterpret_cast<EVP_MD*>(static_cast<std::uintptr_t>(7U));
    }
    void md_free(EVP_MD*) noexcept override {}
    EVP_PKEY* d2i_public_key(OSSL_LIB_CTX* context, const unsigned char*, std::size_t) noexcept override {
        if (!full_state_machine_) {
            return nullptr;
        }
        stage = 9;
        public_key_libctx = context;
        return reinterpret_cast<EVP_PKEY*>(static_cast<std::uintptr_t>(8U));
    }
    int digest(EVP_MD*, const unsigned char*, std::size_t, unsigned char* output, std::size_t* output_size) noexcept override {
        if (!full_state_machine_ || output == nullptr || output_size == nullptr || fail_digest) {
            return 0;
        }
        stage = 8;
        std::memset(output, 0xa5, 32U);
        *output_size = 32U;
        return 1;
    }
    void pkey_free(EVP_PKEY*) noexcept override { ++pkey_free_count; }
    const OSSL_PROVIDER* pkey_get0_provider(const EVP_PKEY*) noexcept override {
        return full_state_machine_ ? reinterpret_cast<const OSSL_PROVIDER*>(static_cast<std::uintptr_t>(3U)) : nullptr;
    }
    const char* provider_name(const OSSL_PROVIDER* provider) noexcept override {
        return full_state_machine_ && provider != nullptr ? "tpm2" : nullptr;
    }
    int pkey_get_utf8_string_param(const EVP_PKEY*, const char* name, char* value, std::size_t value_size, std::size_t* written) noexcept override {
        if (!full_state_machine_ || name == nullptr || value == nullptr || written == nullptr ||
            std::string(name) != OSSL_PKEY_PARAM_GROUP_NAME || value_size < 11U) {
            return 0;
        }
        const char group[] = "prime256v1";
        std::memcpy(value, group, sizeof(group));
        *written = sizeof(group) - 1U;
        return 1;
    }
    OSSL_ENCODER_CTX* encoder_new_for_pkey(const EVP_PKEY*,
                                           int selection,
                                           const char* output_type,
                                           const char* output_structure,
                                           const char* properties) noexcept override {
        if (!full_state_machine_ || fail_encoder) {
            return nullptr;
        }
        stage = 5;
        encoder_selection = selection;
        encoder_output_type = output_type == nullptr ? std::string() : std::string(output_type);
        encoder_output_structure = output_structure == nullptr ? std::string() : std::string(output_structure);
        encoder_properties = properties == nullptr ? std::string() : std::string(properties);
        saw_private_encoder = saw_private_encoder ||
                              (encoder_output_type == "PEM" && encoder_output_structure == "PrivateKeyInfo" &&
                               encoder_properties == "provider=tpm2");
        saw_public_encoder = saw_public_encoder ||
                             (encoder_output_type == "DER" && encoder_output_structure == "SubjectPublicKeyInfo");
        return reinterpret_cast<OSSL_ENCODER_CTX*>(static_cast<std::uintptr_t>(9U));
    }
    int encoder_to_data(OSSL_ENCODER_CTX*, unsigned char** data, std::size_t* data_size) noexcept override {
        if (!full_state_machine_ || data == nullptr || data_size == nullptr) {
            return 0;
        }
        stage = 6;
        if (encoder_output_type == "DER") {
            static constexpr unsigned char kSpki[] = {
                0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06,
                0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
                0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8, 0xbc, 0xe6, 0xe5, 0x63, 0xa4,
                0x40, 0xf2, 0x77, 0x03, 0x7d, 0x81, 0x2d, 0xeb, 0x33, 0xa0, 0xf4, 0xa1, 0x39, 0x45,
                0xd8, 0x98, 0xc2, 0x96, 0x4f, 0xe3, 0x42, 0xe2, 0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7,
                0xeb, 0x4a, 0x7c, 0x0f, 0x9e, 0x16, 0x2b, 0xce, 0x33, 0x57, 0x6b, 0x31, 0x5e, 0xce,
                0xcb, 0xb6, 0x40, 0x68, 0x37, 0xbf, 0x51, 0xf5};
            *data_size = sizeof(kSpki);
            *data = static_cast<unsigned char*>(OPENSSL_malloc(*data_size));
            if (*data == nullptr) {
                return 0;
            }
            std::memcpy(*data, kSpki, *data_size);
            return 1;
        }
        *data_size = pem_.size();
        *data = static_cast<unsigned char*>(OPENSSL_malloc(*data_size));
        if (*data == nullptr) {
            return 0;
        }
        std::memcpy(*data, pem_.data(), *data_size);
        return 1;
    }
    void encoder_free(OSSL_ENCODER_CTX*) noexcept override {}
    void clear_free(void* data, std::size_t size) noexcept override { OPENSSL_clear_free(data, size); }
    OSSL_STORE_CTX* store_open_ex(const char* uri,
                                   OSSL_LIB_CTX* context,
                                   const char* properties,
                                   const UI_METHOD* ui_method,
                                   void*) noexcept override {
        store_uri = uri == nullptr ? std::string() : std::string(uri);
        store_libctx = context;
        store_properties = properties == nullptr ? std::string() : std::string(properties);
        store_ui_method = ui_method;
        store_loaded_count = 0;
        if (invoke_ui_prompt && ui_method != nullptr) {
            UI* ui = UI_new_method(ui_method);
            if (ui != nullptr) {
                char password[16]{};
                const int input_index = UI_add_input_string(ui, "password", 0, password, 0, sizeof(password) - 1U);
                ui_prompt_rejected = input_index > 0 && UI_process(ui) < 0 && password[0] == '\0';
                UI_free(ui);
            }
        }
        if (!full_state_machine_) {
            return nullptr;
        }
        if (store_open_failure) {
            ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", "store open failed");
            return nullptr;
        }
        stage = 10;
        return reinterpret_cast<OSSL_STORE_CTX*>(static_cast<std::uintptr_t>(10U));
    }
    int store_expect(OSSL_STORE_CTX*, int expected_type) noexcept override {
        store_expected_type = expected_type;
        return full_state_machine_ && !store_expect_failure ? 1 : 0;
    }
    OSSL_STORE_INFO* store_load(OSSL_STORE_CTX*) noexcept override {
        if (!full_state_machine_ || store_loaded_count >= store_item_count || store_error_on_load) {
            if (store_error_on_load) {
                store_error_code = 1;
                ERR_raise_data(ERR_LIB_USER,
                               ERR_R_INTERNAL_ERROR,
                               "%s",
                               store_error_reason.empty() ? "input corrupted" : store_error_reason.c_str());
            }
            return nullptr;
        }
        ++store_loaded_count;
        stage = 11;
        return reinterpret_cast<OSSL_STORE_INFO*>(static_cast<std::uintptr_t>(11U));
    }
    int store_eof(OSSL_STORE_CTX*) noexcept override {
        return full_state_machine_ && !force_unclean_eof && !store_error_on_load &&
                       store_loaded_count >= store_item_count ?
                   1 :
                   0;
    }
    int store_error(OSSL_STORE_CTX*) noexcept override { return store_error_code; }
    int store_info_type(const OSSL_STORE_INFO*) noexcept override {
        return store_non_pkey ? OSSL_STORE_INFO_CERT : store_expected_type;
    }
    EVP_PKEY* store_info_get1_pkey(const OSSL_STORE_INFO*) noexcept override {
        if (store_first_pkey_null && store_loaded_count == 1) {
            return nullptr;
        }
        return reinterpret_cast<EVP_PKEY*>(static_cast<std::uintptr_t>(8U));
    }
    void store_info_free(OSSL_STORE_INFO*) noexcept override {}
    int store_close(OSSL_STORE_CTX*) noexcept override { return store_close_failure ? 0 : 1; }
    int rand_priv_bytes_ex(OSSL_LIB_CTX*, unsigned char* data, std::size_t size, unsigned int) noexcept override {
        if (!full_state_machine_ || data == nullptr) {
            return 0;
        }
        std::memset(data, 0x11, size);
        return 1;
    }

    std::vector<std::string> calls;
    int provider_unload_count = 0;
    int libctx_free_count = 0;
    int pkey_free_count = 0;
    std::string store_uri;
    OSSL_LIB_CTX* store_libctx = nullptr;
    std::string store_properties;
    const UI_METHOD* store_ui_method = nullptr;
    bool invoke_ui_prompt = false;
    bool ui_prompt_rejected = false;
    std::string tpm2_failure_reason;
    OSSL_LIB_CTX* keygen_libctx = nullptr;
    OSSL_LIB_CTX* digest_libctx = nullptr;
    OSSL_LIB_CTX* public_key_libctx = nullptr;
    OSSL_LIB_CTX* verify_libctx = nullptr;
    std::string keygen_name;
    std::string keygen_properties;
    std::string group_param;
    std::string digest_param;
    unsigned int parent_param = 0U;
    bool generated = false;
    std::string digest_name;
    std::string digest_properties;
    std::string verify_properties;
    int encoder_selection = 0;
    std::string encoder_output_type;
    std::string encoder_output_structure;
    std::string encoder_properties;
    bool saw_private_encoder = false;
    bool saw_public_encoder = false;
    int store_expected_type = 0;
    int store_item_count = 1;
    int store_loaded_count = 0;
    bool force_unclean_eof = false;
    int store_error_code = 0;
    std::string store_error_reason;
    bool store_open_failure = false;
    bool store_expect_failure = false;
    bool store_non_pkey = false;
    bool store_error_on_load = false;
    bool store_close_failure = false;
    bool store_first_pkey_null = false;
    bool fail_keygen = false;
    int parent_auth_failure = 0;
    bool fail_sign = false;
    bool fail_malformed_der = false;
    bool fail_verify = false;
    bool fail_digest = false;
    bool fail_encoder = false;
    int stage = 0;

private:
    bool provide_tpm2_ = false;
    bool layered_tpm2_error_ = false;
    bool full_state_machine_ = false;
    std::string pem_;
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
    explicit LockReachPosixStorageApi(bool full_state_machine = false)
        : full_state_machine_(full_state_machine) {}

    int openat(int, const char* path, int flags, mode_t mode) noexcept override {
        const std::string name = path == nullptr ? std::string() : std::string(path);
        calls.push_back("openat:" + name);
        if (name == "/") {
            descriptors_[100] = Descriptor{100, Kind::Ancestor, "/"};
            return 100;
        }
        if (name == "safe") {
            selected_directory_flags = flags;
            if (directory_symlink && (flags & O_NOFOLLOW) != 0) {
                errno = ELOOP;
                return -1;
            }
            descriptors_[101] = Descriptor{101, Kind::Directory, name};
            return 101;
        }
        if (name == "ancestor") {
            if (ancestor_symlink && (flags & O_NOFOLLOW) != 0) {
                errno = ELOOP;
                return -1;
            }
            descriptors_[107] = Descriptor{107, Kind::Ancestor, name};
            return 107;
        }
        if (is_final(name)) {
            if (reference_symlink && (flags & O_NOFOLLOW) != 0) {
                errno = ELOOP;
                return -1;
            }
            if (!reference_present && entries_.find(name) == entries_.end()) {
                errno = ENOENT;
                reference_checked = true;
                return -1;
            }
            if (entries_.find(name) == entries_.end()) {
                entries_.emplace(name, FakeFile{104, S_IFREG | 0600U, ::geteuid()});
            }
            if (post_publish_mismatch && reference_open_count++ == 0) {
                entries_.at(name).inode = 201;
            }
            const int descriptor = allocate_descriptor();
            descriptors_[descriptor] = Descriptor{entries_.at(name).inode, Kind::Reference, name};
            reference_checked = true;
            reference_flags = flags;
            return descriptor;
        }
        if (full_state_machine_ && is_temporary(name)) {
            const bool creating = (flags & O_CREAT) != 0;
            if (creating) {
                if (entries_.find(name) != entries_.end()) {
                    errno = EEXIST;
                    return -1;
                }
                entries_.emplace(name, FakeFile{104, S_IFREG | (mode & 07777U), ::geteuid()});
                temporary_opened = true;
                temporary_present = true;
                temporary_flags = flags;
                temporary_open_mode = mode;
            } else {
                auto entry = entries_.find(name);
                if (entry == entries_.end()) {
                    errno = ENOENT;
                    return -1;
                }
                ++temporary_open_count;
                if (cleanup_swap && !cleanup_swap_applied_ && temporary_open_count >= 2) {
                    entry->second.inode = 105;
                    cleanup_swap_applied_ = true;
                }
                if (fallback_swap_before_recheck && !fallback_swap_applied_ && temporary_open_count >= 3) {
                    entry->second.inode = 105;
                    fallback_swap_applied_ = true;
                }
            }
            const int descriptor = allocate_descriptor();
            descriptors_[descriptor] = Descriptor{entries_.at(name).inode, Kind::Temporary, name};
            return descriptor;
        }
        if (full_state_machine_ && is_move(name)) {
            const auto entry = entries_.find(name);
            if (entry == entries_.end()) {
                errno = ENOENT;
                return -1;
            }
            const int descriptor = allocate_descriptor();
            descriptors_[descriptor] = Descriptor{entry->second.inode, Kind::Move, name};
            return descriptor;
        }
        if (full_state_machine_ && is_delete_name(name)) {
            const auto entry = entries_.find(name);
            if (entry == entries_.end()) {
                errno = ENOENT;
                return -1;
            }
            const int descriptor = allocate_descriptor();
            descriptors_[descriptor] = Descriptor{entry->second.inode, Kind::Reference, name};
            return descriptor;
        }
        if (is_lock(name)) {
            if (lock_symlink && (flags & O_NOFOLLOW) != 0) {
                errno = ELOOP;
                return -1;
            }
            if (entries_.find(name) == entries_.end()) {
                entries_.emplace(name, FakeFile{102, S_IFREG | (mode & 07777U), ::geteuid()});
            }
            const int descriptor = allocate_descriptor();
            descriptors_[descriptor] = Descriptor{entries_.at(name).inode, Kind::Lock, name};
            lock_opened = true;
            lock_flags = flags;
            lock_open_mode = mode;
            return descriptor;
        }
        reference_checked = true;
        errno = ENOENT;
        return -1;
    }
    int close(int descriptor) noexcept override {
        calls.push_back("close:" + std::to_string(descriptor));
        const auto found = descriptors_.find(descriptor);
        if (full_state_machine_ && found != descriptors_.end() && found->second.kind == Kind::Temporary &&
            fail_temp_close && !temp_close_failure_consumed_) {
            temp_close_failure_consumed_ = true;
            errno = EIO;
            return -1;
        }
        return 0;
    }
    int fstat(int descriptor, struct stat* status) noexcept override {
        calls.push_back("fstat:" + std::to_string(descriptor));
        if (status == nullptr) {
            errno = EINVAL;
            return -1;
        }
        const auto found = descriptors_.find(descriptor);
        if (found == descriptors_.end()) {
            errno = EBADF;
            return -1;
        }
        *status = {};
        const Descriptor& descriptor_info = found->second;
        if (descriptor_info.kind == Kind::Temporary &&
            (fail_temp_fstat_persistent || (fail_temp_fstat && !temp_fstat_failure_consumed_))) {
            temp_fstat_failure_consumed_ = true;
            errno = EIO;
            return -1;
        }
        const bool wrong_owner =
            (descriptor_info.kind == Kind::Temporary && temporary_wrong_owner) ||
            (descriptor_info.kind == Kind::Directory && directory_wrong_owner) ||
            (descriptor_info.kind == Kind::Lock && lock_wrong_owner) ||
            (descriptor_info.kind == Kind::Reference && reference_wrong_owner);
        status->st_uid = wrong_owner ? ::geteuid() + 1U : ::geteuid();
        status->st_dev = 1;
        const auto entry = entries_.find(descriptor_info.path);
        const mode_t recorded_mode = entry == entries_.end() ? 0600U : entry->second.mode;
        status->st_ino = descriptor_info.inode;
        status->st_mode = descriptor_info.kind == Kind::Directory ?
                              S_IFDIR | (directory_bad_mode ? 0750U : 0700U) :
                          descriptor_info.kind == Kind::Ancestor ?
                              S_IFDIR | (ancestor_bad_mode ? 0775U : 0755U) :
                          descriptor_info.kind == Kind::Reference && reference_nonregular ? S_IFIFO | 0600U :
                          descriptor_info.kind == Kind::Lock && lock_nonregular ? S_IFIFO | (recorded_mode & 07777U) :
                          descriptor_info.kind == Kind::Lock ?
                              S_IFREG | (lock_bad_mode ? 0640U : (recorded_mode & 07777U)) :
                          descriptor_info.kind == Kind::Reference ?
                              S_IFREG | (reference_bad_mode ? 0640U : 0600U) :
                              S_IFREG | (temporary_bad_mode ? 0640U : (recorded_mode & 07777U));
        return 0;
    }
    int flock(int, int) noexcept override {
        calls.push_back("flock");
        if (lock_busy && !(lock_releases_after_deadline && clock_calls >= 2)) {
            errno = EWOULDBLOCK;
            return -1;
        }
        lock_acquired = true;
        return 0;
    }
    ssize_t write(int, const void*, std::size_t size) noexcept override {
        if (!full_state_machine_) {
            errno = ENOSYS;
            return -1;
        }
        if (fail_write) {
            errno = EIO;
            return -1;
        }
        return static_cast<ssize_t>(size);
    }
    int fdatasync(int) noexcept override {
        if (!full_state_machine_) {
            errno = ENOSYS;
            return -1;
        }
        if (fail_fdatasync) {
            errno = EIO;
            return -1;
        }
        return 0;
    }
    int fsync(int) noexcept override {
        if (!full_state_machine_) {
            errno = ENOSYS;
            return -1;
        }
        ++fsync_calls;
        if (fail_fsync_once && fsync_calls == 1) {
            errno = EIO;
            return -1;
        }
        if (fail_cleanup_fsync || (fail_cleanup_fsync_after > 0 && fsync_calls > fail_cleanup_fsync_after)) {
            errno = EIO;
            return -1;
        }
        return 0;
    }
    int unlinkat(int, const char* path, int) noexcept override {
        if (!full_state_machine_) {
            errno = ENOSYS;
            return -1;
        }
        const std::string name = path == nullptr ? std::string() : std::string(path);
        ++cleanup_unlink_calls;
        const bool cleanup_name = is_temporary(name) || is_move(name) || is_delete_name(name);
        if (cleanup_name &&
            (fail_cleanup_unlink ||
             (fail_cleanup_unlink_after > 0 && cleanup_unlink_calls > fail_cleanup_unlink_after))) {
            errno = EIO;
            return -1;
        }
        if (entries_.erase(name) == 0U) {
            errno = ENOENT;
            return -1;
        }
        refresh_presence();
        return 0;
    }
    int linkat(int, const char* old_path, int, const char* new_path, int) noexcept override {
        if (!full_state_machine_) {
            errno = ENOSYS;
            return -1;
        }
        const std::string old_name = old_path == nullptr ? std::string() : std::string(old_path);
        const std::string new_name = new_path == nullptr ? std::string() : std::string(new_path);
        if (link_unsupported && old_name.rfind("/proc/self/fd/", 0U) != 0U) {
            errno = EOPNOTSUPP;
            return -1;
        }
        ino_t inode = 0;
        if (old_name.rfind("/proc/self/fd/", 0U) == 0U) {
            const int descriptor = std::atoi(old_name.c_str() + std::strlen("/proc/self/fd/"));
            const auto found = descriptors_.find(descriptor);
            if (found == descriptors_.end()) {
                errno = ENOENT;
                return -1;
            }
            inode = found->second.inode;
        } else {
            const auto found = entries_.find(old_name);
            if (found == entries_.end()) {
                errno = ENOENT;
                return -1;
            }
            inode = found->second.inode;
        }
        const bool final_name = is_final(new_name);
        if (entries_.find(new_name) != entries_.end() || (final_name && link_winner_exists)) {
            if (final_name && link_winner_exists && entries_.find(new_name) == entries_.end()) {
                entries_.emplace(new_name, FakeFile{200, S_IFREG | 0600U, ::geteuid()});
                reference_present = true;
            }
            errno = EEXIST;
            return -1;
        }
        entries_.emplace(new_name, FakeFile{inode, S_IFREG | 0600U, ::geteuid()});
        refresh_presence();
        return 0;
    }
    int renameat2_noreplace(int, const char* old_path, const char* new_path) noexcept override {
        if (!full_state_machine_) {
            errno = ENOSYS;
            return -1;
        }
        const std::string old_name = old_path == nullptr ? std::string() : std::string(old_path);
        const std::string new_name = new_path == nullptr ? std::string() : std::string(new_path);
        if (rename_unavailable_all) {
            errno = ENOSYS;
            return -1;
        }
        if (rename_unavailable && old_name.find(".tmp.") != std::string::npos &&
            new_name.size() >= 9U && new_name.substr(new_name.size() - 9U) == ".tss2.pem") {
            errno = ENOSYS;
            return -1;
        }
        if (rename_unsupported_errno != 0 && is_temporary(old_name) && is_final(new_name)) {
            errno = rename_unsupported_errno;
            return -1;
        }
        if (force_publish_exists && old_name.find(".tmp.") != std::string::npos &&
            new_name.size() >= 9U && new_name.substr(new_name.size() - 9U) == ".tss2.pem") {
            if (rename_winner_exists && entries_.find(new_name) == entries_.end()) {
                entries_.emplace(new_name, FakeFile{200, S_IFREG | 0600U, ::geteuid()});
                reference_present = true;
            }
            errno = EEXIST;
            return -1;
        }
        if (entries_.find(old_name) == entries_.end()) {
            errno = ENOENT;
            return -1;
        }
        if (entries_.find(new_name) != entries_.end() ||
            (force_publish_exists && is_temporary(old_name) && is_final(new_name))) {
            errno = EEXIST;
            return -1;
        }
        entries_.emplace(new_name, entries_.at(old_name));
        entries_.erase(old_name);
        refresh_presence();
        return 0;
    }
    int clock_gettime(clockid_t, struct timespec* value) noexcept override {
        calls.push_back("clock_gettime");
        if (value == nullptr) {
            errno = EINVAL;
            return -1;
        }
        value->tv_sec = 1;
        value->tv_nsec = lock_busy && ++clock_calls > 1 ? 6'000'000L : 0;
        return 0;
    }
    int nanosleep(const struct timespec*, struct timespec*) noexcept override { return 0; }

    std::vector<std::string> calls;
    bool lock_opened = false;
    bool lock_acquired = false;
    bool reference_checked = false;
    bool reference_present = false;
    bool reference_nonregular = false;
    bool reference_symlink = false;
    bool lock_nonregular = false;
    bool lock_symlink = false;
    bool directory_symlink = false;
    bool directory_bad_mode = false;
    bool directory_wrong_owner = false;
    bool ancestor_symlink = false;
    bool ancestor_bad_mode = false;
    bool reference_bad_mode = false;
    bool reference_wrong_owner = false;
    bool lock_bad_mode = false;
    bool lock_wrong_owner = false;
    bool temporary_bad_mode = false;
    bool temporary_wrong_owner = false;
    bool temporary_opened = false;
    bool temporary_present = false;
    bool post_publish_mismatch = false;
    int reference_open_count = 0;
    bool force_publish_exists = false;
    bool rename_winner_exists = false;
    bool cleanup_swap = false;
    bool fallback_swap_before_recheck = false;
    int temporary_open_count = 0;
    bool rename_unavailable = false;
    bool rename_unavailable_all = false;
    int rename_unsupported_errno = 0;
    bool link_unsupported = false;
    bool fail_cleanup_unlink = false;
    bool fail_cleanup_fsync = false;
    int fail_cleanup_unlink_after = 0;
    int fail_cleanup_fsync_after = 0;
    int cleanup_unlink_calls = 0;
    bool lock_busy = false;
    bool lock_releases_after_deadline = false;
    int clock_calls = 0;
    bool link_winner_exists = false;
    bool fail_write = false;
    bool fail_fdatasync = false;
    bool fail_temp_close = false;
    bool fail_temp_fstat = false;
    bool fail_temp_fstat_persistent = false;
    bool fail_fsync_once = false;
    int fsync_calls = 0;
    int selected_directory_flags = 0;
    int reference_flags = 0;
    int lock_flags = 0;
    int temporary_flags = 0;
    mode_t temporary_open_mode = 0;
    mode_t lock_open_mode = 0;

private:
    enum class Kind { Ancestor, Directory, Lock, Reference, Temporary, Move };
    struct Descriptor {
        ino_t inode;
        Kind kind;
        std::string path;
    };
    struct FakeFile {
        ino_t inode;
        mode_t mode;
        uid_t owner;
    };

    static bool has_suffix(const std::string& value, const char* suffix) {
        const std::size_t length = std::strlen(suffix);
        return value.size() >= length && value.compare(value.size() - length, length, suffix) == 0;
    }
    static bool is_final(const std::string& value) { return has_suffix(value, ".tss2.pem"); }
    static bool is_lock(const std::string& value) { return has_suffix(value, ".lock"); }
    static bool is_temporary(const std::string& value) { return value.find(".tmp.") != std::string::npos; }
    static bool is_move(const std::string& value) { return value.find(".move.") != std::string::npos; }
    static bool is_delete_name(const std::string& value) { return value.find(".delete.") != std::string::npos; }

    int allocate_descriptor() {
        while (descriptors_.find(next_descriptor_) != descriptors_.end()) {
            ++next_descriptor_;
        }
        return next_descriptor_++;
    }
    void refresh_presence() {
        reference_present = false;
        temporary_present = false;
        for (const auto& entry : entries_) {
            reference_present = reference_present || is_final(entry.first);
            temporary_present = temporary_present || is_temporary(entry.first);
        }
    }

    std::map<std::string, FakeFile> entries_;
    std::map<int, Descriptor> descriptors_;
    int next_descriptor_ = 103;
    bool cleanup_swap_applied_ = false;
    bool temp_close_failure_consumed_ = false;
    bool temp_fstat_failure_consumed_ = false;
    bool fallback_swap_applied_ = false;
    bool full_state_machine_ = false;
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

void test_provider_load_unknown_and_allocator_failures_remain_internal() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>();
    openssl->tpm2_failure_reason = "memory allocation failure";
    auto provider = license::device_identity::make_tpm2_openssl_provider(
        openssl, std::make_shared<NullPosixStorageApi>());
    require(provider->open(request_for("/var/lib/licensecc")) == LCC_DEVICE_INTERNAL_ERROR,
            "provider-load allocator failure was collapsed to unavailable");

    openssl = std::make_shared<FakeOpenSsl3Api>();
    openssl->tpm2_failure_reason = "unexpected provider initialization failure";
    provider = license::device_identity::make_tpm2_openssl_provider(
        openssl, std::make_shared<NullPosixStorageApi>());
    require(provider->open(request_for("/var/lib/licensecc")) == LCC_DEVICE_INTERNAL_ERROR,
            "unknown provider-load failure was collapsed to unavailable");

    openssl = std::make_shared<FakeOpenSsl3Api>();
    openssl->tpm2_failure_reason = "memory allocation failure: provider module not found";
    provider = license::device_identity::make_tpm2_openssl_provider(
        openssl, std::make_shared<NullPosixStorageApi>());
    require(provider->open(request_for("/var/lib/licensecc")) == LCC_DEVICE_INTERNAL_ERROR,
            "allocator failure mentioning a module was collapsed to unavailable");
}

void test_error_queue_preserved_when_initially_empty() {
    ERR_clear_error();
    auto provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(), std::make_shared<NullPosixStorageApi>());
    require(provider->open(request_for("/var/lib/licensecc")) == LCC_DEVICE_PROVIDER_UNAVAILABLE,
            "empty-queue provider error mapping");
    require(ERR_peek_error() == 0U, "provider error leaked into an initially empty queue");
}

void test_layered_provider_error_maps_first_cause_and_preserves_caller_queue() {
    ERR_clear_error();
    ERR_raise(ERR_LIB_USER, ERR_R_INTERNAL_ERROR);
    const unsigned long before = ERR_peek_last_error();
    auto provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(false, true), std::make_shared<NullPosixStorageApi>());
    require(provider->open(request_for("/var/lib/licensecc")) == LCC_DEVICE_HARDWARE_UNAVAILABLE,
            "layered TCTI provider failure must map to hardware unavailable");
    require(ERR_peek_last_error() == before, "layered provider error did not preserve caller queue");
}

void test_nested_error_scopes_preserve_empty_and_preexisting_queues() {
    ERR_clear_error();
    require(license::device_identity::tpm2_openssl_nested_error_scope_preserves_for_test(),
            "nested error scopes leaked into an initially empty queue");
    ERR_raise(ERR_LIB_USER, ERR_R_INTERNAL_ERROR);
    require(license::device_identity::tpm2_openssl_nested_error_scope_preserves_for_test(),
            "nested error scopes changed a pre-existing queue");
    ERR_clear_error();
}

void test_error_queue_preserves_full_records_and_segments_operations() {
    require(license::device_identity::tpm2_openssl_error_queue_round_trip_for_test(),
            "OpenSSL error queue record metadata was not preserved");
    require(license::device_identity::tpm2_openssl_error_queue_segments_for_test(),
            "benign OpenSSL errors contaminated a later provider mapping");
}

void test_provider_error_mapping_and_private_reference_type() {
    using license::device_identity::tpm2_openssl_accepts_tss2_private_pem_for_test;
    using license::device_identity::tpm2_openssl_map_error_for_test;
    require(tpm2_openssl_map_error_for_test(0, "resource manager exhausted", false) == LCC_DEVICE_BUSY,
            "resource exhaustion must map to busy");
    require(tpm2_openssl_map_error_for_test(0, "out of memory for session contexts", false) == LCC_DEVICE_BUSY,
            "session memory exhaustion must map to busy");
    require(tpm2_openssl_map_error_for_test(0, "out of memory for object contexts", false) == LCC_DEVICE_BUSY,
            "object memory exhaustion must map to busy");
    require(tpm2_openssl_map_error_for_test(0, "out of session handles", false) == LCC_DEVICE_BUSY,
            "session handle exhaustion must map to busy");
    require(tpm2_openssl_map_error_for_test(0, "out of object handles", false) == LCC_DEVICE_BUSY,
            "object handle exhaustion must map to busy");
    require(tpm2_openssl_map_error_for_test(0, "TPM is performing selftests", false) == LCC_DEVICE_BUSY,
            "TPM selftest pressure must map to busy");
    require(tpm2_openssl_map_error_for_test(0, "the TPM was not able to start the command", false) ==
                LCC_DEVICE_BUSY,
            "TPM retry pressure must map to busy");
    require(tpm2_openssl_map_error_for_test(0, "command may be retried", false) == LCC_DEVICE_BUSY,
            "retryable TPM command must map to busy");
    require(tpm2_openssl_map_error_for_test(0, "cannot connect to TPM", false) ==
                LCC_DEVICE_HARDWARE_UNAVAILABLE,
            "cannot connect must map to hardware unavailable");
    require(tpm2_openssl_map_error_for_test(0, "cannot get capability from TPM", false) ==
                LCC_DEVICE_HARDWARE_UNAVAILABLE,
            "capability failure must map to hardware unavailable");
    require(tpm2_openssl_map_error_for_test(
                0,
                "cannot create primary 2466 tpm:session(1):authorization failure without DA implications",
                false) ==
                LCC_DEVICE_ACCESS_DENIED,
            "parent authorization RC must map to access denied");
    require(tpm2_openssl_map_error_for_test(0, "cannot load key", true) == LCC_DEVICE_KEY_LOST,
            "cannot load key must map to key lost");
    require(tpm2_openssl_map_error_for_test(0, "input corrupted", true) == LCC_DEVICE_KEY_CORRUPT,
            "corrupt input must map to key corrupt");
    require(tpm2_openssl_map_error_for_test(0, "wrong data length", true) == LCC_DEVICE_KEY_CORRUPT,
            "wrong reference data length must map to key corrupt");
    require(tpm2_openssl_map_error_for_test(0, "memory allocation failure", false) == LCC_DEVICE_INTERNAL_ERROR,
            "allocator failure must remain internal");
    require(tpm2_openssl_map_error_for_test(0, "transport unavailable", false) ==
                LCC_DEVICE_HARDWARE_UNAVAILABLE,
            "transport loss must map to hardware unavailable");
    require(tpm2_openssl_map_error_for_test(0, "unsupported algorithm", false) ==
                LCC_DEVICE_UNSUPPORTED_ALGORITHM,
            "unsupported algorithm mapping");

    const std::string valid = private_pem(private_pem_label(true));
    const std::string ordinary = private_pem(private_pem_label(false));
    const std::string trailing = valid + "unexpected";
    require(tpm2_openssl_accepts_tss2_private_pem_for_test(
                reinterpret_cast<const unsigned char*>(valid.data()), valid.size()),
            "valid TSS2 PEM rejected");
    require(!tpm2_openssl_accepts_tss2_private_pem_for_test(
                reinterpret_cast<const unsigned char*>(ordinary.data()), ordinary.size()),
            "ordinary private-key PEM accepted");
    require(!tpm2_openssl_accepts_tss2_private_pem_for_test(
                reinterpret_cast<const unsigned char*>(trailing.data()), trailing.size()),
            "trailing private-key data accepted");
}

void test_der_signature_edges_are_rejected_before_result_mapping() {
    using license::device_identity::tpm2_openssl_accepts_der_signature_for_test;
    using license::device_identity::tpm2_openssl_decode_der_signature_for_test;
    const std::vector<unsigned char> valid = {0x30U, 0x06U, 0x02U, 0x01U, 0x01U, 0x02U, 0x01U, 0x02U};
    require(tpm2_openssl_accepts_der_signature_for_test(valid.data(), valid.size()),
            "valid DER signature rejected");
    const std::vector<std::vector<unsigned char>> malformed = {
        {0x30U, 0x07U, 0x02U, 0x01U, 0x01U, 0x02U, 0x01U, 0x02U},
        {0x30U, 0x06U, 0x02U, 0x02U, 0x00U, 0x01U, 0x02U, 0x01U, 0x02U},
        {0x30U, 0x06U, 0x02U, 0x01U, 0x00U, 0x02U, 0x01U, 0x02U},
        {0x30U, 0x06U, 0x02U, 0x01U, 0x01U, 0x02U, 0x01U, 0x00U},
        {0x30U, 0x07U, 0x02U, 0x02U, 0x00U, 0x01U, 0x02U, 0x01U, 0x02U},
        {0x30U, 0x06U, 0x02U, 0x01U, 0x01U, 0x02U, 0x02U, 0x00U, 0x02U},
    };
    for (const std::vector<unsigned char>& candidate : malformed) {
        require(!tpm2_openssl_accepts_der_signature_for_test(candidate.data(), candidate.size()),
                "malformed/nonminimal DER signature accepted");
    }

    const auto encode_integer = [](const std::array<unsigned char, 32>& scalar,
                                   std::vector<unsigned char>& body) {
        std::size_t first = 0U;
        while (first < 31U && scalar[first] == 0U) {
            ++first;
        }
        const bool protect_sign = (scalar[first] & 0x80U) != 0U;
        body.push_back(0x02U);
        body.push_back(static_cast<unsigned char>(32U - first + (protect_sign ? 1U : 0U)));
        if (protect_sign) {
            body.push_back(0U);
        }
        body.insert(body.end(), scalar.begin() + static_cast<std::ptrdiff_t>(first), scalar.end());
    };
    const auto make_der = [&](const std::array<unsigned char, 32>& r,
                              const std::array<unsigned char, 32>& s) {
        std::vector<unsigned char> body;
        encode_integer(r, body);
        encode_integer(s, body);
        std::vector<unsigned char> result{0x30U, static_cast<unsigned char>(body.size())};
        result.insert(result.end(), body.begin(), body.end());
        return result;
    };
    std::array<unsigned char, 32> leading_sign{};
    leading_sign[31] = 0x80U;
    std::array<unsigned char, 32> one{};
    one[31] = 1U;
    const std::vector<unsigned char> sign_protected = make_der(leading_sign, one);
    require(tpm2_openssl_accepts_der_signature_for_test(sign_protected.data(), sign_protected.size()),
            "valid sign-protected DER signature rejected");
    const std::array<unsigned char, 32> order = {{
        0xffU, 0xffU, 0xffU, 0xffU, 0x00U, 0x00U, 0x00U, 0x00U,
        0xffU, 0xffU, 0xffU, 0xffU, 0xffU, 0xffU, 0xffU, 0xffU,
        0xbcU, 0xe6U, 0xfaU, 0xadU, 0xa7U, 0x17U, 0x9eU, 0x84U,
        0xf3U, 0xb9U, 0xcaU, 0xc2U, 0xfcU, 0x63U, 0x25U, 0x51U}};
    std::array<unsigned char, 32> valid_high_s = order;
    for (std::size_t index = valid_high_s.size(); index-- > 0U;) {
        if (valid_high_s[index] != 0U) {
            --valid_high_s[index];
            break;
        }
        valid_high_s[index] = 0xffU;
    }
    const std::vector<unsigned char> high_s = make_der(one, valid_high_s);
    std::array<unsigned char, 64> decoded_high_s{};
    require(tpm2_openssl_decode_der_signature_for_test(
                high_s.data(), high_s.size(), decoded_high_s.data(), decoded_high_s.size()),
            "valid high-S DER signature rejected");
    require(std::equal(decoded_high_s.begin(), decoded_high_s.begin() + 31U, std::array<unsigned char, 31U>{}.begin()) &&
                decoded_high_s[31] == 1U &&
                std::equal(decoded_high_s.begin() + 32U, decoded_high_s.end(), valid_high_s.begin()),
            "valid high-S DER signature was not padded into exact P1363");
    const std::vector<unsigned char> out_of_range = make_der(one, order);
    require(!tpm2_openssl_accepts_der_signature_for_test(out_of_range.data(), out_of_range.size()),
            "out-of-range s == n DER signature accepted");
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
    require((storage->selected_directory_flags & O_PATH) == 0,
            "selected storage directory must be fsync-capable, not O_PATH");
    require((storage->selected_directory_flags & O_DIRECTORY) != 0,
            "selected storage directory must be opened as a directory");
    require((storage->selected_directory_flags & O_NOFOLLOW) != 0,
            "selected storage directory must reject symlinks");
    require((storage->lock_flags & O_NONBLOCK) != 0, "lock open must not block on a special file");
}

void test_nonregular_reference_rejects_without_blocking_open() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>(true);
    auto storage = std::make_shared<LockReachPosixStorageApi>();
    storage->reference_present = true;
    storage->reference_nonregular = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_ACCESS_DENIED,
            "FIFO reference was not rejected after nonblocking open");
    require((storage->reference_flags & O_NONBLOCK) != 0,
            "reference open must use O_NONBLOCK before type validation");

    storage = std::make_shared<LockReachPosixStorageApi>();
    storage->lock_nonregular = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true), storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_ACCESS_DENIED,
            "FIFO lock was not rejected after nonblocking open");
    require((storage->lock_flags & O_NONBLOCK) != 0,
            "lock open did not use O_NONBLOCK before type validation");
}

void test_storage_owner_mode_and_symlink_matrix() {
    const auto expect_directory_failure = [](bool symlink, bool bad_mode, bool wrong_owner) {
        auto storage = std::make_shared<LockReachPosixStorageApi>();
        storage->directory_symlink = symlink;
        storage->directory_bad_mode = bad_mode;
        storage->directory_wrong_owner = wrong_owner;
        auto provider = license::device_identity::make_tpm2_openssl_provider(
            std::make_shared<FakeOpenSsl3Api>(true), storage);
        require(provider->open(request_for("/safe")) == LCC_DEVICE_ACCESS_DENIED,
                "unsafe storage directory was accepted");
    };
    expect_directory_failure(true, false, false);
    expect_directory_failure(false, true, false);
    expect_directory_failure(false, false, true);

    const auto expect_reference_failure = [](bool bad_mode, bool wrong_owner) {
        auto storage = std::make_shared<LockReachPosixStorageApi>();
        storage->reference_present = true;
        storage->reference_bad_mode = bad_mode;
        storage->reference_wrong_owner = wrong_owner;
        auto provider = license::device_identity::make_tpm2_openssl_provider(
            std::make_shared<FakeOpenSsl3Api>(true), storage);
        require(provider->open(request_for("/safe")) == LCC_DEVICE_ACCESS_DENIED,
                "unsafe reference ownership/mode was accepted");
    };
    expect_reference_failure(true, false);
    expect_reference_failure(false, true);

    auto storage = std::make_shared<LockReachPosixStorageApi>();
    storage->lock_bad_mode = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true), storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_ACCESS_DENIED,
            "unsafe lock mode was accepted");
    storage = std::make_shared<LockReachPosixStorageApi>();
    storage->lock_wrong_owner = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true), storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_ACCESS_DENIED,
            "unsafe lock ownership was accepted");
}

void test_store_open_clears_stale_errno_and_rejects_default_password_ui() {
    ERR_clear_error();
    auto openssl = std::make_shared<FakeOpenSsl3Api>(true);
    openssl->invoke_ui_prompt = true;
    auto storage = std::make_shared<LockReachPosixStorageApi>();
    storage->reference_present = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    errno = EACCES;
    require(provider->open(request_for("/safe")) == LCC_DEVICE_INTERNAL_ERROR,
            "stale errno changed a provider load error");
    require(storage->reference_checked, "stale-errno test did not reach the reference file");
    require(openssl->store_libctx != nullptr, "store did not use the dedicated library context");
    require(openssl->store_uri.rfind("file:/proc/self/fd/", 0U) == 0U, "store URI was not fd-relative");
    require(openssl->store_properties.empty(), "file store must not be restricted to the tpm2 provider");
    require(openssl->store_ui_method != nullptr, "store must fail closed if rejecting UI setup fails");
    require(openssl->ui_prompt_rejected, "fake STORE did not exercise the rejecting password UI");
    UI* ui = UI_new_method(openssl->store_ui_method);
    require(ui != nullptr, "rejecting UI could not be instantiated");
    char password[16]{};
    require(UI_add_input_string(ui, "password", 0, password, 0, sizeof(password) - 1U) > 0,
            "rejecting UI prompt setup failed");
    require(UI_process(ui) < 0 && password[0] == '\0', "rejecting UI accepted a password prompt");
    UI_free(ui);
}

void test_fake_provider_reaches_generation_store_and_dedicated_self_test() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    auto storage = std::make_shared<LockReachPosixStorageApi>(true);
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    const LCC_DEVICE_RESULT create_result = provider->create(request_for("/safe"));
    require(create_result == LCC_DEVICE_OK, "full fake provider create did not complete");
    require(openssl->generated, "provider did not generate a key");
    require(openssl->keygen_name == "EC" && openssl->keygen_properties == "provider=tpm2",
            "generation did not select the TPM2 EC implementation");
    require(openssl->group_param == "prime256v1" && openssl->digest_param == "SHA256" &&
                openssl->parent_param == 0x40000001U,
            "generation parameters did not enforce P-256/SHA256/parent");
    require(openssl->saw_public_encoder && openssl->saw_private_encoder,
            "public SPKI/private TSS2 encoders were not both exercised");
    require(openssl->store_libctx == openssl->keygen_libctx && openssl->public_key_libctx == openssl->keygen_libctx &&
                openssl->verify_libctx == openssl->keygen_libctx,
            "store/digest/SPKI verification escaped the dedicated library context");
    require(openssl->verify_properties == "provider=default" && openssl->digest_properties == "provider=default",
            "self-test verification did not use the dedicated default provider");
    require(openssl->stage == 13, "self-test did not reach default-provider verification");
    require(openssl->store_properties.empty() && openssl->store_ui_method != nullptr,
            "reference load did not permit the default file loader with a rejecting UI");
    require(storage->temporary_opened && storage->reference_present,
            "temporary publication did not reach the final reference");
}

void test_parent_auth_and_prepublication_failures_leave_no_reference() {
    for (int auth_failure = 1; auth_failure <= 2; ++auth_failure) {
        auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
        openssl->parent_auth_failure = auth_failure;
        auto storage = std::make_shared<LockReachPosixStorageApi>(true);
        auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
        require(provider->create(request_for("/safe")) == LCC_DEVICE_ACCESS_DENIED,
                "parent authorization failure was not access denied");
        require(!storage->temporary_present && !storage->reference_present,
                "parent authorization failure published a reference");
    }

    const auto expect_failure_without_publish = [](bool digest_failure,
                                                   bool sign_failure,
                                                   bool verify_failure,
                                                   bool malformed_der,
                                                   bool encoder_failure) {
        auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
        openssl->fail_digest = digest_failure;
        openssl->fail_sign = sign_failure;
        openssl->fail_verify = verify_failure;
        openssl->fail_malformed_der = malformed_der;
        openssl->fail_encoder = encoder_failure;
        auto storage = std::make_shared<LockReachPosixStorageApi>(true);
        auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
        const LCC_DEVICE_RESULT result = provider->create(request_for("/safe"));
        require(result != LCC_DEVICE_OK, "injected pre-publication failure was reported as success");
        require(!storage->temporary_present && !storage->reference_present,
                "pre-publication failure created storage residue");
    };
    expect_failure_without_publish(true, false, false, false, false);
    expect_failure_without_publish(false, true, false, false, false);
    expect_failure_without_publish(false, false, true, false, false);
    expect_failure_without_publish(false, false, false, true, false);
    expect_failure_without_publish(false, false, false, false, true);
}

void test_store_terminal_and_provider_failure_matrix() {
    const auto expect_corrupt = [](int item_count, bool non_pkey, bool expect_failure) {
        auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
        openssl->store_item_count = item_count;
        openssl->store_non_pkey = non_pkey;
        openssl->store_expect_failure = expect_failure;
        auto storage = std::make_shared<LockReachPosixStorageApi>(true);
        storage->reference_present = true;
        auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
        require(provider->open(request_for("/safe")) == LCC_DEVICE_KEY_CORRUPT,
                "invalid STORE cardinality/type/expectation was accepted");
    };
    expect_corrupt(0, false, false);
    expect_corrupt(1, true, false);
    expect_corrupt(1, false, true);

    const auto expect_store_error = [](const std::string& reason, LCC_DEVICE_RESULT expected) {
        auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
        openssl->store_error_on_load = true;
        openssl->store_error_reason = reason;
        auto storage = std::make_shared<LockReachPosixStorageApi>(true);
        storage->reference_present = true;
        auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
        require(provider->open(request_for("/safe")) == expected,
                "STORE provider error was mapped using stale or missing load data");
    };
    expect_store_error("input corrupted", LCC_DEVICE_KEY_CORRUPT);
    expect_store_error("cannot load key", LCC_DEVICE_KEY_LOST);
    expect_store_error("out of memory for object contexts", LCC_DEVICE_BUSY);

    auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    openssl->store_close_failure = true;
    auto storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->reference_present = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_INTERNAL_ERROR,
            "STORE close failure was reported as a malformed key");
}

void test_postpublication_inode_rollback_preserves_race_winner() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    auto storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->post_publish_mismatch = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_BUSY,
            "post-publication inode replacement was not reported as busy");
    require(storage->reference_present && !storage->temporary_present,
            "post-publication race winner was removed or temporary residue remained");
}

void test_storage_ancestor_symlink_lock_timeout_and_publish_capabilities() {
    auto storage = std::make_shared<LockReachPosixStorageApi>();
    storage->ancestor_bad_mode = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true), storage);
    require(provider->open(request_for("/ancestor/safe")) == LCC_DEVICE_ACCESS_DENIED,
            "unsafe ancestor mode was accepted");

    storage = std::make_shared<LockReachPosixStorageApi>();
    storage->ancestor_symlink = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true), storage);
    require(provider->open(request_for("/ancestor/safe")) == LCC_DEVICE_ACCESS_DENIED,
            "ancestor symlink was accepted");

    storage = std::make_shared<LockReachPosixStorageApi>();
    storage->reference_present = true;
    storage->reference_symlink = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true), storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_KEY_CORRUPT,
            "final reference symlink was not rejected");

    storage = std::make_shared<LockReachPosixStorageApi>();
    storage->lock_symlink = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true), storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_IO_ERROR,
            "lock symlink did not fail closed");

    storage = std::make_shared<LockReachPosixStorageApi>();
    storage->lock_busy = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true), storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_BUSY,
            "lock timeout was not busy");

    storage = std::make_shared<LockReachPosixStorageApi>();
    storage->lock_busy = true;
    storage->lock_releases_after_deadline = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true), storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_BUSY,
            "lock became available after the deadline");
    require(!storage->lock_acquired, "lock was acquired after the monotonic deadline");

    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unsupported_errno = EINVAL;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true, false, true), storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_OK,
            "EINVAL no-replace fallback did not publish");

    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unavailable = true;
    storage->link_unsupported = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true, false, true), storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_IO_ERROR,
            "unsupported no-replace primitives were reported as success");
    require(!storage->temporary_present && !storage->reference_present,
            "unsupported publish path left a temporary or final entry");

    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unavailable_all = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true, false, true), storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_OK,
            "link publish did not clean up when renameat2 was wholly unavailable");
    require(storage->reference_present && !storage->temporary_present,
            "whole-kernel renameat2 fallback left wrong entries");

    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->force_publish_exists = true;
    storage->rename_winner_exists = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true, false, true), storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_OK,
            "rename no-replace winner was not adopted");
    require(storage->reference_present && !storage->temporary_present,
            "rename winner adoption left wrong entries");

    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->reference_present = true;
    storage->rename_unavailable_all = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true, false, true), storage);
    std::string expected_id = "sha256:";
    for (unsigned int index = 0U; index < 32U; ++index) {
        expected_id += "a5";
    }
    const LCC_DEVICE_RESULT exact_delete_result = provider->delete_with_expected_id(request_for("/safe"), expected_id);
    require(exact_delete_result == LCC_DEVICE_OK,
            "expected-id delete did not use the exact no-rename fallback");
    require(!storage->reference_present, "whole-rename exact delete left the reference behind");

    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unavailable_all = true;
    storage->post_publish_mismatch = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true, false, true), storage);
    require(provider->create(request_for("/safe")) != LCC_DEVICE_OK,
            "whole-rename post-publish mismatch was reported as success");
    require(storage->reference_present, "whole-rename rollback removed the replacement winner");

    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unavailable_all = true;
    storage->fallback_swap_before_recheck = true;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true, false, true), storage);
    require(provider->create(request_for("/safe")) != LCC_DEVICE_OK,
            "fallback revalidation race was reported as success");
    require(storage->temporary_present,
            "fallback revalidation race removed the replacement temporary entry");

    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unavailable_all = true;
    storage->fallback_swap_before_recheck = true;
    storage->fail_cleanup_unlink_after = 1;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true, false, true), storage);
    const LCC_DEVICE_RESULT fallback_unlink_result = provider->create(request_for("/safe"));
    require(fallback_unlink_result == LCC_DEVICE_IO_ERROR,
            "fallback revalidation cleanup unlink failure was reported as busy");

    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unavailable_all = true;
    storage->fallback_swap_before_recheck = true;
    storage->fail_cleanup_fsync_after = 1;
    provider = license::device_identity::make_tpm2_openssl_provider(
        std::make_shared<FakeOpenSsl3Api>(true, false, true), storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_IO_ERROR,
            "fallback revalidation cleanup fsync failure was reported as busy");
}

void test_fstat_and_cleanup_failures_are_not_success() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    auto storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->fail_temp_fstat = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_IO_ERROR,
            "temporary fstat failure was reported as success");
    require(!storage->temporary_present && !storage->reference_present,
            "retryable temporary fstat failure left residue");

    openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->fail_temp_fstat_persistent = true;
    provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_IO_ERROR,
            "persistent temporary fstat failure was reported as success");
    require(!storage->temporary_present && !storage->reference_present,
            "persistent temporary fstat failure stranded the owned temporary");

    openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->force_publish_exists = true;
    storage->fail_cleanup_unlink = true;
    provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_IO_ERROR,
            "cleanup unlink failure was reported as success");

    openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unavailable_all = true;
    storage->fail_cleanup_unlink = true;
    provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_IO_ERROR,
            "rename unsupported plus quarantine unlink failure was reported as success");

    openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unavailable_all = true;
    storage->fail_cleanup_fsync = true;
    provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_IO_ERROR,
            "rename unsupported plus quarantine fsync failure was reported as success");
}

void test_publish_cleanup_preserves_a_same_name_replacement() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    auto storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->force_publish_exists = true;
    storage->cleanup_swap = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    const LCC_DEVICE_RESULT result = provider->create(request_for("/safe"));
    require(result == LCC_DEVICE_BUSY,
            "publish cleanup race was not reported as busy");
    require(storage->temporary_present && storage->temporary_open_count >= 2,
            "same-name replacement was removed by pathname-only cleanup");
}

void test_store_cardinality_and_clean_eof_are_required() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    openssl->store_item_count = 2;
    auto storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->reference_present = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_KEY_CORRUPT,
            "multiple STORE PKEY objects were accepted");

    openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    openssl->force_unclean_eof = true;
    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->reference_present = true;
    provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_KEY_CORRUPT,
            "STORE without a clean EOF was accepted");

    openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    openssl->store_item_count = 2;
    openssl->store_first_pkey_null = true;
    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->reference_present = true;
    provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->open(request_for("/safe")) == LCC_DEVICE_KEY_CORRUPT,
            "first-null then second-valid PKEY STORE sequence was accepted");
}

void test_no_replace_fallback_winner_and_publish_rollback() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    auto storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unavailable = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_OK,
            "hard-link no-replace fallback did not publish");
    require(storage->reference_present && !storage->temporary_present,
            "hard-link fallback left a temporary reference");
    require((storage->temporary_flags & (O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC)) ==
                (O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC) &&
                (storage->temporary_flags & O_WRONLY) != 0 && storage->temporary_open_mode == 0600U,
            "temporary reference was not opened with exclusive 0600 no-follow flags");
    require((storage->lock_flags & (O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)) ==
                (O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK) &&
                storage->lock_open_mode == 0600U,
            "namespace lock was not opened with exclusive 0600 no-follow flags");

    openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->rename_unavailable = true;
    storage->link_winner_exists = true;
    provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    require(provider->create(request_for("/safe")) == LCC_DEVICE_OK,
            "hard-link EEXIST winner was not adopted");
    require(storage->reference_present && !storage->temporary_present,
            "hard-link EEXIST winner cleanup removed the wrong entry");

    openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->fail_fsync_once = true;
    provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    const LCC_DEVICE_RESULT fsync_result = provider->create(request_for("/safe"));
    require(fsync_result == LCC_DEVICE_IO_ERROR,
            "publish fsync failure was reported as success");
    require(!storage->reference_present && !storage->temporary_present,
            "owned publish fsync failure did not roll back the final reference");
}

void test_temporary_failure_points_clean_only_the_owned_inode() {
    const auto run = [](bool write_failure, bool fdatasync_failure, bool close_failure) {
        auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
        auto storage = std::make_shared<LockReachPosixStorageApi>(true);
        storage->fail_write = write_failure;
        storage->fail_fdatasync = fdatasync_failure;
        storage->fail_temp_close = close_failure;
        auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
        require(provider->create(request_for("/safe")) == LCC_DEVICE_IO_ERROR,
                "temporary write failure was reported as success");
        require(!storage->temporary_present && !storage->reference_present,
                "temporary failure cleanup removed the wrong inode or left residue");
    };
    run(true, false, false);
    run(false, true, false);
    run(false, false, true);
}

void test_temporary_owner_and_mode_validation_is_exercised() {
    auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    auto storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->temporary_bad_mode = true;
    auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    const LCC_DEVICE_RESULT temporary_mode_result = provider->create(request_for("/safe"));
    require(temporary_mode_result == LCC_DEVICE_ACCESS_DENIED,
            "temporary mode validation was not exercised");

    openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
    storage = std::make_shared<LockReachPosixStorageApi>(true);
    storage->temporary_wrong_owner = true;
    provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
    const LCC_DEVICE_RESULT temporary_owner_result = provider->create(request_for("/safe"));
    require(temporary_owner_result == LCC_DEVICE_ACCESS_DENIED,
            "temporary owner validation was not exercised");
}

void test_shim_provider_lifecycle_1000_cycles() {
    ERR_clear_error();
    for (unsigned int cycle = 0U; cycle < 1000U; ++cycle) {
        auto provider = license::device_identity::make_tpm2_openssl_provider(
            std::make_shared<FakeOpenSsl3Api>(), std::make_shared<NullPosixStorageApi>());
        require(provider->open(request_for("/var/lib/licensecc")) == LCC_DEVICE_PROVIDER_UNAVAILABLE,
                "shim lifecycle cycle changed provider-unavailable mapping");
        require(ERR_peek_error() == 0U, "shim lifecycle cycle leaked an OpenSSL error");
    }
}

void test_shim_successful_open_sign_close_1000_cycles() {
    const ProviderOpenRequest request = request_for("/safe");
    for (unsigned int cycle = 0U; cycle < 1000U; ++cycle) {
        auto openssl = std::make_shared<FakeOpenSsl3Api>(true, false, true);
        auto storage = std::make_shared<LockReachPosixStorageApi>(true);
        storage->reference_present = true;
        auto provider = license::device_identity::make_tpm2_openssl_provider(openssl, storage);
        require(provider->open(request) == LCC_DEVICE_OK, "successful shim open cycle failed");
        license::device_identity::P256Digest digest{};
        license::device_identity::P256Signature signature{};
        require(provider->sign_digest(digest, signature) == LCC_DEVICE_OK,
                "successful shim sign cycle failed");
        provider.reset();
        require(openssl->provider_unload_count == 2 && openssl->libctx_free_count == 1 &&
                    openssl->pkey_free_count >= 2,
                "successful shim cycle leaked provider context or key handles");
        require(openssl->calls.size() >= 3U &&
                    openssl->calls[openssl->calls.size() - 3U] == "provider_unload:tpm2" &&
                    openssl->calls[openssl->calls.size() - 2U] == "provider_unload:default" &&
                    openssl->calls[openssl->calls.size() - 1U] == "libctx_free",
                "successful shim cycle teardown order changed");
    }
}

int run_shim() {
    test_provider_load_order_and_unavailable_mapping();
    test_provider_load_unknown_and_allocator_failures_remain_internal();
    test_error_queue_preserved_when_initially_empty();
    test_layered_provider_error_maps_first_cause_and_preserves_caller_queue();
    test_nested_error_scopes_preserve_empty_and_preexisting_queues();
    test_error_queue_preserves_full_records_and_segments_operations();
    test_provider_error_mapping_and_private_reference_type();
    test_der_signature_edges_are_rejected_before_result_mapping();
    test_storage_path_validation_precedes_provider_access();
    test_create_reaches_namespace_lock_after_directory_open();
    test_nonregular_reference_rejects_without_blocking_open();
    test_storage_owner_mode_and_symlink_matrix();
    test_store_open_clears_stale_errno_and_rejects_default_password_ui();
    test_fake_provider_reaches_generation_store_and_dedicated_self_test();
    test_parent_auth_and_prepublication_failures_leave_no_reference();
    test_store_terminal_and_provider_failure_matrix();
    test_postpublication_inode_rollback_preserves_race_winner();
    test_storage_ancestor_symlink_lock_timeout_and_publish_capabilities();
    test_fstat_and_cleanup_failures_are_not_success();
    test_publish_cleanup_preserves_a_same_name_replacement();
    test_store_cardinality_and_clean_eof_are_required();
    test_no_replace_fallback_winner_and_publish_rollback();
    test_temporary_failure_points_clean_only_the_owned_inode();
    test_temporary_owner_and_mode_validation_is_exercised();
    test_shim_provider_lifecycle_1000_cycles();
    test_shim_successful_open_sign_close_1000_cycles();
    std::cout << "PASS: OpenSSL TPM2 provider shim contract\n";
    return 0;
}

int run_real(const char* storage_directory) {
    const char* marker = std::getenv("LCC_TPM2_CAPABILITY_PREREQUISITE");
    const char* hardware_marker = std::getenv("LCC_RUN_REAL_TPM2_TESTS");
    const bool simulator_prerequisite = marker != nullptr && std::string(marker) == "1";
    const bool hardware_opt_in = hardware_marker != nullptr && std::string(hardware_marker) == "1";
    if (!simulator_prerequisite && !hardware_opt_in) {
        std::cerr << "TPM2 capability prerequisite marker absent; skipping\n";
        return 77;
    }
    if (hardware_opt_in) {
        const char* tcti = std::getenv("TPM2OPENSSL_TCTI");
        struct stat storage_status{};
        if (tcti == nullptr || *tcti == '\0' || storage_directory == nullptr ||
            ::stat(storage_directory, &storage_status) != 0 || !S_ISDIR(storage_status.st_mode) ||
            storage_status.st_uid != ::geteuid() || (storage_status.st_mode & 07777U) != 0700U) {
            std::cerr << "real TPM2 tests require a caller-supplied TPM2OPENSSL_TCTI and an existing 0700 storage directory\n";
            return 2;
        }
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
