/*
 * license_verifier_test.cpp
 *
 *  Created on: Nov 20, 2019
 *      Author: devel
 */
#define BOOST_TEST_MODULE license_verifier_test

#include <string>
#include <vector>
#include <boost/test/unit_test.hpp>

#include "../../src/library/base/EventRegistry.h"
#include "../../src/library/base/base.h"
#include "../../src/library/LicenseReader.hpp"
#include "../../src/library/limits/license_verifier.hpp"

namespace license {
namespace test {
using namespace std;

/**
 * toLicenseInfo must populate license_version from the parsed limits and leave
 * unset numeric fields zeroed (regression: the struct used to be left
 * uninitialized, so license_version was indeterminate).
 */
BOOST_AUTO_TEST_CASE(to_license_info_sets_version) {
	FullLicenseInfo full("source", "PRODUCT", "sig");
	full.m_limits[LICENSE_VERSION] = "200";
	EventRegistry er;
	LicenseVerifier verifier(er);

	const LicenseInfo info = verifier.toLicenseInfo(full);
	BOOST_CHECK_EQUAL(info.license_version, 200);
	BOOST_CHECK_EQUAL(info.license_type, LCC_LOCAL);
	BOOST_CHECK_MESSAGE(!info.has_expiry, "no expiry limit -> has_expiry false");
}

/**
 * When no license version is present the field must be a defined value (0),
 * never indeterminate.
 */
BOOST_AUTO_TEST_CASE(to_license_info_version_defaults_to_zero) {
	FullLicenseInfo full("source", "PRODUCT", "sig");
	EventRegistry er;
	LicenseVerifier verifier(er);

	const LicenseInfo info = verifier.toLicenseInfo(full);
	BOOST_CHECK_EQUAL(info.license_version, 0);
}

static LCC_EVENT_TYPE verify_extra_data_result(const string& extra_data) {
	FullLicenseInfo full("source", "PRODUCT", "sig");
	full.m_limits[LICENSE_VERSION] = "200";
	full.m_limits[PARAM_EXTRA_DATA] = extra_data;
	EventRegistry er;
	LicenseVerifier verifier(er);

	const FUNCTION_RETURN result = verifier.verify_limits(full, nullptr);
	if (result == FUNC_RET_OK) {
		return LICENSE_OK;
	}
	er.turnWarningsIntoErrors();
	const AuditEvent* failure = er.getLastFailure();
	return failure == nullptr ? LICENSE_OK : failure->event_type;
}

BOOST_AUTO_TEST_CASE(verify_limits_rejects_malformed_extra_data) {
	BOOST_CHECK_EQUAL(verify_extra_data_result(string(LCC_API_PROPRIETARY_DATA_SIZE, 'x')), LICENSE_OK);

	const vector<string> invalid_values = {"", " leading", "trailing ", "line\nbreak", "tab\tvalue",
										   string("nul") + '\0' + "byte",
										   string(LCC_API_PROPRIETARY_DATA_SIZE + 1, 'x')};
	for (const string& value : invalid_values) {
		BOOST_CHECK_EQUAL(verify_extra_data_result(value), LICENSE_MALFORMED);
	}
}

BOOST_AUTO_TEST_CASE(to_license_info_does_not_truncate_invalid_extra_data) {
	FullLicenseInfo full("source", "PRODUCT", "sig");
	full.m_limits[LICENSE_VERSION] = "200";
	full.m_limits[PARAM_EXTRA_DATA] = string(LCC_API_PROPRIETARY_DATA_SIZE + 1, 'x');
	EventRegistry er;
	LicenseVerifier verifier(er);

	const LicenseInfo info = verifier.toLicenseInfo(full);
	BOOST_CHECK_EQUAL(info.proprietary_data[0], '\0');
}

}  // namespace test
}  // namespace license
