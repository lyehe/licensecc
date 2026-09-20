#define BOOST_TEST_MODULE device_bound_public_test
#include "bound_public.hpp"
#include "bound_session_signer.hpp"
#include <cstring>
using namespace license::device_identity;
namespace {
LccDeviceBoundOptions options(const SessionTestSigner& signer) {
	LccDeviceBoundOptions o;
	lcc_init_device_bound_options(&o);
	std::strcpy(o.application_id, "licensecc.test.public");
	std::strcpy(o.endpoint_origin, "https://backend.test");
	std::strcpy(o.portal_authorization_url, "https://portal.test/authorize");
	std::strcpy(o.issuer, "issuer");
	std::strcpy(o.lease_audience, "app");
	std::strcpy(o.proof_audience, "proof");
	std::strcpy(o.project, "CAD");
	std::strcpy(o.feature, "DEFAULT");
	std::strcpy(o.client_id, "app");
	std::strcpy(o.device_label, "Workstation");
	o.trust_key_count = 1;
	o.trust_keys[0].spki_size = static_cast<uint32_t>(signer.spki.size());
	std::memcpy(o.trust_keys[0].spki, signer.spki.data(), signer.spki.size());
	return o;
}
}  // namespace
extern "C" int bound_public_c_header_check(void);
BOOST_AUTO_TEST_CASE(c_header_links_and_defaults_do_not_enable_key_creation_or_authority) {
	BOOST_CHECK_EQUAL(bound_public_c_header_check(), 0);
	LccDeviceBoundOptions o;
	lcc_init_device_bound_options(&o);
	LccDeviceBoundOutcome result;
	lcc_init_device_bound_outcome(&result);
	LccDeviceBoundClient* client = nullptr;
	BOOST_CHECK_EQUAL(lcc_device_bound_open_enrollment(&o, &client, &result), LCC_BOUND_INVALID_ARGUMENT);
	BOOST_CHECK(client == nullptr);
	BOOST_CHECK_EQUAL(result.checkpoint_result, LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED);
	BOOST_CHECK_EQUAL(lcc_device_bound_authorize(nullptr, &result), LCC_BOUND_INVALID_ARGUMENT);
	lcc_device_bound_close(nullptr);
}
BOOST_AUTO_TEST_CASE(config_rejects_invalid_authority_and_paths_before_any_factory_side_effect) {
	SessionTestSigner signer;
	const auto good = options(signer);
	BoundPublicConfig c;
	BOOST_REQUIRE_EQUAL(validate_bound_public_options(&good, c), LCC_BOUND_OK);
	for (unsigned scenario = 0; scenario < 13; ++scenario) {
		auto o = good;
		switch (scenario) {
			case 0:
				std::strcpy(o.application_id, "Uppercase");
				break;
			case 1:
				std::strcpy(o.endpoint_origin, "http://backend.test");
				break;
			case 2:
				std::strcpy(o.portal_authorization_url, "https://portal.test/authorize?evil=1");
				break;
			case 3:
				std::strcpy(o.callback_path, "//evil.test/");
				break;
			case 4:
				std::memset(o.issuer, 'x', sizeof(o.issuer));
				break;
			case 5:
				o.trust_key_count = 9;
				break;
			case 6:
				o.trust_keys[0].spki_size = 513;
				break;
			case 7:
				o.trust_keys[0].spki[0] ^= 1;
				break;
			case 8:
				std::strcpy(o.device_label, " \t ");
				break;
			case 9:
				o.reserved = 1;
				break;
			case 10:
				o.trust_keys[0].retired = 1;
				break;
			case 11:
				o.trust_keys[0].retired = 2;
				break;
			case 12:
				o.trust_key_count = 2;
				o.trust_keys[1] = o.trust_keys[0];
				break;
		}
		BoundPublicHooks hooks;
		BOOST_CHECK_MESSAGE(validate_bound_public_options(&o, c) == LCC_BOUND_INVALID_ARGUMENT,
							"invalid configuration scenario " << scenario);
		hooks.storage = [](const BoundCheckpointNamespace&) -> std::unique_ptr<BoundCheckpointStorage> {
			BOOST_FAIL("invalid config reached storage");
			return {};
		};
		LccDeviceBoundOutcome result;
		lcc_init_device_bound_outcome(&result);
		result.provider_result = 42;
		LccDeviceBoundClient* client = nullptr;
		BOOST_CHECK_MESSAGE(open_bound_public(&o, &client, &result, false, hooks) == LCC_BOUND_INVALID_ARGUMENT,
							"invalid configuration scenario " << scenario);
		BOOST_CHECK_EQUAL(result.provider_result, 42);
		BOOST_CHECK(client == nullptr);
	}
}
BOOST_AUTO_TEST_CASE(version_and_output_validation_precedes_effects) {
	SessionTestSigner signer;
	auto o = options(signer);
	LccDeviceBoundOutcome result;
	lcc_init_device_bound_outcome(&result);
	LccDeviceBoundClient* client = nullptr;
	result.version = 2;
	BOOST_CHECK_EQUAL(lcc_device_bound_open_resume(&o, &client, &result), LCC_BOUND_UNSUPPORTED_VERSION);
	lcc_init_device_bound_outcome(&result);
	o.version = 2;
	BOOST_CHECK_EQUAL(lcc_device_bound_open_resume(&o, &client, &result), LCC_BOUND_UNSUPPORTED_VERSION);
	LccDeviceBoundView view;
	lcc_init_device_bound_view(&view);
	view.size = 8;
	BOOST_CHECK_EQUAL(lcc_device_bound_prepare(nullptr, &view), LCC_BOUND_INVALID_ARGUMENT);
}
