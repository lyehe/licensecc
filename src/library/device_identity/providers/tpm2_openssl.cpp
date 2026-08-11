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
#include <climits>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace license {
namespace device_identity {
namespace {

constexpr unsigned int kRandomStrength = 256U;
constexpr std::size_t kNamespaceHashSize = 64U;
constexpr std::array<std::uint8_t, 27> kP256SpkiPrefix = {{
    0x30U, 0x59U, 0x30U, 0x13U, 0x06U, 0x07U, 0x2aU, 0x86U, 0x48U, 0xceU, 0x3dU, 0x02U, 0x01U,
    0x06U, 0x08U, 0x2aU, 0x86U, 0x48U, 0xceU, 0x3dU, 0x03U, 0x01U, 0x07U, 0x03U, 0x42U, 0x00U, 0x04U}};
constexpr int kDirectoryOpenFlags = O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW;
constexpr int kSelectedDirectoryOpenFlags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW;
constexpr int kReferenceOpenFlags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK;

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
    EVP_PKEY* d2i_public_key(OSSL_LIB_CTX* libctx,
                             const unsigned char* data,
                             std::size_t size) noexcept override {
        if (data == nullptr || size > static_cast<std::size_t>(LONG_MAX)) {
            return nullptr;
        }
        const unsigned char* cursor = data;
        EVP_PKEY* key = d2i_PUBKEY_ex(nullptr,
                                      &cursor,
                                      static_cast<long>(size),
                                      libctx,
                                      "provider=default");
        if (key == nullptr || cursor != data + size) {
            EVP_PKEY_free(key);
            return nullptr;
        }
        return key;
    }
    int digest(EVP_MD* digest,
               const unsigned char* data,
               std::size_t size,
               unsigned char* output,
               std::size_t* output_size) noexcept override {
        unsigned int written = 0U;
        const unsigned char empty = 0U;
        const int result = EVP_Digest(size == 0U ? &empty : data,
                                      size,
                                      output,
                                      &written,
                                      digest,
                                      nullptr);
        if (output_size != nullptr) {
            *output_size = written;
        }
        return result;
    }
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
    void clear_free(void* data, std::size_t size) noexcept override { OPENSSL_clear_free(data, size); }

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

constexpr const char* kErrorQueueSentinel = "licensecc-tpm2-error-queue-sentinel";
constexpr std::size_t kErrorQueueTextCapacity = ERR_MAX_DATA_SIZE;
thread_local unsigned long g_error_queue_sentinel = 0U;
thread_local unsigned int g_error_queue_scope_depth = 0U;
thread_local const char* g_tpm2_openssl_test_stage = "idle";

void set_tpm2_openssl_test_stage(const char* stage) noexcept {
    g_tpm2_openssl_test_stage = stage == nullptr ? "unknown" : stage;
}

class ErrorQueueScope final {
public:
    ErrorQueueScope() noexcept {
        previous_sentinel_ = g_error_queue_sentinel;
        owns_queue_ = g_error_queue_scope_depth++ == 0U;
        if (!owns_queue_) {
            return;
        }
        preserve_caller_queue();
        ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", kErrorQueueSentinel);
        g_error_queue_sentinel = ERR_peek_last_error();
    }
    ~ErrorQueueScope() {
        if (g_error_queue_scope_depth > 0U) {
            --g_error_queue_scope_depth;
        }
        if (owns_queue_) {
            ERR_clear_error();
            g_error_queue_sentinel = previous_sentinel_;
            restore_caller_queue();
        }
    }

    ErrorQueueScope(const ErrorQueueScope&) = delete;
    ErrorQueueScope& operator=(const ErrorQueueScope&) = delete;

private:
    struct PreservedError final {
        unsigned long code = 0U;
        int line = 0;
        int data_flags = 0;
        bool has_file = false;
        bool has_function = false;
        std::array<char, kErrorQueueTextCapacity> file{};
        std::array<char, kErrorQueueTextCapacity> function{};
        std::array<char, kErrorQueueTextCapacity> data{};
        std::size_t file_size = 0U;
        std::size_t function_size = 0U;
        std::size_t data_size = 0U;
    };

    template <std::size_t Size>
    static void copy_text(const char* source,
                          std::array<char, Size>& destination,
                          std::size_t& destination_size,
                          bool& present) noexcept {
        present = source != nullptr;
        if (!present) {
            destination_size = 0U;
            destination[0] = '\0';
            return;
        }
        destination_size = (std::min)(std::strlen(source), destination.size() - 1U);
        std::memcpy(destination.data(), source, destination_size);
        destination[destination_size] = '\0';
    }

    void preserve_caller_queue() noexcept {
        for (;;) {
            const char* file = nullptr;
            const char* function = nullptr;
            int line = 0;
            const char* data = nullptr;
            int flags = 0;
            const unsigned long code = ERR_get_error_all(&file, &line, &function, &data, &flags);
            if (code == 0U) {
                break;
            }
            if (preserved_count_ == preserved_.size()) {
                continue;
            }
            PreservedError& record = preserved_[preserved_count_++];
            record.code = code;
            record.line = line;
            record.data_flags = flags;
            copy_text(file, record.file, record.file_size, record.has_file);
            copy_text(function, record.function, record.function_size, record.has_function);
            if ((flags & ERR_TXT_STRING) != 0 && data != nullptr) {
                record.data_size = (std::min)(std::strlen(data), record.data.size() - 1U);
                std::memcpy(record.data.data(), data, record.data_size);
                record.data[record.data_size] = '\0';
            }
        }
    }

    void restore_caller_queue() noexcept {
        for (std::size_t index = 0U; index < preserved_count_; ++index) {
            const PreservedError& record = preserved_[index];
            ERR_new();
            ERR_set_debug(record.has_file ? record.file.data() : nullptr,
                          record.line,
                          record.has_function ? record.function.data() : nullptr);
            ERR_set_error(ERR_GET_LIB(record.code),
                          ERR_GET_RFLAGS(record.code) | ERR_GET_REASON(record.code),
                          nullptr);
            if (record.data_size != 0U) {
                char* restored_data = static_cast<char*>(OPENSSL_malloc(record.data_size + 1U));
                if (restored_data != nullptr) {
                    std::memcpy(restored_data, record.data.data(), record.data_size + 1U);
                    ERR_set_error_data(restored_data, record.data_flags | ERR_TXT_MALLOCED);
                }
            }
        }
    }

