#ifndef LICENSECC_BOUND_CALLBACK_HPP_
#define LICENSECC_BOUND_CALLBACK_HPP_
#include <string>
#include <string_view>

namespace license {
namespace device_identity {
enum class BoundCallbackParse { incomplete, invalid, complete };
// Internal HTTP framing only. The target borrows the caller's sensitive buffer;
// success is not consent or authority. The enrollment owner must verify state.
BoundCallbackParse parse_bound_callback_http(std::string_view request, const std::string& registered_uri,
											 std::string_view& target) noexcept;
// Static responses never contain request input. Success means callback receipt,
// not activation. The success document removes its query from browser history.
const std::string& bound_callback_http_response(bool received);
}  // namespace device_identity
}  // namespace license
#endif
