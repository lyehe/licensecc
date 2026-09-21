#define BOOST_TEST_MODULE feature_session_storage_test
#include "feature_session_fixture.hpp"
using namespace feature_test;

BOOST_AUTO_TEST_CASE(same_second_restart_saves_fresh_lease_but_still_requires_online_start) {
	Fixture f;
	++f.revision;  // Supersede the short historical seed before keeping policy fixed.
	const auto normal = f.call;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		// Issuing another lease does not itself advance the entitlement revision.
		if (op == BoundWireOperation::renew) --f.revision;
		return normal(op, body, out);
	};
	std::string prior_operation;
	for (unsigned restart = 0; restart < 3; ++restart) {
		auto owner = f.open();
		const auto before = f.requests;
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail),
						  LCC_BOUND_ONLINE_REQUIRED);
		BOOST_CHECK_EQUAL(f.requests, before);
		BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(f.detail.checkpoint_result, LCC_BOUND_CHECKPOINT_SAVED);
		BOOST_CHECK_EQUAL(f.requests, before + 2);
		BOOST_REQUIRE(f.operations.back() != prior_operation);
		prior_operation = f.operations.back();
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail), LCC_BOUND_OK);
		BOOST_CHECK_EQUAL(*f.memory()->slots[0], *f.memory()->slots[1]);
		// Close without stop, retaining the last committed checkpoint.
	}
}

BOOST_AUTO_TEST_CASE(missing_checkpoint_or_key_and_corrupt_storage_never_create_or_overwrite_state) {
	Fixture f;
	for (unsigned scenario = 0; scenario < 4; ++scenario) {
		f.seed("BATCH_RUN");
		auto storage = f.memory();
		if (scenario == 0) {
			storage->slots[0].reset();
			storage->slots[1].reset();
		}
		if (scenario == 1) storage->slots[0] = "corrupt";
		if (scenario == 2) storage->slots[1] = std::string();
		if (scenario == 3) {
			storage->slots[0] = *f.memory("EXPORT")->slots[0];
			storage->slots[1] = storage->slots[0];
		}
		LccFeatureSession* owner = nullptr;
		const auto writes = storage->writes;
		BOOST_CHECK_EQUAL(open_feature_session(&f.options, &owner, &f.detail, f.hooks),
						  scenario == 0 ? LCC_BOUND_ENROLLMENT_REQUIRED : LCC_BOUND_STORAGE_ERROR);
		BOOST_CHECK(!owner);
		BOOST_CHECK_EQUAL(storage->writes, writes);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_UNKNOWN);
		BOOST_CHECK_EQUAL(f.detail.checkpoint_result,
						  scenario == 0 ? LCC_BOUND_CHECKPOINT_MISSING : LCC_BOUND_CHECKPOINT_INVALID);
		no_time(f.detail);
	}
	for (auto missing : {LCC_DEVICE_KEY_NOT_FOUND, LCC_DEVICE_KEY_LOST}) {
		f.hooks.identity = [missing](const LccDeviceIdentityOptions& in, BoundIdentityOwner&) {
			BOOST_CHECK_EQUAL(in.flags, 0);
			return missing;
		};
		LccFeatureSession* owner = nullptr;
		BOOST_CHECK_EQUAL(open_feature_session(&f.options, &owner, &f.detail, f.hooks), LCC_BOUND_PROVIDER_ERROR);
		BOOST_CHECK_EQUAL(f.detail.provider_result, missing);
		BOOST_CHECK(!owner);
	}
	BOOST_CHECK_EQUAL(f.requests, 0);
	BOOST_CHECK_EQUAL(f.create_calls, 0);
	BOOST_CHECK_EQUAL(f.browser_calls, 0);
}

