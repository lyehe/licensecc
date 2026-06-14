#define BOOST_TEST_MODULE config_public_api_test

#include <licensecc/licensecc.h>

#include <cstring>
#include <string>

#include <boost/test/unit_test.hpp>

#include <licensecc_properties.h>

namespace license {
namespace test {
using namespace std;

BOOST_AUTO_TEST_CASE(config_init_helpers_set_size_version_and_defaults) {
	LccConfigInput input;
	lcc_init_config_input(&input);
	BOOST_CHECK_EQUAL(input.size, sizeof(LccConfigInput));
	BOOST_CHECK_EQUAL(input.version, LCC_CONFIG_INPUT_VERSION);
	BOOST_CHECK(input.token == nullptr);
	BOOST_CHECK_EQUAL(input.device_hash[0], '\0');

	LccConfigVerifyOptions options;
	lcc_init_config_verify_options(&options);
	BOOST_CHECK_EQUAL(options.size, sizeof(LccConfigVerifyOptions));
	BOOST_CHECK_EQUAL(options.version, LCC_CONFIG_VERIFY_OPTIONS_VERSION);
	BOOST_CHECK_EQUAL(options.reserved, 0u);

	LccConfigDecision decision;
	lcc_init_config_decision(&decision);
	BOOST_CHECK_EQUAL(decision.size, sizeof(LccConfigDecision));
	BOOST_CHECK_EQUAL(decision.decision, LCC_LICENSE_DECISION_DENY);

	BOOST_CHECK(lcc_set_config_device_hash(&input, string(64, 'a').c_str()));
	BOOST_CHECK_EQUAL(string(input.device_hash), string(64, 'a'));
	BOOST_CHECK(lcc_set_config_device_hash(&input, ""));
	BOOST_CHECK_EQUAL(input.device_hash[0], '\0');
	BOOST_CHECK(!lcc_set_config_device_hash(&input, string(65, 'a').c_str()));
}

BOOST_AUTO_TEST_CASE(verify_config_rejects_malformed_input) {
	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	LicenseInfo info{};
	LccConfigDecision decision;
	lcc_init_config_decision(&decision);

	// null input
	BOOST_CHECK_EQUAL(lcc_verify_config(&caller, nullptr, &info, nullptr, &decision, nullptr), LICENSE_MALFORMED);
	BOOST_CHECK_EQUAL(decision.decision, LCC_LICENSE_DECISION_DENY);

	// bad size
	LccConfigInput input;
	lcc_init_config_input(&input);
	input.token = "lcccfg1.x.y";
	const unsigned char bytes[] = {1, 2, 3};
	input.config_bytes = bytes;
	input.config_len = sizeof(bytes);
	input.size = 1;
	BOOST_CHECK_EQUAL(lcc_verify_config(&caller, nullptr, &info, &input, &decision, nullptr), LICENSE_MALFORMED);
}

}  // namespace test
}  // namespace license
