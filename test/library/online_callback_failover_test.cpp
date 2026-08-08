#define BOOST_TEST_MODULE online_callback_failover_test

#include <licensecc/licensecc.h>

#include <cstring>
#include <string>
#include <vector>

#include <boost/test/unit_test.hpp>

#include "online_callback_common.hpp"

namespace {

using licensecc_online_callback_example::add_endpoint;
using licensecc_online_callback_example::canonical_request_proof_payload;
using licensecc_online_callback_example::online_check;
using licensecc_online_callback_example::OnlineClient;
using licensecc_online_callback_example::OnlineRequestProofFields;
using licensecc_online_callback_example::request_body;

struct FakeResponse {
	LCC_ONLINE_CALLBACK_STATUS status;
	std::string body;
};

struct FakeTransport {
	std::vector<FakeResponse> responses;
	std::vector<std::string> endpoints_seen;
	std::vector<std::string> request_bodies_seen;
};

LCC_ONLINE_CALLBACK_STATUS fake_post_verify(void* user_data, const std::string& endpoint,
											const LccOnlineRequest& /*request*/, std::string* response_body) {
	FakeTransport* transport = static_cast<FakeTransport*>(user_data);
	transport->endpoints_seen.push_back(endpoint);
	const size_t index = transport->endpoints_seen.size() - 1;
	if (index >= transport->responses.size()) {
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}
	if (response_body != nullptr) {
		*response_body = transport->responses[index].body;
	}
	return transport->responses[index].status;
}

LCC_ONLINE_CALLBACK_STATUS fake_post_verify_body(void* user_data, const std::string& endpoint,
												 const LccOnlineRequest& request, const std::string& request_body_json,
												 std::string* response_body) {
	FakeTransport* transport = static_cast<FakeTransport*>(user_data);
	transport->request_bodies_seen.push_back(request_body_json);
	return fake_post_verify(transport, endpoint, request, response_body);
}

LccOnlineRequest online_request() {
	LccOnlineRequest request{};
	request.size = sizeof(request);
	request.version = LCC_ONLINE_REQUEST_VERSION;
	request.policy = LCC_ONLINE_REQUIRE;
	request.timeout_ms = LCC_ONLINE_DEFAULT_TIMEOUT_MS;
	std::strcpy(request.project, "DEFAULT");
	std::strcpy(request.feature, "DEFAULT");
	std::strcpy(request.license_fingerprint, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	std::strcpy(request.nonce, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
	return request;
}

OnlineClient client_for(FakeTransport* transport) {
	OnlineClient client;
	client.post_verify = fake_post_verify;
	client.post_verify_user_data = transport;
	BOOST_REQUIRE(add_endpoint(&client, "https://primary.example/"));
	BOOST_REQUIRE(add_endpoint(&client, "https://backup.example"));
	return client;
}

bool fixed_request_proof(void*, const LccOnlineRequest&, OnlineRequestProofFields* proof_out) {
	if (proof_out == nullptr) {
		return false;
	}
	proof_out->device_key_id = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
	proof_out->request_timestamp = 1000000;
	proof_out->signature = "MEUCIQDtest-signature==";
	return true;
}

}  // namespace

BOOST_AUTO_TEST_CASE(backup_endpoint_is_used_after_transport_failure) {
	FakeTransport transport;
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE, ""});
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_OK, "{\"ok\":true,\"assertion\":\"lccoa1.payload.sig\"}"});
	OnlineClient client = client_for(&transport);
	LccOnlineRequest request = online_request();
	char assertion[LCC_API_ONLINE_ASSERTION_SIZE + 1] = {};
	size_t assertion_size = sizeof(assertion);

	const LCC_ONLINE_CALLBACK_STATUS status = online_check(&client, &request, assertion, &assertion_size);

	BOOST_CHECK_EQUAL(status, LCC_ONLINE_CB_OK);
	BOOST_REQUIRE_EQUAL(transport.endpoints_seen.size(), static_cast<size_t>(2));
	BOOST_CHECK_EQUAL(transport.endpoints_seen[0], "https://primary.example");
	BOOST_CHECK_EQUAL(transport.endpoints_seen[1], "https://backup.example");
	BOOST_CHECK_EQUAL(std::string(assertion), "lccoa1.payload.sig");
	BOOST_CHECK_EQUAL(assertion_size, std::strlen("lccoa1.payload.sig") + 1);
}

