/*
 * license_verifier_test.cpp
 *
 *  Created on: Nov 20, 2019
 *      Author: devel
 */
#define BOOST_TEST_MODULE license_verifier_test

#include <string>
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

}  // namespace test
}  // namespace license
