#ifndef LICENSECC_BOUND_POSSESSION_HPP_
#define LICENSECC_BOUND_POSSESSION_HPP_
#include <licensecc/device_identity.h>
#include <string>

namespace license {
namespace device_identity {
// Internal local possession check, not a server proof or lease authorization.
// The owning session supplies pinned identity and the verified envelope digest.
// Generates its own fresh challenge and consumes the signature locally. Caller
// coordinates handle lifetime with close/delete, as with other signing methods.
LCC_DEVICE_RESULT prove_bound_key_possession(LccDeviceIdentity* identity, const std::string& project,
											 const std::string& expected_key_id,
											 const std::string& lease_sha256) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
