#include <licensecc/device_identity.h>

#include <cstring>
#include <string>

#ifdef LCC_DEVICE_IDENTITY_C_SMOKE_LINKED
extern "C" int lcc_device_identity_c_header_smoke(void);
#endif

namespace {

template <std::size_t N>
bool set_field(char (&field)[N], const char* value) {
    const std::size_t size = std::strlen(value);
    if (size >= N) {
        return false;
    }
    std::memcpy(field, value, size + 1U);
    return true;
}

}  // namespace

int main() {
#ifdef LCC_DEVICE_IDENTITY_C_SMOKE_LINKED
    if (lcc_device_identity_c_header_smoke() != 0) {
        return 5;
    }
#endif
    LccDeviceIdentityOptions options;
    lcc_init_device_identity_options(&options);
#ifdef LCC_DEVICE_IDENTITY_EXPECT_WINDOWS_TPM
    options.backend = LCC_DEVICE_BACKEND_WINDOWS_TPM;
    options.policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
    options.flags = 0U;
    if (!set_field(options.application_id, "licensecc.test.installed-consumer.windows-tpm") ||
        !set_field(options.project, "DEFAULT")) {
        return 1;
    }
    LccDeviceIdentity* identity = nullptr;
    const LCC_DEVICE_RESULT open_result = lcc_device_identity_open(&options, &identity);
    if (open_result == LCC_DEVICE_OK) {
        LccDeviceIdentityMetadata metadata;
        lcc_init_device_identity_metadata(&metadata);
        const LCC_DEVICE_RESULT metadata_result = lcc_device_identity_get_metadata(identity, &metadata);
        lcc_device_identity_close(identity);
        return metadata_result == LCC_DEVICE_OK &&
                       metadata.backend == LCC_DEVICE_BACKEND_WINDOWS_TPM &&
                       std::string(metadata.provider) == "windows-platform-ksp" &&
                       std::string(metadata.algorithm) == "ecdsa-p256-sha256" ?
                   0 : 3;
    }
    lcc_device_identity_close(identity);
    switch (open_result) {
        case LCC_DEVICE_PROVIDER_UNAVAILABLE:
        case LCC_DEVICE_HARDWARE_UNAVAILABLE:
        case LCC_DEVICE_ACCESS_DENIED:
        case LCC_DEVICE_KEY_NOT_FOUND:
        case LCC_DEVICE_KEY_CORRUPT:
        case LCC_DEVICE_KEY_LOST:
        case LCC_DEVICE_UNSUPPORTED_ALGORITHM:
        case LCC_DEVICE_BUSY:
            return 0;
        default:
            return 2;
    }
#elif defined(LCC_DEVICE_IDENTITY_EXPECT_TPM2_OPENSSL)
    options.backend = LCC_DEVICE_BACKEND_TPM2_OPENSSL;
    options.policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
    options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
    if (!set_field(options.application_id, "licensecc.test.installed-consumer.tpm2") ||
        !set_field(options.project, "DEFAULT") ||
        !set_field(options.storage_directory, LCC_DEVICE_IDENTITY_TPM2_STORAGE_DIRECTORY)) {
        return 1;
    }
    LccDeviceIdentity* identity = nullptr;
    const LCC_DEVICE_RESULT open_result = lcc_device_identity_open(&options, &identity);
    if (open_result != LCC_DEVICE_OK || identity == nullptr) {
#ifdef LCC_DEVICE_IDENTITY_TPM2_ALLOW_SKIP
        switch (open_result) {
            case LCC_DEVICE_PROVIDER_UNAVAILABLE:
            case LCC_DEVICE_HARDWARE_UNAVAILABLE:
            case LCC_DEVICE_ACCESS_DENIED:
            case LCC_DEVICE_BUSY:
                return 77;
            default:
                break;
        }
#endif
        return 2;
    }
    LccDeviceIdentityMetadata metadata;
    lcc_init_device_identity_metadata(&metadata);
    const LCC_DEVICE_RESULT metadata_result = lcc_device_identity_get_metadata(identity, &metadata);
    const std::string key_id = metadata.device_key_id;
    lcc_device_identity_close(identity);
    if (metadata_result != LCC_DEVICE_OK || metadata.backend != LCC_DEVICE_BACKEND_TPM2_OPENSSL ||
        metadata.assurance != LCC_DEVICE_ASSURANCE_REPORTED_HARDWARE ||
        std::string(metadata.provider) != "tpm2-openssl" ||
        std::string(metadata.algorithm) != "ecdsa-p256-sha256") {
        return 3;
    }
    options.flags = 0U;
    return lcc_device_identity_delete_key(&options, key_id.c_str()) == LCC_DEVICE_OK ? 0 : 4;
#else
    options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
    options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
    options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
    if (!set_field(options.application_id, "licensecc.test.installed-consumer") ||
        !set_field(options.project, "DEFAULT")) {
        return 1;
    }
    LccDeviceIdentity* identity = nullptr;
    if (lcc_device_identity_open(&options, &identity) != LCC_DEVICE_OK || identity == nullptr) {
        return 2;
    }
    LccDeviceIdentityMetadata metadata;
    lcc_init_device_identity_metadata(&metadata);
    const LCC_DEVICE_RESULT metadata_result = lcc_device_identity_get_metadata(identity, &metadata);
    lcc_device_identity_close(identity);
    if (metadata_result != LCC_DEVICE_OK || std::string(lcc_device_strerror(LCC_DEVICE_OK)) != "ok") {
        return 3;
    }
    options.flags = 0U;
    return lcc_device_identity_delete_key(&options, metadata.device_key_id) == LCC_DEVICE_OK ? 0 : 4;
#endif
}
