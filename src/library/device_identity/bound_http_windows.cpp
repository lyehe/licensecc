#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winhttp.h>
#include "bound_http.hpp"
#include "bound_encoding.hpp"
#include <algorithm>
#include <array>

namespace license {
namespace device_identity {
namespace {
struct Close {
	void operator()(void* handle) const noexcept {
		if (handle) WinHttpCloseHandle(handle);
	}
};
using Handle = std::unique_ptr<void, Close>;
constexpr DWORD body_limit = 16384;
constexpr ULONGLONG budget_ms = 30000;
bool option(HINTERNET handle, DWORD name, DWORD value) {
	return WinHttpSetOption(handle, name, &value, sizeof(value)) != FALSE;
}
// WinHTTP phase timeouts are not a hard wall-clock deadline. Reject over-budget
// results and shrink every subsequent blocking phase/read to the remaining time.
bool timeouts(HINTERNET handle, ULONGLONG start) {
	const auto elapsed = GetTickCount64() - start;
	if (elapsed >= budget_ms) return false;
	const auto remaining = static_cast<int>(budget_ms - elapsed);
	return WinHttpSetTimeouts(handle, (std::min)(remaining, 5000), (std::min)(remaining, 10000), remaining,
							  remaining) != FALSE;
}
bool json_type(HINTERNET request) {
	std::array<wchar_t, 128> value{};
	DWORD size = static_cast<DWORD>(sizeof(value)), index = 0;
	if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX, value.data(), &size,
							 &index))
		return false;
	std::wstring type(value.data(), size / sizeof(wchar_t));
	for (auto& c : type)
		if (c >= L'A' && c <= L'Z') c += L'a' - L'A';
	// Our serving JSON contract emits one of these forms. Reject duplicate or
	// unknown representations rather than sniffing potentially HTML responses.
	if (type != L"application/json" && type != L"application/json; charset=utf-8") return false;
	size = static_cast<DWORD>(sizeof(value));
	if (WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX, value.data(), &size,
							&index) ||
		GetLastError() != ERROR_WINHTTP_HEADER_NOT_FOUND)
		return false;
	size = static_cast<DWORD>(sizeof(value));
	index = 0;
	// Request identity encoding and reject a server that nevertheless compresses.
	return !WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_ENCODING, WINHTTP_HEADER_NAME_BY_INDEX, value.data(),
								&size, &index) &&
		   GetLastError() == ERROR_WINHTTP_HEADER_NOT_FOUND;
}
bool content_length(HINTERNET request, std::uint64_t& length, bool& present) {
	std::array<wchar_t, 32> value{};
	DWORD size = static_cast<DWORD>(sizeof(value)), index = 0;
	if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_HEADER_NAME_BY_INDEX, value.data(), &size,
							 &index)) {
		present = false;
		return GetLastError() == ERROR_WINHTTP_HEADER_NOT_FOUND;
	}
	std::string text;
	for (DWORD i = 0; i < size / sizeof(wchar_t); ++i) {
		if (value[i] < L'0' || value[i] > L'9') return false;
		text += static_cast<char>(value[i]);
	}
	if (!bound_encoding::safe_integer(text, length) || length > body_limit) return false;
	present = true;
	size = static_cast<DWORD>(sizeof(value));
	return !WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_HEADER_NAME_BY_INDEX, value.data(),
								&size, &index) &&
		   GetLastError() == ERROR_WINHTTP_HEADER_NOT_FOUND;
}
bool transfer_encoding(HINTERNET request, bool has_length) {
	std::array<wchar_t, 32> value{};
	DWORD size = static_cast<DWORD>(sizeof(value)), index = 0;
	if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_TRANSFER_ENCODING, WINHTTP_HEADER_NAME_BY_INDEX, value.data(),
							 &size, &index))
		return GetLastError() == ERROR_WINHTTP_HEADER_NOT_FOUND;
	if (has_length) return false;
	std::wstring encoding(value.data(), size / sizeof(wchar_t));
	for (auto& c : encoding)
		if (c >= L'A' && c <= L'Z') c += L'a' - L'A';
	if (encoding != L"chunked") return false;
	size = static_cast<DWORD>(sizeof(value));
	return !WinHttpQueryHeaders(request, WINHTTP_QUERY_TRANSFER_ENCODING, WINHTTP_HEADER_NAME_BY_INDEX, value.data(),
								&size, &index) &&
		   GetLastError() == ERROR_WINHTTP_HEADER_NOT_FOUND;
}
class WindowsTransport final : public BoundHttpTransport {
	const std::wstring host_;
	const INTERNET_PORT port_;

public:
	explicit WindowsTransport(const BoundHttpOrigin& origin)
		: host_(origin.host.begin(), origin.host.end()), port_(origin.port) {}
	BoundHttpStatus post(BoundWireOperation operation, std::string_view body,
						 BoundHttpResponse& out) noexcept override {
		try {
			const wchar_t* path = nullptr;
			if (operation == BoundWireOperation::renew_challenge ||
				operation == BoundWireOperation::enrollment_challenge)
				path = L"/v2/device-challenges";
			else if (operation == BoundWireOperation::renew)
				path = L"/v2/device-leases/renew";
			else if (operation == BoundWireOperation::exchange)
				path = L"/v2/device-authorizations/exchange";
			else if (operation == BoundWireOperation::authorize)
				path = L"/v2/device-authorizations";
			if (!path || body.empty() || body.size() > body_limit) return BoundHttpStatus::internal_error;
			const auto start = GetTickCount64();
			Handle session(WinHttpOpen(L"Licensecc/1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
									   WINHTTP_NO_PROXY_BYPASS, 0));
			if (!session || !timeouts(session.get(), start) ||
				!option(session.get(), WINHTTP_OPTION_DISABLE_GLOBAL_POOLING, TRUE) ||
				!option(session.get(), WINHTTP_OPTION_DISABLE_SECURE_PROTOCOL_FALLBACK, TRUE) ||
				!option(session.get(), WINHTTP_OPTION_SECURE_PROTOCOLS,
						WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3))
				return BoundHttpStatus::unavailable;
			Handle connection(WinHttpConnect(session.get(), host_.c_str(), port_, 0));
			if (!connection) return BoundHttpStatus::unavailable;
			const wchar_t* accept[] = {L"application/json", nullptr};
			Handle request(WinHttpOpenRequest(connection.get(), L"POST", path, nullptr, WINHTTP_NO_REFERER, accept,
											  WINHTTP_FLAG_SECURE));
			if (!request || !timeouts(request.get(), start) ||
				!option(request.get(), WINHTTP_OPTION_DISABLE_FEATURE,
						WINHTTP_DISABLE_AUTHENTICATION | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_REDIRECTS) ||
				!option(request.get(), WINHTTP_OPTION_AUTOLOGON_POLICY, WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH) ||
				!option(request.get(), WINHTTP_OPTION_ENABLE_FEATURE, WINHTTP_ENABLE_SSL_REVOCATION) ||
				!option(request.get(), WINHTTP_OPTION_MAX_RESPONSE_HEADER_SIZE, 16384))
				return BoundHttpStatus::unavailable;
			// No credentials, client certificate, TLS validation override or retry
			// of certificate errors. Each request has fresh handles and no cookies.
			const auto size = static_cast<DWORD>(body.size());
			if (!WinHttpSendRequest(request.get(), L"Content-Type: application/json\r\nAccept-Encoding: identity\r\n",
									static_cast<DWORD>(-1), const_cast<char*>(body.data()), size, size, 0) ||
				!timeouts(request.get(), start) || !WinHttpReceiveResponse(request.get(), nullptr))
				return BoundHttpStatus::unavailable;
			BoundHttpResponse candidate;
			DWORD status = 0, status_size = sizeof(status);
			if (!WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
									 WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX) ||
				status < 200 || status >= 600 || (status >= 300 && status < 400) || !json_type(request.get()))
				return BoundHttpStatus::invalid_response;
			std::uint64_t expected_length = 0;
			bool has_length = false;
			if (!content_length(request.get(), expected_length, has_length) ||
				!transfer_encoding(request.get(), has_length))
				return BoundHttpStatus::invalid_response;
			candidate.status = status;
			std::array<char, 4096> buffer{};
			for (;;) {
				if (!timeouts(request.get(), start)) return BoundHttpStatus::unavailable;
				DWORD count = 0;
				if (!WinHttpReadData(request.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &count))
					return BoundHttpStatus::unavailable;
				if (GetTickCount64() - start >= budget_ms) return BoundHttpStatus::unavailable;
				if (!count) break;
				if (count > body_limit - candidate.body.size()) return BoundHttpStatus::invalid_response;
				candidate.body.append(buffer.data(), count);
			}
			if (candidate.body.empty() || (has_length && candidate.body.size() != expected_length))
				return BoundHttpStatus::invalid_response;
			out = std::move(candidate);
			return BoundHttpStatus::complete;
		} catch (...) {
			return BoundHttpStatus::internal_error;
		}
	}
};
}  // namespace
std::unique_ptr<BoundHttpTransport> make_bound_http_transport(const std::string& origin) noexcept {
	try {
		BoundHttpOrigin parsed;
		if (!parse_bound_http_origin(origin, parsed)) return nullptr;
		return std::make_unique<WindowsTransport>(parsed);
	} catch (...) {
		return nullptr;
	}
}
}  // namespace device_identity
}  // namespace license
