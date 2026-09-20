#define BOOST_TEST_MODULE device_bound_public_windows_test
#include "bound_loopback_fixture.hpp"
#include "bound_enrollment_fixture.hpp"
#include "bound_public.hpp"
#include <optional>

namespace {
struct Memory {
	std::optional<std::string> slots[2];
	bool held = false;
	unsigned reads = 0, writes = 0, fault = 0;
};
class Storage final : public BoundCheckpointStorage {
	std::shared_ptr<Memory> m;

public:
	explicit Storage(std::shared_ptr<Memory> value) : m(std::move(value)) {}
	BoundCheckpointIo lock() noexcept override {
		if (m->held) return BoundCheckpointIo::busy;
		m->held = true;
		return BoundCheckpointIo::ok;
	}
	void unlock() noexcept override { m->held = false; }
	BoundCheckpointIo read(unsigned slot, std::string& out) noexcept override {
		++m->reads;
		if (!m->slots[slot]) return BoundCheckpointIo::missing;
		out = *m->slots[slot];
		return BoundCheckpointIo::ok;
	}
	BoundCheckpointIo confirm(unsigned slot, const std::string& out) noexcept override {
		return m->slots[slot] && *m->slots[slot] == out ? BoundCheckpointIo::ok : BoundCheckpointIo::error;
	}
	BoundCheckpointIo publish(unsigned slot, const std::string& token) noexcept override {
		++m->writes;
		if ((m->fault == 1 && m->writes == 1) || (m->fault == 3 && m->writes == 2)) return BoundCheckpointIo::error;
		m->slots[slot] = token;
		return m->fault == 2 && m->writes == 1 ? BoundCheckpointIo::error : BoundCheckpointIo::ok;
	}
};
class Browser final : public BoundBrowserLauncher {
public:
	BoundBrowserStatus open(const std::string&) noexcept override { return BoundBrowserStatus::opened; }
};
class AfterSignProvider final : public DeviceKeyProvider {
	std::unique_ptr<DeviceKeyProvider> inner;
	std::function<void()>& after;

public:
	AfterSignProvider(std::unique_ptr<DeviceKeyProvider> provider, std::function<void()>& hook)
		: inner(std::move(provider)), after(hook) {}
	LCC_DEVICE_RESULT open(const ProviderOpenRequest& in) noexcept override { return inner->open(in); }
	LCC_DEVICE_RESULT create(const ProviderOpenRequest& in) noexcept override { return inner->create(in); }
	LCC_DEVICE_RESULT sign_digest(const P256Digest& in, P256Signature& out) noexcept override {
		const auto result = inner->sign_digest(in, out);
		if (after) after();
		return result;
	}
	LCC_DEVICE_RESULT public_spki(P256Spki& out) noexcept override { return inner->public_spki(out); }
	LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept override { return inner->metadata(out); }
	LCC_DEVICE_RESULT delete_with_expected_id(const ProviderOpenRequest& in, const std::string& key) noexcept override {
		return inner->delete_with_expected_id(in, key);
	}
};
struct Public : Fixture {
	std::shared_ptr<Memory> memory = std::make_shared<Memory>();
	BoundPublicHooks hooks;
	LccDeviceBoundOptions options;
	LccDeviceBoundOutcome detail;
	LccDeviceBoundClient* owner = nullptr;
	unsigned identity_calls = 0, create_calls = 0, requests = 0;
	bool capture_failure = false;
	std::function<void()> after_sign;
	std::uint64_t revision = 1;
	Public() {
		flow.reset();
		lcc_init_device_bound_options(&options);
		lcc_init_device_bound_outcome(&detail);
		std::strcpy(options.application_id, "licensecc.test.bound-enrollment");
		std::strcpy(options.endpoint_origin, "https://backend.test");
		std::strcpy(options.portal_authorization_url, portal.c_str());
		std::strcpy(options.issuer, "https://issuer.test/");
		std::strcpy(options.lease_audience, "CAD-client");
		std::strcpy(options.proof_audience, "proof-audience");
		std::strcpy(options.project, "CAD");
		std::strcpy(options.feature, "DEFAULT");
		std::strcpy(options.client_id, "CAD-client");
		std::strcpy(options.device_label, "Workstation");
		options.trust_key_count = 1;
		options.trust_keys[0].spki_size = static_cast<uint32_t>(signer.spki.size());
		std::memcpy(options.trust_keys[0].spki, signer.spki.data(), signer.spki.size());
		hooks.identity = [this](const LccDeviceIdentityOptions& input, BoundIdentityOwner& owner) {
			++identity_calls;
			if (input.flags & LCC_DEVICE_OPEN_CREATE_IF_MISSING) ++create_calls;
			auto o = input;
			o.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
			o.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
			LccDeviceIdentity* raw = nullptr;
			const auto result = lcc_device_identity_open(&o, &raw);
			owner.reset(raw);
			if (raw)
				raw->provider = std::make_unique<AfterSignProvider>(
					std::make_unique<BusyProvider>(std::move(raw->provider), provider_busy), after_sign);
			return result;
		};
		hooks.storage = [this](const BoundCheckpointNamespace&) { return std::make_unique<Storage>(memory); };
		hooks.clock = [this] { return std::make_unique<Platform>(clock); };
		hooks.transport = [this](const std::string&) { return std::make_unique<Transport>(call); };
		hooks.browser = [](const std::string&) { return std::make_unique<Browser>(); };
		hooks.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
		hooks.capture_allowed = [this] { return !capture_failure; };
		auto normal = call;
		call = [this, normal](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
			++requests;
			if (op != BoundWireOperation::renew && op != BoundWireOperation::renew_challenge)
				return normal(op, body, out);
			if (op == BoundWireOperation::renew_challenge) {
				out = {200,
					   "{\"ok\":true,\"code\":\"challenge_created\",\"request_id\":\"trace\",\"data\":{\"challenge_"
					   "id\":\"" +
						   std::string(22, 'A') + "\",\"nonce\":\"" + std::string(43, 'A') +
						   "\",\"expires_at\":2000000060}}"};
				return BoundHttpStatus::complete;
			}
			bound_json::Value request;
			BOOST_REQUIRE(bound_json::parse(std::string(body), request));
			BoundSessionContext c;
			c.lease = {"https://issuer.test/", "CAD-client", "CAD", "DEFAULT", std::string(64, 'a'),
					   std::string(22, 'A'),   key,			 "",	1,		   0};
			const auto token = signer.lease(c, request.fields.at("operation_id").text, revision, 86400);
			out = {200, "{\"ok\":true,\"code\":\"device_renewed\",\"request_id\":\"trace\",\"data\":{\"device_id\":\"" +
							std::string(22, 'A') + "\",\"binding_id\":\"" + std::string(22, 'A') +
							"\",\"generation\":1,\"entitlement\":{\"project\":\"CAD\",\"feature\":\"DEFAULT\","
							"\"license_fingerprint\":\"" +
							std::string(64, 'a') + "\"},\"lease\":\"" + token +
							"\",\"renew_after\":2000043200,\"expires_at\":2000086400,\"accept_until\":2000086520}}"};
			return BoundHttpStatus::complete;
		};
	}
	~Public() { lcc_device_bound_close(owner); }
	void open(bool resume = false) {
		BOOST_REQUIRE_EQUAL(open_bound_public(&options, &owner, &detail, resume, hooks), LCC_BOUND_OK);
	}
	void prepare() {
		LccDeviceBoundView view;
		lcc_init_device_bound_view(&view);
		BOOST_REQUIRE_EQUAL(lcc_device_bound_prepare(owner, &view), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(std::strlen(view.comparison_code), 14);
	}
	void receive() {
		const auto uri = registration.fields.at("redirect_uri").text;
		LocalSocket socket(AF_INET);
		connect_local(socket, uri, false);
		const auto wire = callback_request(uri, registration.fields.at("state").text);
		BOOST_REQUIRE_EQUAL(send(socket.value, wire.data(), static_cast<int>(wire.size()), 0),
							static_cast<int>(wire.size()));
		const auto start = GetTickCount64();
		LCC_BOUND_RESULT result = LCC_BOUND_WAITING;
		while (result == LCC_BOUND_WAITING && GetTickCount64() - start < 2000)
			result = lcc_device_bound_poll(owner, 10);
		BOOST_REQUIRE_EQUAL(result, LCC_BOUND_CALLBACK_RECEIVED);
	}
	void activate() {
		open();
		prepare();
		receive();
		complete_exchange = true;
		BOOST_REQUIRE_EQUAL(lcc_device_bound_activate(owner, &detail), LCC_BOUND_OK);
	}
};
}  // namespace
BOOST_AUTO_TEST_CASE(existing_committed_state_blocks_key_creation_in_both_slots) {
	for (unsigned slot : {0u, 1u})
		for (const std::string value : {std::string(), std::string("corrupt")}) {
			Public f;
			f.memory->slots[slot] = value;
			BOOST_CHECK_EQUAL(open_bound_public(&f.options, &f.owner, &f.detail, false, f.hooks),
							  LCC_BOUND_RESUME_REQUIRED);
			BOOST_CHECK_EQUAL(f.identity_calls, 0);
			BOOST_CHECK_EQUAL(f.requests, 0);
			BOOST_CHECK(!f.owner);
		}
}
BOOST_AUTO_TEST_CASE(public_owner_transitions_to_renewal_and_restart_requires_online_operation) {
	Public f;
	f.activate();
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_SAVED);
	BOOST_CHECK_EQUAL(f.detail.effective_time, 0);
	BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_OK);
	const auto writes = f.memory->writes, requests = f.requests;
	BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.memory->writes, writes);
	BOOST_CHECK_EQUAL(f.requests, requests);
	lcc_device_bound_close(f.owner);
	f.owner = nullptr;
	const auto creates = f.create_calls;
	f.open(true);
	BOOST_CHECK_EQUAL(f.create_calls, creates);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_LOADED);
	BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_ONLINE_REQUIRED);
	f.revision = 2;
	BOOST_REQUIRE_EQUAL(lcc_device_bound_renew(f.owner, &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_OK);
}
BOOST_AUTO_TEST_CASE(failed_capture_never_reports_old_checkpoint_saved_and_cancel_retains_newer_recovery) {
	Public f;
	f.activate();
	const auto old = *f.memory->slots[0];
	f.capture_failure = true;
	f.revision = 2;
	BOOST_REQUIRE_EQUAL(lcc_device_bound_renew(f.owner, &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_IO_ERROR);
	BOOST_CHECK_EQUAL(*f.memory->slots[0], old);
	BOOST_CHECK_EQUAL(lcc_device_bound_cancel(f.owner), LCC_BOUND_INTERNAL_ERROR);
	BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_CANCELLED);
	const auto requests = f.requests;
	f.capture_failure = false;
	BOOST_CHECK_EQUAL(lcc_device_bound_save_checkpoint(f.owner, &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.requests, requests);
	BOOST_CHECK(*f.memory->slots[0] != old);
	ParsedBoundLease parsed;
	BOOST_REQUIRE(decode_bound_lease(*f.memory->slots[0], parsed));
	BOOST_CHECK_EQUAL(parsed.claims.revocation_seq, 2);
	BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_CANCELLED);
}
BOOST_AUTO_TEST_CASE(primary_and_storage_failures_are_independent_and_storage_retry_has_no_http) {
	for (unsigned fault : {1u, 2u, 3u}) {
		Public f;
		f.open();
		f.prepare();
		f.receive();
		f.complete_exchange = true;
		f.memory->fault = fault;
		BOOST_REQUIRE_EQUAL(lcc_device_bound_activate(f.owner, &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(f.detail.checkpoint_result, fault == 1   ? LCC_BOUND_CHECKPOINT_IO_ERROR
													  : fault == 2 ? LCC_BOUND_CHECKPOINT_COMMIT_UNKNOWN
																   : LCC_BOUND_CHECKPOINT_MIRROR_PENDING);
		const auto requests = f.requests;
		f.memory->fault = 0;
		BOOST_CHECK_EQUAL(lcc_device_bound_save_checkpoint(f.owner, &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(f.requests, requests);
	}
}
BOOST_AUTO_TEST_CASE(verified_bootstrap_provider_failure_is_saved_then_abandoned_to_online_renewal) {
	Public f;
	f.open();
	f.prepare();
	f.receive();
	f.complete_exchange = true;
	f.fail_possession = true;
	BOOST_CHECK_EQUAL(lcc_device_bound_activate(f.owner, &f.detail), LCC_BOUND_PROVIDER_ERROR);
	BOOST_CHECK_EQUAL(f.detail.provider_result, LCC_DEVICE_BUSY);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_SAVED);
	BOOST_CHECK_EQUAL(lcc_device_bound_abandon_pending(f.owner, &f.detail), LCC_BOUND_ONLINE_REQUIRED);
	f.provider_busy = false;
	f.fail_possession = false;
	f.revision = 2;
	BOOST_REQUIRE_EQUAL(lcc_device_bound_renew(f.owner, &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_OK);
}
BOOST_AUTO_TEST_CASE(invalid_outputs_and_outer_busy_do_not_mutate_or_perform_io) {
	Public f;
	f.open();
	const auto reads = f.memory->reads;
	BOOST_CHECK_EQUAL(lcc_device_bound_prepare(f.owner, nullptr), LCC_BOUND_INVALID_ARGUMENT);
	f.detail.version = 2;
	BOOST_CHECK_EQUAL(lcc_device_bound_activate(f.owner, &f.detail), LCC_BOUND_UNSUPPORTED_VERSION);
	BOOST_CHECK_EQUAL(f.requests, 0);
	BOOST_CHECK_EQUAL(f.memory->reads, reads);
	lcc_init_device_bound_outcome(&f.detail);
	auto normal = f.call;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		const auto writes = f.memory->writes;
		f.detail.provider_result = 42;
		BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_BUSY);
		BOOST_CHECK_EQUAL(f.detail.provider_result, 42);
		BOOST_CHECK_EQUAL(lcc_device_bound_cancel(f.owner), LCC_BOUND_BUSY);
		BOOST_CHECK_EQUAL(f.memory->writes, writes);
		return normal(op, body, out);
	};
	f.prepare();
	BOOST_CHECK_EQUAL(f.registrations, 1);
}
BOOST_AUTO_TEST_CASE(options_are_copied_and_extended_output_tails_are_preserved) {
	Public f;
	f.open();
	std::strcpy(f.options.endpoint_origin, "http://invalid.test");
	f.options.trust_keys[0].spki[0] ^= 1;
	struct Extended {
		LccDeviceBoundView view;
		uint64_t tail = 0x12345678;
	} out;
	lcc_init_device_bound_view(&out.view);
	out.view.size = sizeof(out);
	BOOST_CHECK_EQUAL(lcc_device_bound_prepare(f.owner, &out.view), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(out.tail, 0x12345678);
	BOOST_CHECK_EQUAL(out.view.size, sizeof(out));
	f.receive();
	f.complete_exchange = true;
	BOOST_CHECK_EQUAL(lcc_device_bound_activate(f.owner, &f.detail), LCC_BOUND_OK);
}
BOOST_AUTO_TEST_CASE(resume_missing_or_lost_key_never_requests_creation) {
	for (auto key_error : {LCC_DEVICE_KEY_NOT_FOUND, LCC_DEVICE_KEY_LOST}) {
		Public f;
		unsigned calls = 0;
		f.hooks.identity = [&](const LccDeviceIdentityOptions& o, BoundIdentityOwner&) {
			++calls;
			BOOST_CHECK_EQUAL(o.flags, 0);
			return key_error;
		};
		BOOST_CHECK_EQUAL(open_bound_public(&f.options, &f.owner, &f.detail, true, f.hooks), LCC_BOUND_PROVIDER_ERROR);
		BOOST_CHECK_EQUAL(f.detail.provider_result, key_error);
		BOOST_CHECK_EQUAL(calls, 1);
		BOOST_CHECK_EQUAL(f.requests, 0);
		BOOST_CHECK(!f.owner);
	}
}
BOOST_AUTO_TEST_CASE(verified_final_clock_failure_and_later_denial_preserve_checkpoint) {
	{
		Public f;
		f.open();
		f.prepare();
		f.receive();
		f.complete_exchange = true;
		bool armed = false;
		auto normal = f.call;
		f.after_sign = [&] {
			if (armed) {
				f.clock->sleep += second;
				armed = false;
			}
		};
		f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
			const auto result = normal(op, body, out);
			if (op == BoundWireOperation::exchange) armed = true;
			return result;
		};
		BOOST_CHECK_EQUAL(lcc_device_bound_activate(f.owner, &f.detail), LCC_BOUND_ONLINE_REQUIRED);
		BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_SAVED);
		BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_ONLINE_REQUIRED);
	}
	{
		Public f;
		f.activate();
		const auto token = *f.memory->slots[0];
		auto normal = f.call;
		f.call = [normal](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
			if (op != BoundWireOperation::renew) return normal(op, body, out);
			out = {404, "{\"ok\":false,\"code\":\"binding_unavailable\",\"request_id\":\"trace\"}"};
			return BoundHttpStatus::complete;
		};
		BOOST_CHECK_EQUAL(lcc_device_bound_renew(f.owner, &f.detail), LCC_BOUND_DENIED);
		BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_UNCHANGED);
		BOOST_CHECK_EQUAL(*f.memory->slots[0], token);
		BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_DENIED);
	}
}
BOOST_AUTO_TEST_CASE(enrollment_rechecks_storage_before_the_first_network_request) {
	Public f;
	f.open();
	f.memory->slots[1] = "corrupt";
	LccDeviceBoundView view;
	lcc_init_device_bound_view(&view);
	BOOST_CHECK_EQUAL(lcc_device_bound_prepare(f.owner, &view), LCC_BOUND_STORAGE_ERROR);
	BOOST_CHECK_EQUAL(f.requests, 0);
}

