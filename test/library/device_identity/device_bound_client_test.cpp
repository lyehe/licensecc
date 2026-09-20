#define BOOST_TEST_MODULE device_bound_client_test
#include <boost/test/unit_test.hpp>
#include "bound_client.hpp"
#include "bound_json.hpp"
#include "bound_session_signer.hpp"
#include "device_identity_handle.hpp"
#include <cstring>
#include <future>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winhttp.h>
#endif

using namespace license::device_identity;
namespace {
struct Clock {
	std::uint64_t ticks = 1000000000, sleep = 0;
	unsigned operations = 0;
};
class Platform final : public BoundAnchorPlatform {
	std::shared_ptr<Clock> clock_;

public:
	explicit Platform(std::shared_ptr<Clock> clock) : clock_(std::move(clock)) {}
	bool random_operation(std::array<std::uint8_t, 32>& out) noexcept override {
		out.fill(static_cast<std::uint8_t>(++clock_->operations));
		return true;
	}
	bool sample(BoundClockSample& out) noexcept override {
		out = {clock_->ticks + clock_->sleep, clock_->ticks, clock_->ticks, 1};
		return true;
	}
};
class Transport final : public BoundHttpTransport {
public:
	std::function<BoundHttpStatus(BoundWireOperation, const std::string&, BoundHttpResponse&)> call;
	BoundHttpStatus post(BoundWireOperation op, std::string_view body, BoundHttpResponse& out) noexcept override {
		try {
			return call(op, std::string(body), out);
		} catch (...) {
			return BoundHttpStatus::internal_error;
		}
	}
};
class BusyProvider final : public DeviceKeyProvider {
	std::unique_ptr<DeviceKeyProvider> inner_;
	bool& busy_;

public:
	BusyProvider(std::unique_ptr<DeviceKeyProvider> inner, bool& busy) : inner_(std::move(inner)), busy_(busy) {}
	LCC_DEVICE_RESULT sign_digest(const P256Digest& in, P256Signature& out) noexcept override {
		return busy_ ? LCC_DEVICE_BUSY : inner_->sign_digest(in, out);
	}
	LCC_DEVICE_RESULT open(const ProviderOpenRequest& in) noexcept override { return inner_->open(in); }
	LCC_DEVICE_RESULT create(const ProviderOpenRequest& in) noexcept override { return inner_->create(in); }
	LCC_DEVICE_RESULT public_spki(P256Spki& out) noexcept override { return inner_->public_spki(out); }
	LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept override { return inner_->metadata(out); }
	LCC_DEVICE_RESULT delete_with_expected_id(const ProviderOpenRequest& in, const std::string& key) noexcept override {
		return inner_->delete_with_expected_id(in, key);
	}
};
struct Fixture {
	SessionTestSigner signer;
	std::shared_ptr<Clock> clock = std::make_shared<Clock>();
	BoundSessionContext context;
	std::unique_ptr<BoundRenewalClient> client;
	Transport* transport = nullptr;
	std::vector<std::string> operations, challenges;
	std::uint64_t duration = 86400, delay = 0, revision = 1;
	bool corrupt = false, provider_busy = false;
	Fixture(bool enrollment = false) { reset(enrollment); }
	void reset(bool enrollment = false, const std::string* checkpoint = nullptr) {
		LccDeviceIdentityOptions options;
		lcc_init_device_identity_options(&options);
		options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
		options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
		options.flags = checkpoint ? 0 : LCC_DEVICE_OPEN_CREATE_IF_MISSING;
		std::strcpy(options.application_id, "licensecc.test.bound-client");
		std::strcpy(options.project, "CAD");
		LccDeviceIdentity* raw = nullptr;
		BOOST_REQUIRE_EQUAL(lcc_device_identity_open(&options, &raw), LCC_DEVICE_OK);
		BoundIdentityOwner identity(raw);
		raw->provider = std::make_unique<BusyProvider>(std::move(raw->provider), provider_busy);
		context.lease = {"https://issuer.test/", "CAD-client",		 "CAD", "DEFAULT", std::string(64, 'a'),
						 std::string(22, 'A'),	 raw->device_key_id, "",	1,		   0};
		context.proof_audience = "proof-audience";
		context.provider_policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
		const auto clock_factory = [clock = clock] { return std::make_unique<Platform>(clock); };
		const auto http_factory = [this](const std::string& origin) {
			BOOST_CHECK_EQUAL(origin, "https://backend.test");
			auto http = std::make_unique<Transport>();
			transport = http.get();
			return http;
		};
		if (checkpoint)
			client = BoundRenewalClient::create_for_resume(
				std::move(identity),
				{context.lease.issuer, context.lease.audience, context.proof_audience, context.lease.project,
				 context.lease.feature, context.provider_policy},
				{{signer.spki, false}}, "https://backend.test", *checkpoint, clock_factory, http_factory);
		else if (enrollment)
			client = BoundRenewalClient::create_for_enrollment(
				std::move(identity),
				{context.lease.issuer, context.lease.audience, context.proof_audience, context.lease.project,
				 context.lease.feature, context.provider_policy},
				{{signer.spki, false}}, "https://backend.test", clock_factory, http_factory);
		else
			client = BoundRenewalClient::create(std::move(identity), context, {{signer.spki, false}},
												"https://backend.test", clock_factory, http_factory);
		BOOST_REQUIRE(client);
		normal();
	}
	void normal() {
		transport->call = [this](BoundWireOperation operation, const std::string& body, BoundHttpResponse& out) {
			bound_json::Value request;
			BOOST_REQUIRE(bound_json::parse(body, request));
			const auto id = request.fields.at("operation_id").text;
			if (operation == BoundWireOperation::renew_challenge ||
				operation == BoundWireOperation::enrollment_challenge) {
				challenges.push_back(id);
				out = {200,
					   "{\"ok\":true,\"code\":\"challenge_created\",\"request_id\":\"trace\",\"data\":{\"challenge_"
					   "id\":\"" +
						   std::string(22, 'A') + "\",\"nonce\":\"" + std::string(43, 'A') +
						   "\",\"expires_at\":2000000060}}"};
			} else {
				operations.push_back(id);
				if (operation == BoundWireOperation::renew)
					BOOST_CHECK_EQUAL(request.fields.at("binding_id").text, context.lease.binding_id);
				BOOST_CHECK_EQUAL(request.fields.at("proof").fields.at("key_id").text, context.lease.device_key_id);
				auto token = signer.lease(context, id, revision, duration);
				if (corrupt) token.back() = token.back() == 'A' ? 'B' : 'A';
				const auto code = operation == BoundWireOperation::exchange ? "device_activated" : "device_renewed";
				out = {200, std::string("{\"ok\":true,\"code\":\"") + code +
								"\",\"request_id\":\"recovered-trace\",\"data\":{\"device_id\":\"" +
								std::string(22, 'A') + "\",\"binding_id\":\"" + context.lease.binding_id +
								"\",\"generation\":1,\"entitlement\":{\"project\":\"CAD\",\"feature\":\"DEFAULT\","
								"\"license_fingerprint\":\"" +
								context.lease.license_fingerprint + "\"},\"lease\":\"" + token +
								"\",\"renew_after\":" + std::to_string(2000000000 + duration / 2) +
								",\"expires_at\":" + std::to_string(2000000000 + duration) +
								",\"accept_until\":" + std::to_string(2000000120 + duration) + "}}"};
				clock->ticks += delay;
			}
			return BoundHttpStatus::complete;
		};
	}
	void error(BoundHttpStatus status, unsigned http_status, const std::string& code) {
		transport->call = [status, http_status, code](BoundWireOperation, const std::string&, BoundHttpResponse& out) {
			// Deliberately poison output even on failed authentication/transport:
			// the owner must ignore it unless complete was returned.
			out = {http_status, "{\"ok\":false,\"code\":\"" + code + "\",\"request_id\":\"trace\"}"};
			return status;
		};
	}
};
void expect(BoundRenewResult result, BoundRenewStatus wanted) {
	BOOST_CHECK_EQUAL(static_cast<int>(result.status), static_cast<int>(wanted));
}
void authority(Fixture& f, BoundSessionStatus wanted) {
	BOOST_CHECK_EQUAL(static_cast<int>(f.client->authorize_operation().status), static_cast<int>(wanted));
}
}  // namespace
BOOST_AUTO_TEST_CASE(resume_client_is_offline_denied_until_a_fresh_online_renewal) {
	Fixture f;
	f.revision = 7;
	expect(f.client->renew(), BoundRenewStatus::accepted);
	std::string checkpoint;
	BOOST_REQUIRE(f.client->export_resume_statement(checkpoint));
	const auto old_operation = f.operations.back();
	const auto requests = f.operations.size();
	f.reset(false, &checkpoint);
	BOOST_CHECK_EQUAL(f.operations.size(), requests);
	authority(f, BoundSessionStatus::online_required);
	f.error(BoundHttpStatus::unavailable, 0, "unavailable");
	expect(f.client->renew(), BoundRenewStatus::retry);
	authority(f, BoundSessionStatus::online_required);
	std::string exported;
	BOOST_REQUIRE(f.client->export_resume_statement(exported));
	BOOST_CHECK_EQUAL(exported, checkpoint);
	f.normal();
	expect(f.client->renew(), BoundRenewStatus::accepted);
	authority(f, BoundSessionStatus::ok);
	BOOST_CHECK(f.operations.back() != old_operation);
	BOOST_REQUIRE(f.client->export_resume_statement(exported));
	BOOST_CHECK(exported != checkpoint);
}

