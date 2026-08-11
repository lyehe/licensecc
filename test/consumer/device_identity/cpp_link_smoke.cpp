#include <licensecc/device_identity.h>

#include <cstring>
#include <string>

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
    LccDeviceIdentityOptions options;
    lcc_init_device_identity_options(&options);
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
}
