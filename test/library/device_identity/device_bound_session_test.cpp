#define BOOST_TEST_MODULE device_bound_session_test
#include <boost/test/unit_test.hpp>
#include <cstring>
#include <future>
#include "bound_session_signer.hpp"
#include "device_identity_handle.hpp"

using namespace license::device_identity;
namespace {
constexpr std::uint64_t second = 10000000;
void expect(BoundSessionDecision result, BoundSessionStatus wanted) {
	BOOST_CHECK_EQUAL(static_cast<int>(result.status), static_cast<int>(wanted));
}
struct Clock {
	std::uint64_t ticks = 100 * second, sleep = 0;
	unsigned operations = 0;
};
class TestPlatform final : public BoundAnchorPlatform {
	std::shared_ptr<Clock> clock_;

public:
	explicit TestPlatform(std::shared_ptr<Clock> clock) : clock_(std::move(clock)) {}
	bool random_operation(std::array<std::uint8_t, 32>& out) noexcept override {
		out.fill(static_cast<std::uint8_t>(++clock_->operations));
		return true;
	}
	bool sample(BoundClockSample& out) noexcept override {
		out = {clock_->ticks + clock_->sleep, clock_->ticks, clock_->ticks, 1};
		return true;
	}
};
class HookProvider final : public DeviceKeyProvider {
	std::unique_ptr<DeviceKeyProvider> inner_;

public:
	std::function<void()> on_sign;
	LCC_DEVICE_RESULT forced = LCC_DEVICE_OK;
	explicit HookProvider(std::unique_ptr<DeviceKeyProvider> inner) : inner_(std::move(inner)) {}
	LCC_DEVICE_RESULT sign_digest(const P256Digest& digest, P256Signature& out) noexcept override {
		if (on_sign) on_sign();
		return forced == LCC_DEVICE_OK ? inner_->sign_digest(digest, out) : forced;
	}
	LCC_DEVICE_RESULT open(const ProviderOpenRequest&) noexcept override { return LCC_DEVICE_INTERNAL_ERROR; }
	LCC_DEVICE_RESULT create(const ProviderOpenRequest&) noexcept override { return LCC_DEVICE_INTERNAL_ERROR; }
	LCC_DEVICE_RESULT public_spki(P256Spki& out) noexcept override { return inner_->public_spki(out); }
	LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept override { return inner_->metadata(out); }
	LCC_DEVICE_RESULT delete_with_expected_id(const ProviderOpenRequest&, const std::string&) noexcept override {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
};
struct Fixture {
	SessionTestSigner signer;
	std::shared_ptr<Clock> clock = std::make_shared<Clock>();
	HookProvider* provider = nullptr;
	BoundSessionContext context;
	std::unique_ptr<BoundRenewalSession> session;
	Fixture(bool enrollment = false) { recreate({}, enrollment); }
	void recreate(const std::function<void(BoundSessionContext&, std::vector<BoundLeaseTrustKey>&)>& mutate = {},
				  bool enrollment = false, const std::string* checkpoint = nullptr) {
		LccDeviceIdentityOptions options;
		lcc_init_device_identity_options(&options);
		options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
		options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
		options.flags = checkpoint ? 0 : LCC_DEVICE_OPEN_CREATE_IF_MISSING;
		std::strcpy(options.application_id, "licensecc.test.bound-session");
		std::strcpy(options.project, "CAD");
		LccDeviceIdentity* raw = nullptr;
		BOOST_REQUIRE_EQUAL(lcc_device_identity_open(&options, &raw), LCC_DEVICE_OK);
		BoundIdentityOwner identity(raw);
		auto hook = std::make_unique<HookProvider>(std::move(raw->provider));
		provider = hook.get();
		raw->provider = std::move(hook);
		context.lease = {"https://issuer.test", "CAD-client",		"CAD", "DEFAULT", std::string(64, 'a'),
						 std::string(22, 'A'),	raw->device_key_id, "",	   1,		  0};
		context.proof_audience = "https://proof.test";
		context.provider_policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
		auto pinned = context;
		std::vector<BoundLeaseTrustKey> trust{{signer.spki, false}};
		if (mutate) mutate(pinned, trust);
		const auto factory = [clock = clock] { return std::make_unique<TestPlatform>(clock); };
		if (checkpoint)
			session = BoundRenewalSession::create_for_resume(
				std::move(identity),
				{pinned.lease.issuer, pinned.lease.audience, pinned.proof_audience, pinned.lease.project,
				 pinned.lease.feature, pinned.provider_policy},
				trust, *checkpoint, factory);
		else if (enrollment)
			session = BoundRenewalSession::create_for_enrollment(
				std::move(identity),
				{pinned.lease.issuer, pinned.lease.audience, pinned.proof_audience, pinned.lease.project,
				 pinned.lease.feature, pinned.provider_policy},
				trust, factory);
		else
			session = BoundRenewalSession::create(std::move(identity), pinned, trust, factory);
		if (!mutate) BOOST_REQUIRE(session);
	}
	std::string begin() {
		BoundRenewInput input;
		expect(session->begin_renewal(input), BoundSessionStatus::ok);
		BOOST_CHECK_EQUAL(input.binding_id, context.lease.binding_id);
		BOOST_CHECK_EQUAL(input.generation, 1U);
		return input.operation_id;
	}
	std::string accept(std::uint64_t revision = 1, std::uint64_t duration = 86400) {
		const auto operation = begin();
		expect(session->accept_renewal(operation, signer.lease(context, operation, revision, duration)),
			   BoundSessionStatus::ok);
		return operation;
	}
};
}  // namespace

namespace {
BoundExchangeInput enrollment_draft() {
	return {std::string(43, 'A'), std::string(43, 'A'), std::string(43, 'A'), "http://127.0.0.1:45678/callback", ""};
}
std::string begin_enrollment(Fixture& f) {
	BoundExchangeSecret input;
	expect(f.session->begin_enrollment(enrollment_draft(), input.value), BoundSessionStatus::ok);
	return input.value.operation_id;
}
}  // namespace
BOOST_AUTO_TEST_CASE(bootstrap_requires_fixed_context_before_discovering_any_binding) {
	Fixture f(true);
	BoundRenewInput renew;
	expect(f.session->begin_renewal(renew), BoundSessionStatus::online_required);
	const auto operation = begin_enrollment(f);
	const std::vector<std::function<void(BoundSessionContext&)>> mutations{
		[](auto& c) { c.lease.issuer += "/other"; }, [](auto& c) { c.lease.audience += "-other"; },
		[](auto& c) { c.lease.project = "OTHER"; }, [](auto& c) { c.lease.feature = "OTHER"; },
		[](auto& c) { c.lease.device_key_id = "sha256:" + std::string(64, 'b'); }};
	for (const auto& mutate : mutations) {
		auto wrong = f.context;
		mutate(wrong);
		wrong.lease.binding_id[0] = 'B';
		wrong.lease.license_fingerprint = std::string(64, 'b');
		wrong.lease.generation = 2;
		expect(f.session->accept_enrollment(operation, f.signer.lease(wrong, operation, 9)),
			   BoundSessionStatus::invalid_response);
		expect(f.session->authorize_operation(), BoundSessionStatus::online_required);
	}
	auto other = operation;
	other[0] = other[0] == 'A' ? 'B' : 'A';
	expect(f.session->accept_enrollment(operation, f.signer.lease(f.context, other, 9)),
		   BoundSessionStatus::invalid_response);
	auto corrupt = f.signer.lease(f.context, operation, 9);
	corrupt.back() = corrupt.back() == 'A' ? 'B' : 'A';
	expect(f.session->accept_enrollment(operation, corrupt), BoundSessionStatus::invalid_response);
	expect(f.session->accept_renewal(operation, f.signer.lease(f.context, operation)), BoundSessionStatus::no_pending);
	expect(f.session->accept_enrollment(operation, f.signer.lease(f.context, operation)), BoundSessionStatus::ok);
	expect(f.session->authorize_operation(), BoundSessionStatus::ok);
	expect(f.session->begin_renewal(renew), BoundSessionStatus::ok);
	BOOST_CHECK_EQUAL(renew.binding_id, f.context.lease.binding_id);
	BOOST_CHECK_EQUAL(renew.generation, 1U);
	BOOST_CHECK(renew.operation_id != operation);
	BoundExchangeSecret input;
	expect(f.session->begin_enrollment(enrollment_draft(), input.value), BoundSessionStatus::no_pending);
}
BOOST_AUTO_TEST_CASE(bootstrap_retry_rejects_every_changed_draft_field_without_replacing_intent) {
	Fixture f(true);
	const auto operation = begin_enrollment(f);
	for (unsigned field = 0; field < 4; ++field) {
		BoundExchangeSecret draft(enrollment_draft()), out;
		std::string* fields[] = {&draft.value.attempt_handle, &draft.value.code, &draft.value.code_verifier,
								 &draft.value.redirect_uri};
		if (field == 3)
			fields[field]->append("-other");
		else
			(*fields[field])[0] = 'B';
		out.value.operation_id = "sentinel";
		expect(f.session->begin_enrollment(draft.value, out.value), BoundSessionStatus::conflict);
		BOOST_CHECK_EQUAL(out.value.operation_id, "sentinel");
		BOOST_CHECK_EQUAL(begin_enrollment(f), operation);
	}
	BoundSignedProof proof;
	expect(f.session->sign_enrollment({std::string(22, 'A'), std::string(43, 'A'), 2000000060}, proof),
		   BoundSessionStatus::ok);
	BOOST_CHECK_EQUAL(proof.prepared.proof.path, "/v2/device-authorizations/exchange");
	BOOST_CHECK_EQUAL(proof.prepared.proof.operation_id, operation);
	expect(f.session->sign_renewal({std::string(22, 'A'), std::string(43, 'A'), 2000000060}, proof),
		   BoundSessionStatus::no_pending);
}
BOOST_AUTO_TEST_CASE(authenticated_bootstrap_tuple_and_floor_survive_provider_failure) {
	Fixture f(true);
	const auto operation = begin_enrollment(f);
	f.provider->forced = LCC_DEVICE_BUSY;
	expect(f.session->accept_enrollment(operation, f.signer.lease(f.context, operation, 7)),
		   BoundSessionStatus::provider_error);
	f.provider->forced = LCC_DEVICE_OK;
	expect(f.session->accept_enrollment(operation, f.signer.lease(f.context, operation, 6)),
		   BoundSessionStatus::invalid_response);
	for (unsigned field = 0; field < 3; ++field) {
		auto wrong = f.context;
		if (field == 0) wrong.lease.binding_id[0] = 'B';
		if (field == 1) wrong.lease.license_fingerprint = std::string(64, 'b');
		if (field == 2) wrong.lease.generation = 2;
		expect(f.session->accept_enrollment(operation, f.signer.lease(wrong, operation, 8)),
			   BoundSessionStatus::invalid_response);
	}
	expect(f.session->authorize_operation(), BoundSessionStatus::online_required);
	expect(f.session->abandon_renewal(operation), BoundSessionStatus::online_required);
	const auto fresh = f.begin();
	expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh, 6)), BoundSessionStatus::invalid_response);
	expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh, 7)), BoundSessionStatus::ok);
}
BOOST_AUTO_TEST_CASE(resume_requires_fresh_online_operation_even_with_a_signed_checkpoint) {
	Fixture f;
	const auto old = f.accept(7, 10);
	std::string checkpoint;
	BOOST_REQUIRE(f.session->export_resume_statement(checkpoint));
	f.clock->ticks += 11 * second;
	f.recreate({}, false, &checkpoint);
	expect(f.session->authorize_operation(), BoundSessionStatus::online_required);
	BOOST_CHECK(!f.session->has_pending_enrollment());
	const auto fresh = f.begin();
	BOOST_CHECK(fresh != old);
	expect(f.session->authorize_operation(), BoundSessionStatus::online_required);
	expect(f.session->accept_renewal(old, checkpoint), BoundSessionStatus::no_pending);
	expect(f.session->accept_renewal(fresh, checkpoint), BoundSessionStatus::invalid_response);
	expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh, 6)), BoundSessionStatus::invalid_response);
	expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh, 7)), BoundSessionStatus::ok);
}
BOOST_AUTO_TEST_CASE(checkpoint_retains_verified_candidate_after_provider_and_clock_failure) {
	for (unsigned failure = 0; failure < 3; ++failure) {
		Fixture f(true);
		const auto operation = begin_enrollment(f);
		const auto token = f.signer.lease(f.context, operation, 7, 10);
		if (failure == 0)
			f.provider->forced = LCC_DEVICE_BUSY;
		else
			f.provider->on_sign = [&f, failure] {
				if (failure == 1)
					f.clock->ticks += 10 * second;
				else
					f.clock->sleep += second;
			};
		const auto result = f.session->accept_enrollment(operation, token);
		BOOST_CHECK(result.status != BoundSessionStatus::ok);
		std::string checkpoint;
		BOOST_REQUIRE(f.session->export_resume_statement(checkpoint));
		BOOST_CHECK_EQUAL(checkpoint, token);
		f.provider->on_sign = {};
		f.provider->forced = LCC_DEVICE_OK;
		f.session->abandon_renewal(operation);
		expect(f.session->record_outcome(operation, BoundTransportOutcome::authority_denied),
			   BoundSessionStatus::denied);
		std::string after;
		BOOST_REQUIRE(f.session->export_resume_statement(after));
		BOOST_CHECK_EQUAL(after, token);
		f.recreate({}, false, &checkpoint);
		expect(f.session->authorize_operation(), BoundSessionStatus::online_required);
		const auto fresh = f.begin();
		expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh, 6)),
			   BoundSessionStatus::invalid_response);
	}
}
BOOST_AUTO_TEST_CASE(checkpoint_is_not_replaced_by_old_authorization_or_invalid_response) {
	Fixture f;
	f.accept(1);
	const auto operation = f.begin();
	f.provider->forced = LCC_DEVICE_BUSY;
	const auto newest = f.signer.lease(f.context, operation, 7);
	expect(f.session->accept_renewal(operation, newest), BoundSessionStatus::provider_error);
	f.provider->forced = LCC_DEVICE_OK;
	expect(f.session->authorize_operation(), BoundSessionStatus::invalid_response);
	expect(f.session->accept_renewal(operation, f.signer.lease(f.context, operation, 6)),
		   BoundSessionStatus::invalid_response);
	auto damaged = newest;
	damaged.back() = damaged.back() == 'A' ? 'B' : 'A';
	expect(f.session->accept_renewal(operation, damaged), BoundSessionStatus::invalid_response);
	std::string checkpoint;
	BOOST_REQUIRE(f.session->export_resume_statement(checkpoint));
	BOOST_CHECK_EQUAL(checkpoint, newest);
}
BOOST_AUTO_TEST_CASE(resume_rejects_retired_signer_and_unknown_or_malformed_state) {
	Fixture f;
	std::string checkpoint = "unchanged";
	BOOST_CHECK(!f.session->export_resume_statement(checkpoint));
	BOOST_CHECK_EQUAL(checkpoint, "unchanged");
	f.accept(3);
	BOOST_REQUIRE(f.session->export_resume_statement(checkpoint));
	f.recreate([](auto&, auto& keys) { keys[0].retired = true; }, false, &checkpoint);
	BOOST_CHECK(!f.session);
	f.recreate([](auto& context, auto&) { context.lease.issuer += "/other"; }, false, &checkpoint);
	BOOST_CHECK(!f.session);
	checkpoint.assign(8193, 'x');
	f.recreate([](auto&, auto&) {}, false, &checkpoint);
	BOOST_CHECK(!f.session);
}
BOOST_AUTO_TEST_CASE(equal_revision_new_response_checkpoint_survives_old_lease_authorization) {
	Fixture f;
	f.accept(7);
	const auto operation = f.begin();
	const auto candidate = f.signer.lease(f.context, operation, 7, 10);
	f.provider->forced = LCC_DEVICE_BUSY;
	expect(f.session->accept_renewal(operation, candidate), BoundSessionStatus::provider_error);
	f.provider->forced = LCC_DEVICE_OK;
	expect(f.session->authorize_operation(), BoundSessionStatus::ok);
	std::string checkpoint;
	BOOST_REQUIRE(f.session->export_resume_statement(checkpoint));
	BOOST_CHECK_EQUAL(checkpoint, candidate);
}
BOOST_AUTO_TEST_CASE(copied_checkpoint_cannot_resume_with_another_actual_device_key) {
	Fixture f;
	f.accept();
	std::string checkpoint;
	BOOST_REQUIRE(f.session->export_resume_statement(checkpoint));
	LccDeviceIdentityOptions options;
	lcc_init_device_identity_options(&options);
	options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
	options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
	options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
	std::strcpy(options.application_id, "licensecc.test.bound-session.other-key");
	std::strcpy(options.project, "CAD");
	LccDeviceIdentity* raw = nullptr;
	BOOST_REQUIRE_EQUAL(lcc_device_identity_open(&options, &raw), LCC_DEVICE_OK);
	BoundIdentityOwner other(raw);
	BOOST_REQUIRE(raw->device_key_id != f.context.lease.device_key_id);
	auto resumed = BoundRenewalSession::create_for_resume(
		std::move(other),
		{f.context.lease.issuer, f.context.lease.audience, f.context.proof_audience, "CAD", "DEFAULT",
		 LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT},
		{{f.signer.spki, false}}, checkpoint, [clock = f.clock] { return std::make_unique<TestPlatform>(clock); });
	BOOST_CHECK(!resumed);
}
BOOST_AUTO_TEST_CASE(bootstrap_final_expiry_or_sleep_keeps_pins_and_allows_fresh_online_recovery) {
	for (bool sleep : {false, true}) {
		Fixture f(true);
		const auto operation = begin_enrollment(f);
		f.provider->on_sign = [&f, sleep] {
			if (sleep)
				f.clock->sleep += second;
			else
				f.clock->ticks += 10 * second;
		};
		expect(f.session->accept_enrollment(operation, f.signer.lease(f.context, operation, 7, 10)),
			   sleep ? BoundSessionStatus::online_required : BoundSessionStatus::invalid_response);
		f.provider->on_sign = {};
		if (!sleep) expect(f.session->abandon_renewal(operation), BoundSessionStatus::online_required);
		const auto fresh = f.begin();
		expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh, 6)),
			   BoundSessionStatus::invalid_response);
		expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh, 7)), BoundSessionStatus::ok);
	}
}
BOOST_AUTO_TEST_CASE(enrollment_denial_is_terminal_without_pins_but_verified_binding_can_recover_online) {
	Fixture empty(true);
	const auto empty_operation = begin_enrollment(empty);
	expect(empty.session->record_outcome(empty_operation, BoundTransportOutcome::authority_denied),
		   BoundSessionStatus::denied);
	BoundExchangeSecret input;
	expect(empty.session->begin_enrollment(enrollment_draft(), input.value), BoundSessionStatus::denied);
	Fixture pinned(true);
	const auto operation = begin_enrollment(pinned);
	pinned.provider->forced = LCC_DEVICE_BUSY;
	expect(pinned.session->accept_enrollment(operation, pinned.signer.lease(pinned.context, operation, 7)),
		   BoundSessionStatus::provider_error);
	expect(pinned.session->record_outcome(operation, BoundTransportOutcome::authority_denied),
		   BoundSessionStatus::denied);
	pinned.provider->forced = LCC_DEVICE_OK;
	const auto fresh = pinned.begin();
	expect(pinned.session->authorize_operation(), BoundSessionStatus::denied);
	expect(pinned.session->accept_renewal(fresh, pinned.signer.lease(pinned.context, fresh, 6)),
		   BoundSessionStatus::invalid_response);
	expect(pinned.session->accept_renewal(fresh, pinned.signer.lease(pinned.context, fresh, 7)),
		   BoundSessionStatus::ok);
}