    bool owns_queue_ = false;
    unsigned long previous_sentinel_ = 0U;
    std::array<PreservedError, ERR_NUM_ERRORS> preserved_{};
    std::size_t preserved_count_ = 0U;
};

void clear_provider_error_queue() noexcept {
    if (g_error_queue_sentinel == 0U) {
        ERR_clear_error();
        return;
    }
    for (;;) {
        const unsigned long error = ERR_get_error();
        if (error == 0U) {
            break;
        }
    }
    ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", kErrorQueueSentinel);
}

std::string provider_error_text() {
    if (g_error_queue_sentinel == 0U) {
        const unsigned long error = ERR_peek_last_error();
        const char* reason = ERR_reason_error_string(error);
        return reason == nullptr ? std::string() : std::string(reason);
    }
    std::string result;
    for (;;) {
        const char* data = nullptr;
        int data_flags = 0;
        const unsigned long error = ERR_get_error_all(nullptr, nullptr, nullptr, &data, &data_flags);
        if (error == 0U) {
            break;
        }
        if ((data_flags & ERR_TXT_STRING) != 0 && data != nullptr && std::strcmp(data, kErrorQueueSentinel) == 0) {
            continue;
        }
        const char* reason = ERR_reason_error_string(error);
        if (reason != nullptr && *reason != '\0') {
            if (!result.empty()) {
                result.push_back(' ');
            }
            result.append(reason);
        }
        if ((data_flags & ERR_TXT_STRING) != 0 && data != nullptr && *data != '\0') {
            if (!result.empty()) {
                result.push_back(' ');
            }
            result.append(data);
        }
    }
    ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", kErrorQueueSentinel);
    std::transform(result.begin(), result.end(), result.begin(), [](unsigned char value) {
        return static_cast<char>(std::tolower(value));
    });
    return result;
}

LCC_DEVICE_RESULT map_provider_error_text(int saved_errno,
                                          bool loading_reference,
                                          const std::string& text) {
    if (saved_errno == EACCES || saved_errno == EPERM) {
        return LCC_DEVICE_ACCESS_DENIED;
    }
    if (saved_errno == EAGAIN || saved_errno == EWOULDBLOCK || saved_errno == EBUSY) {
        return LCC_DEVICE_BUSY;
    }
    if (text.find("memory allocation failure") != std::string::npos ||
        text.find("allocation failure") != std::string::npos) {
        return LCC_DEVICE_INTERNAL_ERROR;
    }
    if (text.find("permission") != std::string::npos || text.find("access") != std::string::npos ||
        text.find("auth") != std::string::npos || text.find("authorization") != std::string::npos ||
        text.find("bad auth") != std::string::npos ||
        (text.find("cannot create primary") != std::string::npos &&
         (text.find("tss2") != std::string::npos || text.find("tpm") != std::string::npos) &&
         (text.find("0x0000098e") != std::string::npos || text.find("0x000009a2") != std::string::npos ||
          text.find("0x098e") != std::string::npos || text.find("0x09a2") != std::string::npos ||
         text.find("0x98e") != std::string::npos || text.find("0x9a2") != std::string::npos))) {
        return LCC_DEVICE_ACCESS_DENIED;
    }
    if (text.find("cannot connect") != std::string::npos ||
        text.find("cannot get capability") != std::string::npos ||
        text.find("tcti") != std::string::npos || text.find("transport") != std::string::npos ||
        text.find("device unavailable") != std::string::npos || text.find("device not found") != std::string::npos) {
        return LCC_DEVICE_HARDWARE_UNAVAILABLE;
    }
    if (text.find("exhaust") != std::string::npos || text.find("resource manager") != std::string::npos ||
        text.find("session memory") != std::string::npos || text.find("object memory") != std::string::npos ||
        text.find("out of memory for object contexts") != std::string::npos ||
        text.find("out of memory for session contexts") != std::string::npos ||
        text.find("out of object handles") != std::string::npos ||
        text.find("out of session handles") != std::string::npos ||
        text.find("performing selftests") != std::string::npos ||
        text.find("command may be retried") != std::string::npos ||
        text.find("was not able to start the command") != std::string::npos ||
        text.find("out of resources") != std::string::npos || text.find("no resources") != std::string::npos ||
        text.find("insufficient resources") != std::string::npos ||
        text.find("retry") != std::string::npos || text.find("try again") != std::string::npos ||
        text.find("timeout") != std::string::npos || text.find("lock") != std::string::npos ||
        text.find("busy") != std::string::npos || text.find("too many") != std::string::npos ||
        text.find("limit") != std::string::npos) {
        return LCC_DEVICE_BUSY;
    }
    if (loading_reference && (text.find("input corrupted") != std::string::npos ||
                              text.find("wrong data length") != std::string::npos ||
                              text.find("decoder") != std::string::npos || text.find("pem") != std::string::npos ||
                              text.find("der") != std::string::npos || text.find("parse") != std::string::npos)) {
        return LCC_DEVICE_KEY_CORRUPT;
    }
    if (text.find("cannot load key") != std::string::npos) {
        return LCC_DEVICE_KEY_LOST;
    }
    if (text.find("unsupported") != std::string::npos || text.find("not implemented") != std::string::npos ||
        text.find("algorithm") != std::string::npos) {
        return LCC_DEVICE_UNSUPPORTED_ALGORITHM;
    }
    if (text.find("unavailable") != std::string::npos ||
        (text.find("resource") != std::string::npos && text.find("tpm") != std::string::npos)) {
        return LCC_DEVICE_HARDWARE_UNAVAILABLE;
    }
    if (text.find("cannot create primary") != std::string::npos || text.find("parent") != std::string::npos ||
        text.find("hierarchy") != std::string::npos || text.find("object") != std::string::npos ||
        text.find("handle") != std::string::npos) {
        return LCC_DEVICE_KEY_LOST;
    }
    if (loading_reference && saved_errno == EINVAL) {
        return LCC_DEVICE_KEY_CORRUPT;
    }
    return LCC_DEVICE_INTERNAL_ERROR;
}

LCC_DEVICE_RESULT map_provider_error(int saved_errno, bool loading_reference) {
    return map_provider_error_text(saved_errno, loading_reference, provider_error_text());
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
                                         DirectoryHandle& out) {
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
            return saved_errno == EACCES || saved_errno == EPERM || saved_errno == ELOOP ?
                       LCC_DEVICE_ACCESS_DENIED :
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
        descriptor_ = api_->openat(
            directory, name.c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600U);
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
        bool initial_attempt = true;
        for (;;) {
            if (!initial_attempt) {
                struct timespec before_retry{};
                if (api_->clock_gettime(CLOCK_MONOTONIC, &before_retry) != 0) {
                    return LCC_DEVICE_INTERNAL_ERROR;
                }
                const std::int64_t before_retry_ns =
                    static_cast<std::int64_t>(before_retry.tv_sec) * 1000000000LL + before_retry.tv_nsec;
                if (before_retry_ns >= deadline_ns) {
                    return LCC_DEVICE_BUSY;
                }
            }
            initial_attempt = false;
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
            const std::int64_t remaining_ns = deadline_ns - now_ns;
            const std::int64_t pause_ns = (std::min)(remaining_ns, static_cast<std::int64_t>(1000000LL));
            const struct timespec pause{pause_ns / 1000000000LL, pause_ns % 1000000000LL};
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

bool valid_removal_status(const struct stat& status, bool require_safe_mode) noexcept {
    return S_ISREG(status.st_mode) && status.st_uid == ::geteuid() &&
           (!require_safe_mode || (status.st_mode & 07777U) == 0600U);
}

bool valid_tss2_private_pem(const unsigned char* data, std::size_t size) noexcept {
    constexpr char kBegin[] = "-----BEGIN TSS2 PRIVATE KEY-----";
    constexpr char kEnd[] = "-----END TSS2 PRIVATE KEY-----";
    constexpr std::size_t kBeginSize = sizeof(kBegin) - 1U;
    constexpr std::size_t kEndSize = sizeof(kEnd) - 1U;
    if (data == nullptr || size <= kBeginSize + kEndSize ||
        std::memcmp(data, kBegin, kBeginSize) != 0) {
        return false;
    }
    std::size_t content_end = size;
    if (content_end > 0U && data[content_end - 1U] == '\n') {
        --content_end;
        if (content_end > 0U && data[content_end - 1U] == '\r') {
            --content_end;
        }
    }
    if (content_end < kBeginSize + kEndSize ||
        std::memcmp(data + content_end - kEndSize, kEnd, kEndSize) != 0) {
        return false;
    }
    const std::size_t body_end = content_end - kEndSize;
    bool has_body = false;
    for (std::size_t index = kBeginSize; index < body_end; ++index) {
        const unsigned char value = data[index];
        if (value == '\r' || value == '\n') {
            continue;
        }
        if (!(std::isalnum(value) || value == '+' || value == '/' || value == '=')) {
            return false;
        }
        has_body = true;
    }
    return has_body;
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
        if (candidate == nullptr || UI_method_set_writer(candidate, [](UI*, UI_STRING*) -> int { return 1; }) != 0 ||
            UI_method_set_reader(candidate, [](UI*, UI_STRING* string) -> int {
                const enum UI_string_types type = UI_get_string_type(string);
                return type == UIT_INFO || type == UIT_ERROR ? 1 : 0;
            }) != 0) {
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
            set_tpm2_openssl_test_stage("reset");
            reset_key();
            set_tpm2_openssl_test_stage("validate_request");
            const LCC_DEVICE_RESULT validated = validate_request(request);
            if (validated != LCC_DEVICE_OK) {
                return validated;
            }
            set_tpm2_openssl_test_stage("ensure_context");
            const LCC_DEVICE_RESULT context_result = ensure_context();
            if (context_result != LCC_DEVICE_OK) {
                return context_result;
            }
            DirectoryHandle directory;
            set_tpm2_openssl_test_stage("open_storage");
            LCC_DEVICE_RESULT result = open_storage_directory(posix_, request.storage_directory, directory);
            if (result != LCC_DEVICE_OK) {
                return result;
            }
            NamespaceLock lock(posix_, directory.descriptor, request.lock_timeout_ms);
            set_tpm2_openssl_test_stage("acquire_lock");
            result = lock.acquire(directory.descriptor, request.device_namespace.lock_name);
            if (result != LCC_DEVICE_OK) {
                return result;
            }

            LoadedReference existing;
            set_tpm2_openssl_test_stage("load_existing");
            result = load_reference(directory.descriptor, request.device_namespace.linux_filename, existing);
            if (result == LCC_DEVICE_OK) {
                adopt_loaded(std::move(existing), request.scope);
                return LCC_DEVICE_OK;
            }
            if (result != LCC_DEVICE_KEY_NOT_FOUND) {
                return result;
            }

            EVP_PKEY* generated_raw = nullptr;
            set_tpm2_openssl_test_stage("generate_key");
            result = generate_key(&generated_raw);
            if (result != LCC_DEVICE_OK) {
                return result;
            }
            PkeyHandle generated(openssl_, generated_raw);
            LoadedReference generated_reference;
            set_tpm2_openssl_test_stage("validate_generated_key");
            result = validate_key(generated.get(), generated_reference.spki);
            if (result == LCC_DEVICE_OK) {
                set_tpm2_openssl_test_stage("self_test");
                result = self_test(generated.get(), generated_reference.spki);
            }
            if (result != LCC_DEVICE_OK) {
                return result;
            }

            SensitiveVector pem;
            set_tpm2_openssl_test_stage("encode_private_reference");
            result = encode_private_reference(generated.get(), pem.value);
            if (result != LCC_DEVICE_OK) {
                return result;
            }

            FileIdentity temp_identity;
            std::string temporary_name;
            set_tpm2_openssl_test_stage("write_temporary");
            result = write_temporary(directory.descriptor,
                                      request.device_namespace.linux_filename,
                                      pem.value,
                                      temporary_name,
                                      temp_identity);
            if (result != LCC_DEVICE_OK) {
                return result;
            }

            bool published = false;
            bool cleanup_attempted = false;
            bool transaction_active = true;
            const auto rollback_transaction = [&]() noexcept {
                LCC_DEVICE_RESULT rollback_result = LCC_DEVICE_OK;
                if (!transaction_active) {
                    return rollback_result;
                }
                if (published) {
                    try {
                        bool removed = false;
                        const LCC_DEVICE_RESULT final_result = remove_owned(
                            directory.descriptor,
                            request.device_namespace.linux_filename,
                            temp_identity,
                            removed);
                        if (final_result != LCC_DEVICE_OK && final_result != LCC_DEVICE_KEY_NOT_FOUND) {
                            rollback_result = final_result;
                        }
                    } catch (...) {
                        rollback_result = LCC_DEVICE_INTERNAL_ERROR;
                    }
                }
                try {
                    const LCC_DEVICE_RESULT temporary_result = cleanup_temporary(
                        directory.descriptor, temporary_name, temp_identity);
                    if (temporary_result != LCC_DEVICE_OK &&
                        (rollback_result == LCC_DEVICE_OK || rollback_result == LCC_DEVICE_BUSY ||
                         rollback_result == LCC_DEVICE_KEY_NOT_FOUND)) {
                        rollback_result = temporary_result;
                    }
                } catch (...) {
                    rollback_result = LCC_DEVICE_INTERNAL_ERROR;
                }
                transaction_active = false;
                return rollback_result;
            };

            try {
                set_tpm2_openssl_test_stage("publish_temporary");
                result = publish_temporary(directory.descriptor,
                                            temporary_name,
                                            request.device_namespace.linux_filename,
                                            published,
                                            cleanup_attempted,
                                            temp_identity);
                if (result != LCC_DEVICE_OK) {
                    const LCC_DEVICE_RESULT rollback_result = rollback_transaction();
                    return rollback_result == LCC_DEVICE_OK ? result : rollback_result;
                }
                if (!published) {
                    set_tpm2_openssl_test_stage("adopt_race_winner");
                    result = load_reference(directory.descriptor, request.device_namespace.linux_filename, existing);
                    if (result == LCC_DEVICE_OK) {
                        adopt_loaded(std::move(existing), request.scope);
                        transaction_active = false;
                        return LCC_DEVICE_OK;
                    }
                    const LCC_DEVICE_RESULT rollback_result = rollback_transaction();
                    return rollback_result == LCC_DEVICE_OK ? result : rollback_result;
                }

                LoadedReference reopened;
                set_tpm2_openssl_test_stage("reopen_published");
                result = load_reference(directory.descriptor, request.device_namespace.linux_filename, reopened);
                if (result == LCC_DEVICE_OK && !same_file(temp_identity, reopened.identity)) {
                    result = LCC_DEVICE_KEY_CORRUPT;
                }
                if (result != LCC_DEVICE_OK) {
                    cleanup_loaded(reopened);
                    const LCC_DEVICE_RESULT rollback_result = rollback_transaction();
                    return rollback_result == LCC_DEVICE_OK ? result : rollback_result;
                }
                adopt_loaded(std::move(reopened), request.scope);
                transaction_active = false;
                set_tpm2_openssl_test_stage("success");
                return LCC_DEVICE_OK;
            } catch (...) {
                set_tpm2_openssl_test_stage("transaction_exception");
                const LCC_DEVICE_RESULT rollback_result = rollback_transaction();
                return rollback_result == LCC_DEVICE_OK ? LCC_DEVICE_INTERNAL_ERROR : rollback_result;
            }
        } catch (...) {
            set_tpm2_openssl_test_stage("outer_exception");
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
            clear_provider_error_queue();
            PkeyContext context(openssl_, openssl_->pkey_ctx_new_from_pkey(libctx_, key_, "provider=tpm2"));
            if (!context.get()) {
                return map_provider_error(0, false);
            }
            clear_provider_error_queue();
            MessageDigest sha256_digest(openssl_, openssl_->md_fetch(libctx_, "SHA256", "provider=default"));
            if (!sha256_digest.get()) {
                return map_provider_error(0, false);
            }
            clear_provider_error_queue();
            if (openssl_->pkey_sign_init(context.get()) <= 0) {
                return map_provider_error(0, false);
            }
            clear_provider_error_queue();
            if (openssl_->pkey_ctx_set_signature_md(context.get(), sha256_digest.get()) <= 0) {
                return map_provider_error(0, false);
            }
            std::size_t signature_size = 0U;
            clear_provider_error_queue();
            if (openssl_->pkey_sign(context.get(), nullptr, &signature_size, digest.data(), digest.size()) <= 0) {
                return map_provider_error(0, false);
            }
            if (signature_size < 8U || signature_size > 72U) {
                return LCC_DEVICE_KEY_CORRUPT;
            }
            SensitiveVector der(signature_size);
            clear_provider_error_queue();
            if (openssl_->pkey_sign(context.get(), der.value.data(), &signature_size, digest.data(), digest.size()) <=
                0) {
                return map_provider_error(0, false);
            }
            if (signature_size < 8U || signature_size > der.value.size() ||
                !der_signature_to_p1363(der.value.data(), signature_size, out)) {
                return LCC_DEVICE_KEY_CORRUPT;
            }
            return LCC_DEVICE_OK;
        } catch (...) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
    }

    LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept override {
        try {
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
        } catch (...) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
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
            cleanup_loaded(loaded);
            std::string actual;
            const LCC_DEVICE_RESULT id_result = device_key_id_dedicated(loaded.spki, actual);
            if (id_result != LCC_DEVICE_OK) {
                return id_result;
            }
            if (!constant_time_equal(actual, expected_device_key_id)) {
                return LCC_DEVICE_POLICY_VIOLATION;
            }
            bool removed = false;
            const LCC_DEVICE_RESULT removed_result = remove_owned(
                directory.descriptor, request.device_namespace.linux_filename, loaded.identity, removed);
            return removed_result;
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

    class PkeyHandle final {
    public:
        PkeyHandle(std::shared_ptr<OpenSsl3Api> api, EVP_PKEY* key)
            : api_(std::move(api)), key_(key) {}
        ~PkeyHandle() {
            if (key_ != nullptr && api_) {
                api_->pkey_free(key_);
            }
        }
        PkeyHandle(const PkeyHandle&) = delete;
        PkeyHandle& operator=(const PkeyHandle&) = delete;
        EVP_PKEY* get() const noexcept { return key_; }
        void reset(EVP_PKEY* key = nullptr) noexcept {
            if (key_ != nullptr && api_) {
                api_->pkey_free(key_);
            }
            key_ = key;
        }
        EVP_PKEY* release() noexcept {
            EVP_PKEY* result = key_;
            key_ = nullptr;
            return result;
        }

    private:
        std::shared_ptr<OpenSsl3Api> api_;
        EVP_PKEY* key_ = nullptr;
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

    class EncodedBuffer final {
    public:
        explicit EncodedBuffer(std::shared_ptr<OpenSsl3Api> api) : api_(std::move(api)) {}
        ~EncodedBuffer() {
            if (data_ != nullptr && api_) {
                api_->clear_free(data_, size_);
            }
        }
        EncodedBuffer(const EncodedBuffer&) = delete;
        EncodedBuffer& operator=(const EncodedBuffer&) = delete;
        void assign(unsigned char* data, std::size_t size) noexcept {
            data_ = data;
            size_ = size;
        }
        unsigned char* get() const noexcept { return data_; }
        std::size_t size() const noexcept { return size_; }

    private:
        std::shared_ptr<OpenSsl3Api> api_;
        unsigned char* data_ = nullptr;
        std::size_t size_ = 0U;
    };

    class DescriptorHandle final {
    public:
        DescriptorHandle(std::shared_ptr<PosixStorageApi> api, int descriptor)
            : api_(std::move(api)), descriptor_(descriptor) {}
        ~DescriptorHandle() {
            if (descriptor_ >= 0 && api_) {
                (void)api_->close(descriptor_);
            }
        }
        DescriptorHandle(const DescriptorHandle&) = delete;
        DescriptorHandle& operator=(const DescriptorHandle&) = delete;
        int get() const noexcept { return descriptor_; }
        int close() noexcept {
            if (descriptor_ < 0 || !api_) {
                return 0;
            }
            const int descriptor = descriptor_;
            descriptor_ = -1;
            return api_->close(descriptor);
        }

    private:
        std::shared_ptr<PosixStorageApi> api_;
        int descriptor_ = -1;
    };

    class StoreContext final {
    public:
        StoreContext(std::shared_ptr<OpenSsl3Api> api, OSSL_STORE_CTX* context)
            : api_(std::move(api)), context_(context) {}
        ~StoreContext() {
            if (context_ != nullptr && api_) {
                (void)api_->store_close(context_);
            }
        }
        StoreContext(const StoreContext&) = delete;
        StoreContext& operator=(const StoreContext&) = delete;
        OSSL_STORE_CTX* get() const noexcept { return context_; }
        int close() noexcept {
            if (context_ == nullptr || !api_) {
                return 1;
            }
            OSSL_STORE_CTX* context = context_;
            context_ = nullptr;
            return api_->store_close(context);
        }

    private:
        std::shared_ptr<OpenSsl3Api> api_;
        OSSL_STORE_CTX* context_ = nullptr;
    };

    struct LoadedReference final {
        EVP_PKEY* key = nullptr;
        P256Spki spki{};
        FileIdentity identity;
    };

    LCC_DEVICE_RESULT validate_request(const ProviderOpenRequest& request) const {
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

    LCC_DEVICE_RESULT ensure_context() {
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
        clear_provider_error_queue();
        default_provider_ = openssl_->provider_load(libctx_, "default");
        if (default_provider_ == nullptr) {
            const std::string error_text = provider_error_text();
            const LCC_DEVICE_RESULT provider_error = map_provider_error_text(0, false, error_text);
            const bool provider_module_missing =
                (error_text.find("not found") != std::string::npos &&
                 (error_text.find("provider") != std::string::npos ||
                  error_text.find("module") != std::string::npos ||
                  error_text.find("dso") != std::string::npos ||
                  error_text.find("shared library") != std::string::npos)) ||
                error_text.find("could not load the shared library") != std::string::npos;
            const bool allocation_failure = error_text.find("memory allocation failure") != std::string::npos ||
                                            error_text.find("allocation failure") != std::string::npos;
            unload_context();
            return provider_module_missing && !allocation_failure ?
                       LCC_DEVICE_PROVIDER_UNAVAILABLE : provider_error;
        }
        clear_provider_error_queue();
        tpm2_provider_ = openssl_->provider_load(libctx_, "tpm2");
        if (tpm2_provider_ == nullptr) {
            const std::string error_text = provider_error_text();
            const LCC_DEVICE_RESULT provider_error = map_provider_error_text(0, false, error_text);
            const bool provider_module_missing =
                (error_text.find("not found") != std::string::npos &&
                 (error_text.find("provider") != std::string::npos ||
                  error_text.find("module") != std::string::npos ||
                  error_text.find("dso") != std::string::npos ||
                  error_text.find("shared library") != std::string::npos)) ||
                error_text.find("could not load the shared library") != std::string::npos;
            const bool allocation_failure = error_text.find("memory allocation failure") != std::string::npos ||
                                            error_text.find("allocation failure") != std::string::npos;
            unload_context();
            return provider_error == LCC_DEVICE_HARDWARE_UNAVAILABLE ||
                           provider_error == LCC_DEVICE_ACCESS_DENIED || provider_error == LCC_DEVICE_BUSY ?
                        provider_error :
                   provider_module_missing && !allocation_failure ?
                       LCC_DEVICE_PROVIDER_UNAVAILABLE : provider_error;
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

    LCC_DEVICE_RESULT generate_key(EVP_PKEY** out) {
        if (out == nullptr) {
            return LCC_DEVICE_INVALID_ARGUMENT;
        }
        *out = nullptr;
        clear_provider_error_queue();
        PkeyContext context(openssl_, openssl_->pkey_ctx_new_from_name(libctx_, "EC", "provider=tpm2"));
        if (!context.get()) {
            return map_provider_error(0, false);
        }
        clear_provider_error_queue();
        if (openssl_->pkey_keygen_init(context.get()) <= 0) {
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
        clear_provider_error_queue();
        if (openssl_->pkey_ctx_set_params(context.get(), params) <= 0) {
            return map_provider_error(0, false);
        }
        clear_provider_error_queue();
        if (openssl_->pkey_generate(context.get(), out) <= 0 || *out == nullptr) {
            if (*out != nullptr) {
                openssl_->pkey_free(*out);
                *out = nullptr;
            }
            return map_provider_error(0, false);
        }
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT validate_key(EVP_PKEY* key, P256Spki& out) {
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
        clear_provider_error_queue();
        OSSL_ENCODER_CTX* raw_encoder = openssl_->encoder_new_for_pkey(
            key, EVP_PKEY_PUBLIC_KEY, "DER", "SubjectPublicKeyInfo", nullptr);
        if (raw_encoder == nullptr) {
            return map_provider_error(0, true);
        }
        unsigned char* encoded = nullptr;
        std::size_t encoded_size = 0U;
        const int encoded_ok = openssl_->encoder_to_data(raw_encoder, &encoded, &encoded_size);
        openssl_->encoder_free(raw_encoder);
        EncodedBuffer encoded_buffer(openssl_);
        encoded_buffer.assign(encoded, encoded_size);
        if (encoded_ok != 1 || encoded == nullptr || encoded_size != 91U) {
            return LCC_DEVICE_KEY_CORRUPT;
        }
        P256Spki candidate{};
        const bool prefix_ok = encoded_size == candidate.size() &&
                               std::equal(kP256SpkiPrefix.begin(), kP256SpkiPrefix.end(), encoded_buffer.get());
        clear_provider_error_queue();
        EVP_PKEY* decoded_public = prefix_ok ?
                                       openssl_->d2i_public_key(libctx_, encoded_buffer.get(), encoded_buffer.size()) :
                                       nullptr;
        const bool canonical = decoded_public != nullptr;
        if (decoded_public != nullptr) {
            openssl_->pkey_free(decoded_public);
        }
        if (canonical) {
            std::copy(encoded_buffer.get(), encoded_buffer.get() + encoded_buffer.size(), candidate.begin());
        }
        if (!canonical) {
            return LCC_DEVICE_KEY_CORRUPT;
        }
        out = candidate;
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT self_test(EVP_PKEY* key, const P256Spki& spki) {
        P256Digest digest{};
        clear_provider_error_queue();
        MessageDigest sha256_digest(openssl_, openssl_->md_fetch(libctx_, "SHA256", "provider=default"));
        std::size_t digest_size = 0U;
        if (!sha256_digest.get()) {
            return map_provider_error(0, false);
        }
        clear_provider_error_queue();
        if (openssl_->digest(sha256_digest.get(), spki.data(), spki.size(), digest.data(), &digest_size) != 1 ||
            digest_size != digest.size()) {
            return map_provider_error(0, false);
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
        clear_provider_error_queue();
        PkeyHandle public_key(openssl_, openssl_->d2i_public_key(libctx_, spki.data(), spki.size()));
        if (public_key.get() == nullptr) {
            return LCC_DEVICE_KEY_CORRUPT;
        }
        clear_provider_error_queue();
        PkeyContext verify_context(
            openssl_, openssl_->pkey_ctx_new_from_pkey(libctx_, public_key.get(), "provider=default"));
        if (!verify_context.get()) {
            return map_provider_error(0, false);
        }
        clear_provider_error_queue();
        MessageDigest verify_digest(openssl_, openssl_->md_fetch(libctx_, "SHA256", "provider=default"));
        if (!verify_digest.get()) {
            return map_provider_error(0, false);
        }
        std::vector<std::uint8_t> der;
        clear_provider_error_queue();
        if (openssl_->pkey_verify_init(verify_context.get()) <= 0) {
            return map_provider_error(0, false);
        }
        clear_provider_error_queue();
        if (openssl_->pkey_ctx_set_signature_md(verify_context.get(), verify_digest.get()) <= 0) {
            return map_provider_error(0, false);
        }
        if (!p1363_signature_to_der(signature, der)) {
            return LCC_DEVICE_KEY_CORRUPT;
        }
        clear_provider_error_queue();
        const int verified = openssl_->pkey_verify(
            verify_context.get(), der.data(), der.size(), digest.data(), digest.size());
        return verified == 1 ? LCC_DEVICE_OK : verified == 0 ? LCC_DEVICE_SIGN_FAILED : map_provider_error(0, false);
    }

    LCC_DEVICE_RESULT device_key_id_dedicated(const P256Spki& spki, std::string& out) {
        P256Digest digest{};
        clear_provider_error_queue();
        MessageDigest sha256_digest(openssl_, openssl_->md_fetch(libctx_, "SHA256", "provider=default"));
        if (!sha256_digest.get()) {
            return map_provider_error(0, false);
        }
        std::size_t digest_size = 0U;
        clear_provider_error_queue();
        if (openssl_->digest(sha256_digest.get(), spki.data(), spki.size(), digest.data(), &digest_size) != 1 ||
            digest_size != digest.size()) {
            return map_provider_error(0, false);
        }
        const std::string encoded = lowercase_hex(digest.data(), digest.size());
        if (encoded.size() != 64U) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
        out = "sha256:" + encoded;
        return out.size() == LCC_DEVICE_KEY_ID_MAX ? LCC_DEVICE_OK : LCC_DEVICE_INTERNAL_ERROR;
    }

    LCC_DEVICE_RESULT encode_private_reference(EVP_PKEY* key, std::vector<std::uint8_t>& out) {
        clear_provider_error_queue();
        OSSL_ENCODER_CTX* raw_encoder = openssl_->encoder_new_for_pkey(
            key, EVP_PKEY_KEYPAIR, "PEM", "PrivateKeyInfo", "provider=tpm2");
        if (raw_encoder == nullptr) {
            return map_provider_error(0, false);
        }
        unsigned char* encoded = nullptr;
        std::size_t encoded_size = 0U;
        const int encoded_ok = openssl_->encoder_to_data(raw_encoder, &encoded, &encoded_size);
        openssl_->encoder_free(raw_encoder);
        EncodedBuffer encoded_buffer(openssl_);
        encoded_buffer.assign(encoded, encoded_size);
        if (encoded_ok != 1 || encoded == nullptr || !valid_tss2_private_pem(encoded_buffer.get(), encoded_buffer.size())) {
            return LCC_DEVICE_KEY_CORRUPT;
        }
        SensitiveVector candidate(encoded_buffer.size());
        std::memcpy(candidate.value.data(), encoded_buffer.get(), encoded_buffer.size());
        out.swap(candidate.value);
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT load_reference(int directory,
                                     const std::string& filename,
                                     LoadedReference& out) {
        const int raw_descriptor = posix_->openat(directory, filename.c_str(), kReferenceOpenFlags, 0U);
        if (raw_descriptor < 0) {
            if (errno == ENOENT) {
                return LCC_DEVICE_KEY_NOT_FOUND;
            }
            return errno == EACCES || errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                   errno == ELOOP ? LCC_DEVICE_KEY_CORRUPT : LCC_DEVICE_IO_ERROR;
        }
        DescriptorHandle descriptor(posix_, raw_descriptor);
        struct stat status{};
        if (posix_->fstat(descriptor.get(), &status) != 0) {
            const int saved_errno = errno;
            return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                                                                    LCC_DEVICE_IO_ERROR;
        }
        if (!valid_reference_status(status)) {
            return LCC_DEVICE_ACCESS_DENIED;
        }
        const std::string uri = "file:/proc/self/fd/" + std::to_string(descriptor.get());
        UI_METHOD* ui_method = rejecting_ui_method();
        if (ui_method == nullptr) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
        errno = 0;
        clear_provider_error_queue();
        StoreContext store(openssl_, openssl_->store_open_ex(uri.c_str(), libctx_, nullptr, ui_method, nullptr));
        const int store_errno = errno;
        if (store.get() == nullptr) {
            return map_provider_error(store_errno, true);
        }
        PkeyHandle key(openssl_, nullptr);
        bool duplicate = false;
        bool null_pkey = false;
        std::size_t pkey_count = 0U;
        std::string load_error;
        clear_provider_error_queue();
        if (openssl_->store_expect(store.get(), OSSL_STORE_INFO_PKEY) != 1) {
            return LCC_DEVICE_KEY_CORRUPT;
        }
        while (!openssl_->store_eof(store.get())) {
            clear_provider_error_queue();
            OSSL_STORE_INFO* info = openssl_->store_load(store.get());
            if (info == nullptr) {
                load_error = provider_error_text();
                break;
            }
            if (openssl_->store_info_type(info) != OSSL_STORE_INFO_PKEY) {
                duplicate = true;
            } else {
                ++pkey_count;
                if (key.get() != nullptr) {
                    duplicate = true;
                } else {
                    EVP_PKEY* loaded = openssl_->store_info_get1_pkey(info);
                    if (loaded == nullptr) {
                        null_pkey = true;
                    } else {
                        key.reset(loaded);
                    }
                }
            }
            openssl_->store_info_free(info);
        }
        const bool clean_eof = openssl_->store_eof(store.get()) == 1;
        const int store_error = openssl_->store_error(store.get());
        clear_provider_error_queue();
        const int close_result = store.close();
        const std::string close_error = provider_error_text();
        if (!clean_eof) {
            if (!load_error.empty()) {
                return map_provider_error_text(0, true, load_error);
            }
            return store_error != 0 ? map_provider_error(0, true) : LCC_DEVICE_KEY_CORRUPT;
        }
        if (close_result != 1) {
            return close_error.empty() ? LCC_DEVICE_INTERNAL_ERROR :
                                         map_provider_error_text(0, true, close_error);
        }
        if (store_error != 0) {
            return map_provider_error(0, true);
        }
        if (duplicate || null_pkey || pkey_count != 1U || key.get() == nullptr) {
            return LCC_DEVICE_KEY_CORRUPT;
        }
        P256Spki spki{};
        const LCC_DEVICE_RESULT validated = validate_key(key.get(), spki);
        if (validated != LCC_DEVICE_OK) {
            return validated;
        }
        const LCC_DEVICE_RESULT usable = self_test(key.get(), spki);
        if (usable != LCC_DEVICE_OK) {
            return usable;
        }
        out.key = key.release();
        out.spki = spki;
        out.identity.device = status.st_dev;
        out.identity.inode = status.st_ino;
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT write_temporary(int directory,
                                       const std::string& filename,
                                       const std::vector<std::uint8_t>& data,
                                       std::string& out_name,
                                       FileIdentity& out_identity) {
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
        const int stat_result = posix_->fstat(descriptor, &status);
        const int stat_errno = errno;
        if (stat_result != 0) {
            struct stat retry_status{};
            if (posix_->fstat(descriptor, &retry_status) == 0) {
                const FileIdentity discovered{retry_status.st_dev, retry_status.st_ino};
                (void)posix_->close(descriptor);
                const LCC_DEVICE_RESULT cleanup_result = cleanup_temporary(directory, out_name, discovered);
                if (cleanup_result != LCC_DEVICE_OK) {
                    return cleanup_result;
                }
            } else {
                const int close_result = posix_->close(descriptor);
                const int unlink_result = posix_->unlinkat(directory, out_name.c_str(), 0);
                const int sync_result = posix_->fsync(directory);
                if (close_result != 0 || unlink_result != 0 || sync_result != 0) {
                    return LCC_DEVICE_IO_ERROR;
                }
            }
            return stat_errno == EACCES || stat_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                                                                  LCC_DEVICE_IO_ERROR;
        }
        if (!valid_reference_status(status)) {
            (void)posix_->close(descriptor);
            const FileIdentity discovered{status.st_dev, status.st_ino};
            const LCC_DEVICE_RESULT cleanup_result = cleanup_temporary(directory, out_name, discovered);
            return cleanup_result == LCC_DEVICE_OK ? LCC_DEVICE_ACCESS_DENIED : cleanup_result;
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
            const int saved_errno = errno;
            (void)posix_->close(descriptor);
            const LCC_DEVICE_RESULT cleanup_result = cleanup_temporary(directory, out_name, out_identity);
            if (cleanup_result != LCC_DEVICE_OK) {
                return cleanup_result;
            }
            return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
        }
        if (posix_->fdatasync(descriptor) != 0) {
            const int saved_errno = errno;
            (void)posix_->close(descriptor);
            const LCC_DEVICE_RESULT cleanup_result = cleanup_temporary(directory, out_name, out_identity);
            if (cleanup_result != LCC_DEVICE_OK) {
                return cleanup_result;
            }
            return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
        }
        if (posix_->close(descriptor) != 0) {
            const LCC_DEVICE_RESULT cleanup_result = cleanup_temporary(directory, out_name, out_identity);
            return cleanup_result == LCC_DEVICE_OK ? LCC_DEVICE_IO_ERROR : cleanup_result;
        }
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT cleanup_temporary(int directory,
                                         const std::string& name,
                                         const FileIdentity& expected_identity) {
        bool removed = false;
        const LCC_DEVICE_RESULT result = remove_owned(directory, name, expected_identity, removed, false);
        return result == LCC_DEVICE_OK && removed ? LCC_DEVICE_OK :
               result == LCC_DEVICE_KEY_NOT_FOUND ? LCC_DEVICE_OK : result;
    }

    static LCC_DEVICE_RESULT storage_errno_result(int saved_errno) noexcept {
        return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
               saved_errno == EAGAIN || saved_errno == EWOULDBLOCK || saved_errno == EBUSY ?
                   LCC_DEVICE_BUSY :
                   LCC_DEVICE_IO_ERROR;
    }

    LCC_DEVICE_RESULT cleanup_quarantine(int directory, const std::string& quarantine) noexcept {
        const int unlink_result = posix_->unlinkat(directory, quarantine.c_str(), 0);
        const int unlink_errno = unlink_result == 0 ? 0 : errno;
        const int sync_result = posix_->fsync(directory);
        const int sync_errno = sync_result == 0 ? 0 : errno;
        if (unlink_result != 0) {
            return storage_errno_result(unlink_errno);
        }
        if (sync_result != 0) {
            return storage_errno_result(sync_errno);
        }
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT remove_exact(int directory,
                                   const std::string& filename,
                                   const FileIdentity& expected,
                                   bool& removed,
                                   bool require_safe_mode = true) {
        removed = false;
        const int raw_descriptor = posix_->openat(directory, filename.c_str(), kReferenceOpenFlags, 0U);
        if (raw_descriptor < 0) {
            return errno == ENOENT ? LCC_DEVICE_KEY_NOT_FOUND :
                   errno == EACCES || errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
        }
        DescriptorHandle descriptor_handle(posix_, raw_descriptor);
        struct stat status{};
        if (posix_->fstat(descriptor_handle.get(), &status) != 0) {
            const int saved_errno = errno;
            return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                                                                    LCC_DEVICE_IO_ERROR;
        }
        const FileIdentity actual{status.st_dev, status.st_ino};
        if (!same_file(expected, actual)) {
            return LCC_DEVICE_BUSY;
        }
        if (!valid_removal_status(status, require_safe_mode)) {
            const LCC_DEVICE_RESULT result = S_ISREG(status.st_mode) && status.st_uid == ::geteuid() ?
                                                  LCC_DEVICE_BUSY : LCC_DEVICE_ACCESS_DENIED;
            return result;
        }

        std::array<std::uint8_t, 16> random{};
        if (openssl_->rand_priv_bytes_ex(libctx_, random.data(), random.size(), kRandomStrength) != 1) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
        const std::string suffix = lowercase_hex(random.data(), random.size());
        const std::string quarantine = filename + ".delete." + suffix;
        const std::string moved = filename + ".move." + suffix;
        const std::string descriptor_path = "/proc/self/fd/" + std::to_string(descriptor_handle.get());
        if (posix_->linkat(AT_FDCWD,
                           descriptor_path.c_str(),
                           directory,
                           quarantine.c_str(),
                           AT_SYMLINK_FOLLOW) != 0) {
            const int saved_errno = errno;
            return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                   saved_errno == EEXIST ? LCC_DEVICE_BUSY : LCC_DEVICE_IO_ERROR;
        }
        if (descriptor_handle.close() != 0) {
            const LCC_DEVICE_RESULT cleanup_result = cleanup_quarantine(directory, quarantine);
            return cleanup_result == LCC_DEVICE_OK ? LCC_DEVICE_IO_ERROR : cleanup_result;
        }
        if (posix_->renameat2_noreplace(directory, filename.c_str(), moved.c_str()) != 0) {
            const int saved_errno = errno;
            const bool rename_unsupported =
                saved_errno == ENOSYS || saved_errno == EINVAL || saved_errno == EOPNOTSUPP;
            const LCC_DEVICE_RESULT cleanup_result = cleanup_quarantine(directory, quarantine);
            if (cleanup_result != LCC_DEVICE_OK) {
                last_rename_unsupported_ = false;
                return cleanup_result;
            }
            last_rename_unsupported_ = rename_unsupported;
            return saved_errno == EACCES || saved_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                   saved_errno == EEXIST ? LCC_DEVICE_BUSY : LCC_DEVICE_IO_ERROR;
        }

        const int raw_moved_descriptor = posix_->openat(directory, moved.c_str(), kReferenceOpenFlags, 0U);
        DescriptorHandle moved_descriptor(posix_, raw_moved_descriptor);
        struct stat moved_status{};
        const bool moved_matches = moved_descriptor.get() >= 0 &&
                                   posix_->fstat(moved_descriptor.get(), &moved_status) == 0 &&
                                   valid_removal_status(moved_status, require_safe_mode) &&
                                   same_file(expected, FileIdentity{moved_status.st_dev, moved_status.st_ino});
        if (!moved_matches) {
            const int restore = posix_->renameat2_noreplace(directory, moved.c_str(), filename.c_str());
            const int restore_errno = restore == 0 ? 0 : errno;
            const bool restore_unsupported = restore_errno == ENOSYS || restore_errno == EINVAL ||
                                             restore_errno == EOPNOTSUPP;
            const LCC_DEVICE_RESULT cleanup_result = cleanup_quarantine(directory, quarantine);
            if (cleanup_result != LCC_DEVICE_OK) {
                last_rename_unsupported_ = false;
                return cleanup_result;
            }
            last_rename_unsupported_ = last_rename_unsupported_ || restore_unsupported;
            return restore == 0 || restore_errno == EEXIST ? LCC_DEVICE_BUSY : LCC_DEVICE_IO_ERROR;
        }

        if (posix_->unlinkat(directory, moved.c_str(), 0) != 0) {
            const int saved_errno = errno;
            const LCC_DEVICE_RESULT cleanup_result = cleanup_quarantine(directory, quarantine);
            return cleanup_result == LCC_DEVICE_OK ? storage_errno_result(saved_errno) : cleanup_result;
        }
        const LCC_DEVICE_RESULT cleanup_result = cleanup_quarantine(directory, quarantine);
        if (cleanup_result != LCC_DEVICE_OK) {
            return cleanup_result;
        }
        removed = true;
        return LCC_DEVICE_OK;
    }

    LCC_DEVICE_RESULT publish_temporary(int directory,
                                         const std::string& temporary,
                                         const std::string& final,
                                         bool& published,
                                         bool& cleanup_attempted,
                                         const FileIdentity& expected_identity) {
        published = false;
        cleanup_attempted = false;
        if (posix_->renameat2_noreplace(directory, temporary.c_str(), final.c_str()) == 0) {
            published = true;
            return posix_->fsync(directory) == 0 ? LCC_DEVICE_OK : LCC_DEVICE_IO_ERROR;
        }
        const int rename_errno = errno;
        if (rename_errno == EEXIST) {
            cleanup_attempted = true;
            return cleanup_temporary(directory, temporary, expected_identity);
        }
        if (rename_errno != ENOSYS && rename_errno != EINVAL && rename_errno != EOPNOTSUPP) {
            return rename_errno == EACCES || rename_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED :
                                                                     LCC_DEVICE_IO_ERROR;
        }
        if (posix_->linkat(directory, temporary.c_str(), directory, final.c_str(), 0) == 0) {
            published = true;
            cleanup_attempted = true;
            return cleanup_temporary(directory, temporary, expected_identity);
        }
        const int link_errno = errno;
        if (link_errno == EEXIST) {
            cleanup_attempted = true;
            return cleanup_temporary(directory, temporary, expected_identity);
        }
        return link_errno == ENOSYS || link_errno == EINVAL || link_errno == EOPNOTSUPP ? LCC_DEVICE_IO_ERROR :
               link_errno == EACCES || link_errno == EPERM ? LCC_DEVICE_ACCESS_DENIED : LCC_DEVICE_IO_ERROR;
    }

    LCC_DEVICE_RESULT rollback_owned(int directory, const std::string& filename, const FileIdentity& identity) {
        bool removed = false;
        return remove_owned(directory, filename, identity, removed);
    }

    LCC_DEVICE_RESULT remove_owned(int directory,
                                   const std::string& filename,
                                   const FileIdentity& expected,
                                   bool& removed,
                                   bool require_safe_mode = true) {
        last_rename_unsupported_ = false;
        const LCC_DEVICE_RESULT result = remove_exact(directory, filename, expected, removed, require_safe_mode);
        if (result == LCC_DEVICE_IO_ERROR && last_rename_unsupported_) {
            return remove_exact_without_rename(directory, filename, expected, removed, require_safe_mode);
        }
        return result;
    }

    LCC_DEVICE_RESULT remove_exact_without_rename(int directory,
                                                  const std::string& filename,
                                                  const FileIdentity& expected,
                                                  bool& removed,
                                                  bool require_safe_mode) {
        removed = false;
        const int raw_descriptor = posix_->openat(directory, filename.c_str(), kReferenceOpenFlags, 0U);
        if (raw_descriptor < 0) {
            return errno == ENOENT ? LCC_DEVICE_KEY_NOT_FOUND : LCC_DEVICE_IO_ERROR;
        }
        DescriptorHandle descriptor(posix_, raw_descriptor);
        struct stat status{};
        if (posix_->fstat(descriptor.get(), &status) != 0) {
            return LCC_DEVICE_IO_ERROR;
        }
        if (!same_file(expected, FileIdentity{status.st_dev, status.st_ino})) {
            return LCC_DEVICE_BUSY;
        }
        if (!valid_removal_status(status, require_safe_mode)) {
            return S_ISREG(status.st_mode) && status.st_uid == ::geteuid() ? LCC_DEVICE_BUSY :
                                                                       LCC_DEVICE_ACCESS_DENIED;
        }
        std::array<std::uint8_t, 16> random{};
        if (openssl_->rand_priv_bytes_ex(libctx_, random.data(), random.size(), kRandomStrength) != 1) {
            return LCC_DEVICE_INTERNAL_ERROR;
        }
        const std::string quarantine = filename + ".delete." + lowercase_hex(random.data(), random.size());
        const std::string descriptor_path = "/proc/self/fd/" + std::to_string(descriptor.get());
        if (posix_->linkat(AT_FDCWD,
                           descriptor_path.c_str(),
                           directory,
                           quarantine.c_str(),
                           AT_SYMLINK_FOLLOW) != 0) {
            return LCC_DEVICE_IO_ERROR;
        }
        const int verify_raw = posix_->openat(directory, filename.c_str(), kReferenceOpenFlags, 0U);
        if (verify_raw < 0) {
            const LCC_DEVICE_RESULT cleanup_result = cleanup_quarantine(directory, quarantine);
            return cleanup_result == LCC_DEVICE_OK ? LCC_DEVICE_BUSY : cleanup_result;
        }
        DescriptorHandle verify_descriptor(posix_, verify_raw);
        struct stat verify_status{};
        const bool source_still_matches = posix_->fstat(verify_descriptor.get(), &verify_status) == 0 &&
                                          valid_removal_status(verify_status, require_safe_mode) &&
                                          same_file(expected, FileIdentity{verify_status.st_dev, verify_status.st_ino});
        if (!source_still_matches) {
            const LCC_DEVICE_RESULT cleanup_result = cleanup_quarantine(directory, quarantine);
            return cleanup_result == LCC_DEVICE_OK ? LCC_DEVICE_BUSY : cleanup_result;
        }
        const int quarantine_raw = posix_->openat(directory, quarantine.c_str(), kReferenceOpenFlags, 0U);
        if (quarantine_raw < 0) {
            const LCC_DEVICE_RESULT cleanup_result = cleanup_quarantine(directory, quarantine);
            return cleanup_result == LCC_DEVICE_OK ? LCC_DEVICE_IO_ERROR : cleanup_result;
        }
        DescriptorHandle quarantine_descriptor(posix_, quarantine_raw);
        struct stat quarantine_status{};
        const bool quarantine_matches = posix_->fstat(quarantine_descriptor.get(), &quarantine_status) == 0 &&
                                        valid_removal_status(quarantine_status, require_safe_mode) &&
                                        same_file(expected, FileIdentity{quarantine_status.st_dev,
                                                                         quarantine_status.st_ino});
        if (!quarantine_matches) {
            const LCC_DEVICE_RESULT cleanup_result = cleanup_quarantine(directory, quarantine);
            return cleanup_result == LCC_DEVICE_OK ? LCC_DEVICE_IO_ERROR : cleanup_result;
        }
        const int unlink_result = posix_->unlinkat(directory, filename.c_str(), 0);
        const int close_result = descriptor.close();
        const LCC_DEVICE_RESULT cleanup_result = cleanup_quarantine(directory, quarantine);
        if (cleanup_result != LCC_DEVICE_OK) {
            return cleanup_result;
        }
        if (unlink_result != 0 || close_result != 0) {
            return LCC_DEVICE_IO_ERROR;
        }
        removed = true;
        return LCC_DEVICE_OK;
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
    bool last_rename_unsupported_ = false;
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

/* Internal shim hooks; these are not part of the installed/public ABI. */
LCC_DEVICE_RESULT tpm2_openssl_map_error_for_test(int saved_errno,
                                                  const char* reason,
                                                  bool loading_reference) {
    try {
        return map_provider_error_text(saved_errno,
                                       loading_reference,
                                       reason == nullptr ? std::string() : std::string(reason));
    } catch (...) {
        return LCC_DEVICE_INTERNAL_ERROR;
    }
}

bool tpm2_openssl_accepts_tss2_private_pem_for_test(const unsigned char* data, std::size_t size) noexcept {
    return valid_tss2_private_pem(data, size);
}

bool tpm2_openssl_accepts_der_signature_for_test(const unsigned char* data, std::size_t size) noexcept {
    P256Signature signature{};
    return data != nullptr && der_signature_to_p1363(data, size, signature);
}

bool tpm2_openssl_decode_der_signature_for_test(const unsigned char* data,
                                                std::size_t size,
                                                unsigned char* output,
                                                std::size_t output_size) noexcept {
    if (data == nullptr || output == nullptr || output_size != P256Signature{}.size()) {
        return false;
    }
    P256Signature signature{};
    if (!der_signature_to_p1363(data, size, signature)) {
        return false;
    }
    std::copy(signature.begin(), signature.end(), output);
    return true;
}

bool tpm2_openssl_nested_error_scope_preserves_for_test() noexcept {
    try {
        const unsigned long before = ERR_peek_last_error();
        const bool initially_empty = before == 0U;
        {
            ErrorQueueScope outer;
            {
                ErrorQueueScope inner;
                ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", "nested-provider-error");
            }
        }
        return initially_empty ? ERR_peek_error() == 0U : ERR_peek_last_error() == before;
    } catch (...) {
        return false;
    }
}

bool tpm2_openssl_error_queue_round_trip_for_test() noexcept {
    struct Snapshot final {
        unsigned long code = 0U;
        int line = 0;
        int flags = 0;
        std::string file;
        std::string function;
        std::string data;
    };
    const auto peek = [](bool last) {
        Snapshot snapshot;
        const char* file = nullptr;
        const char* function = nullptr;
        const char* data = nullptr;
        if (last) {
            snapshot.code = ERR_peek_last_error_all(&file, &snapshot.line, &function, &data, &snapshot.flags);
        } else {
            snapshot.code = ERR_peek_error_all(&file, &snapshot.line, &function, &data, &snapshot.flags);
        }
        snapshot.file = file == nullptr ? std::string() : std::string(file);
        snapshot.function = function == nullptr ? std::string() : std::string(function);
        snapshot.data = (snapshot.flags & ERR_TXT_STRING) != 0 && data != nullptr ? std::string(data) : std::string();
        return snapshot;
    };
    try {
        ERR_clear_error();
        ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", "caller-first");
        ERR_raise_data(ERR_LIB_USER, ERR_RFLAG_FATAL | ERR_R_OPERATION_FAIL, "%s", "caller-second");
        const Snapshot before_first = peek(false);
        const Snapshot before_last = peek(true);
        {
            ErrorQueueScope outer;
            ErrorQueueScope inner;
            ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", "operation-only");
        }
        const Snapshot after_first = peek(false);
        const Snapshot after_last = peek(true);
        const bool same = before_first.code == after_first.code && before_first.line == after_first.line &&
                          (before_first.flags & ~ERR_TXT_MALLOCED) == (after_first.flags & ~ERR_TXT_MALLOCED) &&
                          before_first.file == after_first.file && before_first.function == after_first.function &&
                          before_first.data == after_first.data && before_last.code == after_last.code &&
                          before_last.line == after_last.line &&
                          (before_last.flags & ~ERR_TXT_MALLOCED) == (after_last.flags & ~ERR_TXT_MALLOCED) &&
                          before_last.file == after_last.file && before_last.function == after_last.function &&
                          before_last.data == after_last.data;
        ERR_clear_error();
        return same;
    } catch (...) {
        ERR_clear_error();
        return false;
    }
}

bool tpm2_openssl_error_queue_segments_for_test() noexcept {
    try {
        ERR_clear_error();
        ErrorQueueScope scope;
        ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", "benign-probe");
        clear_provider_error_queue();
        ERR_raise_data(ERR_LIB_USER, ERR_R_INTERNAL_ERROR, "%s", "actual-provider-error");
        const std::string text = provider_error_text();
        const bool isolated = text.find("actual-provider-error") != std::string::npos &&
                              text.find("benign-probe") == std::string::npos;
        return isolated;
    } catch (...) {
        ERR_clear_error();
        return false;
    }
}

const char* tpm2_openssl_test_stage_for_test() noexcept {
    return g_tpm2_openssl_test_stage;
}

}  // namespace device_identity
}  // namespace license