BOOST_AUTO_TEST_CASE(http_endpoint_is_rejected_by_default_and_allowed_for_tests) {
	OnlineClient client;
	BOOST_CHECK(!add_endpoint(&client, "http://primary.example"));
	BOOST_CHECK(client.endpoints.empty());

	client.allow_insecure_http_for_test = true;
	BOOST_CHECK(add_endpoint(&client, "http://primary.example/"));
	BOOST_REQUIRE_EQUAL(client.endpoints.size(), static_cast<size_t>(1));
	BOOST_CHECK_EQUAL(client.endpoints[0], "http://primary.example");
}

BOOST_AUTO_TEST_CASE(denial_does_not_fall_through_to_backup) {
	FakeTransport transport;
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_OK, "{\"ok\":false,\"code\":\"entitlement_denied\"}"});
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_OK, "{\"ok\":true,\"assertion\":\"lccoa1.backup.sig\"}"});
	OnlineClient client = client_for(&transport);
	LccOnlineRequest request = online_request();
	char assertion[LCC_API_ONLINE_ASSERTION_SIZE + 1] = {};
	size_t assertion_size = sizeof(assertion);

	const LCC_ONLINE_CALLBACK_STATUS status = online_check(&client, &request, assertion, &assertion_size);

	BOOST_CHECK_EQUAL(status, LCC_ONLINE_CB_HOST_DECLINED);
	BOOST_CHECK_EQUAL(transport.endpoints_seen.size(), static_cast<size_t>(1));
	BOOST_CHECK_EQUAL(std::string(assertion), "");
}

BOOST_AUTO_TEST_CASE(malformed_success_response_does_not_fall_through_to_backup) {
	FakeTransport transport;
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_OK, "{\"ok\":true,\"assertion\":\"\"}"});
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_OK, "{\"ok\":true,\"assertion\":\"lccoa1.backup.sig\"}"});
	OnlineClient client = client_for(&transport);
	LccOnlineRequest request = online_request();
	char assertion[LCC_API_ONLINE_ASSERTION_SIZE + 1] = {};
	size_t assertion_size = sizeof(assertion);

	const LCC_ONLINE_CALLBACK_STATUS status = online_check(&client, &request, assertion, &assertion_size);

	BOOST_CHECK_EQUAL(status, LCC_ONLINE_CB_MALFORMED_RESPONSE);
	BOOST_CHECK_EQUAL(transport.endpoints_seen.size(), static_cast<size_t>(1));
}

BOOST_AUTO_TEST_CASE(oversized_success_response_does_not_fall_through_to_backup) {
	FakeTransport transport;
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_OK, "{\"assertion\":\"lccoa1.too-large.sig\"}"});
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_OK, "{\"assertion\":\"lccoa1.backup.sig\"}"});
	OnlineClient client = client_for(&transport);
	client.max_response_body = 8;
	LccOnlineRequest request = online_request();
	char assertion[LCC_API_ONLINE_ASSERTION_SIZE + 1] = {};
	size_t assertion_size = sizeof(assertion);

	const LCC_ONLINE_CALLBACK_STATUS status = online_check(&client, &request, assertion, &assertion_size);

	BOOST_CHECK_EQUAL(status, LCC_ONLINE_CB_MALFORMED_RESPONSE);
	BOOST_CHECK_EQUAL(transport.endpoints_seen.size(), static_cast<size_t>(1));
	BOOST_CHECK_EQUAL(std::string(assertion), "");
}

BOOST_AUTO_TEST_CASE(last_transport_status_is_returned_when_all_endpoints_fail) {
	FakeTransport transport;
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE, ""});
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_TIMEOUT, ""});
	OnlineClient client = client_for(&transport);
	LccOnlineRequest request = online_request();
	char assertion[LCC_API_ONLINE_ASSERTION_SIZE + 1] = {};
	size_t assertion_size = sizeof(assertion);

	const LCC_ONLINE_CALLBACK_STATUS status = online_check(&client, &request, assertion, &assertion_size);

	BOOST_CHECK_EQUAL(status, LCC_ONLINE_CB_TIMEOUT);
	BOOST_CHECK_EQUAL(transport.endpoints_seen.size(), static_cast<size_t>(2));
}

