#define BOOST_TEST_MODULE feature_session_test
#include "feature_session_fixture.hpp"
using namespace feature_test;

BOOST_AUTO_TEST_CASE(open_is_online_only_and_each_same_process_job_renews_freshly) {
	Fixture f;
	auto first = f.open();
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_READY);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_LOADED);
	no_time(f.detail);
	BOOST_CHECK_EQUAL(f.requests, 0);
	BOOST_CHECK_EQUAL(f.create_calls, 0);
	BOOST_CHECK_EQUAL(f.browser_calls, 0);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(first.get(), "BATCH_RUN", &f.detail), LCC_BOUND_ONLINE_REQUIRED);
	const auto before = f.detail;
	BOOST_CHECK_EQUAL(lcc_feature_session_renew(first.get(), &f.detail), LCC_BOUND_INVALID_STATE);
	BOOST_CHECK_EQUAL(std::memcmp(&before, &f.detail, sizeof(before)), 0);
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(first.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.requests, 2);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_ACTIVE);
	BOOST_CHECK_EQUAL(f.detail.effective_time, issued);
	BOOST_CHECK_EQUAL(f.detail.renew_after, issued + 450);
	BOOST_CHECK_EQUAL(f.detail.expires_at, issued + 900);
	BOOST_CHECK_EQUAL(f.detail.renewal_due, 0);
	const auto started = f.detail;
	BOOST_CHECK_EQUAL(lcc_feature_session_start(first.get(), &f.detail), LCC_BOUND_INVALID_STATE);
	BOOST_CHECK_EQUAL(std::memcmp(&started, &f.detail, sizeof(started)), 0);
	BOOST_CHECK_EQUAL(f.requests, 2);
	BOOST_REQUIRE_EQUAL(lcc_feature_session_authorize(first.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
	const auto operation = f.operations.back();
	BOOST_CHECK_EQUAL(lcc_feature_session_stop(first.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STOPPED);
	no_time(f.detail);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(first.get(), "BATCH_RUN", &f.detail), LCC_BOUND_CANCELLED);
	BOOST_CHECK_EQUAL(lcc_feature_session_start(first.get(), &f.detail), LCC_BOUND_INVALID_STATE);
	auto second_owner = f.open();
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(second_owner.get(), "BATCH_RUN", &f.detail),
					  LCC_BOUND_ONLINE_REQUIRED);
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(second_owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.requests, 4);
	BOOST_CHECK(f.operations.back() != operation);
	BOOST_CHECK_EQUAL(f.create_calls, 0);
	BOOST_CHECK_EQUAL(f.browser_calls, 0);
}

BOOST_AUTO_TEST_CASE(simultaneous_owners_reject_each_others_unexpired_token_and_failed_second_start) {
	Fixture f;
	auto first = f.open();
	auto second_owner = f.open();
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(first.get(), &f.detail), LCC_BOUND_OK);
	f.replay = f.tokens.at(f.operations.back());
	BOOST_CHECK_EQUAL(lcc_feature_session_start(second_owner.get(), &f.detail), LCC_BOUND_INVALID_RESPONSE);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STARTING);
	no_time(f.detail);
	BOOST_REQUIRE_EQUAL(f.operations.size(), 2);
	BOOST_CHECK(f.operations[0] != f.operations[1]);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(second_owner.get(), "BATCH_RUN", &f.detail),
					  LCC_BOUND_ONLINE_REQUIRED);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(first.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
	f.replay.clear();
	const auto pending = f.operations.back();
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(second_owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.operations.back(), pending);
}