BOOST_AUTO_TEST_CASE(project_only_consent_wrong_feature_preserves_pending_intent_without_checkpoint_or_remote_cleanup) {
	Public f;
	std::strcpy(f.options.feature, "BATCH_RUN");
	const auto normal = f.call;
	std::string committed_operation, committed_token;
	unsigned committed_bindings = 0, exchanges = 0;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		if (op != BoundWireOperation::exchange) return normal(op, body, out);
		++f.requests;
		++exchanges;
		bound_json::Value request;
		BOOST_REQUIRE(bound_json::parse(std::string(body), request));
		const auto operation = request.fields.at("operation_id").text;
		if (committed_operation.empty()) {
			committed_operation = operation;
			++committed_bindings;
			BoundSessionContext selected;
			selected.lease = {"https://issuer.test/", "CAD-client", "CAD", "EXPORT", std::string(64, 'a'),
							  std::string(22, 'A'),	  f.key,		"",	   1,		 0};
			committed_token = f.signer.lease(selected, operation, 1, 900);
		} else
			BOOST_CHECK_EQUAL(operation, committed_operation);
		out = {200, "{\"ok\":true,\"code\":\"device_activated\",\"request_id\":\"trace\",\"data\":{\"device_id\":\"" +
						std::string(22, 'A') + "\",\"binding_id\":\"" + std::string(22, 'A') +
						"\",\"generation\":1,\"entitlement\":{\"project\":\"CAD\",\"feature\":\"EXPORT\",\"license_"
						"fingerprint\":\"" +
						std::string(64, 'a') + "\"},\"lease\":\"" + committed_token +
						"\",\"renew_after\":2000000450,\"expires_at\":2000000900,\"accept_until\":2000001020}}"};
		return BoundHttpStatus::complete;
	};
	f.open();
	f.prepare();
	BOOST_CHECK_EQUAL(f.registration.fields.at("project").text, "CAD");
	BOOST_CHECK_EQUAL(f.registration.fields.count("feature"), 0);
	f.receive();
	f.complete_exchange = true;
	BOOST_CHECK_EQUAL(lcc_device_bound_activate(f.owner, &f.detail), LCC_BOUND_INVALID_RESPONSE);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED);
	BOOST_CHECK_EQUAL(lcc_device_bound_authorize(f.owner, &f.detail), LCC_BOUND_ENROLLMENT_REQUIRED);
	BOOST_CHECK(!f.memory->slots[0]);
	BOOST_CHECK(!f.memory->slots[1]);
	BOOST_CHECK_EQUAL(f.memory->writes, 0);
	BOOST_CHECK_EQUAL(committed_bindings, 1);
	const auto token = committed_token;
	// A failed native acceptance does not prove rollback of portal-approved
	// issuance. Preserve its pending intent for exact recovery, even beyond
	// the original browser-admission deadline, and never auto-retire it.
	f.clock->ticks += 301 * second;
	BOOST_CHECK_EQUAL(lcc_device_bound_activate(f.owner, &f.detail), LCC_BOUND_INVALID_RESPONSE);
	BOOST_CHECK_EQUAL(exchanges, 2);
	BOOST_CHECK_EQUAL(committed_bindings, 1);
	BOOST_CHECK_EQUAL(committed_token, token);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED);
	BOOST_CHECK(!f.memory->slots[0]);
	BOOST_CHECK(!f.memory->slots[1]);
	BOOST_CHECK_EQUAL(f.memory->writes, 0);
	const auto requests = f.requests, creates = f.create_calls;
	BOOST_CHECK_EQUAL(lcc_device_bound_abandon_pending(f.owner, &f.detail), LCC_BOUND_ENROLLMENT_REQUIRED);
	BOOST_CHECK_EQUAL(lcc_device_bound_cancel(f.owner), LCC_BOUND_CANCELLED);
	BOOST_CHECK_EQUAL(f.requests, requests);
	BOOST_CHECK_EQUAL(committed_bindings, 1);
	LccDeviceBoundClient* resumed = nullptr;
	BOOST_CHECK_EQUAL(open_bound_public(&f.options, &resumed, &f.detail, true, f.hooks), LCC_BOUND_ENROLLMENT_REQUIRED);
	BOOST_CHECK(!resumed);
	BOOST_CHECK_EQUAL(f.create_calls, creates);
	BOOST_CHECK(!f.memory->slots[0]);
	BOOST_CHECK(!f.memory->slots[1]);
	BOOST_CHECK_EQUAL(f.memory->writes, 0);
}