BOOST_AUTO_TEST_CASE(assertion_buffer_size_failure_does_not_fall_through_to_backup) {
	FakeTransport transport;
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_OK, "{\"ok\":true,\"assertion\":\"lccoa1.long.sig\"}"});
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_OK, "{\"ok\":true,\"assertion\":\"lccoa1.backup.sig\"}"});
	OnlineClient client = client_for(&transport);
	LccOnlineRequest request = online_request();
	char assertion[4] = {};
	size_t assertion_size = sizeof(assertion);

	const LCC_ONLINE_CALLBACK_STATUS status = online_check(&client, &request, assertion, &assertion_size);

	BOOST_CHECK_EQUAL(status, LCC_ONLINE_CB_BUFFER_TOO_SMALL);
	BOOST_CHECK_EQUAL(transport.endpoints_seen.size(), static_cast<size_t>(1));
	BOOST_CHECK_EQUAL(assertion_size, std::strlen("lccoa1.long.sig") + 1);
}

BOOST_AUTO_TEST_CASE(request_body_includes_client_hardening_only_for_version_two) {
	LccOnlineRequest request = online_request();
	request.client_hardening = LCC_CLIENT_HARDENING_TAMPER_ENFORCE | LCC_CLIENT_HARDENING_ONLINE_REQUIRED;

	request.version = 2;
	const std::string version_two_body = request_body(request);
	BOOST_CHECK(version_two_body.find("\"client_hardening\":") != std::string::npos);

	request.version = 1;
	const std::string version_one_body = request_body(request);
	BOOST_CHECK(version_one_body.find("client_hardening") == std::string::npos);
}

BOOST_AUTO_TEST_CASE(canonical_request_proof_payload_is_byte_exact) {
	LccOnlineRequest request = online_request();
	request.client_hardening = 15;
	OnlineRequestProofFields proof;
	proof.device_key_id = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
	proof.request_timestamp = 1000000;

	const std::string payload = canonical_request_proof_payload(request, proof);

	const std::string expected =
		"purpose=licensecc-online-request\n"
		"version=1\n"
		"alg=ecdsa-p256-sha256\n"
		"project=DEFAULT\n"
		"feature=DEFAULT\n"
		"license-fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
		"device-hash=\n"
		"nonce=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
		"request-timestamp=1000000\n"
		"client-hardening=15\n"
		"device-key-id=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n";
	BOOST_CHECK_EQUAL(payload, expected);
}

BOOST_AUTO_TEST_CASE(body_aware_transport_receives_request_proof_fields) {
	FakeTransport transport;
	transport.responses.push_back(FakeResponse{LCC_ONLINE_CB_OK, "{\"ok\":true,\"assertion\":\"lccoa1.payload.sig\"}"});
	OnlineClient client;
	client.post_verify_body = fake_post_verify_body;
	client.post_verify_user_data = &transport;
	client.request_proof_provider = fixed_request_proof;
	BOOST_REQUIRE(add_endpoint(&client, "https://primary.example/"));
	LccOnlineRequest request = online_request();
	request.client_hardening = 15;
	char assertion[LCC_API_ONLINE_ASSERTION_SIZE + 1] = {};
	size_t assertion_size = sizeof(assertion);

	const LCC_ONLINE_CALLBACK_STATUS status = online_check(&client, &request, assertion, &assertion_size);

	BOOST_CHECK_EQUAL(status, LCC_ONLINE_CB_OK);
	BOOST_REQUIRE_EQUAL(transport.request_bodies_seen.size(), static_cast<size_t>(1));
	const std::string& body = transport.request_bodies_seen[0];
	BOOST_CHECK(body.find("\"request_signature_version\":1") != std::string::npos);
	BOOST_CHECK(body.find("\"device_key_id\":\"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"") !=
				std::string::npos);
	BOOST_CHECK(body.find("\"request_timestamp\":1000000") != std::string::npos);
	BOOST_CHECK(body.find("\"request_signature_algorithm\":\"ecdsa-p256-sha256\"") != std::string::npos);
	BOOST_CHECK(body.find("\"request_signature\":\"MEUCIQDtest-signature==\"") != std::string::npos);
}