BOOST_AUTO_TEST_CASE(initial_approval_exchange_recovers_lost_response_then_renews_same_binding) {
	Fixture f(true);
	BoundExchangeSecret draft;
	draft.value = {std::string(43, 'A'), std::string(43, 'A'), std::string(43, 'A'), "http://127.0.0.1:45678/callback",
				   ""};
	authority(f, BoundSessionStatus::online_required);
	const auto normal = f.transport->call;
	f.transport->call = [normal](BoundWireOperation op, const std::string& body, BoundHttpResponse& out) {
		const auto status = normal(op, body, out);
		return op == BoundWireOperation::exchange ? BoundHttpStatus::unavailable : status;
	};
	expect(f.client->activate(draft.value), BoundRenewStatus::retry);
	authority(f, BoundSessionStatus::online_required);
	f.normal();
	expect(f.client->activate(draft.value), BoundRenewStatus::accepted);
	authority(f, BoundSessionStatus::ok);
	BOOST_REQUIRE_EQUAL(f.operations.size(), 2U);
	BOOST_CHECK_EQUAL(f.operations[0], f.operations[1]);
	expect(f.client->renew(), BoundRenewStatus::accepted);
	BOOST_CHECK(f.operations[2] != f.operations[1]);
}
BOOST_AUTO_TEST_CASE(unavailable_authorization_requests_enrollment_without_granting_authority) {
	Fixture f(true);
	BoundExchangeSecret draft;
	draft.value = {std::string(43, 'A'), std::string(43, 'A'), std::string(43, 'A'), "http://[::1]:45678/callback", ""};
	f.error(BoundHttpStatus::complete, 404, "authorization_unavailable");
	expect(f.client->activate(draft.value), BoundRenewStatus::enrollment_required);
	authority(f, BoundSessionStatus::online_required);
	f.normal();
	expect(f.client->activate(draft.value), BoundRenewStatus::accepted);
}
BOOST_AUTO_TEST_CASE(exchange_recovery_binding_unavailable_is_an_authoritative_denial) {
	Fixture f(true);
	BoundExchangeSecret draft;
	draft.value = {std::string(43, 'A'), std::string(43, 'A'), std::string(43, 'A'), "http://127.0.0.1:45678/callback",
				   ""};
	const auto normal = f.transport->call;
	f.transport->call = [normal](BoundWireOperation op, const std::string& body, BoundHttpResponse& out) {
		if (op == BoundWireOperation::enrollment_challenge) return normal(op, body, out);
		out = {404, "{\"ok\":false,\"code\":\"binding_unavailable\",\"request_id\":\"trace\"}"};
		return BoundHttpStatus::complete;
	};
	expect(f.client->activate(draft.value), BoundRenewStatus::denied);
	authority(f, BoundSessionStatus::denied);
	f.normal();
	expect(f.client->activate(draft.value), BoundRenewStatus::denied);
}
BOOST_AUTO_TEST_CASE(expired_authorization_after_verified_bootstrap_directs_fresh_renewal_with_retained_floor) {
	Fixture f(true);
	BoundExchangeSecret draft;
	draft.value = {std::string(43, 'A'), std::string(43, 'A'), std::string(43, 'A'), "http://127.0.0.1:45678/callback",
				   ""};
	f.revision = 7;
	const auto normal = f.transport->call;
	f.transport->call = [&f, normal](BoundWireOperation op, const std::string& body, BoundHttpResponse& out) {
		const auto status = normal(op, body, out);
		if (op == BoundWireOperation::exchange) f.provider_busy = true;
		return status;
	};
	expect(f.client->activate(draft.value), BoundRenewStatus::session_error);
	authority(f, BoundSessionStatus::online_required);
	f.error(BoundHttpStatus::complete, 404, "authorization_unavailable");
	expect(f.client->activate(draft.value), BoundRenewStatus::renewal_required);
	authority(f, BoundSessionStatus::online_required);
	f.provider_busy = false;
	f.normal();
	f.revision = 6;
	expect(f.client->renew(), BoundRenewStatus::session_error);
	authority(f, BoundSessionStatus::online_required);
	f.revision = 7;
	expect(f.client->renew(), BoundRenewStatus::accepted);
	authority(f, BoundSessionStatus::ok);
}

