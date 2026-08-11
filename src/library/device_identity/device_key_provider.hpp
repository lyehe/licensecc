#ifndef LICENSECC_DEVICE_KEY_PROVIDER_HPP_
#define LICENSECC_DEVICE_KEY_PROVIDER_HPP_

#include <licensecc/device_identity.h>

#include "p256_crypto.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace license {
namespace device_identity {

constexpr const char* kP256Algorithm = "ecdsa-p256-sha256";

struct DeviceNamespace {
    std::string payload;
    std::string hash;
    std::string windows_name;
    std::string linux_filename;
    std::string lock_name;
};

struct ProviderOpenRequest {
    DeviceNamespace device_namespace;
    std::uint32_t backend = LCC_DEVICE_BACKEND_AUTO;
    std::uint32_t scope = LCC_DEVICE_SCOPE_UNSPECIFIED;
    std::uint32_t lock_timeout_ms = 0U;
    std::string storage_directory;
};

struct ProviderMetadata {
    std::uint32_t backend = LCC_DEVICE_BACKEND_AUTO;
    std::uint32_t scope = LCC_DEVICE_SCOPE_UNSPECIFIED;
    std::uint32_t assurance = LCC_DEVICE_ASSURANCE_UNKNOWN;
    std::string provider;
    std::string algorithm;
};

/* Internal v1 provider surface. It deliberately accepts only a pre-hashed,
 * fixed-width digest; arbitrary-byte signing is not part of this contract. */
class DeviceKeyProvider {
public:
    virtual ~DeviceKeyProvider() = default;
    virtual LCC_DEVICE_RESULT open(const ProviderOpenRequest& request) noexcept = 0;
    virtual LCC_DEVICE_RESULT create(const ProviderOpenRequest& request) noexcept = 0;
    virtual LCC_DEVICE_RESULT public_spki(P256Spki& out) noexcept = 0;
    virtual LCC_DEVICE_RESULT sign_digest(const P256Digest& digest, P256Signature& out) noexcept = 0;
    virtual LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept = 0;
    virtual LCC_DEVICE_RESULT delete_with_expected_id(
        const ProviderOpenRequest& request, const std::string& expected_device_key_id) noexcept = 0;
};

std::unique_ptr<DeviceKeyProvider> make_software_test_provider() noexcept;

bool derive_namespace_v1(const std::string& application_id,
                         const std::string& project,
                         std::uint32_t scope,
                         DeviceNamespace& out) noexcept;

LCC_DEVICE_RESULT build_request_proof_payload_v1(const LccDeviceProofInput& input,
                                                 const std::string& device_key_id,
                                                 std::vector<std::uint8_t>& out) noexcept;

}  // namespace device_identity
}  // namespace license

#endif
