#ifndef LICENSECC_BOUND_CHECKPOINT_WINDOWS_HPP_
#define LICENSECC_BOUND_CHECKPOINT_WINDOWS_HPP_
#include "bound_checkpoint.hpp"

namespace license {
namespace device_identity {
struct BoundCheckpointNamespace {
	std::string application_id, endpoint_origin, issuer, lease_audience, proof_audience, project, feature;
};
// User scope is fixed. Key IDs, signers and discovered bindings are deliberately
// absent: key loss/rotation must not silently select an empty namespace.
bool bound_checkpoint_namespace(const BoundCheckpointNamespace&, std::string& out) noexcept;
std::unique_ptr<BoundCheckpointStorage> make_bound_checkpoint_storage(const BoundCheckpointNamespace&) noexcept;
// Private test seam: already-created private local-NTFS root, with the identical
// ACL, reparse, hard-link and resolved-path checks as the production directory.
std::unique_ptr<BoundCheckpointStorage> make_bound_checkpoint_storage_at_root(const std::wstring&,
																			  unsigned wait_ms = 250) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
