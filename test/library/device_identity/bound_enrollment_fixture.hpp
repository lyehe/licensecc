#ifndef LICENSECC_BOUND_ENROLLMENT_FIXTURE_HPP_
#define LICENSECC_BOUND_ENROLLMENT_FIXTURE_HPP_
#include <boost/test/unit_test.hpp>
#include "bound_enrollment.hpp"
#include "bound_encoding.hpp"
#include "bound_json.hpp"
#include "bound_session_signer.hpp"
#include "device_identity_handle.hpp"
#include <cstring>
#include <future>

using namespace license::device_identity;
namespace {
constexpr std::uint64_t second = 10000000;
const std::string redirect = "http://127.0.0.1:49152/callback";
const std::string portal = "https://portal.test/authorize";
struct Clock {
	std::uint64_t ticks = 1000000000, sleep = 0;
	unsigned draws = 0, fail_draw = 0;
};
class Platform final : public BoundAnchorPlatform {
	std::shared_ptr<Clock> clock_;

public:
	explicit Platform(std::shared_ptr<Clock> clock) : clock_(std::move(clock)) {}
	bool random_operation(std::array<std::uint8_t, 32>& out) noexcept override {
		++clock_->draws;
		if (clock_->draws == clock_->fail_draw) return false;
		out.fill(static_cast<std::uint8_t>(clock_->draws));
		return true;
	}
	bool sample(BoundClockSample& out) noexcept override {
		out = {clock_->ticks + clock_->sleep, clock_->ticks, clock_->ticks, 1};
		return true;
	}
};
using Call = std::function<BoundHttpStatus(BoundWireOperation, std::string_view, BoundHttpResponse&)>;
class BusyProvider final : public DeviceKeyProvider {
	std::unique_ptr<DeviceKeyProvider> inner_;
	bool& busy_;

public:
	BusyProvider(std::unique_ptr<DeviceKeyProvider> inner, bool& busy) : inner_(std::move(inner)), busy_(busy) {}
	LCC_DEVICE_RESULT open(const ProviderOpenRequest& request) noexcept override { return inner_->open(request); }
	LCC_DEVICE_RESULT create(const ProviderOpenRequest& request) noexcept override { return inner_->create(request); }
	LCC_DEVICE_RESULT sign_digest(const P256Digest& in, P256Signature& out) noexcept override {
		return busy_ ? LCC_DEVICE_BUSY : inner_->sign_digest(in, out);
	}
	LCC_DEVICE_RESULT public_spki(P256Spki& out) noexcept override { return inner_->public_spki(out); }
	LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept override { return inner_->metadata(out); }
	LCC_DEVICE_RESULT delete_with_expected_id(const ProviderOpenRequest& in, const std::string& key) noexcept override {
		return inner_->delete_with_expected_id(in, key);
	}
};
class Transport final : public BoundHttpTransport {
	Call& call_;

public:
	explicit Transport(Call& call) : call_(call) {}
	BoundHttpStatus post(BoundWireOperation op, std::string_view body, BoundHttpResponse& out) noexcept override {
		try {
			return call_(op, body, out);
		} catch (...) {
			return BoundHttpStatus::internal_error;
		}
	}
};
struct Fixture {
	SessionTestSigner signer;
	std::shared_ptr<Clock> clock = std::make_shared<Clock>();
	Call call;
	std::unique_ptr<BoundEnrollmentFlow> flow;
	bound_json::Value registration;
	std::string key, response_url = portal, comparison_override;
	unsigned registrations = 0, challenges = 0;
	bool complete_exchange = false, lose_clock = false;
	bool fail_possession = false, provider_busy = false;
	std::vector<std::string> operation_ids;
	Fixture() {
		LccDeviceIdentityOptions options;
		lcc_init_device_identity_options(&options);
		options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
		options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
		options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
		std::strcpy(options.application_id, "licensecc.test.bound-enrollment");
		std::strcpy(options.project, "CAD");
		LccDeviceIdentity* raw = nullptr;
		BOOST_REQUIRE_EQUAL(lcc_device_identity_open(&options, &raw), LCC_DEVICE_OK);
		BoundIdentityOwner identity(raw);
		key = raw->device_key_id;
		raw->provider = std::make_unique<BusyProvider>(std::move(raw->provider), provider_busy);
		call = [this](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
			bound_json::Value request;
			BOOST_REQUIRE(bound_json::parse(std::string(body), request));
			if (op != BoundWireOperation::authorize) {
				++challenges;
				operation_ids.push_back(request.fields.at("operation_id").text);
				if (!complete_exchange) return BoundHttpStatus::unavailable;
				if (op == BoundWireOperation::enrollment_challenge) {
					out = {200,
						   "{\"ok\":true,\"code\":\"challenge_created\",\"request_id\":\"trace\",\"data\":{\"challenge_"
						   "id\":\"" +
							   std::string(22, 'A') + "\",\"nonce\":\"" + std::string(43, 'A') +
							   "\",\"expires_at\":2000000060}}"};
					return BoundHttpStatus::complete;
				}
				const auto verifier = request.fields.at("code_verifier").text;
				P256Digest digest;
				BOOST_REQUIRE(sha256(reinterpret_cast<const std::uint8_t*>(verifier.data()), verifier.size(), digest));
				BOOST_CHECK_EQUAL(bound_encoding::base64url(digest.data(), digest.size()),
								  registration.fields.at("code_challenge").text);
				BoundSessionContext context;
				context.lease = {"https://issuer.test/", "CAD-client", "CAD", "DEFAULT", std::string(64, 'a'),
								 std::string(22, 'A'),	 key,		   "",	  1,		 0};
				const auto token = signer.lease(context, operation_ids.back(), 1, 86400);
				out = {
					200,
					"{\"ok\":true,\"code\":\"device_activated\",\"request_id\":\"trace\",\"data\":{\"device_id\":\"" +
						std::string(22, 'A') + "\",\"binding_id\":\"" + std::string(22, 'A') +
						"\",\"generation\":1,\"entitlement\":{\"project\":\"CAD\",\"feature\":\"DEFAULT\",\"license_"
						"fingerprint\":\"" +
						std::string(64, 'a') + "\"},\"lease\":\"" + token +
						"\",\"renew_after\":2000043200,\"expires_at\":2000086400,\"accept_until\":2000086520}}"};
				if (lose_clock) clock->sleep += second;
				provider_busy = fail_possession;
				return BoundHttpStatus::complete;
			}
			++registrations;
			registration = request;
			const auto field = [&request](const char* name) { return request.fields.at(name).text; };
			std::string comparison;
			const std::string handle(43, 'A');
			BOOST_REQUIRE(
				enrollment_comparison_code_v1({handle, field("client_id"), field("project"), field("redirect_uri"),
											   field("state"), field("code_challenge")},
											  key, comparison));
			if (!comparison_override.empty()) comparison = comparison_override;
			out = {200,
				   "{\"ok\":true,\"code\":\"authorization_created\",\"request_id\":\"trace\",\"data\":{\"attempt_"
				   "handle\":\"" +
					   handle + "\",\"authorization_url\":\"" + response_url + "#attempt_handle=" + handle +
					   "\",\"comparison_code\":\"" + comparison + "\",\"expires_at\":2000000300}}"};
			return BoundHttpStatus::complete;
		};
		BoundEnrollmentOptions configuration{{"https://issuer.test/", "CAD-client", "proof-audience", "CAD", "DEFAULT",
											  LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT},
											 "https://backend.test",
											 portal,
											 "CAD-client",
											 "Workstation"};
		flow = BoundEnrollmentFlow::create(
			std::move(identity), configuration, {{signer.spki, false}},
			[clock = clock] { return std::make_unique<Platform>(clock); },
			[this](const std::string&) { return std::make_unique<Transport>(call); });
		BOOST_REQUIRE(flow);
	}
	std::string callback(const std::string& code = std::string(43, 'A')) {
		return redirect + "?code=" + code + "&state=" + registration.fields.at("state").text;
	}
	void begin() {
		BoundEnrollmentView view;
		BOOST_REQUIRE(flow->begin(redirect, view).status == BoundEnrollmentStatus::ready);
		BOOST_CHECK_EQUAL(view.authorization_url, portal + "#attempt_handle=" + std::string(43, 'A'));
	}
	void receive() {
		BOOST_REQUIRE(flow->receive_callback(callback()).status == BoundEnrollmentStatus::callback_received);
	}
};
}  // namespace

#endif