BOOST_AUTO_TEST_CASE(all_checkpoint_namespace_pins_and_signed_response_contexts_remain_isolated) {
	Fixture f;
	for (unsigned field = 0; field < 5; ++field) {
		auto other = f.options;
		if (field == 0) std::strcpy(other.endpoint_origin, "https://other.test");
		if (field == 1) std::strcpy(other.issuer, "other-issuer");
		if (field == 2) std::strcpy(other.lease_audience, "other-client");
		if (field == 3) std::strcpy(other.proof_audience, "other-proof");
		if (field == 4) std::strcpy(other.project, "OTHER");
		LccFeatureSession* owner = nullptr;
		BOOST_CHECK_EQUAL(open_feature_session(&other, &owner, &f.detail, f.hooks),
						  field == 4 ? LCC_BOUND_PROVIDER_ERROR : LCC_BOUND_ENROLLMENT_REQUIRED);
		BOOST_CHECK(!owner);
	}
	BOOST_CHECK_EQUAL(f.requests, 0);
	BOOST_CHECK_EQUAL(f.create_calls, 0);
	for (unsigned field = 0; field < 7; ++field) {
		auto owner = f.open();
		const auto checkpoint = *f.memory()->slots[0];
		f.mutate_claims = [field](BoundSessionContext& c) {
			if (field == 0) c.lease.issuer += "other";
			if (field == 1) c.lease.audience += "other";
			if (field == 2) c.lease.project = "OTHER";
			if (field == 3) c.lease.feature = "EXPORT";
			if (field == 4) c.lease.device_key_id = "sha256:" + std::string(64, 'b');
			if (field == 5) ++c.lease.generation;
			if (field == 6) c.lease.binding_id = std::string(22, 'A');
		};
		BOOST_CHECK_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_INVALID_RESPONSE);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_STARTING);
		no_time(f.detail);
		BOOST_CHECK_EQUAL(*f.memory()->slots[0], checkpoint);
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "BATCH_RUN", &f.detail),
						  LCC_BOUND_ONLINE_REQUIRED);
	}
}

BOOST_AUTO_TEST_CASE(required_feature_grammar_is_bounded_and_errors_preserve_output_and_authority) {
	Fixture f;
	f.seed("ABCDEFGHIJKLMNO");
	auto owner = f.open("ABCDEFGHIJKLMNO");
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &f.detail), LCC_BOUND_OK);
	const auto before = f.detail;
	const auto requests = f.requests;
	const char unterminated[16] = {'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'};
	const char* invalid_features[] = {nullptr, "", "with space", "bad/feature", "ABCDEFGHIJKLMNOP", unterminated};
	for (const char* bad : invalid_features) {
		BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), bad, &f.detail), LCC_BOUND_INVALID_ARGUMENT);
		BOOST_CHECK_EQUAL(std::memcmp(&before, &f.detail, sizeof(before)), 0);
	}
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "ABCDEFGHIJKLMNO", &f.detail), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(f.requests, requests);
	auto invalid = f.options;
	std::memset(invalid.feature, 'A', sizeof(invalid.feature));
	LccFeatureSession* empty = nullptr;
	BOOST_CHECK_EQUAL(open_feature_session(&invalid, &empty, &f.detail, f.hooks), LCC_BOUND_INVALID_ARGUMENT);
	BOOST_CHECK(!empty);
}

BOOST_AUTO_TEST_CASE(options_are_copied_and_output_extensions_and_error_outputs_follow_the_contract) {
	Fixture f;
	auto owner = f.open();
	std::strcpy(f.options.endpoint_origin, "http://invalid.test");
	f.options.trust_keys[0].spki[0] ^= 1;
	struct Extended {
		LccFeatureSessionOutcome value;
		std::uint64_t tail = 0x12345678;
	} out;
	lcc_init_feature_session_outcome(&out.value);
	out.value.size = sizeof(out);
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(owner.get(), &out.value), LCC_BOUND_OK);
	BOOST_CHECK_EQUAL(out.value.size, sizeof(out));
	BOOST_CHECK_EQUAL(out.tail, 0x12345678);
	BOOST_CHECK_EQUAL(out.value.reserved[0], 0);
	BOOST_CHECK_EQUAL(out.value.reserved[1], 0);
	const auto started = out.value;
	out.value.version = 2;
	const auto invalid = out.value;
	const auto requests = f.requests;
	BOOST_CHECK_EQUAL(lcc_feature_session_renew(owner.get(), &out.value), LCC_BOUND_UNSUPPORTED_VERSION);
	BOOST_CHECK_EQUAL(std::memcmp(&invalid, &out.value, sizeof(invalid)), 0);
	out.value = started;
	out.value.size = 8;
	const auto undersized = out.value;
	BOOST_CHECK_EQUAL(lcc_feature_session_stop(owner.get(), &out.value), LCC_BOUND_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(std::memcmp(&undersized, &out.value, sizeof(undersized)), 0);
	out.value = started;
	BOOST_CHECK_EQUAL(lcc_feature_session_authorize(owner.get(), "EXPORT", &out.value), LCC_BOUND_DENIED);
	no_time(out.value);
	BOOST_CHECK_EQUAL(out.value.state, LCC_FEATURE_SESSION_ACTIVE);
	BOOST_CHECK_EQUAL(out.value.provider_result, LCC_DEVICE_OK);
	BOOST_CHECK_EQUAL(out.value.checkpoint_result, LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED);
	BOOST_CHECK_EQUAL(f.requests, requests);
	BOOST_CHECK_EQUAL(out.tail, 0x12345678);
}

