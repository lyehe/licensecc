#define BOOST_TEST_MODULE feature_session_failures_test
#include "feature_session_fixture.hpp"
#include <future>
using namespace feature_test;

BOOST_AUTO_TEST_CASE(transient_renewal_keeps_prior_permission_only_until_actual_expiry) {
	Fixture f;
	auto owner = f.open();
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
	const auto normal = f.call;
	f.call = [](BoundWireOperation, std::string_view, BoundHttpResponse&) { return BoundHttpStatus::unavailable; };
	f.clock->ticks += 450 * second;
	BOOST_CHECK_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_RETRY);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_ACTIVE);
	no_time(f.detail);
	const auto pending = f.operations.back();
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.detail.effective_time, issued + 450);
	BOOST_CHECK_EQUAL(f.detail.renewal_due, 1);
	f.clock->ticks += 450 * second;
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_INVALID_RESPONSE);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_NEEDS_ONLINE);
	no_time(f.detail);
	BOOST_CHECK_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_RETRY);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_NEEDS_ONLINE);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_ONLINE_REQUIRED);
	f.call = normal;
	BOOST_REQUIRE_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.operations.back(), pending);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_ACTIVE);
	no_time(f.detail);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.detail.effective_time, issued + 450);
}

BOOST_AUTO_TEST_CASE(nontransient_admitted_renewal_failure_pauses_old_authority_until_online_acceptance) {
	for (unsigned failure = 0; failure < 3; ++failure) {
		Fixture f;
		auto owner = f.open();
		BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
		const auto normal = f.call;
		f.call = [failure](BoundWireOperation, std::string_view, BoundHttpResponse& out) {
			if (failure == 0) {
				out = {200, "not-json"};
				return BoundHttpStatus::complete;
			}
			if (failure == 1) return BoundHttpStatus::internal_error;
			return Fixture::error(400, "invalid_request", out);
		};
		const LCC_BOUND_RESULT expected[] = {LCC_BOUND_INVALID_RESPONSE, LCC_BOUND_INTERNAL_ERROR,
											 LCC_BOUND_INVALID_STATE};
		BOOST_CHECK_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), expected[failure]);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_NEEDS_ONLINE);
		no_time(f.detail);
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail),
						  LCC_BOUND_ONLINE_REQUIRED);
		f.call = normal;
		BOOST_REQUIRE_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_ACTIVE);
		no_time(f.detail);
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
	}
}

BOOST_AUTO_TEST_CASE(accepted_renewal_final_check_failure_requires_another_online_acceptance) {
	for (bool lose_clock : {false, true}) {
		Fixture f;
		auto owner = f.open();
		BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
		const auto final_possession = f.provider.signs + 3;
		if (lose_clock) {
			f.provider.after_sign = [&] {
				if (f.provider.signs == final_possession) f.clock->sleep += second;
			};
		} else {
			f.provider.fail_at = final_possession;
		}
		const auto before_requests = f.requests;
		BOOST_CHECK_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail),
						  lose_clock ? LCC_BOUND_ONLINE_REQUIRED : LCC_BOUND_PROVIDER_ERROR);
		BOOST_CHECK_EQUAL(f.detail.provider_result, lose_clock ? LCC_DEVICE_OK : LCC_DEVICE_BUSY);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_NEEDS_ONLINE);
		BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_SAVED);
		BOOST_CHECK_EQUAL(f.requests, before_requests + 2);
		no_time(f.detail);
		const auto accepted = f.operations.back();
		BOOST_CHECK_EQUAL(*f.memory()->slots[0], f.tokens.at(accepted));
		f.provider.fail_at = 0;
		f.provider.after_sign = {};
		const auto signs = f.provider.signs;
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail),
						  LCC_BOUND_ONLINE_REQUIRED);
		BOOST_CHECK_EQUAL(f.provider.signs, signs);
		BOOST_CHECK_EQUAL(lcc_feature_session_save_checkpoint(owner.get(), &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_NEEDS_ONLINE);
		const auto normal = f.call;
		f.call = [](BoundWireOperation, std::string_view, BoundHttpResponse&) { return BoundHttpStatus::unavailable; };
		BOOST_CHECK_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_RETRY);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_NEEDS_ONLINE);
		no_time(f.detail);
		const auto pending = f.operations.back();
		BOOST_CHECK(pending != accepted);
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail),
						  LCC_BOUND_ONLINE_REQUIRED);
		f.call = normal;
		BOOST_REQUIRE_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(f.operations.back(), pending);
		BOOST_CHECK_EQUAL(f.requests, before_requests + 5);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_ACTIVE);
		no_time(f.detail);
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
	}
}