BOOST_AUTO_TEST_CASE(two_features_share_one_key_but_keep_checkpoints_and_guards_independent) {
	Fixture f;
	auto batch = f.open();
	auto export_owner = f.open("EXPORT");
	BOOST_REQUIRE_EQUAL(f.opened_keys.size(), 2);
	BOOST_CHECK_EQUAL(f.opened_keys[0], f.opened_keys[1]);
	BOOST_CHECK(f.memory() != f.memory("EXPORT"));
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(batch.get(), &f.detail), LCC_BOUND_OK);
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(export_owner.get(), &f.detail), LCC_BOUND_OK);
	std::strcpy(f.options.feature, "EXPORT");  // caller memory cannot rebind batch
	const auto requests = f.requests;
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(batch.get(), "EXPORT", &f.detail), LCC_BOUND_DENIED);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_ACTIVE);
	no_time(f.detail);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(batch.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(export_owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_DENIED);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(export_owner.get(), "EXPORT", &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.requests, requests);
	ParsedBoundLease batch_token, export_token;
	BOOST_REQUIRE(decode_bound_lease(*f.memory()->slots[0], batch_token));
	BOOST_REQUIRE(decode_bound_lease(*f.memory("EXPORT")->slots[0], export_token));
	BOOST_CHECK_EQUAL(batch_token.claims.feature, "BATCH_RUN");
	BOOST_CHECK_EQUAL(export_token.claims.feature, "EXPORT");
	BOOST_CHECK(batch_token.claims.binding_id != export_token.claims.binding_id);
	BOOST_CHECK_EQUAL(lcc_feature_session_stop(batch.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(export_owner.get(), "EXPORT", &f.detail), LCC_BOUND_OK);
}

BOOST_AUTO_TEST_CASE(start_retry_keeps_operation_and_original_anchor_after_lost_committed_response) {
	Fixture f;
	auto owner = f.open();
	const auto normal = f.call;
	bool drop = true;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		const auto result = normal(op, body, out);
		if (op == BoundWireOperation::renew && drop) {
			drop = false;
			return BoundHttpStatus::unavailable;
		}
		return result;
	};
	BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_RETRY);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STARTING);
	no_time(f.detail);
	const auto pending = f.operations.back(), token = f.tokens.at(pending);
	f.clock->ticks += 451 * second;
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_ONLINE_REQUIRED);
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.operations.back(), pending);
	BOOST_CHECK_EQUAL(f.tokens.size(), 1);
	BOOST_CHECK_EQUAL(f.tokens.at(pending), token);
	BOOST_CHECK_EQUAL(f.challenges, 2);
	BOOST_CHECK_EQUAL(f.detail.effective_time, issued + 451);
	BOOST_CHECK_EQUAL(f.detail.renewal_due, 1);
	f.clock->ticks += 449 * second;
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_INVALID_RESPONSE);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_NEEDS_ONLINE);
	no_time(f.detail);
}

BOOST_AUTO_TEST_CASE(accepted_start_whose_final_possession_fails_cannot_retry_as_cached_success) {
	Fixture f;
	auto owner = f.open();
	f.provider.fail_at = 3;
	BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_PROVIDER_ERROR);
	BOOST_CHECK_EQUAL(f.detail.provider_result, LCC_DEVICE_BUSY);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STARTING);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_SAVED);
	no_time(f.detail);
	const auto accepted = f.operations.back();
	const auto requests = f.requests;
	const auto normal = f.call;
	f.call = [](BoundWireOperation, std::string_view, BoundHttpResponse&) { return BoundHttpStatus::unavailable; };
	BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_RETRY);
	BOOST_CHECK_EQUAL(f.requests, requests + 1);
	BOOST_CHECK(f.operations.back() != accepted);
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_ONLINE_REQUIRED);
	const auto pending = f.operations.back();
	f.call = normal;
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.operations.back(), pending);
}

BOOST_AUTO_TEST_CASE(verified_acceptance_provider_failure_retains_pending_intent_and_checkpoint) {
	Fixture f;
	auto owner = f.open();
	f.provider.fail_at = 2;
	BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_PROVIDER_ERROR);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_SAVED);
	no_time(f.detail);
	const auto pending = f.operations.back();
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.operations.back(), pending);
	BOOST_CHECK_EQUAL(f.clock->operations, 1);
}

BOOST_AUTO_TEST_CASE(network_signing_verification_and_final_check_delay_all_count) {
	Fixture f;
	auto owner = f.open();
	const auto normal = f.call;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		f.clock->ticks += 10 * second;
		return normal(op, body, out);
	};
	f.provider.after_sign = [&] { f.clock->ticks += 2 * second; };
	f.clock->before_sample = [&] { f.clock->ticks += second; };
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.detail.effective_time, issued + 34);  // 20 network + 6 signing + 8 verification samples
	BOOST_CHECK_EQUAL(f.detail.renew_after, issued + 450);
	BOOST_CHECK_EQUAL(f.detail.expires_at, issued + 900);
	f.clock->before_sample = {};
	f.provider.after_sign = {};
	const auto requests = f.requests;
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.requests, requests);
}

BOOST_AUTO_TEST_CASE(final_start_clock_failure_saves_statement_without_admitting_work) {
	Fixture f;
	auto owner = f.open();
	f.provider.after_sign = [&] {
		if (f.provider.signs == 3) f.clock->sleep += second;
	};
	BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_ONLINE_REQUIRED);
	BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STARTING);
	BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_SAVED);
	no_time(f.detail);
	f.provider.after_sign = {};
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_ONLINE_REQUIRED);
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_REQUIRE_EQUAL(f.operations.size(), 2);
	BOOST_CHECK(f.operations[0] != f.operations[1]);
}