BOOST_AUTO_TEST_CASE(session_starts_online_only_and_pins_renewal_input_and_distinct_audiences) {
	Fixture f;
	expect(f.session->authorize_operation(), BoundSessionStatus::online_required);
	BoundSignedProof proof;
	BoundChallenge challenge{std::string(22, 'A'), std::string(43, 'A'), 2000000060};
	expect(f.session->sign_renewal(challenge, proof), BoundSessionStatus::no_pending);
	const auto operation = f.begin();
	BOOST_CHECK_EQUAL(f.begin(), operation);
	BOOST_CHECK_EQUAL(f.clock->operations, 1U);
	expect(f.session->sign_renewal(challenge, proof), BoundSessionStatus::ok);
	BOOST_CHECK_EQUAL(proof.prepared.proof.audience, f.context.proof_audience);
	BOOST_CHECK_EQUAL(proof.prepared.proof.operation_id, operation);
	BOOST_CHECK_EQUAL(proof.prepared.proof.path, "/v2/device-leases/renew");
	const auto token = f.signer.lease(f.context, operation);
	// Mutating the caller's original configuration cannot alter the copied pins.
	f.context.lease.audience = "changed";
	expect(f.session->accept_renewal(operation, token), BoundSessionStatus::ok);
	expect(f.session->authorize_operation(), BoundSessionStatus::ok);
	expect(f.session->accept_renewal(operation, token), BoundSessionStatus::no_pending);
}