BOOST_AUTO_TEST_CASE(authority_denial_is_terminal_and_conflict_requires_deliberate_new_owner) {
	for (const auto& failure : std::vector<std::pair<unsigned, std::string>>{{404, "binding_unavailable"},
																			 {409, "revision_conflict"},
																			 {409, "idempotency_conflict"},
																			 {403, "device_retired"}}) {
		for (bool started : {false, true}) {
			Fixture f;
			auto owner = f.open();
			if (started) BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
			const auto normal = f.call;
			f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
				if (op == BoundWireOperation::renew_challenge) return normal(op, body, out);
				return Fixture::error(failure.first, failure.second, out);
			};
			const auto result = failure.second == "idempotency_conflict" ? LCC_BOUND_CONFLICT : LCC_BOUND_DENIED;
			BOOST_CHECK_EQUAL(started ? lcc_feature_session_renew(owner.get(), &f.detail)
									  : lcc_feature_session_start(owner.get(), &f.detail),
							  result);
			BOOST_CHECK_EQUAL(f.detail.state,
							  result == LCC_BOUND_DENIED ? LCC_FEATURE_SESSION_DENIED : LCC_FEATURE_SESSION_FAILED);
			no_time(f.detail);
			const auto requests = f.requests;
			BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), result);
			BOOST_CHECK_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_INVALID_STATE);
			BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_INVALID_STATE);
			lcc_feature_session_save_checkpoint(owner.get(), &f.detail);
			BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), result);
			BOOST_CHECK_EQUAL(lcc_feature_session_stop(owner.get(), &f.detail), LCC_BOUND_OK);
			BOOST_CHECK_EQUAL(f.requests, requests);
		}
	}
}

BOOST_AUTO_TEST_CASE(rate_limit_and_challenge_expiry_retry_same_start_without_granting_work) {
	for (bool rate : {false, true}) {
		Fixture f;
		auto owner = f.open();
		const auto normal = f.call;
		bool reject = true;
		f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
			if (reject && (rate || op == BoundWireOperation::renew))
				return Fixture::error(rate ? 429 : 410, rate ? "rate_limited" : "challenge_expired", out);
			return normal(op, body, out);
		};
		BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_RETRY);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STARTING);
		const auto operation = f.operations.back();
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail),
						  LCC_BOUND_ONLINE_REQUIRED);
		reject = false;
		BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(f.operations.back(), operation);
		BOOST_CHECK_EQUAL(f.clock->operations, 1);
	}
}

BOOST_AUTO_TEST_CASE(lost_response_recovery_at_original_expiry_cannot_reset_time) {
	Fixture f;
	auto owner = f.open();
	const auto normal = f.call;
	bool drop = true;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		const auto status = normal(op, body, out);
		return drop && op == BoundWireOperation::renew ? BoundHttpStatus::unavailable : status;
	};
	BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_RETRY);
	const auto operation = f.operations.back();
	f.clock->ticks += 900 * second;
	drop = false;
	BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_INVALID_RESPONSE);
	BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_INVALID_RESPONSE);
	BOOST_CHECK_EQUAL(f.operations.back(), operation);
	BOOST_CHECK_EQUAL(f.clock->operations, 1);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STARTING);
	no_time(f.detail);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_ONLINE_REQUIRED);
}

BOOST_AUTO_TEST_CASE(local_provider_and_clock_continuity_failures_require_fresh_online_recovery) {
	for (unsigned failure = 0; failure < 4; ++failure) {
		Fixture f;
		auto owner = f.open();
		BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
		if (failure == 0) f.provider.forced = LCC_DEVICE_KEY_LOST;
		if (failure == 1) --f.clock->ticks;
		if (failure == 2) f.clock->sleep += second;
		if (failure == 3) ++f.clock->process;
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail),
						  failure == 0 ? LCC_BOUND_PROVIDER_ERROR : LCC_BOUND_ONLINE_REQUIRED);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_NEEDS_ONLINE);
		no_time(f.detail);
		f.provider.forced = LCC_DEVICE_OK;
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail),
						  LCC_BOUND_ONLINE_REQUIRED);
		BOOST_REQUIRE_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
	}
}

