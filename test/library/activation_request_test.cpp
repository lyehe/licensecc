#define BOOST_TEST_MODULE test_activation_request

#include <cstdint>
#include <string>

#include <boost/test/unit_test.hpp>

#include "../../src/library/activation/ActivationRequest.hpp"
#include "../../src/library/base/base64.h"

namespace license {
namespace test {
using namespace std;
using license::activation::ActivationRequestFields;
using license::activation::build_activation_request;
using license::activation::parse_activation_request;

static ActivationRequestFields sample() {
	ActivationRequestFields f;
	f.project = "DEFAULT";
	f.feature = "PREMIUM";
	// A canonical hwid as identify_pc() prints it -- note the trailing base64 '=' padding, which the
	// codec must round-trip through its `key=value` framing.
	f.hwid = "AABQ-6/bO-ATs=";
	f.nonce = 0xFEEDFACECAFEBEEDULL;
	f.issued_at = 1751328000;
	return f;
}

BOOST_AUTO_TEST_CASE(round_trips_including_hwid_with_equals) {
	const ActivationRequestFields in = sample();
	const string token = build_activation_request(in);
	BOOST_REQUIRE(!token.empty());
	BOOST_CHECK(token.compare(0, 9, "lccareq1.") == 0);

	ActivationRequestFields out;
	string error;
	BOOST_REQUIRE_MESSAGE(parse_activation_request(token, out, error), error);
	BOOST_CHECK_EQUAL(out.project, in.project);
	BOOST_CHECK_EQUAL(out.feature, in.feature);
	BOOST_CHECK_EQUAL(out.hwid, in.hwid);  // trailing '=' preserved
	BOOST_CHECK_EQUAL(out.nonce, in.nonce);
	BOOST_CHECK_EQUAL(out.issued_at, in.issued_at);
}

BOOST_AUTO_TEST_CASE(rejects_wrong_prefix) {
	ActivationRequestFields out;
	string error;
	BOOST_CHECK(!parse_activation_request("lcccfg1.QUJD", out, error));
	BOOST_CHECK(!parse_activation_request("QUJD", out, error));
	BOOST_CHECK(!parse_activation_request("lccareq1.", out, error));  // empty payload
}

BOOST_AUTO_TEST_CASE(rejects_non_canonical_base64_payload) {
	ActivationRequestFields out;
	string error;
	BOOST_CHECK(!parse_activation_request("lccareq1.!!!!", out, error));
	// A second dot (a signature segment) is not part of the two-segment request envelope.
	BOOST_CHECK(!parse_activation_request("lccareq1.QUJD.QUJD", out, error));
}

BOOST_AUTO_TEST_CASE(rejects_missing_or_reordered_fields) {
	// Payload with feature/project swapped -> out of order.
	const string swapped_payload = "feature=F\nproject=P\nhwid=X\nnonce=1\nissued-at=2\n";
	const string token = string("lccareq1.") + license::base64(swapped_payload.data(), swapped_payload.size(), 0);
	ActivationRequestFields out;
	string error;
	BOOST_CHECK(!parse_activation_request(token, out, error));

	// Payload missing issued-at.
	const string short_payload = "project=P\nfeature=F\nhwid=X\nnonce=1\n";
	const string short_token = string("lccareq1.") + license::base64(short_payload.data(), short_payload.size(), 0);
	BOOST_CHECK(!parse_activation_request(short_token, out, error));
}

BOOST_AUTO_TEST_CASE(rejects_trailing_garbage_and_bad_numbers) {
	ActivationRequestFields out;
	string error;

	const string trailing = "project=P\nfeature=F\nhwid=X\nnonce=1\nissued-at=2\nextra=3\n";
	const string trailing_token = string("lccareq1.") + license::base64(trailing.data(), trailing.size(), 0);
	BOOST_CHECK(!parse_activation_request(trailing_token, out, error));

	const string bad_nonce = "project=P\nfeature=F\nhwid=X\nnonce=notanumber\nissued-at=2\n";
	const string bad_nonce_token = string("lccareq1.") + license::base64(bad_nonce.data(), bad_nonce.size(), 0);
	BOOST_CHECK(!parse_activation_request(bad_nonce_token, out, error));
}

BOOST_AUTO_TEST_CASE(build_rejects_line_breaks_in_values) {
	ActivationRequestFields f = sample();
	f.feature = "bad\nvalue";
	BOOST_CHECK(build_activation_request(f).empty());
}

}  // namespace test
}  // namespace license