BOOST_AUTO_TEST_CASE(timeouts_and_fresh_challenges_preserve_original_request_time) {
	Fixture f;
	const auto operation = f.begin();
	const auto token = f.signer.lease(f.context, operation);
	f.clock->ticks += 40000 * second;
	expect(f.session->record_outcome(operation, BoundTransportOutcome::transient), BoundSessionStatus::ok);
	BOOST_CHECK_EQUAL(f.begin(), operation);
	expect(f.session->accept_renewal(operation, token), BoundSessionStatus::ok);
	f.clock->ticks += 46399 * second;
	const auto last = f.session->authorize_operation();
	expect(last, BoundSessionStatus::ok);
	BOOST_CHECK_EQUAL(last.effective_time, 2000086399U);
	BOOST_CHECK(last.renewal_due);
	f.clock->ticks += second;
	expect(f.session->authorize_operation(), BoundSessionStatus::invalid_response);
}

BOOST_AUTO_TEST_CASE(authenticated_higher_revision_survives_provider_failure_and_bad_tokens_do_not_advance_it) {
	Fixture f;
	f.accept();
	const auto next = f.begin();
	auto bad = f.signer.lease(f.context, next, 9);
	bad.back() = bad.back() == 'A' ? 'B' : 'A';
	expect(f.session->accept_renewal(next, bad), BoundSessionStatus::invalid_response);
	expect(f.session->authorize_operation(), BoundSessionStatus::ok);
	const auto higher = f.signer.lease(f.context, next, 2);
	f.provider->forced = LCC_DEVICE_BUSY;
	const auto failed = f.session->accept_renewal(next, higher);
	expect(failed, BoundSessionStatus::provider_error);
	BOOST_CHECK_EQUAL(failed.provider_result, LCC_DEVICE_BUSY);
	f.provider->forced = LCC_DEVICE_OK;
	expect(f.session->authorize_operation(), BoundSessionStatus::invalid_response);
	expect(f.session->accept_renewal(next, higher), BoundSessionStatus::ok);
	expect(f.session->authorize_operation(), BoundSessionStatus::ok);
}

