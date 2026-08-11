#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif

#include "openssl3_api.hpp"
#include "posix_storage_api.hpp"
#include "../device_key_provider.hpp"

#include <openssl/bio.h>
#include <openssl/core_names.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/ui.h>
#include <openssl/x509.h>

#include <linux/fs.h>
#include <sys/file.h>
#include <sys/syscall.h>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace license {
namespace device_identity {
namespace {

constexpr unsigned int kRandomStrength = 256U;
constexpr std::size_t kNamespaceHashSize = 64U;
constexpr int kDirectoryOpenFlags = O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW;
constexpr int kSelectedDirectoryOpenFlags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW;
constexpr int kReferenceOpenFlags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW;

class NativeOpenSsl3Api final : public OpenSsl3Api {
public:
    OSSL_LIB_CTX* libctx_new() noexcept override { return OSSL_LIB_CTX_new(); }
    void libctx_free(OSSL_LIB_CTX* libctx) noexcept override { OSSL_LIB_CTX_free(libctx); }
    OSSL_PROVIDER* provider_load(OSSL_LIB_CTX* libctx, const char* name) noexcept override {
        return OSSL_PROVIDER_load(libctx, name);
    }
    int provider_unload(OSSL_PROVIDER* provider) noexcept override { return OSSL_PROVIDER_unload(provider); }

    EVP_PKEY_CTX* pkey_ctx_new_from_name(OSSL_LIB_CTX* libctx,
                                          const char* name,
                                          const char* properties) noexcept override {
        return EVP_PKEY_CTX_new_from_name(libctx, name, properties);
    }
    EVP_PKEY_CTX* pkey_ctx_new_from_pkey(OSSL_LIB_CTX* libctx,
                                         EVP_PKEY* key,
                                         const char* properties) noexcept override {
        return EVP_PKEY_CTX_new_from_pkey(libctx, key, properties);
    }
    void pkey_ctx_free(EVP_PKEY_CTX* context) noexcept override { EVP_PKEY_CTX_free(context); }
    int pkey_keygen_init(EVP_PKEY_CTX* context) noexcept override { return EVP_PKEY_keygen_init(context); }
    int pkey_ctx_set_params(EVP_PKEY_CTX* context, const OSSL_PARAM* params) noexcept override {
        return EVP_PKEY_CTX_set_params(context, params);
    }
    int pkey_generate(EVP_PKEY_CTX* context, EVP_PKEY** key) noexcept override {
        return EVP_PKEY_generate(context, key);
    }
    int pkey_sign_init(EVP_PKEY_CTX* context) noexcept override { return EVP_PKEY_sign_init(context); }
    int pkey_verify_init(EVP_PKEY_CTX* context) noexcept override { return EVP_PKEY_verify_init(context); }
    int pkey_ctx_set_signature_md(EVP_PKEY_CTX* context, const EVP_MD* digest) noexcept override {
        return EVP_PKEY_CTX_set_signature_md(context, digest);
    }
    int pkey_sign(EVP_PKEY_CTX* context,
                  unsigned char* signature,
                  std::size_t* signature_size,
                  const unsigned char* digest,
                  std::size_t digest_size) noexcept override {
        return EVP_PKEY_sign(context, signature, signature_size, digest, digest_size);
    }
    int pkey_verify(EVP_PKEY_CTX* context,
                    const unsigned char* signature,
                    std::size_t signature_size,
                    const unsigned char* digest,
                    std::size_t digest_size) noexcept override {
        return EVP_PKEY_verify(context, signature, signature_size, digest, digest_size);
    }
    EVP_MD* md_fetch(OSSL_LIB_CTX* libctx, const char* name, const char* properties) noexcept override {
        return EVP_MD_fetch(libctx, name, properties);
    }
    void md_free(EVP_MD* digest) noexcept override { EVP_MD_free(digest); }
    void pkey_free(EVP_PKEY* key) noexcept override { EVP_PKEY_free(key); }
    const OSSL_PROVIDER* pkey_get0_provider(const EVP_PKEY* key) noexcept override {
        return EVP_PKEY_get0_provider(key);
    }
    const char* provider_name(const OSSL_PROVIDER* provider) noexcept override {
        return provider == nullptr ? nullptr : OSSL_PROVIDER_get0_name(provider);
    }
    int pkey_get_utf8_string_param(const EVP_PKEY* key,
                                   const char* name,
                                   char* value,
                                   std::size_t value_size,
                                   std::size_t* written) noexcept override {
        return EVP_PKEY_get_utf8_string_param(key, name, value, value_size, written);
    }

    OSSL_ENCODER_CTX* encoder_new_for_pkey(const EVP_PKEY* key,
                                           int selection,
                                           const char* output_type,
                                           const char* output_structure,
                                           const char* properties) noexcept override {
        return OSSL_ENCODER_CTX_new_for_pkey(key, selection, output_type, output_structure, properties);
    }
    int encoder_to_data(OSSL_ENCODER_CTX* context,
                        unsigned char** data,
                        std::size_t* data_size) noexcept override {
        return OSSL_ENCODER_to_data(context, data, data_size);
    }
    void encoder_free(OSSL_ENCODER_CTX* context) noexcept override { OSSL_ENCODER_CTX_free(context); }

    OSSL_STORE_CTX* store_open_ex(const char* uri,
                                  OSSL_LIB_CTX* libctx,
                                  const char* properties,
                                  const UI_METHOD* ui_method,
                                  void* ui_data) noexcept override {
        return OSSL_STORE_open_ex(uri, libctx, properties, ui_method, ui_data, nullptr, nullptr, nullptr);
    }
    int store_expect(OSSL_STORE_CTX* context, int expected_type) noexcept override {
        return OSSL_STORE_expect(context, expected_type);
    }
    OSSL_STORE_INFO* store_load(OSSL_STORE_CTX* context) noexcept override { return OSSL_STORE_load(context); }
    int store_eof(OSSL_STORE_CTX* context) noexcept override { return OSSL_STORE_eof(context); }
    int store_error(OSSL_STORE_CTX* context) noexcept override { return OSSL_STORE_error(context); }
    int store_info_type(const OSSL_STORE_INFO* info) noexcept override { return OSSL_STORE_INFO_get_type(info); }
    EVP_PKEY* store_info_get1_pkey(const OSSL_STORE_INFO* info) noexcept override {
        return OSSL_STORE_INFO_get1_PKEY(info);
    }
    void store_info_free(OSSL_STORE_INFO* info) noexcept override { OSSL_STORE_INFO_free(info); }
    int store_close(OSSL_STORE_CTX* context) noexcept override { return OSSL_STORE_close(context); }

