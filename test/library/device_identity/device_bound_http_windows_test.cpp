#define BOOST_TEST_MODULE device_bound_http_windows_test
#include <boost/test/unit_test.hpp>
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winhttp.h>
#include <cstring>
#include <map>
#include <string>
#include <vector>
#include "bound_http.hpp"

// Compile the actual adapter against deterministic WinHTTP calls. This seam
// exists only in this test translation unit, with a renamed factory; shipping
// code has no runtime option to bypass TLS or inject a response.
namespace shim {
struct State {
	std::map<DWORD, DWORD> options;
	std::map<DWORD, std::vector<std::wstring>> headers{{WINHTTP_QUERY_CONTENT_TYPE, {L"application/json"}}};
	unsigned opened = 0, closed = 0, sends = 0, receives = 0, reads = 0;
	DWORD fail_option = 0, status = 200, step_ms = 0;
	unsigned fail_read = 0;
	bool expire_at_eof = false;
	ULONGLONG time = 0;
	bool send_ok = true, receive_ok = true, read_ok = true, timeout_ok = true;
	std::string body = "{}", sent;
	std::wstring host, path;
	unsigned short port = 0;
	DWORD request_flags = 0;
	std::size_t offset = 0;
} state;
HINTERNET open(LPCWSTR, DWORD access, LPCWSTR, LPCWSTR, DWORD flags) {
	BOOST_CHECK_EQUAL(access, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY);
	BOOST_CHECK_EQUAL(flags, 0U);
	return reinterpret_cast<HINTERNET>(static_cast<std::uintptr_t>(++state.opened));
}
HINTERNET connect(HINTERNET, LPCWSTR host, INTERNET_PORT port, DWORD) {
	state.host = host;
	state.port = port;
	return reinterpret_cast<HINTERNET>(static_cast<std::uintptr_t>(++state.opened));
}
HINTERNET request(HINTERNET, LPCWSTR method, LPCWSTR path, LPCWSTR, LPCWSTR ref, LPCWSTR*, DWORD flags) {
	BOOST_CHECK(std::wstring(method) == L"POST");
	BOOST_CHECK(ref == nullptr);
	state.path = path;
	state.request_flags = flags;
	return reinterpret_cast<HINTERNET>(static_cast<std::uintptr_t>(++state.opened));
}
BOOL close(HINTERNET) {
	++state.closed;
	return TRUE;
}
BOOL option(HINTERNET handle, DWORD name, LPVOID data, DWORD size) {
	BOOST_CHECK_EQUAL(size, sizeof(DWORD));
	if (name == WINHTTP_OPTION_ENABLE_FEATURE || name == WINHTTP_OPTION_DISABLE_FEATURE)
		BOOST_CHECK_EQUAL(reinterpret_cast<std::uintptr_t>(handle), 3U);
	if (name == WINHTTP_OPTION_SECURE_PROTOCOLS) BOOST_CHECK_EQUAL(reinterpret_cast<std::uintptr_t>(handle), 1U);
	state.options[name] = *static_cast<DWORD*>(data);
	return name == state.fail_option ? FALSE : TRUE;
}
BOOL timeouts(HINTERNET, int resolve, int connect, int send, int receive) {
	BOOST_CHECK_GT(resolve, 0);
	BOOST_CHECK_LE(resolve, 5000);
	BOOST_CHECK_GT(connect, 0);
	BOOST_CHECK_LE(connect, 10000);
	BOOST_CHECK_GT(send, 0);
	BOOST_CHECK_LE(send, 30000);
	BOOST_CHECK_GT(receive, 0);
	BOOST_CHECK_LE(receive, 30000);
	return state.timeout_ok;
}
ULONGLONG ticks() {
	const auto now = state.time;
	state.time += state.step_ms;
	return now;
}
BOOL send(HINTERNET, LPCWSTR headers, DWORD, LPVOID body, DWORD size, DWORD total, DWORD_PTR) {
	++state.sends;
	BOOST_CHECK_EQUAL(size, total);
	state.sent.assign(static_cast<char*>(body), size);
	BOOST_CHECK(std::wstring(headers).find(L"Accept-Encoding: identity") != std::wstring::npos);
	if (!state.send_ok) SetLastError(ERROR_WINHTTP_SECURE_FAILURE);
	return state.send_ok;
}
BOOL receive(HINTERNET, LPVOID) {
	++state.receives;
	return state.receive_ok;
}
BOOL query(HINTERNET, DWORD name, LPCWSTR, LPVOID buffer, LPDWORD size, LPDWORD index) {
	if (name == (WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER)) {
		*static_cast<DWORD*>(buffer) = state.status;
		*size = sizeof(DWORD);
		return TRUE;
	}
	const auto found = state.headers.find(name);
	if (found == state.headers.end() || *index >= found->second.size()) {
		SetLastError(ERROR_WINHTTP_HEADER_NOT_FOUND);
		return FALSE;
	}
	const auto& text = found->second[(*index)++];
	if (*size < (text.size() + 1) * sizeof(wchar_t)) {
		SetLastError(ERROR_INSUFFICIENT_BUFFER);
		return FALSE;
	}
	std::memcpy(buffer, text.c_str(), (text.size() + 1) * sizeof(wchar_t));
	*size = static_cast<DWORD>(text.size() * sizeof(wchar_t));
	return TRUE;
}
BOOL read(HINTERNET, LPVOID buffer, DWORD size, LPDWORD count) {
	++state.reads;
	if (!state.read_ok || state.reads == state.fail_read) return FALSE;
	*count = static_cast<DWORD>((std::min)(static_cast<std::size_t>(size), state.body.size() - state.offset));
	std::memcpy(buffer, state.body.data() + state.offset, *count);
	state.offset += *count;
	if (!*count && state.expire_at_eof) state.time = 30000;
	return TRUE;
}
}  // namespace shim
#define WinHttpOpen shim::open
#define WinHttpConnect shim::connect
#define WinHttpOpenRequest shim::request
#define WinHttpCloseHandle shim::close
#define WinHttpSetOption shim::option
#define WinHttpSetTimeouts shim::timeouts
#define GetTickCount64 shim::ticks
#define WinHttpSendRequest shim::send
#define WinHttpReceiveResponse shim::receive
#define WinHttpQueryHeaders shim::query
#define WinHttpReadData shim::read
#define make_bound_http_transport make_shim_http_transport
#include "bound_http_windows.cpp"
#undef make_bound_http_transport

