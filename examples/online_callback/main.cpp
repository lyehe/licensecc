#include <curl/curl.h>
#include <licensecc/licensecc.h>

#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <unordered_map>

namespace {

struct OnlineClient {
	std::string endpoint;
	std::string cache_path;
	std::unordered_map<std::string, std::string> assertion_cache;
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

std::string cache_key(const LccOnlineRequest& request) {
	return std::string(request.project) + "\n" + request.feature + "\n" + request.license_fingerprint + "\n" +
		   request.device_hash;
}

std::string cache_key_from_fields(const std::string& project, const std::string& feature,
								  const std::string& license_fingerprint, const std::string& device_hash) {
	return project + "\n" + feature + "\n" + license_fingerprint + "\n" + device_hash;
}

bool load_cache_file(OnlineClient* client) {
	if (client == nullptr || client->cache_path.empty()) {
		return false;
	}
	std::ifstream input(client->cache_path.c_str(), std::ios::binary);
	if (!input.is_open()) {
		return false;
	}
	std::string header;
	std::string project;
	std::string feature;
	std::string fingerprint;
	std::string device_hash;
	std::string assertion;
	std::getline(input, header);
	std::getline(input, project);
	std::getline(input, feature);
	std::getline(input, fingerprint);
	std::getline(input, device_hash);
	std::getline(input, assertion);
	if (header != "licensecc-online-cache-v1" || assertion.empty()) {
		return false;
	}
	client->assertion_cache[cache_key_from_fields(project, feature, fingerprint, device_hash)] = assertion;
	return true;
}

void save_cache_file(const OnlineClient& client, const LccOnlineRequest& request, const std::string& assertion) {
	if (client.cache_path.empty()) {
		return;
	}
	const std::string tmp_path = client.cache_path + ".tmp";
	std::ofstream output(tmp_path.c_str(), std::ios::binary | std::ios::trunc);
	if (!output.is_open()) {
		return;
	}
	output << "licensecc-online-cache-v1\n";
	output << request.project << '\n';
	output << request.feature << '\n';
	output << request.license_fingerprint << '\n';
	output << request.device_hash << '\n';
	output << assertion << '\n';
	output.close();
	std::remove(client.cache_path.c_str());
	std::rename(tmp_path.c_str(), client.cache_path.c_str());
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

LCC_ONLINE_CALLBACK_STATUS cached_or_status(OnlineClient* client, const LccOnlineRequest& request,
											LCC_ONLINE_CALLBACK_STATUS status, char* assertion_out,
											size_t* assertion_out_size) {
	if (request.policy == LCC_ONLINE_REQUIRE_WITH_CACHE && client != nullptr) {
		const auto found = client->assertion_cache.find(cache_key(request));
		if (found != client->assertion_cache.end()) {
			return copy_assertion(found->second, assertion_out, assertion_out_size);
		}
	}
	return status;
}

LCC_ONLINE_CALLBACK_STATUS online_check(void* user_data, const LccOnlineRequest* request, char* assertion_out,
										size_t* assertion_out_size) {
	OnlineClient* client = static_cast<OnlineClient*>(user_data);
	if (client == nullptr || request == nullptr || assertion_out == nullptr || assertion_out_size == nullptr) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}

	CURL* curl = curl_easy_init();
	if (curl == nullptr) {
		return cached_or_status(client, *request, LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE, assertion_out,
								assertion_out_size);
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
		return cached_or_status(client, *request, LCC_ONLINE_CB_TIMEOUT, assertion_out, assertion_out_size);
	}
	if (curl_result != CURLE_OK || http_status >= 500) {
		return cached_or_status(client, *request, LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE, assertion_out,
								assertion_out_size);
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
	const LCC_ONLINE_CALLBACK_STATUS copy_status = copy_assertion(assertion, assertion_out, assertion_out_size);
	if (copy_status == LCC_ONLINE_CB_OK) {
		client->assertion_cache[cache_key(*request)] = assertion;
		save_cache_file(*client, *request, assertion);
	}
	return copy_status;
}

void print_result(LCC_EVENT_TYPE result, const LicenseInfo& info) {
	char message[LCC_API_ERROR_BUFFER_SIZE];
	print_error(message, &info);
	std::printf("result=%s\n%s\n", lcc_strerror(result), message);
}

LCC_ONLINE_POLICY policy_from_arg(const char* arg) {
	if (arg != nullptr && std::strcmp(arg, "require") == 0) {
		return LCC_ONLINE_REQUIRE;
	}
	if (arg != nullptr && (std::strcmp(arg, "cache") == 0 || std::strcmp(arg, "cache-smoke") == 0)) {
		return LCC_ONLINE_REQUIRE_WITH_CACHE;
	}
	return LCC_ONLINE_AUDIT;
}

LCC_EVENT_TYPE run_check(const CallerInformations& caller, const LicenseLocation& location, OnlineClient* client,
						 LCC_ONLINE_POLICY policy, LicenseInfo* info) {
	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.online_policy = policy;
	options.online_check = online_check;
	options.online_user_data = client;

	lcc_init_license_info(info);
	return acquire_license_ex(&caller, &location, info, &options);
}

}  // namespace

int main(int argc, char** argv) {
	if (argc < 3) {
		std::fprintf(stderr, "usage: %s <license-path> <worker-url> [audit|require|cache|cache-smoke] [cache-file]\n",
					 argv[0]);
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
	if (argc > 4) {
		client.cache_path = argv[4];
		load_cache_file(&client);
	}

	const char* mode = argc > 3 ? argv[3] : "audit";
	const LCC_ONLINE_POLICY policy = policy_from_arg(mode);

	LicenseInfo info;
	const LCC_EVENT_TYPE result = run_check(caller, location, &client, policy, &info);
	print_result(result, info);
	if (result != LICENSE_OK) {
		curl_global_cleanup();
		return 1;
	}
	if (std::strcmp(mode, "cache-smoke") == 0) {
		client.endpoint = "https://127.0.0.1:9";
		LicenseInfo cached_info;
		const LCC_EVENT_TYPE cached_result = run_check(caller, location, &client, policy, &cached_info);
		std::printf("cached ");
		print_result(cached_result, cached_info);
		curl_global_cleanup();
		return cached_result == LICENSE_OK ? 0 : 1;
	}

	curl_global_cleanup();
	return 0;
}
