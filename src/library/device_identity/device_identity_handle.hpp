#ifndef LICENSECC_DEVICE_IDENTITY_HANDLE_HPP_
#define LICENSECC_DEVICE_IDENTITY_HANDLE_HPP_

#include "device_key_provider.hpp"
#include <memory>
#include <mutex>
#include <string>

// Private definition of the public opaque handle. Signing is serialized;
// close/delete retain their documented exclusive owner coordination contract.
struct LccDeviceIdentity {
	std::unique_ptr<license::device_identity::DeviceKeyProvider> provider;
	license::device_identity::P256Spki spki{};
	license::device_identity::ProviderMetadata provider_metadata;
	std::string device_key_id;
	std::string project;
	std::mutex signing_mutex;
};
#endif
