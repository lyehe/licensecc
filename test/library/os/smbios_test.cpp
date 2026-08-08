#define BOOST_TEST_MODULE test_smbios

#include <boost/test/unit_test.hpp>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "../../../src/library/os/windows/smbios.hpp"

// Regression coverage for the bounded SMBIOS walk (iterative review rounds 5-7).
// The parser reads firmware-provided bytes; a structure with a bogus length or an
// unterminated string table must never read past the buffer. The assertions here are
// implicitly "no out-of-bounds read": a regression that drops the buffer-end bound
// trips the Windows Debug heap (or ASan) on these malformed inputs instead of
// silently over-reading.

using smbios::byte_t;
using smbios::parser;
using smbios::string_array_t;

namespace {

void parse_and_materialize(const std::vector<byte_t> &buf) {
	parser p;
	p.feed(buf.empty() ? reinterpret_cast<const byte_t *>("") : buf.data(), buf.size());
	for (auto *h : p.headers) {
		string_array_t strings;
		parser::extract_strings(h, strings, p.buffer_end());
		BOOST_CHECK(!strings.empty());  // always carries the index-0 sentinel
		// Materializing each pushed string is exactly what the DMI consumer does;
		// the +2 guard bytes keep std::string() in-bounds even for a string that
		// runs to the end of the buffer without its own terminator.
		for (std::size_t i = 1; i < strings.size(); ++i) {
			const std::size_t len = std::string(strings[i]).size();
			(void)len;
		}
	}
}

}  // namespace

BOOST_AUTO_TEST_CASE(smbios_parser_handles_empty_table) {
	parser p;
	const byte_t sentinel = 0;
	p.feed(&sentinel, 0);
	BOOST_CHECK(p.headers.empty());
}

BOOST_AUTO_TEST_CASE(smbios_parser_clamps_bogus_structure_length) {
	// A type-4 header at the very end declaring length 200 with no room for it.
	const std::vector<byte_t> buf = {4, 200, 0, 0};
	BOOST_CHECK_NO_THROW(parse_and_materialize(buf));
}

BOOST_AUTO_TEST_CASE(smbios_parser_bounds_unterminated_string_table) {
	// header(length 4) + "abc" with NO terminating double-NUL before end-of-buffer.
	const std::vector<byte_t> buf = {4, 4, 0, 0, 'a', 'b', 'c'};
	BOOST_CHECK_NO_THROW(parse_and_materialize(buf));
}

BOOST_AUTO_TEST_CASE(smbios_parser_reads_well_formed_strings) {
	// type 1, length 4 (header only), strings "Vendor"/"Product", terminating double-NUL.
	std::vector<byte_t> buf = {1, 4, 0, 0};
	for (const char *s : {"Vendor", "Product"}) {
		for (const char *c = s; *c != '\0'; ++c) {
			buf.push_back(static_cast<byte_t>(*c));
		}
		buf.push_back(0);
	}
	buf.push_back(0);  // terminating double-NUL of the string table

	parser p;
	p.feed(buf.data(), buf.size());
	BOOST_REQUIRE_EQUAL(p.headers.size(), static_cast<size_t>(1));
	string_array_t strings;
	parser::extract_strings(p.headers[0], strings, p.buffer_end());
	BOOST_REQUIRE_EQUAL(strings.size(), static_cast<size_t>(3));  // sentinel + 2 strings
	BOOST_CHECK_EQUAL(std::string(strings[1]), "Vendor");
	BOOST_CHECK_EQUAL(std::string(strings[2]), "Product");
}