    int rand_priv_bytes_ex(OSSL_LIB_CTX* libctx,
                           unsigned char* data,
                           std::size_t size,
                           unsigned int strength) noexcept override {
        return RAND_priv_bytes_ex(libctx, data, size, strength);
    }
};

class NativePosixStorageApi final : public PosixStorageApi {
public:
    int openat(int directory, const char* path, int flags, mode_t mode) noexcept override {
        return ::openat(directory, path, flags, mode);
    }
    int close(int descriptor) noexcept override { return ::close(descriptor); }
    int fstat(int descriptor, struct stat* status) noexcept override { return ::fstat(descriptor, status); }
    int flock(int descriptor, int operation) noexcept override { return ::flock(descriptor, operation); }
    ssize_t write(int descriptor, const void* data, std::size_t size) noexcept override {
        return ::write(descriptor, data, size);
    }
    int fdatasync(int descriptor) noexcept override { return ::fdatasync(descriptor); }
    int fsync(int descriptor) noexcept override { return ::fsync(descriptor); }
    int unlinkat(int directory, const char* path, int flags) noexcept override {
        return ::unlinkat(directory, path, flags);
    }
    int linkat(int old_directory,
               const char* old_path,
               int new_directory,
               const char* new_path,
               int flags) noexcept override {
        return ::linkat(old_directory, old_path, new_directory, new_path, flags);
    }
    int renameat2_noreplace(int directory, const char* old_path, const char* new_path) noexcept override {
        return static_cast<int>(::syscall(SYS_renameat2,
                                          directory,
                                          old_path,
                                          directory,
                                          new_path,
                                          static_cast<unsigned int>(RENAME_NOREPLACE)));
    }
    int clock_gettime(clockid_t clock, struct timespec* value) noexcept override {
        return ::clock_gettime(clock, value);
    }
    int nanosleep(const struct timespec* request, struct timespec* remaining) noexcept override {
        return ::nanosleep(request, remaining);
    }
};

std::shared_ptr<OpenSsl3Api> native_openssl3_api() noexcept {
    try {
        return std::make_shared<NativeOpenSsl3Api>();
    } catch (...) {
        return nullptr;
    }
}

std::shared_ptr<PosixStorageApi> native_posix_storage_api() noexcept {
    try {
        return std::make_shared<NativePosixStorageApi>();
    } catch (...) {
        return nullptr;
    }
}

class ErrorQueueScope final {
public:
    ErrorQueueScope() noexcept {
        const bool had_error = ERR_peek_error() != 0U;
        marked_ = ERR_set_mark() == 1;
        if (!marked_ && !had_error) {
            ERR_raise(ERR_LIB_USER, ERR_R_INTERNAL_ERROR);
            sentinel_ = ERR_peek_last_error();
            marked_ = sentinel_ != 0U && ERR_set_mark() == 1;
        }
    }
    ~ErrorQueueScope() {
        if (marked_) {
            (void)ERR_pop_to_mark();
            if (sentinel_ != 0U) {
                (void)ERR_get_error();
            }
        }
    }

