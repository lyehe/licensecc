
#define BOOST_TEST_MODULE test_activation_it

#include <boost/test/unit_test.hpp>
#include <boost/filesystem.hpp>

#include <licensecc/licensecc.h>
#include <licensecc_properties_test.h>
#include <licensecc_properties.h>

#include <cstring>
#include <string>
#include <vector>

#include "generate-license.h"
#include "../../src/library/activation/ActivationRequest.hpp"
#include "../../src/library/base/base.h"

using namespace std;
namespace fs = boost::filesystem;

namespace license {
namespace test {

static bool try_identify_pc(const LCC_API_HW_IDENTIFICATION_STRATEGY strategy, string& identifier) {
	size_t buffer_size = 0;
	identify_pc(strategy, nullptr, &buffer_size, nullptr);
	if (buffer_size == 0) {
		return false;
	}
	vector<char> buffer(buffer_size, '\0');
	if (!identify_pc(strategy, buffer.data(), &buffer_size, nullptr)) {
		return false;
	}
	identifier = buffer.data();
	return !identifier.empty();
}

static string current_strong_pc_identifier() {
	string identifier;
	if (try_identify_pc(STRATEGY_DISK, identifier)) {
		return identifier;
	}
	if (try_identify_pc(STRATEGY_ETHERNET, identifier)) {
		return identifier;
	}
	BOOST_FAIL("Current host cannot generate a strong disk or ethernet hardware identifier for the activation E2E test");
	return string();
}

// End-to-end proof that the offline-activation flow reuses the existing .lic crypto with NO new
// verification path: the machine's real hardware id is carried through the activation-request codec
// (build -> parse), the recovered id is used verbatim as the license generator's --client-signature,
// and the resulting hardware-bound v201 license validates through the ordinary acquire_license path.
// This also locks the codec<->generator contract that a canonical hwid's trailing base64 '=' survives.
BOOST_AUTO_TEST_CASE(offline_activation_request_round_trips_into_a_verifiable_license) {
	const string hwid = current_strong_pc_identifier();

	license::activation::ActivationRequestFields fields;
	fields.project = LCC_PROJECT_NAME;
	fields.feature = LCC_PROJECT_NAME;  // default feature == project name
	fields.hwid = hwid;
	fields.nonce = 0x0123456789ABCDEFULL;
	fields.issued_at = 1751328000;

	const string request = license::activation::build_activation_request(fields);
	BOOST_REQUIRE_MESSAGE(!request.empty(), "activation request builds for the real host hwid");
	BOOST_CHECK(request.compare(0, 9, "lccareq1.") == 0);

	license::activation::ActivationRequestFields decoded;
	string error;
	BOOST_REQUIRE_MESSAGE(license::activation::parse_activation_request(request, decoded, error), error);
	// The operator must receive the hwid byte-for-byte to feed it to the generator.
	BOOST_CHECK_EQUAL(decoded.hwid, hwid);
	BOOST_CHECK_EQUAL(decoded.project, fields.project);
	BOOST_CHECK_EQUAL(decoded.feature, fields.feature);
	BOOST_CHECK_EQUAL(decoded.nonce, fields.nonce);

	// Operator issues a hardware-bound v201 license for the recovered hwid (existing generator/crypto).
	const vector<string> extraArgs = {"--license-version",
									  "201",
									  "--target-license-format-max",
									  "201",
									  "--client-signature",
									  decoded.hwid};
	const string licLocation = generate_license("offline_activation", extraArgs);

	// Machine installs it; the ordinary verifier accepts it and reports it hardware-bound.
	LicenseInfo licenseInfo;
	LicenseLocation location = {LICENSE_PATH};
	BOOST_REQUIRE(lcc_set_license_path(&location, licLocation.c_str()));
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &licenseInfo);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(licenseInfo.license_version, LCC_LICENSE_FORMAT_VERSION_V201);
	BOOST_CHECK_EQUAL(licenseInfo.linked_to_pc, true);
}

}  // namespace test
}  // namespace license
