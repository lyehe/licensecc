#ifndef LICENSECC_BOUND_HTTP_HPP_
#define LICENSECC_BOUND_HTTP_HPP_
#include "bound_wire.hpp"
#include <memory>
#include <string_view>

namespace license {
namespace device_identity {
struct BoundHttpOrigin {
	std::string host;
	unsigned short port = 443;
};
// Pilot transport configuration: canonical HTTPS DNS origin, no path/userinfo,
// query or fragment. Explicit non-default ports are supported.
bool parse_bound_http_origin(const std::string&, BoundHttpOrigin& out) noexcept;
bool valid_bound_portal_url(const std::string&) noexcept;
enum class BoundHttpStatus { complete, unavailable, invalid_response, internal_error };
struct BoundHttpResponse {
	unsigned status = 0;
	std::string body;
};
// Internal native seam, never a public caller-supplied "authenticated" Boolean.
// complete requires authenticated TLS to the factory's immutable origin and a
// complete bounded JSON HTTP response. Any failure leaves output unchanged.
class BoundHttpTransport {
public:
	virtual ~BoundHttpTransport() = default;
	// Synchronous borrowing only: never retain the view after post returns.
	virtual BoundHttpStatus post(BoundWireOperation, std::string_view body, BoundHttpResponse& out) noexcept = 0;
};
std::unique_ptr<BoundHttpTransport> make_bound_http_transport(const std::string& origin) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
