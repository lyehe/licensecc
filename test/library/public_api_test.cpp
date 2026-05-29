/*
 * public_api_test.cpp
 *
 * Tests for the consumer-facing helpers in licensecc.h: lcc_strerror() and
 * print_error().
 */
#define BOOST_TEST_MODULE public_api_test

#include <cstring>
#include <string>
#include <boost/test/unit_test.hpp>

#include <licensecc_properties.h>
#include <licensecc/licensecc.h>
#include "../../src/library/base/EventRegistry.h"

namespace license {
namespace test {
using namespace std;

BOOST_AUTO_TEST_CASE(lcc_strerror_known_and_unknown) {
	BOOST_CHECK(string(lcc_strerror(PRODUCT_EXPIRED)).find("expired") != string::npos);
	BOOST_CHECK(string(lcc_strerror(LICENSE_OK)).find("OK") != string::npos);
	// an out-of-range value must still return a non-null, non-empty string
	const char *unknown = lcc_strerror(static_cast<LCC_EVENT_TYPE>(9999));
	BOOST_REQUIRE(unknown != nullptr);
	BOOST_CHECK(strlen(unknown) > 0);
}

BOOST_AUTO_TEST_CASE(print_error_renders_failures) {
	EventRegistry er;
	er.addEvent(PRODUCT_NOT_LICENSED, "some.lic");
	er.turnWarningsIntoErrors();
	LicenseInfo info;
	er.exportLastEvents(info.status, LCC_API_AUDIT_EVENT_NUM);

	char buffer[LCC_API_ERROR_BUFFER_SIZE];
	print_error(buffer, &info);
	const string out(buffer);
	BOOST_CHECK_MESSAGE(out.find("not licensed") != string::npos, "describes the failure, got: " + out);
	BOOST_CHECK_MESSAGE(out.find("some.lic") != string::npos, "includes the reference, got: " + out);
}

BOOST_AUTO_TEST_CASE(print_error_null_safe) {
	char buffer[LCC_API_ERROR_BUFFER_SIZE];
	print_error(buffer, nullptr);
	BOOST_CHECK(strlen(buffer) > 0);  // defined, non-empty, NUL-terminated
	print_error(nullptr, nullptr);    // must not crash
}

}  // namespace test
}  // namespace license
