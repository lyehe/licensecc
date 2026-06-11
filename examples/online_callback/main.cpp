#include <curl/curl.h>
#include <licensecc/licensecc.h>

#include <cstdio>
#include <cstring>
#include <string>

namespace {

struct OnlineClient {
	std::string endpoint;
};

size_t write_body(char* ptr, size_t size, size_t nmemb, void* user_data) {
	std::string* body = static_cast<std::string*>(user_data);
	const size_t bytes = size * nmemb;
	body->append(ptr, bytes);
	return bytes;
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
	std::string body = std::string("{") + json_field("project", request.project) + "," +
					   json_field("feature", request.feature) + "," +
					   json_field("license_fingerprint", request.license_fingerprint) + "," +
					   json_field("device_hash", request.device_hash) + "," + json_field("nonce", request.nonce);
	if (request.version >= 2u) {
		body += ",\"client_hardening\":" + std::to_string(request.client_hardening);
	}
	body += "}";
	return body;
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

LCC_ONLINE_CALLBACK_STATUS online_check(void* user_data, const LccOnlineRequest* request, char* assertion_out,
										size_t* assertion_out_size) {
	OnlineClient* client = static_cast<OnlineClient*>(user_data);
	if (client == nullptr || request == nullptr || assertion_out == nullptr || assertion_out_size == nullptr) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}

	CURL* curl = curl_easy_init();
	if (curl == nullptr) {
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}

	const std::string url = client->endpoint + "/v1/verify";
	const std::string body = request_body(*request);
	std::string response_body;
	struct curl_slist* headers = nullptr;
	headers = curl_slist_append(headers, "Content-Type: application/json");

	curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
	curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
	curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
	curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
	curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_body);
	curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response_body);
	curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(request->timeout_ms));
	curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

	const CURLcode curl_result = curl_easy_perform(curl);
	long http_status = 0;
	curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_status);
	curl_slist_free_all(headers);
	curl_easy_cleanup(curl);

	if (curl_result == CURLE_OPERATION_TIMEDOUT) {
		return LCC_ONLINE_CB_TIMEOUT;
	}
	if (curl_result != CURLE_OK || http_status >= 500) {
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}
	if (http_status != 200) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}

	std::string assertion;
	if (!extract_json_string(response_body, "assertion", &assertion) || assertion.empty()) {
		std::string code;
		if (extract_json_string(response_body, "code", &code) && code == "entitlement_denied") {
			return LCC_ONLINE_CB_HOST_DECLINED;
		}
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

	curl_global_init(CURL_GLOBAL_DEFAULT);

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
		curl_global_cleanup();
		return 1;
	}

	curl_global_cleanup();
	return 0;
}
