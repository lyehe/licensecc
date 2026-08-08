#define BOOST_TEST_MODULE "test_event_registry"

#include <iostream>
#include <iterator>

#include <fstream>
#include <string>
#include <vector>

#include <boost/filesystem.hpp>
#include <boost/optional.hpp>
#include <boost/test/unit_test.hpp>
#include <stdlib.h>
#include <cstdio>
#include <cstring>

#include "../../src/library/base/EventRegistry.h"

namespace test {

using namespace std;
using namespace license;

/**
 * The error reported is for the license that advanced most in the validation process
 *
 */
BOOST_AUTO_TEST_CASE(test_most_advanced_license_error) {
	EventRegistry er;
	er.addEvent(LICENSE_SPECIFIED, "lic2");
	er.addEvent(LICENSE_FOUND, "lic1");
	er.addEvent(LICENSE_CORRUPTED, "lic1");
	er.turnWarningsIntoErrors();
	const AuditEvent *event = er.getLastFailure();
	BOOST_CHECK_MESSAGE(event != nullptr, "An error is detected");
	BOOST_CHECK_MESSAGE(string("lic1") == event->license_reference, "Error is for lic1");
	BOOST_CHECK_MESSAGE(LICENSE_CORRUPTED == event->event_type, "Error is for LICENSE_CORRUPTED");
}

/**
 * to_string must render the registry contents, not stream the `this` pointer.
 */
BOOST_AUTO_TEST_CASE(to_string_renders_contents) {
	EventRegistry er;
	er.addEvent(LICENSE_FOUND, "lic1");
	const string s = er.to_string();
	BOOST_CHECK_MESSAGE(s.find("EventReg[step:") != string::npos, "to_string renders the registry, got: " + s);
}

/**
 * An over-length license reference must be truncated and NUL-terminated within
 * the AuditEvent buffer (previously copied with a non-terminating strncpy).
 */
BOOST_AUTO_TEST_CASE(addEvent_truncates_and_terminates_long_reference) {
	EventRegistry er;
	const string longRef(LCC_API_PATH_SIZE + 50, 'x');
	er.addEvent(PRODUCT_NOT_LICENSED, longRef);
	AuditEvent ev;
	er.exportLastEvents(&ev, 1);
	BOOST_CHECK_EQUAL(strlen(ev.license_reference), (size_t)LCC_API_PATH_SIZE - 1);
}

}  // namespace test