BOOST_AUTO_TEST_CASE(enrollment_opens_for_two_features_reuse_app_project_key_and_distinct_namespaces) {
	Fixture f;
	class Browser final : public BoundBrowserLauncher {
		BoundBrowserStatus open(const std::string&) noexcept override { return BoundBrowserStatus::opened; }
	};
	f.hooks.browser = [](const std::string&) { return std::make_unique<Browser>(); };
	for (const auto* feature : {"BATCH_RUN", "EXPORT"}) {
		auto storage = f.memory(feature);
		storage->slots[0].reset();
		storage->slots[1].reset();
		auto config = f.options;
		std::strcpy(config.feature, feature);
		LccDeviceBoundClient* enrolled = nullptr;
		LccDeviceBoundOutcome detail;
		lcc_init_device_bound_outcome(&detail);
		BOOST_REQUIRE_EQUAL(open_bound_public(&config, &enrolled, &detail, false, f.hooks), LCC_BOUND_OK);
		lcc_device_bound_close(enrolled);
	}
	BOOST_REQUIRE_EQUAL(f.opened_keys.size(), 2);
	BOOST_CHECK_EQUAL(f.opened_keys[0], f.opened_keys[1]);
	BOOST_CHECK_EQUAL(f.opened_keys[0], f.key);
	BOOST_CHECK_EQUAL(f.create_calls, 2);
	BOOST_CHECK_EQUAL(f.requests, 0);
	BOOST_CHECK(f.memory() != f.memory("EXPORT"));
}

BOOST_AUTO_TEST_CASE(deleting_a_synthetic_shared_software_key_prevents_both_features_from_resuming) {
	Fixture f;
	auto batch = f.open();
	auto export_owner = f.open("EXPORT");
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(batch.get(), &f.detail), LCC_BOUND_OK);
	BOOST_REQUIRE_EQUAL(lcc_feature_session_start(export_owner.get(), &f.detail), LCC_BOUND_OK);
	BOOST_REQUIRE_EQUAL(f.opened_keys.size(), 2);
	BOOST_CHECK_EQUAL(f.opened_keys[0], f.opened_keys[1]);
	// Key deletion requires exclusive coordination over the namespace. Close
	// both handles first; this test makes no claim about live handle invalidation.
	batch.reset();
	export_owner.reset();
	LccDeviceIdentityOptions key_options;
	lcc_init_device_identity_options(&key_options);
	key_options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
	key_options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
	std::strcpy(key_options.application_id, f.options.application_id);
	std::strcpy(key_options.project, f.options.project);
	BOOST_REQUIRE(std::string(key_options.application_id).find("licensecc.test.feature-session.") == 0);
	BOOST_REQUIRE_EQUAL(lcc_device_identity_delete_key(&key_options, f.key.c_str()), LCC_DEVICE_OK);
	const auto requests = f.requests, creates = f.create_calls;
	for (const auto* feature : {"BATCH_RUN", "EXPORT"}) {
		const auto storage = f.memory(feature);
		const auto primary = *storage->slots[0], mirror = *storage->slots[1];
		const auto writes = storage->writes;
		auto config = f.options;
		std::strcpy(config.feature, feature);
		LccFeatureSession* owner = nullptr;
		BOOST_CHECK_EQUAL(open_feature_session(&config, &owner, &f.detail, f.hooks), LCC_BOUND_PROVIDER_ERROR);
		BOOST_CHECK_EQUAL(f.detail.provider_result, LCC_DEVICE_KEY_NOT_FOUND);
		BOOST_CHECK_EQUAL(f.detail.state, LCC_FEATURE_SESSION_UNKNOWN);
		BOOST_CHECK(!owner);
		no_time(f.detail);
		BOOST_CHECK_EQUAL(*storage->slots[0], primary);
		BOOST_CHECK_EQUAL(*storage->slots[1], mirror);
		BOOST_CHECK_EQUAL(storage->writes, writes);
	}
	BOOST_CHECK_EQUAL(f.requests, requests);
	BOOST_CHECK_EQUAL(f.create_calls, creates);
}