    ErrorQueueScope(const ErrorQueueScope&) = delete;
    ErrorQueueScope& operator=(const ErrorQueueScope&) = delete;

private:
    bool marked_ = false;
    unsigned long sentinel_ = 0U;
};

std::string provider_error_text() {
    const unsigned long error = ERR_peek_last_error();
    const char* reason = ERR_reason_error_string(error);
    std::string result = reason == nullptr ? std::string() : std::string(reason);
    std::transform(result.begin(), result.end(), result.begin(), [](unsigned char value) {
        return static_cast<char>(std::tolower(value));
    });
    return result;
}

LCC_DEVICE_RESULT map_provider_error(int saved_errno, bool loading_reference) noexcept {
    if (saved_errno == EACCES || saved_errno == EPERM) {
        return LCC_DEVICE_ACCESS_DENIED;
    }
    if (saved_errno == EAGAIN || saved_errno == EWOULDBLOCK || saved_errno == EBUSY) {
        return LCC_DEVICE_BUSY;
    }
    const std::string text = provider_error_text();
    if (text.find("permission") != std::string::npos || text.find("access") != std::string::npos ||
        text.find("auth") != std::string::npos) {
        return LCC_DEVICE_ACCESS_DENIED;
    }
    if (text.find("unsupported") != std::string::npos || text.find("not implemented") != std::string::npos ||
        text.find("algorithm") != std::string::npos) {
        return LCC_DEVICE_UNSUPPORTED_ALGORITHM;
    }
    if (text.find("tcti") != std::string::npos || text.find("transport") != std::string::npos ||
        text.find("device") != std::string::npos || text.find("resource") != std::string::npos) {
        return LCC_DEVICE_HARDWARE_UNAVAILABLE;
    }
    if (text.find("parent") != std::string::npos || text.find("hierarchy") != std::string::npos ||
        text.find("object") != std::string::npos || text.find("handle") != std::string::npos) {
        return LCC_DEVICE_KEY_LOST;
    }
    if (text.find("decoder") != std::string::npos || text.find("pem") != std::string::npos ||
        text.find("der") != std::string::npos || text.find("parse") != std::string::npos) {
        return LCC_DEVICE_KEY_CORRUPT;
    }
    if (loading_reference && saved_errno == EINVAL) {
        return LCC_DEVICE_KEY_CORRUPT;
    }
    return LCC_DEVICE_INTERNAL_ERROR;
}

bool safe_namespace_component(const std::string& path, std::vector<std::string>& components) {
    if (path.empty() || path.front() != '/' || path.find('\0') != std::string::npos) {
        return false;
    }
    std::size_t offset = 1U;
    while (offset <= path.size()) {
        const std::size_t slash = path.find('/', offset);
        const std::size_t end = slash == std::string::npos ? path.size() : slash;
        if (end == offset) {
            return false;
        }
        const std::string component = path.substr(offset, end - offset);
        if (component == "." || component == ".." || component.empty()) {
            return false;
        }
        components.push_back(component);
        if (slash == std::string::npos) {
            break;
        }
        offset = slash + 1U;
        if (offset == path.size()) {
            return false;
        }
    }
    return !components.empty();
}

bool owned_directory(const struct stat& status, bool selected) noexcept {
    if (!S_ISDIR(status.st_mode)) {
        return false;
    }
    if (selected) {
        return status.st_uid == ::geteuid() && (status.st_mode & 07777U) == 0700U;
    }
    return (status.st_mode & 0022U) == 0U;
}

struct DirectoryHandle final {
    std::shared_ptr<PosixStorageApi> api;
    int descriptor = -1;
    DirectoryHandle() = default;
    ~DirectoryHandle() {
        if (descriptor >= 0 && api) {
            (void)api->close(descriptor);
        }
    }
    DirectoryHandle(const DirectoryHandle&) = delete;
    DirectoryHandle& operator=(const DirectoryHandle&) = delete;
};

LCC_DEVICE_RESULT open_storage_directory(const std::shared_ptr<PosixStorageApi>& api,
                                         const std::string& path,
                                         DirectoryHandle& out) noexcept {
    if (!api) {
        return LCC_DEVICE_INTERNAL_ERROR;
    }
    std::vector<std::string> components;
    if (!safe_namespace_component(path, components)) {
        return LCC_DEVICE_INVALID_ARGUMENT;
    }
    int current = api->openat(AT_FDCWD, "/", kDirectoryOpenFlags, 0U);
    if (current < 0) {
        return errno == EACCES || errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
    }
    for (std::size_t index = 0U; index < components.size(); ++index) {
        const bool selected = index + 1U == components.size();
        const int next = api->openat(current,
                                     components[index].c_str(),
                                     selected ? kSelectedDirectoryOpenFlags : kDirectoryOpenFlags,
                                     0U);
        if (next < 0) {
            const int saved_errno = errno;
            (void)api->close(current);
            return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                   saved_errno == ENOENT ? LCC_DEVICE_KEY_NOT_FOUND : LCC_DEVICE_IO_ERROR;
        }
        struct stat status{};
        if (api->fstat(next, &status) != 0) {
            const int saved_errno = errno;
            (void)api->close(next);
            (void)api->close(current);
            return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                                                                    LCC_DEVICE_IO_ERROR;
        }
        if (!owned_directory(status, selected)) {
            (void)api->close(next);
            (void)api->close(current);
            return LCC_DEVICE_ACCESS_DENIED;
        }
        (void)api->close(current);
        current = next;
    }
    out.api = api;
    out.descriptor = current;
    return LCC_DEVICE_OK;
}

class NamespaceLock final {
public:
    NamespaceLock(std::shared_ptr<PosixStorageApi> api, int, std::uint32_t timeout)
        : api_(std::move(api)), timeout_(timeout) {}

    ~NamespaceLock() {
        if (descriptor_ >= 0 && api_) {
            (void)api_->close(descriptor_);
        }
    }

    NamespaceLock(const NamespaceLock&) = delete;
    NamespaceLock& operator=(const NamespaceLock&) = delete;

    LCC_DEVICE_RESULT acquire(int directory, const std::string& name) noexcept {
        if (!api_) {
            return errno == EACCES || errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
        }
        descriptor_ = api_->openat(directory, name.c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600U);
        if (descriptor_ < 0) {
            return errno == EACCES || errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
        }
        struct stat status{};
        if (api_->fstat(descriptor_, &status) != 0 || !S_ISREG(status.st_mode) || status.st_uid != ::geteuid() ||
            (status.st_mode & 07777U) != 0600U) {
            return LCC_DEVICE_ACCESS_DENIED;
        }
        struct timespec start{};
        if (api_->clock_gettime(CLOCK_MONOTONIC, &start) != 0) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
        const std::int64_t deadline_ns = static_cast<std::int64_t>(start.tv_sec) * 1000000000LL + start.tv_nsec +
                                         static_cast<std::int64_t>(timeout_) * 1000000LL;
        for (;;) {
            if (api_->flock(descriptor_, LOCK_EX | LOCK_NB) == 0) {
                return LCC_DEVICE_OK;
            }
            const int saved_errno = errno;
            if (saved_errno == EINTR) {
                continue;
            }
            if (saved_errno != EWOULDBLOCK && saved_errno != EAGAIN) {
                return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                                                                        LCC_DEVICE_IO_ERROR;
            }
            struct timespec now{};
            if (api_->clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
                return LCC_DEVICE_INTERNAL_ERROR;
            }
            const std::int64_t now_ns = static_cast<std::int64_t>(now.tv_sec) * 1000000000LL + now.tv_nsec;
            if (now_ns >= deadline_ns) {
                return LCC_DEVICE_BUSY;
            }
            const struct timespec pause{0, 1000000L};
            if (api_->nanosleep(&pause, nullptr) != 0 && errno != EINTR) {
                return LCC_DEVICE_INTERNAL_ERROR;
            }
        }
    }

private:
    std::shared_ptr<PosixStorageApi> api_;
    int descriptor_ = -1;
    std::uint32_t timeout_ = 0U;
};

struct FileIdentity final {
    dev_t device = 0;
    ino_t inode = 0;
};

bool same_file(const FileIdentity& left, const FileIdentity& right) noexcept {
    return left.device == right.device && left.inode == right.inode;
}

bool valid_reference_status(const struct stat& status) noexcept {
    return S_ISREG(status.st_mode) && status.st_uid == ::geteuid() && (status.st_mode & 07777U) == 0600U;
}

bool constant_time_equal(const std::string& left, const std::string& right) noexcept {
    std::size_t difference = left.size() ^ right.size();
    const std::size_t maximum = (std::max)(left.size(), right.size());
    for (std::size_t index = 0U; index < maximum; ++index) {
        const unsigned char a = index < left.size() ? static_cast<unsigned char>(left[index]) : 0U;
        const unsigned char b = index < right.size() ? static_cast<unsigned char>(right[index]) : 0U;
        difference |= static_cast<std::size_t>(a ^ b);
    }
    return difference == 0U;
}

UI_METHOD* rejecting_ui_method() noexcept {
    static UI_METHOD* method = []() noexcept -> UI_METHOD* {
        UI_METHOD* candidate = UI_create_method("licensecc-tpm2-no-password");
        if (candidate == nullptr || UI_method_set_writer(candidate, [](UI*, UI_STRING*) -> int { return 1; }) != 1 ||
            UI_method_set_reader(candidate, [](UI*, UI_STRING* string) -> int {
                const enum UI_string_types type = UI_get_string_type(string);
                return type == UIT_INFO || type == UIT_ERROR ? 1 : 0;
            }) != 1) {
            if (candidate != nullptr) {
                UI_destroy_method(candidate);
            }
            return nullptr;
        }
        return candidate;
    }();
    return method;
}

class Tpm2OpenSslProvider final : public DeviceKeyProvider {
public:
    Tpm2OpenSslProvider(std::shared_ptr<OpenSsl3Api> openssl, std::shared_ptr<PosixStorageApi> posix)
        : openssl_(std::move(openssl)), posix_(std::move(posix)) {}

