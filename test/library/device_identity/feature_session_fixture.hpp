#ifndef LICENSECC_TEST_FEATURE_SESSION_FIXTURE_HPP_
#define LICENSECC_TEST_FEATURE_SESSION_FIXTURE_HPP_
#include "feature_session.hpp"
#include "bound_session_signer.hpp"
#include "bound_json.hpp"
#include "device_identity_handle.hpp"
#include <map>
#include <optional>

using namespace license::device_identity;
namespace feature_test {
constexpr std::uint64_t second = 10000000, issued = 2000000000;
struct Clock {
	std::uint64_t ticks = 100 * second, sleep = 0, process = 1;
	unsigned operations = 0, samples = 0;
	std::function<void()> before_sample;
};
class Platform final : public BoundAnchorPlatform {
	std::shared_ptr<Clock> clock;

public:
	explicit Platform(std::shared_ptr<Clock> value) : clock(std::move(value)) {}
	bool random_operation(std::array<std::uint8_t, 32>& out) noexcept override {
		out.fill(static_cast<std::uint8_t>(++clock->operations));
		return true;
	}
	bool sample(BoundClockSample& out) noexcept override {
		++clock->samples;
		if (clock->before_sample) clock->before_sample();
		out = {clock->ticks + clock->sleep, clock->ticks, clock->ticks, clock->process};
		return true;
	}
};
struct Memory {
	std::optional<std::string> slots[2];
	bool held = false;
	unsigned writes = 0, reads = 0, fault = 0;
};
class Storage final : public BoundCheckpointStorage {
	std::shared_ptr<Memory> memory;

public:
	explicit Storage(std::shared_ptr<Memory> value) : memory(std::move(value)) {}
	BoundCheckpointIo lock() noexcept override {
		if (memory->held) return BoundCheckpointIo::busy;
		memory->held = true;
		return BoundCheckpointIo::ok;
	}
	void unlock() noexcept override { memory->held = false; }
	BoundCheckpointIo read(unsigned slot, std::string& out) noexcept override {
		++memory->reads;
		if (!memory->slots[slot]) return BoundCheckpointIo::missing;
		out = *memory->slots[slot];
		return BoundCheckpointIo::ok;
	}
	BoundCheckpointIo confirm(unsigned slot, const std::string& value) noexcept override {
		return memory->slots[slot] && *memory->slots[slot] == value ? BoundCheckpointIo::ok : BoundCheckpointIo::error;
	}
	BoundCheckpointIo publish(unsigned slot, const std::string& value) noexcept override {
		++memory->writes;
		if ((memory->fault == 1 && memory->writes == 1) || (memory->fault == 3 && memory->writes == 2))
			return BoundCheckpointIo::error;
		memory->slots[slot] = value;
		return memory->fault == 2 && memory->writes == 1 ? BoundCheckpointIo::error : BoundCheckpointIo::ok;
	}
};
struct ProviderState {
	LCC_DEVICE_RESULT forced = LCC_DEVICE_OK;
	unsigned signs = 0, fail_at = 0;
	std::function<void()> after_sign;
};
class Provider final : public DeviceKeyProvider {
	std::unique_ptr<DeviceKeyProvider> inner;
	ProviderState& state;

public:
	Provider(std::unique_ptr<DeviceKeyProvider> value, ProviderState& control)
		: inner(std::move(value)), state(control) {}
	LCC_DEVICE_RESULT open(const ProviderOpenRequest& value) noexcept override { return inner->open(value); }
	LCC_DEVICE_RESULT create(const ProviderOpenRequest& value) noexcept override { return inner->create(value); }
	LCC_DEVICE_RESULT sign_digest(const P256Digest& digest, P256Signature& out) noexcept override {
		++state.signs;
		if (state.signs == state.fail_at) return LCC_DEVICE_BUSY;
		if (state.forced != LCC_DEVICE_OK) return state.forced;
		const auto result = inner->sign_digest(digest, out);
		if (state.after_sign) state.after_sign();
		return result;
	}
	LCC_DEVICE_RESULT public_spki(P256Spki& out) noexcept override { return inner->public_spki(out); }
	LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept override { return inner->metadata(out); }
	LCC_DEVICE_RESULT delete_with_expected_id(const ProviderOpenRequest&, const std::string&) noexcept override {
		BOOST_ERROR("feature sessions must never delete a key");
		return LCC_DEVICE_INTERNAL_ERROR;
	}
};
using Call = std::function<BoundHttpStatus(BoundWireOperation, std::string_view, BoundHttpResponse&)>;
class Transport final : public BoundHttpTransport {
	Call& call;
	unsigned& requests;
	std::vector<std::string>& operations;

public:
	Transport(Call& value, unsigned& count, std::vector<std::string>& ids)
		: call(value), requests(count), operations(ids) {}
	BoundHttpStatus post(BoundWireOperation op, std::string_view body, BoundHttpResponse& out) noexcept override {
		try {
			++requests;
			BOOST_REQUIRE(op == BoundWireOperation::renew || op == BoundWireOperation::renew_challenge);
			bound_json::Value parsed;
			BOOST_REQUIRE(bound_json::parse(std::string(body), parsed));
			if (op == BoundWireOperation::renew_challenge) operations.push_back(parsed.fields.at("operation_id").text);
			return call(op, body, out);
		} catch (...) {
			return BoundHttpStatus::internal_error;
		}
	}
};
struct Closer {
	void operator()(LccFeatureSession* value) const { lcc_feature_session_close(value); }
};
using Owner = std::unique_ptr<LccFeatureSession, Closer>;
struct Fixture {
	SessionTestSigner signer;
	LccDeviceBoundOptions options;
	LccFeatureSessionOutcome detail;
	BoundPublicHooks hooks;
	std::shared_ptr<Clock> clock = std::make_shared<Clock>();
	ProviderState provider;
	std::map<std::string, std::shared_ptr<Memory>> stores;
	std::map<std::string, std::string> binding_features, tokens;
	std::vector<std::string> operations, opened_keys;
	Call call;
	std::string key, replay;
	std::function<void(BoundSessionContext&)> mutate_claims;
	unsigned requests = 0, identity_calls = 0, create_calls = 0, browser_calls = 0, challenges = 0;
	std::uint64_t revision = 1, duration = 900;
	bool capture_failure = false;
	Fixture() {
		lcc_init_device_bound_options(&options);
		lcc_init_feature_session_outcome(&detail);
		static unsigned namespaces = 0;
		const auto application = "licensecc.test.feature-session." + std::to_string(++namespaces);
		std::strcpy(options.application_id, application.c_str());
		std::strcpy(options.endpoint_origin, "https://backend.test");
		std::strcpy(options.portal_authorization_url, "https://portal.test/authorize");
		std::strcpy(options.issuer, "https://issuer.test/");
		std::strcpy(options.lease_audience, "CAD-client");
		std::strcpy(options.proof_audience, "proof-audience");
		std::strcpy(options.project, "CAD");
		std::strcpy(options.feature, "BATCH_RUN");
		std::strcpy(options.client_id, "CAD-client");
		std::strcpy(options.device_label, "Synthetic session test");
		options.trust_key_count = 1;
		options.trust_keys[0].spki_size = static_cast<uint32_t>(signer.spki.size());
		std::memcpy(options.trust_keys[0].spki, signer.spki.data(), signer.spki.size());
		LccDeviceIdentityOptions identity;
		lcc_init_device_identity_options(&identity);
		identity.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
		identity.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
		identity.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
		std::strcpy(identity.application_id, options.application_id);
		std::strcpy(identity.project, options.project);
		LccDeviceIdentity* raw = nullptr;
		BOOST_REQUIRE_EQUAL(lcc_device_identity_open(&identity, &raw), LCC_DEVICE_OK);
		key = raw->device_key_id;
		lcc_device_identity_close(raw);
		hooks.identity = [this](const LccDeviceIdentityOptions& in, BoundIdentityOwner& owner) {
			++identity_calls;
			if (in.flags & LCC_DEVICE_OPEN_CREATE_IF_MISSING) ++create_calls;
			auto native = in;
			native.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
			native.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
			LccDeviceIdentity* raw = nullptr;
			const auto result = lcc_device_identity_open(&native, &raw);
			owner.reset(raw);
			if (raw) {
				opened_keys.push_back(raw->device_key_id);
				raw->provider = std::make_unique<Provider>(std::move(raw->provider), provider);
			}
			return result;
		};
		hooks.storage = [this](const BoundCheckpointNamespace& space) {
			std::string name;
			BOOST_REQUIRE(bound_checkpoint_namespace(space, name));
			auto& value = stores[name];
			if (!value) value = std::make_shared<Memory>();
			return std::make_unique<Storage>(value);
		};
		hooks.clock = [this] { return std::make_unique<Platform>(clock); };
		hooks.transport = [this](const std::string&) {
			return std::make_unique<Transport>(call, requests, operations);
		};
		hooks.browser = [this](const std::string&) -> std::unique_ptr<BoundBrowserLauncher> {
			++browser_calls;
			BOOST_ERROR("feature sessions must not create a browser");
			return nullptr;
		};
		hooks.capture_allowed = [this] { return !capture_failure; };
		hooks.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
		call = [this](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
			return respond(op, body, out);
		};
		seed("BATCH_RUN");
		seed("EXPORT");
	}
	BoundSessionContext context(const std::string& feature) {
		const auto binding = bound_encoding::base64url(std::string(16, feature == "EXPORT" ? 'E' : 'B'));
		binding_features[binding] = feature;
		BoundSessionContext value;
		value.lease = {
			"https://issuer.test/", "CAD-client", "CAD", feature, std::string(64, 'a'), binding, key, "", 1, 0};
		return value;
	}
	std::shared_ptr<Memory> memory(const std::string& feature = "BATCH_RUN") {
		auto config = options;
		std::strcpy(config.feature, feature.c_str());
		BoundPublicConfig validated;
		BOOST_REQUIRE_EQUAL(validate_bound_public_options(&config, validated), LCC_BOUND_OK);
		std::string name;
		BOOST_REQUIRE(bound_checkpoint_namespace(validated.storage, name));
		auto& out = stores[name];
		if (!out) out = std::make_shared<Memory>();
		return out;
	}
	void seed(const std::string& feature) {
		auto store = memory(feature);
		const auto token = signer.lease(context(feature), std::string(43, 'A'), 1, 2);
		store->slots[0] = token;
		store->slots[1] = token;
	}
	Owner open(const char* feature = "BATCH_RUN") {
		auto config = options;
		std::strcpy(config.feature, feature);
		LccFeatureSession* raw = nullptr;
		BOOST_REQUIRE_EQUAL(open_feature_session(&config, &raw, &detail, hooks), LCC_BOUND_OK);
		return Owner(raw);
	}
	BoundHttpStatus respond(BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		if (op == BoundWireOperation::renew_challenge) {
			const auto id = bound_encoding::base64url(std::string(16, static_cast<char>(++challenges)));
			const auto nonce = bound_encoding::base64url(std::string(32, static_cast<char>(challenges)));
			out = {
				200,
				"{\"ok\":true,\"code\":\"challenge_created\",\"request_id\":\"trace\",\"data\":{\"challenge_id\":\"" +
					id + "\",\"nonce\":\"" + nonce + "\",\"expires_at\":2000000060}}"};
			return BoundHttpStatus::complete;
		}
		bound_json::Value request;
		BOOST_REQUIRE(bound_json::parse(std::string(body), request));
		const auto operation = request.fields.at("operation_id").text;
		auto& token = tokens[operation];
		if (token.empty()) {
			auto expected = context(binding_features.at(request.fields.at("binding_id").text));
			if (mutate_claims) mutate_claims(expected);
			token = signer.lease(expected, operation, ++revision, duration);
		}
		return lease_response(replay.empty() ? token : replay, out);
	}
	static BoundHttpStatus lease_response(const std::string& token, BoundHttpResponse& out) {
		ParsedBoundLease parsed;
		BOOST_REQUIRE(decode_bound_lease(token, parsed));
		const auto& c = parsed.claims;
		out = {200, "{\"ok\":true,\"code\":\"device_renewed\",\"request_id\":\"trace\",\"data\":{\"device_id\":\"" +
						std::string(22, 'A') + "\",\"binding_id\":\"" + c.binding_id + "\",\"generation\":" +
						std::to_string(c.generation) + ",\"entitlement\":{\"project\":\"" + c.project +
						"\",\"feature\":\"" + c.feature + "\",\"license_fingerprint\":\"" + c.license_fingerprint +
						"\"},\"lease\":\"" + token + "\",\"renew_after\":" + std::to_string(c.renew_after) +
						",\"expires_at\":" + std::to_string(c.expires_at) +
						",\"accept_until\":" + std::to_string(c.expires_at + 120) + "}}"};
		return BoundHttpStatus::complete;
	}
	static BoundHttpStatus error(unsigned status, const std::string& code, BoundHttpResponse& out) {
		out = {status, "{\"ok\":false,\"code\":\"" + code + "\",\"request_id\":\"trace\"}"};
		return BoundHttpStatus::complete;
	}
};
inline void no_time(const LccFeatureSessionOutcome& value) {
	BOOST_CHECK_EQUAL(value.effective_time, 0);
	BOOST_CHECK_EQUAL(value.renew_after, 0);
	BOOST_CHECK_EQUAL(value.expires_at, 0);
}
}  // namespace feature_test
#endif
