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

struct CustomLimitProbe {
	string expected;
	LCC_CUSTOM_LIMIT_RESULT result = LCC_CUSTOM_LIMIT_ERROR;
	size_t calls = 0;
};

static LCC_CUSTOM_LIMIT_RESULT evaluate_custom_limit(void* user_data, const char* policy, size_t policy_size) {
	CustomLimitProbe* probe = static_cast<CustomLimitProbe*>(user_data);
	++probe->calls;
	BOOST_CHECK_EQUAL(string(policy, policy_size), probe->expected);
	BOOST_CHECK_EQUAL(policy[policy_size], '\0');
	return probe->result;
}

static LCC_EVENT_TYPE verify_custom_limit(LCC_CUSTOM_LIMIT_CHECK callback, void* user_data,
										  const string& policy = "cpu<=8") {
	FullLicenseInfo full("source", "PRODUCT", "sig");
	full.m_limits[LICENSE_VERSION] = "201";
	full.m_limits[PARAM_CUSTOM_LIMIT] = policy;
	EventRegistry er;
	LicenseVerifier verifier(er);
	const FUNCTION_RETURN result = verifier.verify_limits(full, nullptr, callback, user_data);
	if (result == FUNC_RET_OK) {
		return LICENSE_OK;
	}
	er.turnWarningsIntoErrors();
	const AuditEvent* failure = er.getLastFailure();
	return failure == nullptr ? LICENSE_MALFORMED : failure->event_type;
}

BOOST_AUTO_TEST_CASE(signed_custom_limit_evaluator_is_fail_closed_and_typed) {
	CustomLimitProbe probe{"cpu<=8", LCC_CUSTOM_LIMIT_ALLOW};
	BOOST_CHECK_EQUAL(verify_custom_limit(evaluate_custom_limit, &probe), LICENSE_OK);
	BOOST_CHECK_EQUAL(probe.calls, 1U);

	probe.result = LCC_CUSTOM_LIMIT_DENY;
	BOOST_CHECK_EQUAL(verify_custom_limit(evaluate_custom_limit, &probe), LICENSE_CUSTOM_LIMIT_DENIED);
	probe.result = LCC_CUSTOM_LIMIT_ERROR;
	BOOST_CHECK_EQUAL(verify_custom_limit(evaluate_custom_limit, &probe),
					  LICENSE_CUSTOM_LIMIT_EVALUATION_FAILED);
	BOOST_CHECK_EQUAL(verify_custom_limit(nullptr, nullptr), LICENSE_CUSTOM_LIMIT_EVALUATION_FAILED);
	BOOST_CHECK_EQUAL(verify_custom_limit(evaluate_custom_limit, &probe, string(LCC_API_CUSTOM_LIMIT_SIZE + 1, 'x')),
					  LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(signed_custom_limit_rejects_values_outside_the_public_policy_contract) {
	CustomLimitProbe probe{"unused", LCC_CUSTOM_LIMIT_ALLOW};
	for (const string& invalid : {string(" leading"), string("trailing "), string("line\nbreak"),
								 string("non-ascii-") + static_cast<char>(0x80)}) {
		BOOST_CHECK_EQUAL(verify_custom_limit(evaluate_custom_limit, &probe, invalid), LICENSE_MALFORMED);
	}
	BOOST_CHECK_EQUAL(probe.calls, 0U);
}

}  // namespace test
}  // namespace license