BOOST_AUTO_TEST_CASE(permission_and_all_storage_failures_remain_independent) {
	for (unsigned fault = 1; fault <= 4; ++fault) {
		Fixture f;
		auto owner = f.open();
		auto storage = f.memory();
		storage->fault = fault;
		storage->held = fault == 4;
		BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
		const unsigned expected[] = {0, LCC_BOUND_CHECKPOINT_IO_ERROR, LCC_BOUND_CHECKPOINT_COMMIT_UNKNOWN,
									 LCC_BOUND_CHECKPOINT_MIRROR_PENDING, LCC_BOUND_CHECKPOINT_BUSY};
		BOOST_CHECK_EQUAL(f.detail.checkpoint_result, expected[fault]);
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
		const auto requests = f.requests;
		storage->fault = 0;
		storage->held = false;
		BOOST_CHECK_EQUAL(lcc_feature_session_save_checkpoint(owner.get(), &f.detail), LCC_BOUND_OK);
		no_time(f.detail);
		BOOST_CHECK_EQUAL(f.requests, requests);
		storage->held = true;
		BOOST_CHECK_EQUAL(lcc_feature_session_stop(owner.get(), &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STOPPED);
		BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_BUSY);
		storage->held = false;
		BOOST_CHECK_EQUAL(lcc_feature_session_save_checkpoint(owner.get(), &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(lcc_feature_session_stop(owner.get(), &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_CANCELLED);
		BOOST_CHECK_EQUAL(f.requests, requests);
	}
}

BOOST_AUTO_TEST_CASE(stop_capture_failure_disables_authority_and_preserves_latest_exact_statement_for_retry) {
	Fixture f;
	auto owner = f.open();
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
	const auto prior = *f.memory()->slots[0];
	f.capture_failure = true;
	BOOST_REQUIRE_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_IO_ERROR);
	BOOST_CHECK_EQUAL(*f.memory()->slots[0], prior);
	const auto latest = f.tokens.at(f.operations.back());
	const auto requests = f.requests;
	BOOST_CHECK_EQUAL(lcc_feature_session_stop(owner.get(), &f.detail), LCC_BOUND_INTERNAL_ERROR);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STOPPED);
	no_time(f.detail);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_CANCELLED);
	BOOST_CHECK_EQUAL(lcc_feature_session_save_checkpoint(owner.get(), &f.detail), LCC_BOUND_STORAGE_ERROR);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STOPPED);
	f.capture_failure = false;
	BOOST_CHECK_EQUAL(lcc_feature_session_save_checkpoint(owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(*f.memory()->slots[0], latest);
	BOOST_CHECK_EQUAL(*f.memory()->slots[1], latest);
	BOOST_CHECK_EQUAL(f.requests, requests);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_CANCELLED);
	BOOST_CHECK_EQUAL(lcc_feature_session_stop(owner.get(), &f.detail), LCC_BOUND_OK);
}

BOOST_AUTO_TEST_CASE(stale_and_conflicting_checkpoint_save_never_overwrite_or_grant_permission) {
	for (bool newer : {false, true}) {
		Fixture f;
		auto owner = f.open();
		BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
		const auto other =
			f.signer.lease(f.context("BATCH_RUN"), std::string(43, 'A'), f.revision + (newer ? 1 : 0), 900);
		auto storage = f.memory();
		storage->slots[0] = other;
		storage->slots[1] = other;
		const auto requests = f.requests, writes = storage->writes;
		BOOST_CHECK_EQUAL(lcc_feature_session_save_checkpoint(owner.get(), &f.detail), LCC_BOUND_STORAGE_ERROR);
		BOOST_CHECK_EQUAL(f.detail.checkpoint_result,
						  newer ? LCC_BOUND_CHECKPOINT_STALE : LCC_BOUND_CHECKPOINT_CONFLICT);
		no_time(f.detail);
		BOOST_CHECK_EQUAL(lcc_feature_session_stop(owner.get(), &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(f.detail.checkpoint_result,
						  newer ? LCC_BOUND_CHECKPOINT_STALE : LCC_BOUND_CHECKPOINT_CONFLICT);
		BOOST_CHECK_EQUAL(storage->writes, writes);
		BOOST_CHECK_EQUAL(f.requests, requests);
		BOOST_CHECK_EQUAL(*storage->slots[0], other);
	}
}

BOOST_AUTO_TEST_CASE(overlapping_calls_return_busy_without_output_change_and_stop_cannot_race_admission) {
	Fixture f;
	auto owner = f.open();
	const auto normal = f.call;
	std::promise<void> entered, release;
	auto unblock = release.get_future();
	bool held = false;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		if (!held) {
			held = true;
			entered.set_value();
			unblock.wait();
		}
		return normal(op, body, out);
	};
	LccFeatureSessionOutcome starting;
	lcc_init_feature_session_outcome(&starting);
	auto task = std::async(std::launch::async, [&] { return lcc_feature_session_start(owner.get(), &starting); });
	entered.get_future().wait();
	f.detail.provider_result = 42;
	f.detail.expires_at = 73;
	const auto before = f.detail;
	BOOST_CHECK_EQUAL(lcc_feature_session_stop(owner.get(), &f.detail), LCC_BOUND_BUSY);
	BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_BUSY);
	BOOST_CHECK_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_BUSY);
	BOOST_CHECK_EQUAL(lcc_feature_session_save_checkpoint(owner.get(), &f.detail), LCC_BOUND_BUSY);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_BUSY);
	BOOST_CHECK_EQUAL(std::memcmp(&before, &f.detail, sizeof(before)), 0);
	release.set_value();
	BOOST_REQUIRE_EQUAL(task.get(), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(starting.state, LCC_FEATURE_SESSION_ACTIVE);
	BOOST_CHECK_EQUAL(lcc_feature_session_stop(owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_CANCELLED);
}

BOOST_AUTO_TEST_CASE(close_performs_no_network_or_implicit_checkpoint_retry) {
	Fixture f;
	auto owner = f.open();
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
	f.capture_failure = true;
	BOOST_REQUIRE_EQUAL(lcc_feature_session_renew(owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_IO_ERROR);
	f.capture_failure = false;
	const auto storage = f.memory();
	const auto requests = f.requests, reads = storage->reads, writes = storage->writes;
	owner.reset();
	BOOST_CHECK_EQUAL(f.requests, requests);
	BOOST_CHECK_EQUAL(storage->reads, reads);
	BOOST_CHECK_EQUAL(storage->writes, writes);
}