using namespace license::device_identity;
namespace {
BoundHttpStatus run(BoundWireOperation operation = BoundWireOperation::renew_challenge) {
	auto transport = make_shim_http_transport("https://backend.test:8443");
	BOOST_REQUIRE(transport);
	BoundHttpResponse response{42, "sentinel"};
	const auto status = transport->post(operation, "{}", response);
	BOOST_CHECK_EQUAL(shim::state.opened, shim::state.closed);
	if (status == BoundHttpStatus::complete) {
		BOOST_CHECK_EQUAL(response.status, shim::state.status);
		BOOST_CHECK_EQUAL(response.body, shim::state.body);
	} else {
		BOOST_CHECK_EQUAL(response.status, 42);
		BOOST_CHECK_EQUAL(response.body, "sentinel");
	}
	return status;
}
}  // namespace
BOOST_AUTO_TEST_CASE(security_options_fixed_destination_and_complete_bounded_body) {
	shim::state = {};
	shim::state.body = std::string(16384, 'x');
	shim::state.headers[WINHTTP_QUERY_CONTENT_LENGTH] = {L"16384"};
	BOOST_CHECK(run() == BoundHttpStatus::complete);
	BOOST_CHECK(shim::state.host == L"backend.test");
	BOOST_CHECK_EQUAL(shim::state.port, 8443);
	BOOST_CHECK(shim::state.path == L"/v2/device-challenges");
	BOOST_CHECK_EQUAL(shim::state.request_flags, WINHTTP_FLAG_SECURE);
	BOOST_CHECK_EQUAL(shim::state.options.at(WINHTTP_OPTION_SECURE_PROTOCOLS),
					  WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3);
	BOOST_CHECK_EQUAL(shim::state.options.at(WINHTTP_OPTION_ENABLE_FEATURE), WINHTTP_ENABLE_SSL_REVOCATION);
	BOOST_CHECK_EQUAL(shim::state.options.at(WINHTTP_OPTION_DISABLE_FEATURE),
					  WINHTTP_DISABLE_AUTHENTICATION | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_REDIRECTS);
	BOOST_CHECK_EQUAL(shim::state.options.at(WINHTTP_OPTION_AUTOLOGON_POLICY), WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH);
	BOOST_CHECK_EQUAL(shim::state.options.at(WINHTTP_OPTION_MAX_RESPONSE_HEADER_SIZE), 16384);
	BOOST_CHECK_EQUAL(shim::state.options.at(WINHTTP_OPTION_DISABLE_GLOBAL_POOLING), TRUE);
	BOOST_CHECK_EQUAL(shim::state.options.at(WINHTTP_OPTION_DISABLE_SECURE_PROTOCOL_FALLBACK), TRUE);
	BOOST_CHECK_EQUAL(shim::state.options.count(WINHTTP_OPTION_SECURITY_FLAGS), 0U);
	shim::state = {};
	BOOST_CHECK(run(BoundWireOperation::renew) == BoundHttpStatus::complete);
	BOOST_CHECK(shim::state.path == L"/v2/device-leases/renew");
	shim::state = {};
	BOOST_CHECK(run(BoundWireOperation::enrollment_challenge) == BoundHttpStatus::complete);
	BOOST_CHECK(shim::state.path == L"/v2/device-challenges");
	shim::state = {};
	BOOST_CHECK(run(BoundWireOperation::exchange) == BoundHttpStatus::complete);
	BOOST_CHECK(shim::state.path == L"/v2/device-authorizations/exchange");
	shim::state = {};
	BOOST_CHECK(run(BoundWireOperation::authorize) == BoundHttpStatus::complete);
	BOOST_CHECK(shim::state.path == L"/v2/device-authorizations");
}
BOOST_AUTO_TEST_CASE(every_required_security_option_failure_stops_before_send) {
	for (DWORD option : {WINHTTP_OPTION_SECURE_PROTOCOLS, WINHTTP_OPTION_ENABLE_FEATURE, WINHTTP_OPTION_DISABLE_FEATURE,
						 WINHTTP_OPTION_AUTOLOGON_POLICY, WINHTTP_OPTION_MAX_RESPONSE_HEADER_SIZE,
						 WINHTTP_OPTION_DISABLE_GLOBAL_POOLING, WINHTTP_OPTION_DISABLE_SECURE_PROTOCOL_FALLBACK}) {
		shim::state = {};
		shim::state.fail_option = option;
		BOOST_CHECK(run() == BoundHttpStatus::unavailable);
		BOOST_CHECK_EQUAL(shim::state.sends, 0U);
	}
	shim::state = {};
	shim::state.timeout_ok = false;
	BOOST_CHECK(run() == BoundHttpStatus::unavailable);
	BOOST_CHECK_EQUAL(shim::state.sends, 0U);
	shim::state = {};
	shim::state.send_ok = false;
	BOOST_CHECK(run() == BoundHttpStatus::unavailable);
	BOOST_CHECK_EQUAL(shim::state.receives, 0U);
	shim::state = {};
	shim::state.receive_ok = false;
	BOOST_CHECK(run() == BoundHttpStatus::unavailable);
	BOOST_CHECK_EQUAL(shim::state.reads, 0U);
}
BOOST_AUTO_TEST_CASE(redirect_and_representation_ambiguity_never_complete) {
	for (unsigned status : {199, 301, 302, 307, 308, 600}) {
		shim::state = {};
		shim::state.status = status;
		BOOST_CHECK(run() == BoundHttpStatus::invalid_response);
		BOOST_CHECK_EQUAL(shim::state.sends, 1U);
	}
	for (auto types : {std::vector<std::wstring>{},
					   {L"text/html"},
					   {L"application/json", L"application/json"},
					   {std::wstring(200, L'x')}}) {
		shim::state = {};
		shim::state.headers[WINHTTP_QUERY_CONTENT_TYPE] = types;
		BOOST_CHECK(run() == BoundHttpStatus::invalid_response);
	}
	shim::state = {};
	shim::state.headers[WINHTTP_QUERY_CONTENT_ENCODING] = {L"gzip"};
	BOOST_CHECK(run() == BoundHttpStatus::invalid_response);
	shim::state = {};
	shim::state.headers[WINHTTP_QUERY_TRANSFER_ENCODING] = {L"chunked"};
	BOOST_CHECK(run() == BoundHttpStatus::complete);
	shim::state = {};
	shim::state.headers[WINHTTP_QUERY_TRANSFER_ENCODING] = {L"chunked"};
	shim::state.headers[WINHTTP_QUERY_CONTENT_LENGTH] = {L"2"};
	BOOST_CHECK(run() == BoundHttpStatus::invalid_response);
	for (auto encodings : {std::vector<std::wstring>{L"gzip"}, {L"chunked", L"chunked"}}) {
		shim::state = {};
		shim::state.headers[WINHTTP_QUERY_TRANSFER_ENCODING] = encodings;
		BOOST_CHECK(run() == BoundHttpStatus::invalid_response);
	}
	shim::state = {};
	shim::state.headers[WINHTTP_QUERY_CONTENT_TYPE] = {L"Application/JSON; Charset=UTF-8"};
	BOOST_CHECK(run() == BoundHttpStatus::complete);
}
BOOST_AUTO_TEST_CASE(truncated_oversized_empty_or_delayed_response_preserves_output) {
	for (auto lengths : {std::vector<std::wstring>{L"3"}, {L"16385"}, {L"02"}, {L"2", L"2"}}) {
		shim::state = {};
		shim::state.headers[WINHTTP_QUERY_CONTENT_LENGTH] = lengths;
		BOOST_CHECK(run() == BoundHttpStatus::invalid_response);
	}
	shim::state = {};
	shim::state.body = std::string(16385, 'x');
	BOOST_CHECK(run() == BoundHttpStatus::invalid_response);
	shim::state = {};
	shim::state.body.clear();
	BOOST_CHECK(run() == BoundHttpStatus::invalid_response);
	shim::state = {};
	shim::state.read_ok = false;
	BOOST_CHECK(run() == BoundHttpStatus::unavailable);
	shim::state = {};
	shim::state.body = "{\"ok\":false,\"code\":\"binding_unavailable\",\"request_id\":\"trace\"}";
	shim::state.status = 404;
	shim::state.fail_read = 2;
	BOOST_CHECK(run() == BoundHttpStatus::unavailable);
	shim::state = {};
	shim::state.expire_at_eof = true;
	BOOST_CHECK(run() == BoundHttpStatus::unavailable);
	shim::state = {};
	shim::state.step_ms = 7000;
	BOOST_CHECK(run() == BoundHttpStatus::unavailable);
}