BOOST_AUTO_TEST_CASE(shorter_replacement_discards_longer_old_authority_and_old_success) {
	Fixture f;
	const auto first = f.accept();
	const auto old = f.signer.lease(f.context, first);
	const auto second_operation = f.accept(2, 10);
	expect(f.session->accept_renewal(first, old), BoundSessionStatus::no_pending);
	f.clock->ticks += 10 * second;
	expect(f.session->authorize_operation(), BoundSessionStatus::invalid_response);
	expect(f.session->record_outcome(second_operation, BoundTransportOutcome::operation_expired),
		   BoundSessionStatus::online_required);
	expect(f.session->authorize_operation(), BoundSessionStatus::invalid_response);
}

BOOST_AUTO_TEST_CASE(denial_from_superseded_request_stops_newer_authority_until_new_online_acceptance) {
	Fixture f;
	const auto first = f.accept();
	const auto second_operation = f.accept(2);
	const auto pending = f.begin();
	const auto response = f.signer.lease(f.context, pending, 3);
	expect(f.session->record_outcome(first, BoundTransportOutcome::authority_denied), BoundSessionStatus::denied);
	expect(f.session->accept_renewal(pending, response), BoundSessionStatus::no_pending);
	expect(f.session->authorize_operation(), BoundSessionStatus::denied);
	const auto fresh = f.begin();
	BOOST_CHECK(fresh != pending);
	expect(f.session->authorize_operation(), BoundSessionStatus::denied);
	expect(f.session->accept_renewal(second_operation, f.signer.lease(f.context, second_operation, 2)),
		   BoundSessionStatus::no_pending);
	expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh, 3)), BoundSessionStatus::ok);
	expect(f.session->authorize_operation(), BoundSessionStatus::ok);
}