    ~Tpm2OpenSslProvider() override {
        reset_key();
        unload_context();
    }

    LCC_DEVICE_RESULT open(const ProviderOpenRequest& request) noexcept override {
        ErrorQueueScope errors;
        try {
            reset_key();
            const LCC_DEVICE_RESULT validated = validate_request(request);
            if (validated != LCC_DEVICE_OK) {
                return validated;
            }
            const LCC_DEVICE_RESULT context_result = ensure_context();
            if (context_result != LCC_DEVICE_OK) {
                return context_result;
            }
            DirectoryHandle directory;
            LCC_DEVICE_RESULT result = open_storage_directory(posix_, request.storage_directory, directory);
            if (result != LCC_DEVICE_OK) {
                return result;
            }
            NamespaceLock lock(posix_, directory.descriptor, request.lock_timeout_ms);
            result = lock.acquire(directory.descriptor, request.device_namespace.lock_name);
            if (result != LCC_DEVICE_OK) {
                return result;
            }
            LoadedReference loaded;
            result = load_reference(directory.descriptor, request.device_namespace.linux_filename, loaded);
            if (result != LCC_DEVICE_OK) {
                return result;
            }
            adopt_loaded(std::move(loaded), request.scope);
            return LCC_DEVICE_OK;
        } catch (...) {
            reset_key();
            return LCC_DEVICE_INTERNAL_ERROR;
        }
    }

    LCC_DEVICE_RESULT create(const ProviderOpenRequest& request) noexcept override {
        ErrorQueueScope errors;
        try {
            reset_key();
            const LCC_DEVICE_RESULT validated = validate_request(request);
            if (validated != LCC_DEVICE_OK) {
                return validated;
            }
            const LCC_DEVICE_RESULT context_result = ensure_context();
            if (context_result != LCC_DEVICE_OK) {
                return context_result;
            }
            DirectoryHandle directory;
            LCC_DEVICE_RESULT result = open_storage_directory(posix_, request.storage_directory, directory);
            if (result != LCC_DEVICE_OK) {
                return result;
            }
            NamespaceLock lock(posix_, directory.descriptor, request.lock_timeout_ms);
            result = lock.acquire(directory.descriptor, request.device_namespace.lock_name);
            if (result != LCC_DEVICE_OK) {
                return result;
            }

            LoadedReference existing;
            result = load_reference(directory.descriptor, request.device_namespace.linux_filename, existing);
            if (result == LCC_DEVICE_OK) {
                adopt_loaded(std::move(existing), request.scope);
                return LCC_DEVICE_OK;
            }
            if (result != LCC_DEVICE_KEY_NOT_FOUND) {
                return result;
            }

            EVP_PKEY* generated = nullptr;
            result = generate_key(&generated);
            if (result != LCC_DEVICE_OK) {
                return result;
            }
            LoadedReference generated_reference;
            result = validate_key(generated, generated_reference.spki);
            if (result == LCC_DEVICE_OK) {
                result = self_test(generated, generated_reference.spki);
            }
            if (result != LCC_DEVICE_OK) {
                openssl_->pkey_free(generated);
                return result;
            }

            SensitiveVector pem;
            result = encode_private_reference(generated, pem.value);
            openssl_->pkey_free(generated);
            generated = nullptr;
            if (result != LCC_DEVICE_OK) {
                return result;
            }

            FileIdentity temp_identity;
            std::string temporary_name;
            result = write_temporary(directory.descriptor,
                                      request.device_namespace.linux_filename,
                                      pem.value,
                                      temporary_name,
                                      temp_identity);
            if (result != LCC_DEVICE_OK) {
                return result;
            }

            bool published = false;
            result = publish_temporary(directory.descriptor,
                                        temporary_name,
                                        request.device_namespace.linux_filename,
                                        published);
            if (result != LCC_DEVICE_OK) {
                cleanup_temporary(directory.descriptor, temporary_name);
                return result;
            }
            if (!published) {
                result = load_reference(directory.descriptor, request.device_namespace.linux_filename, existing);
                if (result == LCC_DEVICE_OK) {
                    adopt_loaded(std::move(existing), request.scope);
                }
                return result;
            }

            LoadedReference reopened;
            result = load_reference(directory.descriptor, request.device_namespace.linux_filename, reopened);
            if (result == LCC_DEVICE_OK && !same_file(temp_identity, reopened.identity)) {
                result = LCC_DEVICE_KEY_CORRUPT;
            }
            if (result != LCC_DEVICE_OK) {
                cleanup_loaded(reopened);
                rollback_owned(directory.descriptor, request.device_namespace.linux_filename, temp_identity);
                return result;
            }
            adopt_loaded(std::move(reopened), request.scope);
            return LCC_DEVICE_OK;
        } catch (...) {
            reset_key();
            return LCC_DEVICE_INTERNAL_ERROR;
        }
    }

