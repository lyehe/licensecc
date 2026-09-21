#ifndef LICENSECC_BOUND_DIRECTORY_LINUX_HPP_
#define LICENSECC_BOUND_DIRECTORY_LINUX_HPP_
#include <string>
namespace license {
namespace device_identity {
// Private user-owned directory, resolved without following symbolic links.
// Production roots come from the account database, never HOME/XDG overrides.
int open_bound_private_directory(const std::string& path) noexcept;
bool bound_linux_directory(const std::string& leaf, std::string& out) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
