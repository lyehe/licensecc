#ifndef LICENSECC_BOUND_PUBLIC_HPP_
#define LICENSECC_BOUND_PUBLIC_HPP_
#include <licensecc/device_bound.h>
#include "bound_enrollment.hpp"
#include "bound_checkpoint_platform.hpp"
#include "bound_browser.hpp"

namespace license {
namespace device_identity {
struct BoundPublicConfig {
	BoundEnrollmentOptions enrollment;
	BoundCheckpointNamespace storage;
	std::string callback_path;
	std::vector<BoundLeaseTrustKey> trust;
};
LCC_BOUND_RESULT validate_bound_public_options(const LccDeviceBoundOptions*, BoundPublicConfig&) noexcept;
template <class T>
LCC_BOUND_RESULT bound_public_structure(const T* value) noexcept {
	if (!value || value->size < sizeof(T)) return LCC_BOUND_INVALID_ARGUMENT;
	return value->version == LCC_DEVICE_BOUND_VERSION ? LCC_BOUND_OK : LCC_BOUND_UNSUPPORTED_VERSION;
}
LCC_BOUND_RESULT bound_public_result(BoundEnrollmentStatus) noexcept;
LCC_BOUND_RESULT bound_public_result(BoundRenewStatus) noexcept;
LCC_BOUND_RESULT bound_public_result(const BoundSessionDecision&, LccDeviceBoundOutcome&) noexcept;
LCC_BOUND_CHECKPOINT_RESULT bound_public_checkpoint(BoundCheckpointStatus) noexcept;
// Share the final local authorization decision with the feature-session owner.
// No token decoding, accepted authority import or public metadata injection.
LCC_BOUND_RESULT authorize_bound_public(LccDeviceBoundClient*, LccDeviceBoundOutcome*, BoundSessionDecision*) noexcept;

// Private native test seam; never installed and never configurable through the C ABI.
struct BoundPublicHooks {
	std::function<LCC_DEVICE_RESULT(const LccDeviceIdentityOptions&, BoundIdentityOwner&)> identity;
	std::function<std::unique_ptr<BoundCheckpointStorage>(const BoundCheckpointNamespace&)> storage;
	BoundRenewalSession::PlatformFactory clock = make_bound_anchor_platform;
	BoundRenewalClient::TransportFactory transport = make_bound_http_transport;
	std::function<std::unique_ptr<BoundBrowserLauncher>(const std::string&)> browser;
	LCC_DEVICE_POLICY policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
	std::function<bool()> capture_allowed;	// Private fault injection; empty in production.
};
LCC_BOUND_RESULT open_bound_public(const LccDeviceBoundOptions*, LccDeviceBoundClient**, LccDeviceBoundOutcome*,
								   bool resume, const BoundPublicHooks&) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