BOOST_AUTO_TEST_CASE(expiry_and_sleep_during_provider_work_reject_the_current_invocation) {
	Fixture f;
	f.accept(1, 10);
	f.provider->on_sign = [&] { f.clock->ticks += 10 * second; };
	expect(f.session->authorize_operation(), BoundSessionStatus::invalid_response);
	f.provider->on_sign = {};
	f.accept(2);
	f.provider->on_sign = [&] { f.clock->sleep += second; };
	expect(f.session->authorize_operation(), BoundSessionStatus::online_required);
	f.provider->on_sign = {};
	expect(f.session->authorize_operation(), BoundSessionStatus::online_required);
	f.accept(3);
	expect(f.session->authorize_operation(), BoundSessionStatus::ok);
}

BOOST_AUTO_TEST_CASE(concurrent_authorize_accept_and_deny_are_serialized_and_denial_wins) {
	Fixture f;
	const auto accepted = f.accept();
	const auto operation = f.begin();
	const auto token = f.signer.lease(f.context, operation, 2);
	auto authorize = std::async(std::launch::async, [&] { return f.session->authorize_operation(); });
	auto accept = std::async(std::launch::async, [&] { return f.session->accept_renewal(operation, token); });
	auto deny = std::async(std::launch::async, [&] {
		return f.session->record_outcome(accepted, BoundTransportOutcome::authority_denied);
	});
	const auto auth = authorize.get();
	const auto response = accept.get();
	BOOST_CHECK(auth.status == BoundSessionStatus::ok || auth.status == BoundSessionStatus::denied);
	BOOST_CHECK(response.status == BoundSessionStatus::ok || response.status == BoundSessionStatus::no_pending);
	expect(deny.get(), BoundSessionStatus::denied);
	expect(f.session->authorize_operation(), BoundSessionStatus::denied);
}

