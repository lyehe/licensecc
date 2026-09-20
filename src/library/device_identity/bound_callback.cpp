#include "bound_callback.hpp"
#include "bound_encoding.hpp"

namespace license {
namespace device_identity {
namespace {
bool equal_header(std::string_view left, std::string_view right) {
	if (left.size() != right.size()) return false;
	for (std::size_t i = 0; i < left.size(); ++i) {
		const char c = left[i] >= 'A' && left[i] <= 'Z' ? left[i] + ('a' - 'A') : left[i];
		if (c != right[i]) return false;
	}
	return true;
}
bool header_name(std::string_view name) {
	if (name.empty()) return false;
	for (unsigned char c : name) {
		if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) continue;
		if (std::string_view("!#$%&'*+-.^_`|~").find(c) == std::string_view::npos) return false;
	}
	return true;
}
}  // namespace
BoundCallbackParse parse_bound_callback_http(std::string_view request, const std::string& uri,
											 std::string_view& target) noexcept {
	try {
		if (request.size() > 8192 || !bound_encoding::loopback_uri(uri)) return BoundCallbackParse::invalid;
		const auto end = request.find("\r\n\r\n");
		if (end == std::string_view::npos)
			return request.size() == 8192 ? BoundCallbackParse::invalid : BoundCallbackParse::incomplete;
		if (end + 4 != request.size()) return BoundCallbackParse::invalid;
		const auto line_end = request.find("\r\n");
		const auto line = request.substr(0, line_end);
		if (line.size() < 14 || line.substr(0, 4) != "GET " || line.substr(line.size() - 9) != " HTTP/1.1")
			return BoundCallbackParse::invalid;
		const auto candidate = line.substr(4, line.size() - 13);
		const auto path_start = uri.find('/', 7);
		const auto authority = std::string_view(uri).substr(7, path_start - 7);
		const auto path = std::string_view(uri).substr(path_start);
		if (candidate.size() > 2048 || candidate.size() <= path.size() || candidate.substr(0, path.size()) != path ||
			candidate[path.size()] != '?')
			return BoundCallbackParse::invalid;
		for (unsigned char c : candidate)
			if (c < 33 || c > 126 || c == '#' || c == '\\' || c == '%') return BoundCallbackParse::invalid;
		bool host = false, length = false;
		unsigned fields = 0;
		for (std::size_t offset = line_end + 2; offset < end;) {
			const auto next = request.find("\r\n", offset);
			if (next == std::string_view::npos || ++fields > 64) return BoundCallbackParse::invalid;
			const auto header = request.substr(offset, next - offset);
			const auto colon = header.find(':');
			if (colon == std::string_view::npos || !header_name(header.substr(0, colon)))
				return BoundCallbackParse::invalid;
			const auto name = header.substr(0, colon);
			auto value = header.substr(colon + 1);
			for (unsigned char c : value)
				if ((c < 32 && c != '\t') || c > 126) return BoundCallbackParse::invalid;
			while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) value.remove_prefix(1);
			while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) value.remove_suffix(1);
			if (equal_header(name, "host")) {
				if (host || value != authority) return BoundCallbackParse::invalid;
				host = true;
			} else if (equal_header(name, "content-length")) {
				if (length || value != "0") return BoundCallbackParse::invalid;
				length = true;
			} else if (equal_header(name, "transfer-encoding") || equal_header(name, "expect"))
				return BoundCallbackParse::invalid;
			offset = next + 2;
		}
		if (!host) return BoundCallbackParse::invalid;
		target = candidate;
		return BoundCallbackParse::complete;
	} catch (...) {
		return BoundCallbackParse::invalid;
	}
}
const std::string& bound_callback_http_response(bool received) {
	static const auto build = [](bool success) {
		const std::string body =
			success ? "<!doctype html><meta charset=utf-8><title>Return to "
					  "application</title><script>history.replaceState(null,'','/complete');</script><p>Approval "
					  "received. Return to the application to finish activation.</p>"
					: "<!doctype html><meta charset=utf-8><title>Callback not "
					  "accepted</title><script>history.replaceState(null,'','/complete');</script><p>This callback was "
					  "not accepted. Return to the application and try again.</p>";
		return std::string(success ? "HTTP/1.1 200 OK\r\n" : "HTTP/1.1 400 Bad Request\r\n") +
			   "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: "
			   "no-referrer\r\nX-Content-Type-Options: nosniff\r\n"
			   "Content-Security-Policy: default-src 'none'; script-src "
			   "'sha256-Lf/N59q6KU/9GVHgg2dDcUopzg+zOYjQ/mz5Xv/OwTU='; base-uri 'none'; form-action 'none'; "
			   "frame-ancestors 'none'\r\n"
			   "Connection: close\r\nContent-Length: " +
			   std::to_string(body.size()) + "\r\n\r\n" + body;
	};
	static const std::string success = build(true), failure = build(false);
	return received ? success : failure;
}
}  // namespace device_identity
}  // namespace license
