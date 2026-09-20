#define BOOST_TEST_MODULE feature_session_public_test
#include "feature_session.hpp"
#include "bound_session_signer.hpp"
#include <type_traits>
using namespace license::device_identity;
static_assert(std::is_standard_layout<LccFeatureSessionOutcome>::value, "C outcome layout");
extern "C" int feature_session_c_header_check(void);

BOOST_AUTO_TEST_CASE(c11_header_links_every_public_symbol_and_defaults_grant_nothing) {
	BOOST_CHECK_EQUAL(feature_session_c_header_check(), 0);
	LccFeatureSessionOutcome out;
	std::memset(&out, 0xff, sizeof(out));
	lcc_init_feature_session_outcome(&out);
	BOOST_CHECK_EQUAL(out.effective_time, 0);
	BOOST_CHECK_EQUAL(out.renew_after, 0);
	BOOST_CHECK_EQUAL(out.expires_at, 0);
	BOOST_CHECK_EQUAL(out.reserved[0], 0);
	BOOST_CHECK_EQUAL(out.reserved[1], 0);
	lcc_init_feature_session_outcome(nullptr);
}

BOOST_AUTO_TEST_CASE(public_preconditions_leave_output_untouched_before_any_effect) {
	LccFeatureSessionOutcome out;
	lcc_init_feature_session_outcome(&out);
	out.provider_result = 42;
	LccDeviceBoundOptions options;
	lcc_init_device_bound_options(&options);
	LccFeatureSession* owner = nullptr;
	const auto before = out;
	BOOST_CHECK_EQUAL(lcc_feature_session_open(&options, &owner, &out), LCC_BOUND_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(lcc_feature_session_open(&options, nullptr, &out), LCC_BOUND_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(std::memcmp(&before, &out, sizeof(out)), 0);
	BOOST_CHECK(!owner);
	out.version = 2;
	const auto version = out;
	BOOST_CHECK_EQUAL(lcc_feature_session_open(&options, &owner, &out), LCC_BOUND_UNSUPPORTED_VERSION);
	BOOST_CHECK_EQUAL(lcc_feature_session_start(nullptr, &out), LCC_BOUND_UNSUPPORTED_VERSION);
	BOOST_CHECK_EQUAL(std::memcmp(&version, &out, sizeof(out)), 0);
	out = before;
	out.size = sizeof(out) - 1;
	BOOST_CHECK_EQUAL(lcc_feature_session_stop(nullptr, &out), LCC_BOUND_INVALID_ARGUMENT);
}

#ifndef _WIN32
BOOST_AUTO_TEST_CASE(public_owner_preserves_unsupported_platform_without_work_authority) {
	SessionTestSigner signer;
	LccDeviceBoundOptions options;
	lcc_init_device_bound_options(&options);
	std::strcpy(options.application_id, "licensecc.test.feature-public");
	std::strcpy(options.endpoint_origin, "https://backend.test");
	std::strcpy(options.portal_authorization_url, "https://portal.test/authorize");
	std::strcpy(options.issuer, "issuer");
	std::strcpy(options.lease_audience, "app");
	std::strcpy(options.proof_audience, "proof");
	std::strcpy(options.project, "CAD");
	std::strcpy(options.feature, "BATCH_RUN");
	std::strcpy(options.client_id, "app");
	std::strcpy(options.device_label, "Synthetic public test");
	options.trust_key_count = 1;
	options.trust_keys[0].spki_size = static_cast<uint32_t>(signer.spki.size());
	std::memcpy(options.trust_keys[0].spki, signer.spki.data(), signer.spki.size());
	LccFeatureSession* owner = nullptr;
	LccFeatureSessionOutcome out;
	lcc_init_feature_session_outcome(&out);
	out.expires_at = 73;
	BOOST_CHECK_EQUAL(lcc_feature_session_open(&options, &owner, &out), LCC_BOUND_UNSUPPORTED_PLATFORM);
	BOOST_CHECK(!owner);
	BOOST_CHECK_EQUAL(out.state, LCC_FEATURE_SESSION_UNKNOWN);
	BOOST_CHECK_EQUAL(out.expires_at, 0);
}
#endif