BOOST_AUTO_TEST_CASE(expired_delivery_can_be_abandoned_without_reusing_the_old_origin) {
	Fixture f;
	const auto stale = f.begin();
	const auto token = f.signer.lease(f.context, stale);
	f.clock->ticks += 86400 * second;
	expect(f.session->accept_renewal(stale, token), BoundSessionStatus::invalid_response);
	expect(f.session->abandon_renewal(stale), BoundSessionStatus::online_required);
	const auto fresh = f.accept();
	BOOST_CHECK(fresh != stale);
	expect(f.session->accept_renewal(stale, token), BoundSessionStatus::no_pending);
	expect(f.session->authorize_operation(), BoundSessionStatus::ok);
}

BOOST_AUTO_TEST_CASE(recreated_session_cannot_restore_a_cached_lease_or_old_operation) {
	Fixture f;
	const auto old = f.accept();
	const auto token = f.signer.lease(f.context, old);
	f.session.reset();
	f.recreate();
	expect(f.session->authorize_operation(), BoundSessionStatus::online_required);
	expect(f.session->accept_renewal(old, token), BoundSessionStatus::no_pending);
	const auto fresh = f.begin();
	BOOST_CHECK(fresh != old);
	expect(f.session->accept_renewal(fresh, token), BoundSessionStatus::invalid_response);
	expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh)), BoundSessionStatus::ok);
}

