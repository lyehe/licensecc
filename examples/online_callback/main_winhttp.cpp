#include <windows.h>
#include <winhttp.h>

#include <licensecc/licensecc.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

struct OnlineClient {
	std::string endpoint;
};

std::wstring utf8_to_wide(const std::string& value) {
	if (value.empty()) {
		return std::wstring();
	}
	const int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), nullptr, 0);
	if (size <= 0) {
		return std::wstring();
	}
	std::wstring out(static_cast<size_t>(size), L'\0');
	MultiByteToWideChar(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), &out[0], size);
	return out;
}

std::string json_escape(const char* value) {
	std::string out;
	for (const char* p = value; p != nullptr && *p != '\0'; ++p) {
		switch (*p) {
			case '\\':
				out += "\\\\";
				break;
			case '"':
				out += "\\\"";
				break;
			default:
				out.push_back(*p);
				break;
		}
	}
	return out;
}

std::string json_field(const char* name, const char* value) {
	return std::string("\"") + name + "\":\"" + json_escape(value) + "\"";
}

std::string request_body(const LccOnlineRequest& request) {
	return std::string("{") + json_field("project", request.project) + "," +
		   json_field("feature", request.feature) + "," +
		   json_field("license_fingerprint", request.license_fingerprint) + "," +
		   json_field("device_hash", request.device_hash) + "," + json_field("nonce", request.nonce) + "}";
}

bool extract_json_string(const std::string& json, const char* name, std::string* out) {
	const std::string needle = std::string("\"") + name + "\"";
	size_t pos = json.find(needle);
	if (pos == std::string::npos) {
		return false;
	}
	pos = json.find(':', pos + needle.size());
	if (pos == std::string::npos) {
		return false;
	}
	pos = json.find('"', pos + 1);
	if (pos == std::string::npos) {
		return false;
	}
	++pos;
	std::string value;
	for (; pos < json.size(); ++pos) {
		const char ch = json[pos];
		if (ch == '"') {
			*out = value;
			return true;
		}
		if (ch == '\\') {
			if (++pos >= json.size()) {
				return false;
			}
			const char escaped = json[pos];
			if (escaped == '"' || escaped == '\\' || escaped == '/') {
				value.push_back(escaped);
				continue;
			}
			return false;
		}
		value.push_back(ch);
	}
	return false;
}

LCC_ONLINE_CALLBACK_STATUS copy_assertion(const std::string& assertion, char* assertion_out,
										  size_t* assertion_out_size) {
	if (assertion_out == nullptr || assertion_out_size == nullptr) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	const size_t required = assertion.size() + 1;
	if (required > *assertion_out_size) {
		*assertion_out_size = required;
		return LCC_ONLINE_CB_BUFFER_TOO_SMALL;
	}
	std::memcpy(assertion_out, assertion.c_str(), required);
	*assertion_out_size = required;
	return LCC_ONLINE_CB_OK;
}