    LCC_DEVICE_RESULT public_spki(P256Spki& out) noexcept override {
        return key_ != nullptr && validated_ ? (out = spki_, LCC_DEVICE_OK) : LCC_DEVICE_KEY_LOST;
    }

    LCC_DEVICE_RESULT sign_digest(const P256Digest& digest, P256Signature& out) noexcept override {
        ErrorQueueScope errors;
        if (key_ == nullptr || !validated_) {
            return LCC_DEVICE_KEY_LOST;
        }
        try {
            PkeyContext context(openssl_, openssl_->pkey_ctx_new_from_pkey(libctx_, key_, "provider=tpm2"));
            MessageDigest sha256_digest(openssl_, openssl_->md_fetch(libctx_, "SHA256", "provider=default"));
            if (!context.get() || !sha256_digest.get() || openssl_->pkey_sign_init(context.get()) <= 0 ||
                openssl_->pkey_ctx_set_signature_md(context.get(), sha256_digest.get()) <= 0) {
                return map_provider_error(0, false);
            }
            std::size_t signature_size = 0U;
            if (openssl_->pkey_sign(context.get(), nullptr, &signature_size, digest.data(), digest.size()) <= 0 ||
                signature_size < 8U || signature_size > 72U) {
                return map_provider_error(0, false);
            }
            SensitiveVector der(signature_size);
            if (openssl_->pkey_sign(context.get(), der.value.data(), &signature_size, digest.data(), digest.size()) <=
                    0 ||
                signature_size < 8U || signature_size > der.value.size() ||
                !der_signature_to_p1363(der.value.data(), signature_size, out)) {
                return map_provider_error(0, false) == LCC_DEVICE_INTERNAL_ERROR ? LCC_DEVICE_SIGN_FAILED :
                                                                                       map_provider_error(0, false);
            }
            return LCC_DEVICE_OK;
        } catch (...) {
            return LCC_DEVICE_SIGN_FAILED;
        }
    }

    LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept override {
        if (key_ == nullptr || !validated_) {
            return LCC_DEVICE_KEY_LOST;
        }
        ProviderMetadata candidate;
        candidate.backend = kTpm2OpenSslProviderContract.backend;
        candidate.scope = scope_;
        candidate.assurance = kTpm2OpenSslProviderContract.assurance;
        candidate.provider = kTpm2OpenSslProviderContract.provider;
        candidate.algorithm = kTpm2OpenSslProviderContract.algorithm;
        out = std::move(candidate);
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT delete_with_expected_id(const ProviderOpenRequest& request,
                                              const std::string& expected_device_key_id) noexcept override {
        ErrorQueueScope errors;
        try {
            reset_key();
            const LCC_DEVICE_RESULT validated = validate_request(request);
            if (validated != LCC_DEVICE_OK) {
                return validated;
            }
            if (expected_device_key_id.size() != LCC_DEVICE_KEY_ID_MAX) {
                return LCC_DEVICE_INVALID_ARGUMENT;
            }
            const LCC_DEVICE_RESULT context_result = ensure_context();
            if (context_result != LCC_DEVICE_OK) {
                return context_result;
            }
            DirectoryHandle directory;
            LCC_DEVICE_RESULT result = open_storage_directory(posix_, request.storage_directory, directory);
            if (result != LCC_DEVICE_OK) {
                return result;
            }
            NamespaceLock lock(posix_, directory.descriptor, request.lock_timeout_ms);
            result = lock.acquire(directory.descriptor, request.device_namespace.lock_name);
            if (result != LCC_DEVICE_OK) {
                return result;
            }
            LoadedReference loaded;
            result = load_reference(directory.descriptor, request.device_namespace.linux_filename, loaded);
            if (result != LCC_DEVICE_OK) {
                return result;
            }
            const std::string actual = device_key_id(loaded.spki);
            cleanup_loaded(loaded);
            if (actual.empty()) {
                return LCC_DEVICE_KEY_CORRUPT;
            }
            if (!constant_time_equal(actual, expected_device_key_id)) {
                return LCC_DEVICE_POLICY_VIOLATION;
            }
            if (posix_->unlinkat(directory.descriptor, request.device_namespace.linux_filename.c_str(), 0) != 0) {
                return errno == EACCES || errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
            }
            return posix_->fsync(directory.descriptor) == 0 ? LCC_DEVICE_OK : LCC_DEVICE_IO_ERROR;
        } catch (...) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
    }

private:
    class PkeyContext final {
    public:
        PkeyContext(std::shared_ptr<OpenSsl3Api> api, EVP_PKEY_CTX* context)
            : api_(std::move(api)), context_(context) {}
        ~PkeyContext() {
            if (context_ != nullptr && api_) {
                api_->pkey_ctx_free(context_);
            }
        }
        PkeyContext(const PkeyContext&) = delete;
        PkeyContext& operator=(const PkeyContext&) = delete;
        EVP_PKEY_CTX* get() const noexcept { return context_; }

    private:
        std::shared_ptr<OpenSsl3Api> api_;
        EVP_PKEY_CTX* context_ = nullptr;
    };

    class MessageDigest final {
    public:
        MessageDigest(std::shared_ptr<OpenSsl3Api> api, EVP_MD* digest)
            : api_(std::move(api)), digest_(digest) {}
        ~MessageDigest() {
            if (digest_ != nullptr && api_) {
                api_->md_free(digest_);
            }
        }
        MessageDigest(const MessageDigest&) = delete;
        MessageDigest& operator=(const MessageDigest&) = delete;
        EVP_MD* get() const noexcept { return digest_; }

    private:
        std::shared_ptr<OpenSsl3Api> api_;
        EVP_MD* digest_ = nullptr;
    };

    struct LoadedReference final {
        EVP_PKEY* key = nullptr;
        P256Spki spki{};
        FileIdentity identity;
    };

    LCC_DEVICE_RESULT validate_request(const ProviderOpenRequest& request) const noexcept {
        if (request.backend != LCC_DEVICE_BACKEND_TPM2_OPENSSL ||
            (request.scope != LCC_DEVICE_SCOPE_USER && request.scope != LCC_DEVICE_SCOPE_MACHINE) ||
            request.device_namespace.hash.size() != kNamespaceHashSize ||
            request.device_namespace.linux_filename != "licensecc-v1-" + request.device_namespace.hash +
                ".tss2.pem" ||
            request.device_namespace.lock_name != request.device_namespace.linux_filename + ".lock" ||
            request.storage_directory.empty() || request.storage_directory.front() != '/') {
            return LCC_DEVICE_INVALID_ARGUMENT;
        }
        std::vector<std::string> components;
        if (!safe_namespace_component(request.storage_directory, components)) {
            return LCC_DEVICE_INVALID_ARGUMENT;
        }
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT ensure_context() noexcept {
        if (libctx_ != nullptr && default_provider_ != nullptr && tpm2_provider_ != nullptr) {
            return LCC_DEVICE_OK;
        }
        unload_context();
        if (!openssl_) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
        libctx_ = openssl_->libctx_new();
        if (libctx_ == nullptr) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
        default_provider_ = openssl_->provider_load(libctx_, "default");
        if (default_provider_ == nullptr) {
            unload_context();
            return LCC_DEVICE_PROVIDER_UNAVAILABLE;
        }
        tpm2_provider_ = openssl_->provider_load(libctx_, "tpm2");
        if (tpm2_provider_ == nullptr) {
            unload_context();
            return LCC_DEVICE_PROVIDER_UNAVAILABLE;
        }
        return LCC_DEVICE_OK;
    }

    void unload_context() noexcept {
        if (tpm2_provider_ != nullptr && openssl_) {
            (void)openssl_->provider_unload(tpm2_provider_);
            tpm2_provider_ = nullptr;
        }
        if (default_provider_ != nullptr && openssl_) {
            (void)openssl_->provider_unload(default_provider_);
            default_provider_ = nullptr;
        }
        if (libctx_ != nullptr && openssl_) {
            openssl_->libctx_free(libctx_);
            libctx_ = nullptr;
        }
    }

    LCC_DEVICE_RESULT generate_key(EVP_PKEY** out) noexcept {
        if (out == nullptr) {
            return LCC_DEVICE_INVALID_ARGUMENT;
        }
        *out = nullptr;
        PkeyContext context(openssl_, openssl_->pkey_ctx_new_from_name(libctx_, "EC", "provider=tpm2"));
        if (!context.get() || openssl_->pkey_keygen_init(context.get()) <= 0) {
            return map_provider_error(0, false);
        }
        char group[] = "prime256v1";
        char digest[] = "SHA256";
        unsigned int parent = 0x40000001U;
        const OSSL_PARAM params[] = {
            OSSL_PARAM_construct_utf8_string(OSSL_PKEY_PARAM_GROUP_NAME, group, 0U),
            OSSL_PARAM_construct_utf8_string(OSSL_PKEY_PARAM_DIGEST, digest, 0U),
            OSSL_PARAM_construct_uint("parent", &parent),
            OSSL_PARAM_construct_end()};
        if (openssl_->pkey_ctx_set_params(context.get(), params) <= 0 ||
            openssl_->pkey_generate(context.get(), out) <= 0 || *out == nullptr) {
            if (*out != nullptr) {
                openssl_->pkey_free(*out);
                *out = nullptr;
            }
            return map_provider_error(0, false);
        }
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT validate_key(EVP_PKEY* key, P256Spki& out) noexcept {
        const OSSL_PROVIDER* owning_provider = key == nullptr ? nullptr : openssl_->pkey_get0_provider(key);
        const char* owning_name = openssl_->provider_name(owning_provider);
        if (key == nullptr || owning_name == nullptr || std::string(owning_name) != "tpm2") {
            return LCC_DEVICE_KEY_CORRUPT;
        }
        std::array<char, 32> group{};
        std::size_t group_size = 0U;
        if (openssl_->pkey_get_utf8_string_param(key,
                                                 OSSL_PKEY_PARAM_GROUP_NAME,
                                                 group.data(),
                                                 group.size(),
                                                 &group_size) <= 0 ||
            std::string(group.data(), group_size) != "prime256v1") {
            return LCC_DEVICE_UNSUPPORTED_ALGORITHM;
        }
        OSSL_ENCODER_CTX* raw_encoder = openssl_->encoder_new_for_pkey(
            key, EVP_PKEY_PUBLIC_KEY, "DER", "SubjectPublicKeyInfo", nullptr);
        if (raw_encoder == nullptr) {
            return map_provider_error(0, true);
        }
        unsigned char* encoded = nullptr;
        std::size_t encoded_size = 0U;
        const int encoded_ok = openssl_->encoder_to_data(raw_encoder, &encoded, &encoded_size);
        openssl_->encoder_free(raw_encoder);
        if (encoded_ok != 1 || encoded == nullptr || encoded_size != 91U) {
            OPENSSL_free(encoded);
            return LCC_DEVICE_KEY_CORRUPT;
        }
        P256Spki candidate{};
        const bool canonical = canonicalize_p256_spki(encoded, encoded_size, candidate);
        OPENSSL_free(encoded);
        if (!canonical) {
            return LCC_DEVICE_KEY_CORRUPT;
        }
        out = candidate;
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT self_test(EVP_PKEY* key, const P256Spki& spki) noexcept {
        P256Digest digest{};
        if (!sha256(spki.data(), spki.size(), digest)) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
        P256Signature signature{};
        EVP_PKEY* saved = key_;
        key_ = key;
        validated_ = true;
        const LCC_DEVICE_RESULT signed_result = sign_digest(digest, signature);
        key_ = saved;
        validated_ = saved != nullptr;
        if (signed_result != LCC_DEVICE_OK) {
            return signed_result;
        }
        return verify_p256_p1363(spki, digest, signature) ? LCC_DEVICE_OK : LCC_DEVICE_SIGN_FAILED;
    }

    LCC_DEVICE_RESULT encode_private_reference(EVP_PKEY* key, std::vector<std::uint8_t>& out) noexcept {
        OSSL_ENCODER_CTX* raw_encoder = openssl_->encoder_new_for_pkey(
            key, EVP_PKEY_KEYPAIR, "PEM", "TSS2 PRIVATE KEY", "provider=tpm2");
        if (raw_encoder == nullptr) {
            return map_provider_error(0, false);
        }
        unsigned char* encoded = nullptr;
        std::size_t encoded_size = 0U;
        const int encoded_ok = openssl_->encoder_to_data(raw_encoder, &encoded, &encoded_size);
        openssl_->encoder_free(raw_encoder);
        if (encoded_ok != 1 || encoded == nullptr || encoded_size == 0U) {
            OPENSSL_free(encoded);
            return map_provider_error(0, false);
        }
        SensitiveVector candidate(encoded_size);
        std::memcpy(candidate.value.data(), encoded, encoded_size);
        OPENSSL_free(encoded);
        out.swap(candidate.value);
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT load_reference(int directory,
                                     const std::string& filename,
                                     LoadedReference& out) noexcept {
        const int descriptor = posix_->openat(directory, filename.c_str(), kReferenceOpenFlags, 0U);
        if (descriptor < 0) {
            if (errno == ENOENT) {
                return LCC_DEVICE_KEY_NOT_FOUND;
            }
            return errno == EACCES || errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                   errno == ELOOP ? LCC_DEVICE_KEY_CORRUPT : LCC_DEVICE_IO_ERROR;
        }
        struct stat status{};
        if (posix_->fstat(descriptor, &status) != 0) {
            const int saved_errno = errno;
            (void)posix_->close(descriptor);
            return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                                                                    LCC_DEVICE_IO_ERROR;
        }
        if (!valid_reference_status(status)) {
            (void)posix_->close(descriptor);
            return LCC_DEVICE_ACCESS_DENIED;
        }
        const std::string uri = "file:/proc/self/fd/" + std::to_string(descriptor);
        UI_METHOD* ui_method = rejecting_ui_method();
        OSSL_STORE_CTX* store = openssl_->store_open_ex(uri.c_str(), libctx_, "provider=tpm2", ui_method, nullptr);
        if (store == nullptr) {
            (void)posix_->close(descriptor);
            return map_provider_error(errno, true);
        }
        EVP_PKEY* key = nullptr;
        bool duplicate = false;
        if (openssl_->store_expect(store, OSSL_STORE_INFO_PKEY) != 1) {
            (void)openssl_->store_close(store);
            (void)posix_->close(descriptor);
            return LCC_DEVICE_KEY_CORRUPT;
        }
        while (!openssl_->store_eof(store)) {
            OSSL_STORE_INFO* info = openssl_->store_load(store);
            if (info == nullptr) {
                break;
            }
            if (openssl_->store_info_type(info) != OSSL_STORE_INFO_PKEY) {
                duplicate = true;
            } else if (key != nullptr) {
                duplicate = true;
            } else {
                key = openssl_->store_info_get1_pkey(info);
            }
            openssl_->store_info_free(info);
        }
        const bool store_failed = openssl_->store_error(store) != 0;
        const int close_result = openssl_->store_close(store);
        (void)posix_->close(descriptor);
        if (store_failed || close_result != 1) {
            if (key != nullptr) {
                openssl_->pkey_free(key);
            }
            return map_provider_error(0, true);
        }
        if (duplicate || key == nullptr) {
            if (key != nullptr) {
                openssl_->pkey_free(key);
            }
            return LCC_DEVICE_KEY_CORRUPT;
        }
        P256Spki spki{};
        const LCC_DEVICE_RESULT validated = validate_key(key, spki);
        if (validated != LCC_DEVICE_OK) {
            openssl_->pkey_free(key);
            return validated;
        }
        const LCC_DEVICE_RESULT usable = self_test(key, spki);
        if (usable != LCC_DEVICE_OK) {
            openssl_->pkey_free(key);
            return usable;
        }
        out.key = key;
        out.spki = spki;
        out.identity.device = status.st_dev;
        out.identity.inode = status.st_ino;
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT write_temporary(int directory,
                                       const std::string& filename,
                                       const std::vector<std::uint8_t>& data,
                                       std::string& out_name,
                                       FileIdentity& out_identity) noexcept {
        std::array<std::uint8_t, 16> random{};
        if (openssl_->rand_priv_bytes_ex(libctx_, random.data(), random.size(), kRandomStrength) != 1) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
        const std::string prefix = filename.substr(0U, filename.size() - std::strlen(".tss2.pem"));
        out_name = prefix + ".tmp." + lowercase_hex(random.data(), random.size());
        const int descriptor = posix_->openat(directory, out_name.c_str(), O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC |
                                                                    O_NOFOLLOW,
                                               0600U);
        if (descriptor < 0) {
            return errno == EEXIST ? LCC_DEVICE_BUSY :
                   errno == EACCES || errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
        }
        struct stat status{};
        if (posix_->fstat(descriptor, &status) != 0 || !valid_reference_status(status)) {
            (void)posix_->close(descriptor);
            cleanup_temporary(directory, out_name);
            return LCC_DEVICE_ACCESS_DENIED;
        }
        out_identity.device = status.st_dev;
        out_identity.inode = status.st_ino;
        std::size_t offset = 0U;
        while (offset < data.size()) {
            const ssize_t written = posix_->write(descriptor, data.data() + offset, data.size() - offset);
            if (written > 0) {
                offset += static_cast<std::size_t>(written);
                continue;
            }
            if (written < 0 && errno == EINTR) {
                continue;
            }
            (void)posix_->close(descriptor);
            cleanup_temporary(directory, out_name);
            return errno == EACCES || errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
        }
        if (posix_->fdatasync(descriptor) != 0) {
            const int saved_errno = errno;
            (void)posix_->close(descriptor);
            cleanup_temporary(directory, out_name);
            return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
        }
        if (posix_->close(descriptor) != 0) {
            cleanup_temporary(directory, out_name);
            return LCC_DEVICE_IO_ERROR;
        }
        return LCC_DEVICE_OK;
    }

    void cleanup_temporary(int directory, const std::string& name) noexcept {
        if (posix_->unlinkat(directory, name.c_str(), 0) == 0 || errno == ENOENT) {
            (void)posix_->fsync(directory);
        }
    }

    LCC_DEVICE_RESULT publish_temporary(int directory,
                                         const std::string& temporary,
                                         const std::string& final,
                                         bool& published) noexcept {
        published = false;
        if (posix_->renameat2_noreplace(directory, temporary.c_str(), final.c_str()) == 0) {
            published = true;
            return posix_->fsync(directory) == 0 ? LCC_DEVICE_OK : LCC_DEVICE_IO_ERROR;
        }
        const int rename_errno = errno;
        if (rename_errno == EEXIST) {
            cleanup_temporary(directory, temporary);
            return LCC_DEVICE_OK;
        }
        if (rename_errno != ENOSYS && rename_errno != EINVAL && rename_errno != EOPNOTSUPP) {
            return rename_errno == EACCES || rename_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                                                                     LCC_DEVICE_IO_ERROR;
        }
        if (posix_->linkat(directory, temporary.c_str(), directory, final.c_str(), 0) == 0) {
            published = true;
            if (posix_->unlinkat(directory, temporary.c_str(), 0) != 0 || posix_->fsync(directory) != 0) {
                return LCC_DEVICE_IO_ERROR;
            }
            return LCC_DEVICE_OK;
        }
        const int link_errno = errno;
        if (link_errno == EEXIST) {
            cleanup_temporary(directory, temporary);
            return LCC_DEVICE_OK;
        }
        return link_errno == ENOSYS || link_errno == EINVAL || link_errno == EOPNOTSUPP ? LCC_DEVICE_IO_ERROR :
               link_errno == EACCES || link_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
    }

    void rollback_owned(int directory, const std::string& filename, const FileIdentity& identity) noexcept {
        const int descriptor = posix_->openat(directory, filename.c_str(), kReferenceOpenFlags, 0U);
        if (descriptor < 0) {
            return;
        }
        struct stat status{};
        const bool owned = posix_->fstat(descriptor, &status) == 0 &&
                           same_file(identity, FileIdentity{status.st_dev, status.st_ino});
        (void)posix_->close(descriptor);
        if (owned && posix_->unlinkat(directory, filename.c_str(), 0) == 0) {
            (void)posix_->fsync(directory);
        }
    }

    void cleanup_loaded(LoadedReference& loaded) noexcept {
        if (loaded.key != nullptr && openssl_) {
            openssl_->pkey_free(loaded.key);
            loaded.key = nullptr;
        }
    }

    void adopt_loaded(LoadedReference&& loaded, std::uint32_t scope) noexcept {
        reset_key();
        key_ = loaded.key;
        loaded.key = nullptr;
        spki_ = loaded.spki;
        scope_ = scope;
        validated_ = true;
    }

    void reset_key() noexcept {
        if (key_ != nullptr && openssl_) {
            openssl_->pkey_free(key_);
            key_ = nullptr;
        }
        validated_ = false;
        spki_.fill(0U);
        scope_ = LCC_DEVICE_SCOPE_UNSPECIFIED;
    }

    std::shared_ptr<OpenSsl3Api> openssl_;
    std::shared_ptr<PosixStorageApi> posix_;
    OSSL_LIB_CTX* libctx_ = nullptr;
    OSSL_PROVIDER* default_provider_ = nullptr;
    OSSL_PROVIDER* tpm2_provider_ = nullptr;
    EVP_PKEY* key_ = nullptr;
    P256Spki spki_{};
    std::uint32_t scope_ = LCC_DEVICE_SCOPE_UNSPECIFIED;
    bool validated_ = false;
};

}  // namespace

std::shared_ptr<OpenSsl3Api> make_native_openssl3_api() noexcept { return native_openssl3_api(); }
std::shared_ptr<PosixStorageApi> make_native_posix_storage_api() noexcept { return native_posix_storage_api(); }

std::unique_ptr<DeviceKeyProvider> make_tpm2_openssl_provider(
    std::shared_ptr<OpenSsl3Api> openssl,
    std::shared_ptr<PosixStorageApi> posix) noexcept {
    try {
        if (!openssl || !posix) {
            return nullptr;
        }
        return std::unique_ptr<DeviceKeyProvider>(
            new Tpm2OpenSslProvider(std::move(openssl), std::move(posix)));
    } catch (...) {
        return nullptr;
    }
}

std::unique_ptr<DeviceKeyProvider> make_tpm2_openssl_provider() noexcept {
    return make_tpm2_openssl_provider(make_native_openssl3_api(), make_native_posix_storage_api());
}

}  // namespace device_identity
}  // namespace license