BOOST_AUTO_TEST_CASE(creation_rejects_bad_trust_and_provider_or_identity_pins_before_request_work) {
	Fixture f;
	f.recreate([](BoundSessionContext&, std::vector<BoundLeaseTrustKey>& trust) { trust.push_back(trust.front()); });
	BOOST_CHECK(!f.session);
	f.recreate([](BoundSessionContext&, std::vector<BoundLeaseTrustKey>& trust) { trust.front().spki.push_back(0); });
	BOOST_CHECK(!f.session);
	f.recreate([](BoundSessionContext& context, std::vector<BoundLeaseTrustKey>&) {
		context.provider_policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
	});
	BOOST_CHECK(!f.session);
	f.recreate([](BoundSessionContext& context, std::vector<BoundLeaseTrustKey>&) {
		context.lease.device_key_id = "sha256:" + std::string(64, '0');
	});
	BOOST_CHECK(!f.session);
	BOOST_CHECK_EQUAL(f.clock->operations, 0U);
}

BOOST_AUTO_TEST_CASE(failed_final_acceptance_keeps_authenticated_floor_without_publishing_replacement) {
	for (const bool sleep : {false, true}) {
		Fixture f;
		f.accept();
		const auto operation = f.begin();
		const auto higher = f.signer.lease(f.context, operation, 2, 10);
		f.provider->on_sign = [&] {
			if (sleep)
				f.clock->sleep += second;
			else
				f.clock->ticks += 10 * second;
		};
		expect(f.session->accept_renewal(operation, higher),
			   sleep ? BoundSessionStatus::online_required : BoundSessionStatus::invalid_response);
		f.provider->on_sign = {};
		if (!sleep) expect(f.session->abandon_renewal(operation), BoundSessionStatus::online_required);
		BOOST_CHECK(f.session->authorize_operation().status != BoundSessionStatus::ok);
		const auto fresh = f.begin();
		expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh, 1)),
			   BoundSessionStatus::invalid_response);
		expect(f.session->accept_renewal(fresh, f.signer.lease(f.context, fresh, 2)), BoundSessionStatus::ok);
		expect(f.session->authorize_operation(), BoundSessionStatus::ok);
	}
}
