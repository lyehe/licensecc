#ifndef LICENSECC_EXAMPLES_ONLINE_CALLBACK_COMMON_HPP_
#define LICENSECC_EXAMPLES_ONLINE_CALLBACK_COMMON_HPP_

#include <licensecc/licensecc.h>

#include <cctype>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace licensecc_online_callback_example {

typedef LCC_ONLINE_CALLBACK_STATUS (*OnlinePostVerify)(void* user_data, const std::string& endpoint,
													   const LccOnlineRequest& request, std::string* response_body);

typedef LCC_ONLINE_CALLBACK_STATUS (*OnlinePostVerifyBody)(void* user_data, const std::string& endpoint,
														   const LccOnlineRequest& request,
														   const std::string& request_body,
														   std::string* response_body);

struct OnlineRequestProofFields {
	std::string device_key_id;
	uint64_t request_timestamp = 0;
	std::string signature;
};

typedef bool (*OnlineRequestProofProvider)(void* user_data, const LccOnlineRequest& request,
										   OnlineRequestProofFields* proof_out);

struct OnlineClient {
	std::vector<std::string> endpoints;
	OnlinePostVerify post_verify = nullptr;
	OnlinePostVerifyBody post_verify_body = nullptr;
	void* post_verify_user_data = nullptr;
	OnlineRequestProofProvider request_proof_provider = nullptr;
	void* request_proof_user_data = nullptr;
	bool allow_insecure_http_for_test = false;
	size_t max_response_body = 64U * 1024U;
};

inline bool scheme_is(const std::string& endpoint, const char* scheme) {
	for (size_t i = 0; scheme[i] != '\0'; ++i) {
		if (i >= endpoint.size() ||
			std::tolower(static_cast<unsigned char>(endpoint[i])) !=
				std::tolower(static_cast<unsigned char>(scheme[i]))) {
			return false;
		}
	}
	return true;
}

inline bool allowed_endpoint_scheme(const OnlineClient& client, const std::string& endpoint) {
	if (scheme_is(endpoint, "https://")) {
		return true;
	}
	return client.allow_insecure_http_for_test && scheme_is(endpoint, "http://");
}

inline std::string normalize_endpoint(std::string endpoint) {
	while (!endpoint.empty() && endpoint[endpoint.size() - 1] == '/') {
		endpoint.resize(endpoint.size() - 1);
	}
	return endpoint;
}

inline bool add_endpoint(OnlineClient* client, const char* endpoint) {
	if (client == nullptr || endpoint == nullptr || endpoint[0] == '\0') {
		return false;
	}
	const std::string normalized = normalize_endpoint(endpoint);
	if (normalized.empty()) {
		return false;
	}
	if (!allowed_endpoint_scheme(*client, normalized)) {
		return false;
	}
	client->endpoints.push_back(normalized);
	return true;
}

inline bool is_retryable_transport_status(const LCC_ONLINE_CALLBACK_STATUS status) {
	return status == LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE || status == LCC_ONLINE_CB_TIMEOUT;
}

inline std::string json_escape(const char* value) {
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

inline std::string json_field(const char* name, const char* value) {
	return std::string("\"") + name + "\":\"" + json_escape(value) + "\"";
}

inline std::string canonical_request_proof_payload(const LccOnlineRequest& request,
												   const OnlineRequestProofFields& proof) {
	return std::string("purpose=licensecc-online-request\n") + "version=1\n" + "alg=ecdsa-p256-sha256\n" +
		   "project=" + request.project + "\n" + "feature=" + request.feature + "\n" +
		   "license-fingerprint=" + request.license_fingerprint + "\n" + "device-hash=" + request.device_hash + "\n" +
		   "nonce=" + request.nonce + "\n" + "request-timestamp=" + std::to_string(proof.request_timestamp) + "\n" +
		   "client-hardening=" + std::to_string(request.version >= 2u ? request.client_hardening : 0u) + "\n" +
		   "device-key-id=" + proof.device_key_id + "\n";
}

inline bool request_proof_complete(const OnlineRequestProofFields& proof) {
	return !proof.device_key_id.empty() && proof.request_timestamp != 0 && !proof.signature.empty();
}

inline std::string request_body(const LccOnlineRequest& request, const OnlineRequestProofFields* proof) {
	std::string body = std::string("{") + json_field("project", request.project) + "," +
					   json_field("feature", request.feature) + "," +
					   json_field("license_fingerprint", request.license_fingerprint) + "," +
					   json_field("device_hash", request.device_hash) + "," + json_field("nonce", request.nonce);
	if (request.version >= 2u) {
		body += ",\"client_hardening\":" + std::to_string(request.client_hardening);
	}
	if (proof != nullptr && request_proof_complete(*proof)) {
		body += ",\"request_signature_version\":1";
		body += ",";
		body += json_field("device_key_id", proof->device_key_id.c_str());
		body += ",\"request_timestamp\":" + std::to_string(proof->request_timestamp);
		body += ",\"request_signature_algorithm\":\"ecdsa-p256-sha256\"";
		body += ",";
		body += json_field("request_signature", proof->signature.c_str());
	}
	body += "}";
	return body;
}

inline std::string request_body(const LccOnlineRequest& request) {
	return request_body(request, nullptr);
}

inline std::string request_body_for_client(const OnlineClient& client, const LccOnlineRequest& request) {
	OnlineRequestProofFields proof;
	if (client.request_proof_provider != nullptr &&
		client.request_proof_provider(client.request_proof_user_data, request, &proof) &&
		request_proof_complete(proof)) {
		return request_body(request, &proof);
	}
	return request_body(request);
}

inline bool extract_json_string(const std::string& json, const char* name, std::string* out) {
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

inline LCC_ONLINE_CALLBACK_STATUS copy_assertion(const std::string& assertion, char* assertion_out,
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

inline LCC_ONLINE_CALLBACK_STATUS response_to_assertion(const std::string& response_body, char* assertion_out,
														size_t* assertion_out_size) {
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

inline LCC_ONLINE_CALLBACK_STATUS online_check(void* user_data, const LccOnlineRequest* request, char* assertion_out,
											   size_t* assertion_out_size) {
	OnlineClient* client = static_cast<OnlineClient*>(user_data);
	if (client == nullptr || request == nullptr || assertion_out == nullptr || assertion_out_size == nullptr ||
		(client->post_verify == nullptr && client->post_verify_body == nullptr)) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	if (client->endpoints.empty()) {
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}

	const std::string body =
		client->post_verify_body == nullptr ? std::string() : request_body_for_client(*client, *request);
	LCC_ONLINE_CALLBACK_STATUS last_transport_status = LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	for (std::vector<std::string>::const_iterator endpoint = client->endpoints.begin();
		 endpoint != client->endpoints.end(); ++endpoint) {
		std::string response_body;
		const LCC_ONLINE_CALLBACK_STATUS status = client->post_verify_body != nullptr
													  ? client->post_verify_body(client->post_verify_user_data, *endpoint,
																				*request, body, &response_body)
													  : client->post_verify(client->post_verify_user_data, *endpoint,
																			*request, &response_body);
		if (status == LCC_ONLINE_CB_OK) {
			if (response_body.size() > client->max_response_body) {
				return LCC_ONLINE_CB_MALFORMED_RESPONSE;
			}
			return response_to_assertion(response_body, assertion_out, assertion_out_size);
		}
		if (is_retryable_transport_status(status)) {
			last_transport_status = status;
			continue;
		}
		return status;
	}
	return last_transport_status;
}

}  // namespace licensecc_online_callback_example

#endif
