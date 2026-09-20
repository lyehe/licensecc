#ifndef LICENSECC_BOUND_BROWSER_HPP_
#define LICENSECC_BOUND_BROWSER_HPP_
#include <memory>
#include <string>

namespace license {
namespace device_identity {
enum class BoundBrowserStatus { opened, unavailable, invalid_input, busy, expired };
// Internal native seam. An opened browser is not authorization. A failed shell
// operation is ambiguous; retry must retain the same prepared attempt.
class BoundBrowserLauncher {
public:
	virtual ~BoundBrowserLauncher() = default;
	virtual BoundBrowserStatus open(const std::string& authorization_url) noexcept = 0;
};
std::unique_ptr<BoundBrowserLauncher> make_bound_browser_launcher(const std::string& portal_base) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