LCC_ONLINE_CALLBACK_STATUS post_verify(const std::string& endpoint, const LccOnlineRequest& request,
									   std::string* response_body) {
	const std::wstring url = utf8_to_wide(endpoint + "/v1/verify");
	if (url.empty()) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}

	URL_COMPONENTS parts = {};
	parts.dwStructSize = sizeof(parts);
	parts.dwSchemeLength = static_cast<DWORD>(-1);
	parts.dwHostNameLength = static_cast<DWORD>(-1);
	parts.dwUrlPathLength = static_cast<DWORD>(-1);
	parts.dwExtraInfoLength = static_cast<DWORD>(-1);
	if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts)) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}

	const std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
	std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
	if (parts.dwExtraInfoLength > 0) {
		path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
	}
	const bool secure = parts.nScheme == INTERNET_SCHEME_HTTPS;
	const std::string body = request_body(request);

	HINTERNET session = WinHttpOpen(L"licensecc-online-callback/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
								   WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
	if (session == nullptr) {
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}
	const DWORD timeout = request.timeout_ms == 0 ? LCC_ONLINE_DEFAULT_TIMEOUT_MS : request.timeout_ms;
	WinHttpSetTimeouts(session, static_cast<int>(timeout), static_cast<int>(timeout), static_cast<int>(timeout),
					   static_cast<int>(timeout));

	HINTERNET connection = WinHttpConnect(session, host.c_str(), parts.nPort, 0);
	if (connection == nullptr) {
		WinHttpCloseHandle(session);
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}

	HINTERNET http_request = WinHttpOpenRequest(connection, L"POST", path.c_str(), nullptr, WINHTTP_NO_REFERER,
											   WINHTTP_DEFAULT_ACCEPT_TYPES, secure ? WINHTTP_FLAG_SECURE : 0);
	if (http_request == nullptr) {
		WinHttpCloseHandle(connection);
		WinHttpCloseHandle(session);
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}

	const wchar_t headers[] = L"Content-Type: application/json\r\n";
	const BOOL sent = WinHttpSendRequest(http_request, headers, static_cast<DWORD>(wcslen(headers)),
										 const_cast<char*>(body.data()), static_cast<DWORD>(body.size()),
										 static_cast<DWORD>(body.size()), 0);
	if (!sent || !WinHttpReceiveResponse(http_request, nullptr)) {
		const DWORD error = GetLastError();
		WinHttpCloseHandle(http_request);
		WinHttpCloseHandle(connection);
		WinHttpCloseHandle(session);
		return error == ERROR_WINHTTP_TIMEOUT ? LCC_ONLINE_CB_TIMEOUT : LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}

	DWORD status = 0;
	DWORD status_size = sizeof(status);
	WinHttpQueryHeaders(http_request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
						WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX);
	if (status != 200) {
		WinHttpCloseHandle(http_request);
		WinHttpCloseHandle(connection);
		WinHttpCloseHandle(session);
		return status >= 500 ? LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE : LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}

	response_body->clear();
	for (;;) {
		DWORD available = 0;
		if (!WinHttpQueryDataAvailable(http_request, &available)) {
			WinHttpCloseHandle(http_request);
			WinHttpCloseHandle(connection);
			WinHttpCloseHandle(session);
			return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
		}
		if (available == 0) {
			break;
		}
		std::vector<char> buffer(static_cast<size_t>(available));
		DWORD read = 0;
		if (!WinHttpReadData(http_request, buffer.data(), available, &read)) {
			WinHttpCloseHandle(http_request);
			WinHttpCloseHandle(connection);
			WinHttpCloseHandle(session);
			return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
		}
		response_body->append(buffer.data(), read);
	}

	WinHttpCloseHandle(http_request);
	WinHttpCloseHandle(connection);
	WinHttpCloseHandle(session);
	return LCC_ONLINE_CB_OK;
}

LCC_ONLINE_CALLBACK_STATUS online_check(void* user_data, const LccOnlineRequest* request, char* assertion_out,
										size_t* assertion_out_size) {
	OnlineClient* client = static_cast<OnlineClient*>(user_data);
	if (client == nullptr || request == nullptr || assertion_out == nullptr || assertion_out_size == nullptr) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}

	std::string response_body;
	const LCC_ONLINE_CALLBACK_STATUS status = post_verify(client->endpoint, *request, &response_body);
	if (status != LCC_ONLINE_CB_OK) {
		return status;
	}

	std::string assertion;
	if (!extract_json_string(response_body, "assertion", &assertion) || assertion.empty()) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	return copy_assertion(assertion, assertion_out, assertion_out_size);
}

void print_result(LCC_EVENT_TYPE result, const LicenseInfo& info) {
	char message[LCC_API_ERROR_BUFFER_SIZE];
	print_error(message, &info);
	std::printf("result=%s\n%s\n", lcc_strerror(result), message);
}

LCC_EVENT_TYPE run_check(const CallerInformations& caller, const LicenseLocation& location, OnlineClient* client,
						 LicenseInfo* info) {
	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.online_policy = LCC_ONLINE_REQUIRE;
	options.online_check = online_check;
	options.online_user_data = client;

	lcc_init_license_info(info);
	return acquire_license_ex(&caller, &location, info, &options);
}

}  // namespace

int main(int argc, char** argv) {
	if (argc != 3) {
		std::fprintf(stderr, "usage: %s <license-path> <worker-url>\n", argv[0]);
		return 2;
	}

	LicenseLocation location;
	lcc_init_license_location(&location, LICENSE_PATH);
	if (!lcc_set_license_path(&location, argv[1])) {
		std::fprintf(stderr, "license path is too long\n");
		return 2;
	}

	CallerInformations caller;
	lcc_init_caller_informations(&caller);

	OnlineClient client;
	client.endpoint = argv[2];
	while (!client.endpoint.empty() && client.endpoint[client.endpoint.size() - 1] == '/') {
		client.endpoint.resize(client.endpoint.size() - 1);
	}
	LicenseInfo info;
	const LCC_EVENT_TYPE result = run_check(caller, location, &client, &info);
	print_result(result, info);
	if (result != LICENSE_OK) {
		return 1;
	}
	return 0;
}
