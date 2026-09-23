#define BOOST_TEST_MODULE device_bound_callback_test
#include <boost/test/unit_test.hpp>
#include "bound_callback.hpp"
#include "p256_crypto.hpp"

using namespace license::device_identity;
namespace {
const std::string uri = "http://127.0.0.1:49152/callback";
const std::string target = "/callback?code=" + std::string(43, 'A') + "&state=" + std::string(43, 'B');
std::string request(const std::string& headers = "Host: 127.0.0.1:49152\r\n") {
	return "GET " + target + " HTTP/1.1\r\n" + headers + "\r\n";
}
}  // namespace
BOOST_AUTO_TEST_CASE(bodyless_callback_finishes_at_headers_without_waiting_for_eof) {
	const auto wire = request();
	std::string_view out = "untouched";
	for (std::size_t size = 0; size < wire.size(); ++size) {
		BOOST_CHECK(parse_bound_callback_http(std::string_view(wire).substr(0, size), uri, out) ==
					BoundCallbackParse::incomplete);
		BOOST_CHECK_EQUAL(out, "untouched");
	}
	BOOST_CHECK(parse_bound_callback_http(wire, uri, out) == BoundCallbackParse::complete);
	BOOST_CHECK_EQUAL(out, target);
	BOOST_CHECK(out.data() == wire.data() + 4);
	BOOST_CHECK(parse_bound_callback_http(
					request("hOsT:\t127.0.0.1:49152 \r\nContent-Length: 0\r\nAccept: text/html\r\n"), uri, out) ==
				BoundCallbackParse::complete);
}
BOOST_AUTO_TEST_CASE(callback_http_rejects_host_framing_and_path_ambiguity) {
	const std::vector<std::string> headers{"",
										   "Host: localhost:49152\r\n",
										   "Host: 127.0.0.1:49153\r\n",
										   "Host: 127.0.0.1:49152\r\nHost: 127.0.0.1:49152\r\n",
										   "Host: 127.0.0.1:49152\r\nTransfer-Encoding: chunked\r\n",
										   "Host: 127.0.0.1:49152\r\nContent-Length: 1\r\n",
										   "Host: 127.0.0.1:49152\r\nContent-Length: 00\r\n",
										   "Host: 127.0.0.1:49152\r\nContent-Length: 0\r\ncontent-length: 0\r\n",
										   "Host : 127.0.0.1:49152\r\n",
										   "Host: 127.0.0.1:49152\r\n folded: value\r\n",
										   "Host: 127.0.0.1:49152\r\nExpect: 100-continue\r\n",
										   "Host: 127.0.0.1:49152\r\nBad: raw\nnewline\r\n"};
	std::string_view out = "untouched";
	for (const auto& header : headers)
		BOOST_CHECK(parse_bound_callback_http(request(header), uri, out) == BoundCallbackParse::invalid);
	const std::vector<std::string> lines{"POST " + target + " HTTP/1.1",
										 "GET " + target + " HTTP/1.0",
										 "GET http://127.0.0.1:49152" + target + " HTTP/1.1",
										 "GET /other?code=x HTTP/1.1",
										 "GET /callback?code=%41 HTTP/1.1",
										 "GET " + target + "#fragment HTTP/1.1"};
	for (const auto& line : lines)
		BOOST_CHECK(parse_bound_callback_http(line + "\r\nHost: 127.0.0.1:49152\r\n\r\n", uri, out) ==
					BoundCallbackParse::invalid);
	BOOST_CHECK(parse_bound_callback_http(request() + "extra", uri, out) == BoundCallbackParse::invalid);
	BOOST_CHECK(parse_bound_callback_http(request() + request(), uri, out) == BoundCallbackParse::invalid);
	BOOST_CHECK(parse_bound_callback_http(std::string(8192, 'x'), uri, out) == BoundCallbackParse::invalid);
	BOOST_CHECK_EQUAL(out, "untouched");
}
BOOST_AUTO_TEST_CASE(response_pages_have_exact_lengths_csp_hashes_and_no_query_reflection) {
	for (bool accepted : {false, true}) {
		const auto& response = bound_callback_http_response(accepted);
		const auto body_start = response.find("\r\n\r\n") + 4;
		const auto body = response.substr(body_start);
		BOOST_CHECK(response.find("Content-Length: " + std::to_string(body.size()) + "\r\n") != std::string::npos);
		BOOST_CHECK(response.find("Cache-Control: no-store\r\n") != std::string::npos);
		BOOST_CHECK(response.find("Referrer-Policy: no-referrer\r\n") != std::string::npos);
		const auto start = body.find("<script>") + 8;
		const auto script = body.substr(start, body.find("</script>") - start);
		BOOST_CHECK_EQUAL(script, "history.replaceState(null,'','/complete');");
		P256Digest digest;
		BOOST_REQUIRE(sha256(reinterpret_cast<const std::uint8_t*>(script.data()), script.size(), digest));
		BOOST_CHECK(response.find("'sha256-" + encode_canonical_base64(digest.data(), digest.size()) + "'") !=
					std::string::npos);
		const auto style_start = body.find("<style>") + 7;
		const auto style = body.substr(style_start, body.find("</style>") - style_start);
		BOOST_REQUIRE(sha256(reinterpret_cast<const std::uint8_t*>(style.data()), style.size(), digest));
		BOOST_CHECK(response.find("style-src 'sha256-" + encode_canonical_base64(digest.data(), digest.size()) + "'") !=
					std::string::npos);
		BOOST_CHECK(body.find("name=viewport") != std::string::npos);
		BOOST_CHECK(body.find(accepted ? "Return to your app to finish activation" : "start Connect again") !=
					std::string::npos);
		BOOST_CHECK(response.find("default-src 'none'") != std::string::npos);
		BOOST_CHECK(response.find("frame-ancestors 'none'") != std::string::npos);
		BOOST_CHECK(response.find(target) == std::string::npos);
	}
}
