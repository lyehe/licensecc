#include "bound_http.hpp"
#include "bound_encoding.hpp"

namespace license {
namespace device_identity {
bool valid_bound_portal_url(const std::string& url) noexcept {
	try {
		if (url.size() > 1024) return false;
		const auto slash = url.find('/', 8);
		BoundHttpOrigin origin;
		return slash != std::string::npos && parse_bound_http_origin(url.substr(0, slash), origin) &&
			   bound_encoding::uri_path(url.substr(slash));
	} catch (...) {
		return false;
	}
}
bool parse_bound_http_origin(const std::string& value, BoundHttpOrigin& out) noexcept {
	try {
		if (value.size() > 270 || value.compare(0, 8, "https://") != 0) return false;
		const auto authority = value.substr(8);
		const auto colon = authority.find(':');
		BoundHttpOrigin candidate;
		candidate.host = authority.substr(0, colon);
		if (candidate.host.empty() || candidate.host.size() > 253) return false;
		std::size_t label = 0;
		for (std::size_t i = 0; i < candidate.host.size(); ++i) {
			const char c = candidate.host[i];
			if (c == '.') {
				if (!label || candidate.host[i - 1] == '-') return false;
				label = 0;
			} else {
				if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || (c == '-' && label))) return false;
				if (++label > 63) return false;
			}
		}
		if (!label || candidate.host.back() == '-') return false;
		// Exclude IPv4 shorthand, decimal/hex IP aliases and numeric terminal
		// labels. This pilot accepts DNS names, not an alternate IP grammar.
		const auto last_dot = candidate.host.rfind('.');
		const auto terminal = last_dot == std::string::npos ? 0 : last_dot + 1;
		if (candidate.host[terminal] < 'a' || candidate.host[terminal] > 'z') return false;
		if (colon != std::string::npos) {
			std::uint64_t port = 0;
			if (!bound_encoding::safe_integer(authority.substr(colon + 1), port) || port == 0 || port > 65535 ||
				port == 443)
				return false;
			candidate.port = static_cast<unsigned short>(port);
		}
		out = std::move(candidate);
		return true;
	} catch (...) {
		return false;
	}
}
#ifndef _WIN32
std::unique_ptr<BoundHttpTransport> make_bound_http_transport(const std::string&) noexcept { return nullptr; }
#endif
}  // namespace device_identity
}  // namespace license
