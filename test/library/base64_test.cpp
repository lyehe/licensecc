#define BOOST_TEST_MODULE test_base64

#include <cstdint>
#include <string>
#include <vector>

#include <boost/test/unit_test.hpp>

#include "../../src/library/base/base64.h"

namespace license {
namespace test {
using namespace std;

BOOST_AUTO_TEST_CASE(reject_invalid_base64_input) {
	BOOST_CHECK(unbase64("").empty());
	BOOST_CHECK(unbase64("A").empty());
	BOOST_CHECK(unbase64("AA").empty());
	BOOST_CHECK(unbase64("AAA").empty());
	BOOST_CHECK(unbase64("!!!!").empty());
	BOOST_CHECK(unbase64("AA=A").empty());
	BOOST_CHECK(unbase64("AAAA====").empty());
	BOOST_CHECK(unbase64("AAAA-").empty());
	BOOST_CHECK(unbase64("AAAA ").empty());
	BOOST_CHECK(unbase64("AAAA\t").empty());

	const string high_bit_input = string("AAA") + static_cast<char>(0x80);
	BOOST_CHECK(unbase64(high_bit_input).empty());

	const string embedded_nul_input(string("AA", 2) + string(1, '\0') + string("A", 1));
	BOOST_CHECK(unbase64(embedded_nul_input).empty());
}

BOOST_AUTO_TEST_CASE(reject_noncanonical_base64_pad_bits) {
	BOOST_CHECK(unbase64("QR==").empty());
	BOOST_CHECK(unbase64("QUF=").empty());
}

BOOST_AUTO_TEST_CASE(decode_padded_base64_input) {
	const vector<uint8_t> one_byte = unbase64("QQ==");
	BOOST_REQUIRE_EQUAL(one_byte.size(), 1);
	BOOST_CHECK_EQUAL(one_byte[0], static_cast<uint8_t>('A'));

	const vector<uint8_t> one_byte_with_line_endings = unbase64("Q\r\nQ==");
	BOOST_REQUIRE_EQUAL(one_byte_with_line_endings.size(), 1);
	BOOST_CHECK_EQUAL(one_byte_with_line_endings[0], static_cast<uint8_t>('A'));

	const vector<uint8_t> one_byte_with_outer_line_endings = unbase64("\r\nQQ==\r\n");
	BOOST_REQUIRE_EQUAL(one_byte_with_outer_line_endings.size(), 1);
	BOOST_CHECK_EQUAL(one_byte_with_outer_line_endings[0], static_cast<uint8_t>('A'));

	const vector<uint8_t> two_bytes = unbase64("QUE=");
	BOOST_REQUIRE_EQUAL(two_bytes.size(), 2);
	BOOST_CHECK_EQUAL(two_bytes[0], static_cast<uint8_t>('A'));
	BOOST_CHECK_EQUAL(two_bytes[1], static_cast<uint8_t>('A'));
}

BOOST_AUTO_TEST_CASE(canonical_base64_policy_matches_decoder) {
	BOOST_CHECK(is_canonical_base64("QQ=="));
	BOOST_CHECK(is_canonical_base64("Q\r\nQ=="));
	BOOST_CHECK(!is_canonical_base64("Q\r\nQ==", false));
	BOOST_CHECK(!is_canonical_base64(""));
	BOOST_CHECK(!is_canonical_base64("QR=="));
	BOOST_CHECK(!is_canonical_base64("QUF="));
	BOOST_CHECK(!is_canonical_base64("AAAA "));
}

BOOST_AUTO_TEST_CASE(round_trip_preserves_binary_length) {
	const vector<uint8_t> data = {0x00, 0x41, 0x00, 0xff, 0x10, 0x7f};
	const string encoded = base64(data.data(), data.size());
	const vector<uint8_t> decoded = unbase64(encoded);
	BOOST_CHECK_EQUAL_COLLECTIONS(data.begin(), data.end(), decoded.begin(), decoded.end());
}

BOOST_AUTO_TEST_CASE(round_trip_large_binary_input) {
	vector<uint8_t> data(1024 * 1024);
	for (size_t i = 0; i < data.size(); ++i) {
		data[i] = static_cast<uint8_t>((i * 131U + 17U) & 0xffU);
	}
	const string encoded = base64(data.data(), data.size(), 0);
	BOOST_CHECK(is_canonical_base64(encoded, false));
	const vector<uint8_t> decoded = unbase64(encoded);
	BOOST_CHECK_EQUAL_COLLECTIONS(data.begin(), data.end(), decoded.begin(), decoded.end());
}

BOOST_AUTO_TEST_CASE(encode_short_inputs) {
	const vector<uint8_t> empty;
	BOOST_CHECK_EQUAL(base64(empty.data(), empty.size()), "");
	BOOST_CHECK_EQUAL(base64(empty.data(), empty.size(), 5), "");

	const vector<uint8_t> one_byte = {0x00};
	BOOST_CHECK_EQUAL(base64(one_byte.data(), one_byte.size()), "AA==\n");
	BOOST_CHECK_EQUAL(base64(one_byte.data(), one_byte.size(), 0), "AA==");
	BOOST_CHECK_EQUAL(base64(one_byte.data(), one_byte.size(), 5), "AA==\n");

	const vector<uint8_t> two_bytes = {0x00, 0xff};
	BOOST_CHECK_EQUAL(base64(two_bytes.data(), two_bytes.size()), "AP8=\n");
	BOOST_CHECK_EQUAL(base64(two_bytes.data(), two_bytes.size(), 0), "AP8=");
	BOOST_CHECK_EQUAL(base64(two_bytes.data(), two_bytes.size(), 5), "AP8=\n");
}

}  // namespace test
}  // namespace license
