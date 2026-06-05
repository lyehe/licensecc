#define BOOST_TEST_MODULE test_date

#include <boost/test/unit_test.hpp>
#include <boost/filesystem.hpp>

#include <stdexcept>
#include <licensecc_properties.h>
#include <licensecc_properties_test.h>

#include <licensecc/licensecc.h>
#include "../../src/library/ini/SimpleIni.h"
#include "../../src/library/base/EventRegistry.h"
#include "../../src/library/base/string_utils.h"
#include "../../src/library/limits/license_verifier.hpp"
#include "generate-license.h"

namespace fs = boost::filesystem;
using namespace license;
using namespace std;

namespace license {
namespace test {

static FUNCTION_RETURN verify_single_date_limit(const string &key, const string &value, EventRegistry &registry) {
	FullLicenseInfo license_info("date-policy-test", LCC_PROJECT_NAME, "QUJDRA==");
	license_info.m_limits[LICENSE_VERSION] = "200";
	license_info.m_limits[key] = value;
	LicenseVerifier verifier(registry);
	return verifier.verify_limits(license_info, nullptr);
}

BOOST_AUTO_TEST_CASE(license_not_expired) {
	vector<string> extraArgs;
	extraArgs.push_back("-e");
	extraArgs.push_back("2050-10-10");
	const string licLocation = generate_license("not_expired.lic", extraArgs);
	/* */
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);

	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(license.has_expiry, true);
	BOOST_CHECK_EQUAL(license.linked_to_pc, false);
	BOOST_CHECK_GT(license.days_left, (unsigned int)0);
}

BOOST_AUTO_TEST_CASE(license_expired) {
	vector<string> extraArgs;
	extraArgs.push_back("-e");
	extraArgs.push_back("2013-10-10");
	const string licLocation = generate_license("expired", extraArgs);
	/* */
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	BOOST_TEST_MESSAGE("before acquire license");
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, PRODUCT_EXPIRED);
	BOOST_CHECK_EQUAL(license.has_expiry, true);
	BOOST_CHECK_EQUAL(license.linked_to_pc, false);
	BOOST_CHECK_EQUAL(license.days_left, 0);
}

BOOST_AUTO_TEST_CASE(license_valid_from_past) {
	vector<string> extraArgs;
	extraArgs.push_back("--valid-from");
	extraArgs.push_back("2020-01-01");
	const string licLocation = generate_license("valid_from_past", extraArgs);
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);

	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(license.has_expiry, false);
	BOOST_CHECK_EQUAL(license.linked_to_pc, false);
}

BOOST_AUTO_TEST_CASE(license_valid_from_future) {
	vector<string> extraArgs;
	extraArgs.push_back("--valid-from");
	extraArgs.push_back("2050-10-10");
	const string licLocation = generate_license("valid_from_future", extraArgs);
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);

	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, PRODUCT_EXPIRED);
	BOOST_CHECK_EQUAL(license.has_expiry, false);
	BOOST_CHECK_EQUAL(license.linked_to_pc, false);
}

BOOST_AUTO_TEST_CASE(canonical_date_parser_rejects_noncanonical_or_impossible_dates) {
	const vector<string> invalid_dates = {"20501010",	  "2050/10/10", "2050-02-30", "2021-02-29",
										  "2050-00-01", "2050-01-00", "2050-13-01", "2050-10-10x",
										  " 2050-10-10", "2050-10-10 "};
	for (const string &date : invalid_dates) {
		BOOST_CHECK_MESSAGE(!is_canonical_v200_date(date), "Date should be rejected: " + date);
		BOOST_CHECK_THROW(seconds_from_epoch(date), invalid_argument);
	}
	BOOST_CHECK(is_canonical_v200_date("2020-02-29"));
	BOOST_CHECK_NO_THROW(seconds_from_epoch("2020-02-29"));
}

BOOST_AUTO_TEST_CASE(verifier_rejects_malformed_date_limits_without_normalization) {
	const vector<string> invalid_dates = {"20501010",	"2050/10/10", "2050-02-30", "2021-02-29",
										  "2050-00-01", "2050-01-00", "2050-13-01", "2050-10-10x"};
	for (const string &date : invalid_dates) {
		EventRegistry expiry_registry;
		BOOST_CHECK_EQUAL(verify_single_date_limit(PARAM_EXPIRY_DATE, date, expiry_registry), FUNC_RET_ERROR);
		expiry_registry.turnWarningsIntoErrors();
		BOOST_REQUIRE(expiry_registry.getLastFailure() != nullptr);
		BOOST_CHECK_EQUAL(expiry_registry.getLastFailure()->event_type, LICENSE_MALFORMED);

		EventRegistry start_registry;
		BOOST_CHECK_EQUAL(verify_single_date_limit(PARAM_BEGIN_DATE, date, start_registry), FUNC_RET_ERROR);
		start_registry.turnWarningsIntoErrors();
		BOOST_REQUIRE(start_registry.getLastFailure() != nullptr);
		BOOST_CHECK_EQUAL(start_registry.getLastFailure()->event_type, LICENSE_MALFORMED);
	}
}

}  // namespace test
}  // namespace license