BOOST_AUTO_TEST_CASE(origin_is_fixed_canonical_https_and_failures_preserve_output) {
	for (const auto& value : {"http://server.test",
							  "https://SERVER.test",
							  "https://server.test/",
							  "https://server.test:443",
							  "https://user@server.test",
							  "https://server.test?x",
							  "https://server.test#x",
							  "https://server.test\\x",
							  "https://server.test:0",
							  "https://server.test:0444",
							  "https://server.test:65536",
							  "https://[::1]",
							  "https://-server.test",
							  "https://server-.test",
							  "https://server..test",
							  "https://server.test.",
							  "https://127.1",
							  "https://2130706433",
							  "https://0x7f000001",
							  "https://127.0.0.1",
							  "https://server.123"}) {
		BoundHttpOrigin out{"sentinel", 42};
		BOOST_CHECK(!parse_bound_http_origin(value, out));
		BOOST_CHECK_EQUAL(out.host, "sentinel");
		BOOST_CHECK_EQUAL(out.port, 42);
		BOOST_CHECK(!make_bound_http_transport(value));
	}
	BoundHttpOrigin out;
	BOOST_REQUIRE(parse_bound_http_origin("https://backend.test:8443", out));
	BOOST_CHECK_EQUAL(out.host, "backend.test");
	BOOST_CHECK_EQUAL(out.port, 8443);
	BOOST_REQUIRE(parse_bound_http_origin("https://backend.test", out));
	BOOST_CHECK_EQUAL(out.port, 443);
#ifdef _WIN32
	auto transport = make_bound_http_transport("https://backend.test");
	BOOST_REQUIRE(transport);
	BoundHttpResponse response{42, "sentinel"};
	BOOST_CHECK(transport->post(static_cast<BoundWireOperation>(99), "{}", response) ==
				BoundHttpStatus::internal_error);
	BOOST_CHECK_EQUAL(response.body, "sentinel");
	BOOST_CHECK_EQUAL(response.status, 42);
#else
	BOOST_CHECK(!make_bound_http_transport("https://backend.test"));
#endif
}
BOOST_AUTO_TEST_CASE(renewal_connects_real_native_signing_and_signed_acceptance) {
	Fixture f;
	authority(f, BoundSessionStatus::online_required);
	expect(f.client->renew(), BoundRenewStatus::accepted);
	authority(f, BoundSessionStatus::ok);
	BOOST_REQUIRE_EQUAL(f.operations.size(), 1U);
	BOOST_CHECK_EQUAL(f.operations[0], f.challenges[0]);
	f.duration = 10;
	expect(f.client->renew(), BoundRenewStatus::accepted);
	BOOST_CHECK(f.operations[0] != f.operations[1]);
	f.clock->ticks += 100000000;
	authority(f, BoundSessionStatus::invalid_response);
}
#ifdef _WIN32
BOOST_AUTO_TEST_CASE(host_winhttp_accepts_the_required_security_profile_without_network_io) {
	struct Close {
		void operator()(void* value) const {
			if (value) WinHttpCloseHandle(value);
		}
	};
	std::unique_ptr<void, Close> session(WinHttpOpen(L"Licensecc-test", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
													 WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
	BOOST_REQUIRE(session);
	for (const auto item :
		 {std::pair<DWORD, DWORD>{WINHTTP_OPTION_SECURE_PROTOCOLS,
								  WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3},
		  {WINHTTP_OPTION_DISABLE_GLOBAL_POOLING, TRUE},
		  {WINHTTP_OPTION_DISABLE_SECURE_PROTOCOL_FALLBACK, TRUE}}) {
		auto value = item.second;
		const auto accepted = WinHttpSetOption(session.get(), item.first, &value, sizeof(value));
		const auto error = accepted ? ERROR_SUCCESS : GetLastError();
		BOOST_CHECK_MESSAGE(accepted, "WinHTTP session option " << item.first << " rejected with error " << error);
	}
	std::unique_ptr<void, Close> connection(WinHttpConnect(session.get(), L"localhost", 443, 0));
	BOOST_REQUIRE(connection);
	std::unique_ptr<void, Close> request(WinHttpOpenRequest(connection.get(), L"POST", L"/", nullptr,
															WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
															WINHTTP_FLAG_SECURE));
	BOOST_REQUIRE(request);
	for (const auto item : {std::pair<DWORD, DWORD>{WINHTTP_OPTION_ENABLE_FEATURE, WINHTTP_ENABLE_SSL_REVOCATION},
							{WINHTTP_OPTION_DISABLE_FEATURE,
							 WINHTTP_DISABLE_AUTHENTICATION | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_REDIRECTS},
							{WINHTTP_OPTION_AUTOLOGON_POLICY, WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH},
							{WINHTTP_OPTION_MAX_RESPONSE_HEADER_SIZE, 16384}}) {
		auto value = item.second;
		const auto accepted = WinHttpSetOption(request.get(), item.first, &value, sizeof(value));
		const auto error = accepted ? ERROR_SUCCESS : GetLastError();
		BOOST_CHECK_MESSAGE(accepted, "WinHTTP request option " << item.first << " rejected with error " << error);
	}
}
#endif
BOOST_AUTO_TEST_CASE(transport_failure_cannot_turn_poisoned_response_into_denial) {
	Fixture f;
	expect(f.client->renew(), BoundRenewStatus::accepted);
	for (auto status :
		 {BoundHttpStatus::unavailable, BoundHttpStatus::invalid_response, BoundHttpStatus::internal_error}) {
		f.error(status, 404, "binding_unavailable");
		BOOST_CHECK(f.client->renew().status != BoundRenewStatus::denied);
		authority(f, BoundSessionStatus::ok);
	}
	f.error(BoundHttpStatus::complete, 403, "unknown_code");
	expect(f.client->renew(), BoundRenewStatus::invalid_response);
	authority(f, BoundSessionStatus::ok);
	f.error(BoundHttpStatus::complete, 404, "binding_unavailable");
	expect(f.client->renew(), BoundRenewStatus::denied);
	authority(f, BoundSessionStatus::denied);
	f.error(BoundHttpStatus::unavailable, 404, "binding_unavailable");
	expect(f.client->renew(), BoundRenewStatus::retry);
	authority(f, BoundSessionStatus::denied);
	f.normal();
	expect(f.client->renew(), BoundRenewStatus::accepted);
	authority(f, BoundSessionStatus::ok);
}
BOOST_AUTO_TEST_CASE(lost_response_reuses_original_operation_and_elapsed_time) {
	Fixture f;
	f.duration = 10;
	const auto normal = f.transport->call;
	f.transport->call = [normal](BoundWireOperation op, const std::string& body, BoundHttpResponse& out) {
		const auto status = normal(op, body, out);
		return op == BoundWireOperation::renew ? BoundHttpStatus::unavailable : status;
	};
	expect(f.client->renew(), BoundRenewStatus::retry);
	f.clock->ticks += 100000000;
	f.normal();
	expect(f.client->renew(), BoundRenewStatus::session_error);
	authority(f, BoundSessionStatus::online_required);
	BOOST_REQUIRE_EQUAL(f.operations.size(), 2U);
	BOOST_CHECK_EQUAL(f.operations[0], f.operations[1]);
	f.client->abandon_renewal();
	expect(f.client->renew(), BoundRenewStatus::accepted);
	BOOST_CHECK(f.operations[1] != f.operations[2]);
}
BOOST_AUTO_TEST_CASE(conflict_does_not_restart_immutable_intent_and_bad_signature_grants_nothing) {
	Fixture f;
	auto normal = f.transport->call;
	f.transport->call = [normal](BoundWireOperation op, const std::string& body, BoundHttpResponse& out) {
		if (op == BoundWireOperation::renew_challenge) return normal(op, body, out);
		out = {409, "{\"ok\":false,\"code\":\"idempotency_conflict\",\"request_id\":\"trace\"}"};
		return BoundHttpStatus::complete;
	};
	expect(f.client->renew(), BoundRenewStatus::conflict);
	expect(f.client->renew(), BoundRenewStatus::conflict);
	BOOST_REQUIRE_EQUAL(f.challenges.size(), 2U);
	BOOST_CHECK_EQUAL(f.challenges[0], f.challenges[1]);
	f.normal();
	f.corrupt = true;
	BOOST_CHECK(f.client->renew().status != BoundRenewStatus::accepted);
	authority(f, BoundSessionStatus::online_required);
	f.corrupt = false;
	expect(f.client->renew(), BoundRenewStatus::accepted);
}
BOOST_AUTO_TEST_CASE(expired_recovery_requires_explicit_new_renewal_and_rejects_abandoned_response) {
	Fixture f;
	const auto normal = f.transport->call;
	BoundHttpResponse delayed;
	f.transport->call = [normal, &delayed](BoundWireOperation op, const std::string& body, BoundHttpResponse& out) {
		const auto status = normal(op, body, out);
		if (op == BoundWireOperation::renew) {
			delayed = out;
			return BoundHttpStatus::unavailable;
		}
		return status;
	};
	expect(f.client->renew(), BoundRenewStatus::retry);
	const auto original = f.operations.back();
	f.clock->ticks += 48ULL * 3600 * 10000000;
	f.transport->call = [normal](BoundWireOperation op, const std::string& body, BoundHttpResponse& out) {
		if (op == BoundWireOperation::renew_challenge) return normal(op, body, out);
		out = {409, "{\"ok\":false,\"code\":\"idempotency_conflict\",\"request_id\":\"expired\"}"};
		return BoundHttpStatus::complete;
	};
	expect(f.client->renew(), BoundRenewStatus::conflict);
	expect(f.client->renew(), BoundRenewStatus::conflict);
	BOOST_CHECK_EQUAL(f.challenges.back(), original);
	authority(f, BoundSessionStatus::online_required);
	BOOST_CHECK(f.client->abandon_renewal().status == BoundSessionStatus::online_required);
	f.transport->call = [normal, delayed](BoundWireOperation op, const std::string& body, BoundHttpResponse& out) {
		if (op == BoundWireOperation::renew_challenge) return normal(op, body, out);
		out = delayed;
		return BoundHttpStatus::complete;
	};
	BOOST_CHECK(f.client->renew().status != BoundRenewStatus::accepted);
	BOOST_CHECK(f.challenges.back() != original);
	const auto replacement = f.challenges.back();
	authority(f, BoundSessionStatus::online_required);
	f.normal();
	expect(f.client->renew(), BoundRenewStatus::accepted);
	BOOST_CHECK_EQUAL(f.operations.back(), replacement);
	authority(f, BoundSessionStatus::ok);
}
BOOST_AUTO_TEST_CASE(network_is_single_flight_but_does_not_block_protected_operations) {
	Fixture f;
	expect(f.client->renew(), BoundRenewStatus::accepted);
	std::promise<void> started, release;
	auto ready = release.get_future().share();
	const auto normal = f.transport->call;
	f.transport->call = [&started, ready, normal](BoundWireOperation op, const std::string& body,
												  BoundHttpResponse& out) {
		if (op == BoundWireOperation::renew_challenge) {
			started.set_value();
			ready.wait();
		}
		return normal(op, body, out);
	};
	auto task = std::async(std::launch::async, [&f] { return f.client->renew(); });
	started.get_future().wait();
	expect(f.client->renew(), BoundRenewStatus::busy);
	authority(f, BoundSessionStatus::ok);
	BOOST_CHECK_EQUAL(f.client->abandon_renewal().provider_result, LCC_DEVICE_BUSY);
	release.set_value();
	expect(task.get(), BoundRenewStatus::accepted);
}
