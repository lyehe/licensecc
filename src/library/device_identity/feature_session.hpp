#ifndef LICENSECC_FEATURE_SESSION_HPP_
#define LICENSECC_FEATURE_SESSION_HPP_
#include <licensecc/feature_session.h>
#include "bound_public.hpp"

namespace license {
namespace device_identity {
// Reuse the native owner's existing private test seam. Not installed or exposed
// through the C ABI; production always uses the fixed native providers.
LCC_BOUND_RESULT open_feature_session(const LccDeviceBoundOptions*, LccFeatureSession**, LccFeatureSessionOutcome*,
									  const BoundPublicHooks&) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
