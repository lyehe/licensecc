#include <curl/curl.h>
#include <licensecc/licensecc.h>

#include "online_callback_common.hpp"

#include <cstdio>
#include <cstring>
#include <string>

namespace {

using licensecc_online_callback_example::add_endpoint;
using licensecc_online_callback_example::online_check;
using licensecc_online_callback_example::OnlineClient;

struct ResponseBodySink {
	std::string* body = nullptr;
	size_t max_size = 0;
	bool too_large = false;
};

size_t write_body(char* ptr, size_t size, size_t nmemb, void* user_data) {
	ResponseBodySink* sink = static_cast<ResponseBodySink*>(user_data);
	const size_t bytes = size * nmemb;
	if (sink == nullptr || sink->body == nullptr) {
		return 0;
	}
	if (bytes > sink->max_size || sink->body->size() > sink->max_size - bytes) {
		sink->too_large = true;
		return 0;
	}
	sink->body->append(ptr, bytes);
	return bytes;
}

LCC_ONLINE_CALLBACK_STATUS post_verify(void* /*user_data*/, const std::string& endpoint,
									   const LccOnlineRequest& request, const std::string& body,
									   std::string* response_body) {
	if (response_body == nullptr) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	CURL* curl = curl_easy_init();
	if (curl == nullptr) {
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}

	const std::string url = endpoint + "/v1/verify";
	ResponseBodySink response_sink;
	response_sink.body = response_body;
	response_sink.max_size = 64U * 1024U;
	struct curl_slist* headers = nullptr;
	headers = curl_slist_append(headers, "Content-Type: application/json");

	curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
	curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
	curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
	curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
	curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_body);
	curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response_sink);
	curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(request.timeout_ms));
	curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

	const CURLcode curl_result = curl_easy_perform(curl);
	long http_status = 0;
	curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_status);
	curl_slist_free_all(headers);
	curl_easy_cleanup(curl);

	if (curl_result == CURLE_OPERATION_TIMEDOUT) {
		return LCC_ONLINE_CB_TIMEOUT;
	}
	if (response_sink.too_large) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	if (curl_result != CURLE_OK || http_status >= 500) {
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}
	if (http_status != 200) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	return LCC_ONLINE_CB_OK;
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
	if (argc < 3) {
		std::fprintf(stderr,
					 "usage: %s <license-path> [--allow-insecure-http-for-test] <primary-worker-url> "
					 "[backup-worker-url ...]\n",
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
	client.post_verify_body = post_verify;
	for (int i = 2; i < argc; ++i) {
		if (std::strcmp(argv[i], "--allow-insecure-http-for-test") == 0) {
			client.allow_insecure_http_for_test = true;
			continue;
		}
		if (!add_endpoint(&client, argv[i])) {
			std::fprintf(stderr, "invalid worker URL: %s\n", argv[i]);
			curl_global_cleanup();
			return 2;
		}
	}
	if (client.endpoints.empty()) {
		std::fprintf(stderr, "at least one worker URL is required\n");
		curl_global_cleanup();
		return 2;
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
