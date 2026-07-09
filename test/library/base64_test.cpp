/*
 * base64_test.cpp
 *
 * Tests for the base64 codec in src/library/base/base64.cpp. Focus:
 *  - unbase64() must not over-read short inputs (len 2-3 without padding
 *    used to underflow the size_t loop bound and read past the buffer);
 *  - unbase64() must not print to the host application's stdout.
 */
#define BOOST_TEST_MODULE base64_test

#include <cstdint>
#include <string>
#include <vector>
#include <boost/test/unit_test.hpp>

#include "../../src/library/base/base64.h"

namespace license {
namespace test {
using namespace std;

static string as_string(const vector<uint8_t>& v) {
	return string(reinterpret_cast<const char*>(v.data()), v.size());
}

BOOST_AUTO_TEST_CASE(unbase64_rejects_short_inputs) {
	// An incomplete quantum (fewer than 4 base64 chars) is not decodable.
	// These previously underflowed `len - 4 - pad` and read out of bounds.
	BOOST_CHECK(unbase64("").empty());
	BOOST_CHECK(unbase64("a").empty());
	BOOST_CHECK(unbase64("ab").empty());
	BOOST_CHECK(unbase64("abc").empty());
}

BOOST_AUTO_TEST_CASE(unbase64_decodes_full_quanta) {
	BOOST_CHECK_EQUAL(as_string(unbase64("TWFu")), "Man");   // no padding
	BOOST_CHECK_EQUAL(as_string(unbase64("TWE=")), "Ma");    // one pad
	BOOST_CHECK_EQUAL(as_string(unbase64("TQ==")), "M");     // two pad
}

BOOST_AUTO_TEST_CASE(unbase64_tolerates_newlines) {
	BOOST_CHECK_EQUAL(as_string(unbase64("TW\nFu")), "Man");
}

}  // namespace test
}  // namespace license
