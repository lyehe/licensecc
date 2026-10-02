#define BOOST_TEST_MODULE device_bound_wire_test
#include <boost/property_tree/json_parser.hpp>
#include <boost/test/unit_test.hpp>
#include "bound_wire.hpp"
#include "bound_json.hpp"
#include <fstream>
#include <tuple>

using namespace license::device_identity;
namespace {
const std::string trace = "00000000-0000-4000-8000-000000000000";
boost::property_tree::ptree vector(const char* name = "protocol.json") {
	std::ifstream file(std::string(LCC_DEVICE_IDENTITY_VECTOR_ROOT) + "/device_bound/v1/" + name);
	BOOST_REQUIRE(file.good());
	boost::property_tree::ptree result;
	boost::property_tree::read_json(file, result);
	return result;
}
std::string replace(std::string text, const std::string& before, const std::string& after) {
	const auto position = text.find(before);
	BOOST_REQUIRE(position != std::string::npos);
	text.replace(position, before.size(), after);
	return text;
}
std::string challenge() { return vector("renewal_wire.json").get<std::string>("challenge_response"); }
std::string renewal() { return vector("renewal_wire.json").get<std::string>("renew_response"); }
std::string error(const std::string& code) {
	return "{\"ok\":false,\"code\":\"" + code + "\",\"request_id\":\"" + trace + "\"}";
}
}  // namespace

BOOST_AUTO_TEST_CASE(strict_json_accepts_ordinary_escapes_whitespace_and_safe_numbers) {
	bound_json::Value out;
	BOOST_REQUIRE(bound_json::parse(
		" \n{\"x\":\"\\uD83D\\uDE00\\n\\t\\b\\f\\r\\/\\\\\\\"\",\"n\":9007199254740991,\"b\":false,\"o\":{}}\r\n",
		out));
	BOOST_CHECK_EQUAL(out.fields.at("n").number, 9007199254740991ULL);
	BOOST_CHECK_EQUAL(out.fields.at("x").text.substr(0, 4), std::string("\xf0\x9f\x98\x80", 4));
	BOOST_CHECK(!out.fields.at("b").boolean);
	BOOST_REQUIRE(bound_json::parse("{}" + std::string(16382, ' '), out));
	BOOST_CHECK(!bound_json::parse("{}" + std::string(16383, ' '), out));
}
BOOST_AUTO_TEST_CASE(registration_wire_matches_shared_fixture_and_normalizes_labels) {
	const auto v = vector("registration_wire.json");
	const auto r = v.get_child("request");
	BoundAuthorizationInput input{r.get<std::string>("client_id"),		 r.get<std::string>("project"),
								  r.get<std::string>("public_key_spki"), r.get<std::string>("device_label"),
								  r.get<std::string>("redirect_uri"),	 r.get<std::string>("state"),
								  r.get<std::string>("code_challenge"),	 r.get<std::string>("requested_feature")};
	SensitiveVector out;
	BOOST_REQUIRE(encode_bound_authorization(input, out));
	const auto wire = v.get<std::string>("request_json");
	BOOST_CHECK_EQUAL(std::string(out.value.begin(), out.value.end()), wire);
	input.device_label = "\xef\xbb\xbf \t" + r.get<std::string>("device_label") + "\xe3\x80\x80\r\n";
	BOOST_REQUIRE(encode_bound_authorization(input, out));
	BOOST_CHECK_EQUAL(std::string(out.value.begin(), out.value.end()), wire);
	for (const auto& invalid :
		 {std::string(" \t\r\n\xc2\xa0\xe2\x80\xa8"), std::string(81, 'x'), std::string("\xc0\x80")}) {
		input.device_label = invalid;
		BOOST_CHECK(!encode_bound_authorization(input, out));
		BOOST_CHECK_EQUAL(std::string(out.value.begin(), out.value.end()), wire);
	}
	input.device_label = "quote\" slash\\ inside";
	BOOST_REQUIRE(encode_bound_authorization(input, out));
	bound_json::Value decoded;
	BOOST_REQUIRE(bound_json::parse(std::string(out.value.begin(), out.value.end()), decoded));
	BOOST_CHECK_EQUAL(decoded.fields.at("device_label").text, input.device_label);
	std::string emoji;
	for (unsigned i = 0; i < 80; ++i) emoji += "\xf0\x9f\x98\x80";
	input.device_label = emoji;
	BOOST_CHECK(encode_bound_authorization(input, out));
	input.device_label += "x";
	BOOST_CHECK(!encode_bound_authorization(input, out));
}
// The approval page shows the label beside the comparison code, so the app refuses, before
// sending, a label that breaks lines, reorders or hides text, or carries a code of its own.
BOOST_AUTO_TEST_CASE(registration_refuses_labels_that_could_mislead_the_approver) {
	const auto r = vector("registration_wire.json").get_child("request");
	BoundAuthorizationInput input{r.get<std::string>("client_id"),		 r.get<std::string>("project"),
								  r.get<std::string>("public_key_spki"), r.get<std::string>("device_label"),
								  r.get<std::string>("redirect_uri"),	 r.get<std::string>("state"),
								  r.get<std::string>("code_challenge"),	 r.get<std::string>("requested_feature")};
	SensitiveVector out;
	const std::string misleading[] = {
		// C0 controls (BEL, LF, CR, TAB), DEL and C1 controls (U+0085, U+009F) inside the label.
		"My\x07PC", "My PC\nApproved", "My\rPC", "My\tPC", "My\x7fPC", "My\xc2\x85PC", "My\xc2\x9fPC",
		// Line and paragraph separators, U+2028 and U+2029.
		"My\xe2\x80\xa8PC", "My\xe2\x80\xa9PC",
		// Bidi and format controls: U+200B, U+200E, U+200F, U+202A, U+202E, U+2060, U+2064, U+2066,
		// U+2069 and an inner U+FEFF.
		"My\xe2\x80\x8bPC", "\xe2\x80\x8eMy PC", "My\xe2\x80\x8fPC", "My\xe2\x80\xaaPC", "PC\xe2\x80\xaemy",
		"My\xe2\x81\xa0PC", "My\xe2\x81\xa4PC", "My\xe2\x81\xa6PC", "My\xe2\x81\xa9PC", "My\xef\xbb\xbfPC",
		// Anything shaped like a comparison code, in either case and inside a word.
		"code 4F2A-0C12-B7E4 matches", "pick 4f2a-0c12-b7e4", "PC4F2A-0C12-B7E4X"};
	for (const auto& label : misleading) {
		input.device_label = label;
		BOOST_CHECK_MESSAGE(!encode_bound_authorization(input, out), "label must be refused: " << label);
		std::string normalized;
		BOOST_CHECK_MESSAGE(!normalize_bound_device_label(label, normalized), "label must be refused: " << label);
	}
	const std::string accepted[] = {"B\xc3\xbcro-PC", "\xe5\xb7\xa5\xe4\xbd\x9c\xe7\xab\x99",
									"Ana's MacBook Pro (2024)", "build-01.example.com", "Room 4F2A-0C12"};
	for (const auto& label : accepted) {
		input.device_label = label;
		BOOST_CHECK_MESSAGE(encode_bound_authorization(input, out), "label must be accepted: " << label);
	}
	std::string normalized;
	BOOST_REQUIRE(normalize_bound_device_label("\xef\xbb\xbf\t B\xc3\xbcro-PC \r\n", normalized));
	BOOST_CHECK_EQUAL(normalized, "B\xc3\xbcro-PC");
}
// A label may not hide a comparison code behind a character that renders as nothing, or spell one
// with other dashes, spaces or fullwidth forms.
BOOST_AUTO_TEST_CASE(registration_refuses_hidden_or_lookalike_comparison_codes) {
	const auto r = vector("registration_wire.json").get_child("request");
	BoundAuthorizationInput input{r.get<std::string>("client_id"),		 r.get<std::string>("project"),
								  r.get<std::string>("public_key_spki"), r.get<std::string>("device_label"),
								  r.get<std::string>("redirect_uri"),	 r.get<std::string>("state"),
								  r.get<std::string>("code_challenge"),	 r.get<std::string>("requested_feature")};
	SensitiveVector out;
	const std::string refused[] = {
		// Soft hyphen, combining grapheme joiner, variation selector and tag character inside a code.
		"4F2A\xc2\xad-0C12-B7E4",
		"4F2A-0C12-B\xcd\x8f"
		"7E4",
		"4F2A-0C12-B7E\xef\xb8\x8f"
		"4",
		"4F2A-0C12-B7\xf3\xa0\x81\x81"
		"E4",
		// U+206A, U+FFF9, U+061C and U+3164 inside a label.
		"My\xe2\x81\xaaPC", "My\xef\xbf\xb9PC", "My\xd8\x9cPC", "My\xe3\x85\xa4PC",
		// A code separated by en dashes, spaces, spaced em dashes or no-break spaces.
		"4F2A\xe2\x80\x93"
		"0C12\xe2\x80\x93"
		"B7E4",
		"4F2A 0C12 B7E4", "4F2A \xe2\x80\x94 0C12 \xe2\x80\x94 B7E4",
		"4F2A\xc2\xa0"
		"0C12\xc2\xa0"
		"B7E4",
		// A code in fullwidth digits and letters, with fullwidth or ASCII dashes.
		"\xef\xbc\x94\xef\xbc\xa6\xef\xbc\x92\xef\xbc\xa1\xef\xbc\x8d\xef\xbc\x90\xef\xbc\xa3\xef\xbc\x91\xef\xbc\x92"
		"\xef\xbc\x8d\xef\xbc\xa2\xef\xbc\x97\xef\xbc\xa5\xef\xbc\x94",
		"\xef\xbc\x94\xef\xbc\xa6\xef\xbc\x92\xef\xbc\xa1-\xef\xbc\x90\xef\xbc\xa3\xef\xbc\x91\xef\xbc\x92-"
		"\xef\xbc\xa2\xef\xbc\x97\xef\xbc\xa5\xef\xbc\x94"};
	for (const auto& label : refused) {
		input.device_label = label;
		BOOST_CHECK_MESSAGE(!encode_bound_authorization(input, out), "label must be refused: " << label);
		std::string normalized;
		BOOST_CHECK_MESSAGE(!normalize_bound_device_label(label, normalized), "label must be refused: " << label);
	}
	const std::string accepted[] = {"DESKTOP-7Q2K1AB", "Studio \xe2\x80\x93 Mac",
									"Lab PC\xc2\xa0"
									"12",
									"\xef\xbc\xb0\xef\xbc\xa3\xef\xbc\x91\xef\xbc\x92"};
	for (const auto& label : accepted) {
		input.device_label = label;
		BOOST_CHECK_MESSAGE(encode_bound_authorization(input, out), "label must be accepted: " << label);
	}
}
// A label may not spell a comparison code with characters from other scripts whose Unicode
// confusable prototype is a code digit, letter or dash. Ordinary names in those scripts stay valid.
BOOST_AUTO_TEST_CASE(registration_refuses_comparison_codes_spelled_with_lookalikes_from_other_scripts) {
	const auto r = vector("registration_wire.json").get_child("request");
	BoundAuthorizationInput input{r.get<std::string>("client_id"),		 r.get<std::string>("project"),
								  r.get<std::string>("public_key_spki"), r.get<std::string>("device_label"),
								  r.get<std::string>("redirect_uri"),	 r.get<std::string>("state"),
								  r.get<std::string>("code_challenge"),	 r.get<std::string>("requested_feature")};
	SensitiveVector out;
	const std::string refused[] = {
		// Cyrillic capital A (U+0410), Greek capital Alpha (U+0391) and Cyrillic small a (U+0430).
		"4F2\xd0\x90-0C12-B7E4", "4F2\xce\x91-0C12-B7E4", "4f2\xd0\xb0-0c12-b7e4",
		// Mathematical bold digit four (U+1D7D2).
		"\xf0\x9d\x9f\x92"
		"F2A-0C12-B7E4",
		// One code mixing U+1D7D2, Cyrillic A and Es, Greek Beta and Cyrillic Ie with Latin.
		"\xf0\x9d\x9f\x92"
		"F2\xd0\x90-0\xd0\xa1"
		"12-\xce\x92"
		"7\xd0\x95"
		"4",
		// A code separated by minus signs (U+2212).
		"4F2A\xe2\x88\x92"
		"0C12\xe2\x88\x92"
		"B7E4"};
	for (const auto& label : refused) {
		input.device_label = label;
		BOOST_CHECK_MESSAGE(!encode_bound_authorization(input, out), "label must be refused: " << label);
		std::string normalized;
		BOOST_CHECK_MESSAGE(!normalize_bound_device_label(label, normalized), "label must be refused: " << label);
	}
	// "Computer" in Cyrillic, "Delta-PC" in Greek, "workstation" in CJK, "Buero-PC" with u-umlaut,
	// "DESKTOP-7Q2K1AB", "OLD-BOX" and "Lab-PC-01". 4F2A-0C1Z-B7E4 is the control: Z is neither a code
	// character nor the skeleton of one.
	const std::string accepted[] = {"\xd0\x9a\xd0\xbe\xd0\xbc\xd0\xbf\xd1\x8c\xd1\x8e\xd1\x82\xd0\xb5\xd1\x80",
									"\xce\x94\xce\xad\xce\xbb\xcf\x84\xce\xb1-PC",
									"\xe5\xb7\xa5\xe4\xbd\x9c\xe7\xab\x99",
									"B\xc3\xbcro-PC",
									"DESKTOP-7Q2K1AB",
									"OLD-BOX",
									"Lab-PC-01",
									"4F2A-0C1Z-B7E4"};
	for (const auto& label : accepted) {
		input.device_label = label;
		BOOST_CHECK_MESSAGE(encode_bound_authorization(input, out), "label must be accepted: " << label);
		std::string normalized;
		BOOST_CHECK_MESSAGE(normalize_bound_device_label(label, normalized) && normalized == label,
							"label must be accepted unchanged: " << label);
	}
}
// The skeleton of 0 is O and the skeleton of 1 is l, so O, I, l, | and their look-alikes in any
// script stand in for those digits as well as the digits themselves do.
BOOST_AUTO_TEST_CASE(registration_refuses_o_i_and_l_standing_in_for_zero_and_one) {
	const auto r = vector("registration_wire.json").get_child("request");
	BoundAuthorizationInput input{r.get<std::string>("client_id"),		 r.get<std::string>("project"),
								  r.get<std::string>("public_key_spki"), r.get<std::string>("device_label"),
								  r.get<std::string>("redirect_uri"),	 r.get<std::string>("state"),
								  r.get<std::string>("code_challenge"),	 r.get<std::string>("requested_feature")};
	SensitiveVector out;
	// A letter O for 0; a capital I, a small l or a vertical line for 1; Cyrillic capital O (U+041E)
	// for 0; Cyrillic capital I (U+0406) for 1; and a code made only of O, l and I.
	const std::string refused[] = {"4F2A-OC12-B7E4",
								   "4F2A-0CI2-B7E4",
								   "4F2A-0Cl2-B7E4",
								   "4F2A-0C|2-B7E4",
								   "4F2A-\xd0\x9e"
								   "C12-B7E4",
								   "4F2A-0C\xd0\x86"
								   "2-B7E4",
								   "OOOO-llll-IIII"};
	for (const auto& label : refused) {
		input.device_label = label;
		BOOST_CHECK_MESSAGE(!encode_bound_authorization(input, out), "label must be refused: " << label);
		std::string normalized;
		BOOST_CHECK_MESSAGE(!normalize_bound_device_label(label, normalized), "label must be refused: " << label);
	}
}
BOOST_AUTO_TEST_CASE(registration_response_requires_exact_schema_and_status) {
	const auto v = vector("registration_wire.json");
	const auto response = v.get<std::string>("response_json");
	BoundWireResponse out;
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::authorize, 200, response, out));
	BOOST_CHECK(out.kind == BoundWireKind::registration);
	const auto saved = out.attempt_handle;
	for (const auto status : {201u, 302u, 400u, 503u})
		BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::authorize, status, response, out));
	for (const auto& invalid :
		 {replace(response, "2000000300", "0"), replace(response, "2000000300", "9007199254740992"),
		  replace(response, "authorization_created", "challenge_created"),
		  replace(response, "\"data\":{", "\"data\":{\"extra\":true,"),
		  replace(response, "\"data\":{", "\"data\":{\"expires_at\":1,"),
		  replace(response, "\"comparison_code\":\"", "\"comparison_code\":\"z"),
		  replace(response, "\"attempt_handle\":\"", "\"attempt_handle\":\"=")}) {
		BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::authorize, 200, invalid, out));
		BOOST_CHECK_EQUAL(out.attempt_handle, saved);
	}
	BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::authorize, 404, error("binding_unavailable"), out));
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::authorize, 429, error("rate_limited"), out));
	BOOST_CHECK(out.kind == BoundWireKind::retry);
}

BOOST_AUTO_TEST_CASE(strict_json_rejects_ambiguity_invalid_unicode_and_unbounded_shapes) {
	bound_json::Value out;
	BOOST_REQUIRE(bound_json::parse("{\"saved\":true}", out));
	const std::vector<std::string> bad{"{\"ok\":true,\"o\\u006b\":false}",
									   "{\"p\":{\"x\":1,\"\\u0078\":2}}",
									   "{\"n\":01}",
									   "{\"n\":-0}",
									   "{\"n\":1e0}",
									   "{\"n\":1.0}",
									   "{\"n\":9007199254740992}",
									   "{\"n\":18446744073709551616}",
									   "{\"x\":\"\\uD800\"}",
									   "{\"x\":\"\\uDC00\"}",
									   "{\"x\":\"\\uD800\\u0041\"}",
									   "{\"x\":\"\\uZZZZ\"}",
									   "{\"x\":\"\\x00\"}",
									   "{\"x\":\"raw\nline\"}",
									   std::string("{\"x\":\"") + std::string("\xc0\x80", 2) + "\"}",
									   std::string("\xef\xbb\xbf") + "{}",
									   "[]",
									   "{\"x\":[]}",
									   "{\"x\":null}",
									   "{}{}",
									   "{\"x\":truefalse}",
									   "{\"x\":true,}",
									   "{\"a\":{\"b\":{\"c\":{\"d\":{}}}}}"};
	for (const auto& text : bad) {
		BOOST_CHECK_MESSAGE(!bound_json::parse(text, out), text);
		BOOST_CHECK(out.fields.count("saved") == 1);
	}
	std::string many = "{";
	for (unsigned i = 0; i < 33; ++i) many += (i ? "," : "") + std::string("\"k") + std::to_string(i) + "\":0";
	BOOST_CHECK(!bound_json::parse(many + "}", out));
}

BOOST_AUTO_TEST_CASE(native_request_encoder_preserves_shared_vector_intent_and_rejects_changed_body) {
	const auto v = vector();
	const auto& b = v.get_child("body");
	const auto& p = v.get_child("proof");
	BoundRenewInput input{b.get<std::string>("binding_id"), b.get<std::uint64_t>("generation"),
						  b.get<std::string>("operation_id")};
	BoundSignedProof proof;
	proof.key_id = p.get<std::string>("key_id");
	proof.signature = v.get<std::string>("proof_signature");
	BOOST_REQUIRE_EQUAL(prepare_bound_proof_v2(input,
											   {p.get<std::string>("challenge_id"), p.get<std::string>("nonce"),
												p.get<std::uint64_t>("expires_at")},
											   p.get<std::string>("audience"), proof.key_id, proof.prepared),
						LCC_DEVICE_OK);
	std::string body;
	BOOST_REQUIRE(encode_bound_renew_challenge(input, body));
	BOOST_CHECK_EQUAL(body, vector("renewal_wire.json").get<std::string>("challenge_request"));
	bound_json::Value decoded;
	BOOST_REQUIRE(bound_json::parse(body, decoded));
	BOOST_CHECK_EQUAL(decoded.fields.size(), 3U);
	BOOST_CHECK_EQUAL(decoded.fields.at("purpose").text, "renew");
	BOOST_REQUIRE(encode_bound_renew_request(input, proof, body));
	BOOST_CHECK_EQUAL(body, vector("renewal_wire.json").get<std::string>("renew_request"));
	BOOST_REQUIRE(bound_json::parse(body, decoded));
	BOOST_CHECK_EQUAL(decoded.fields.size(), 4U);
	BOOST_CHECK_EQUAL(decoded.fields.at("proof").fields.size(), 5U);
	BOOST_CHECK_EQUAL(decoded.fields.at("proof").fields.at("signature").text, proof.signature);
	BOOST_CHECK_EQUAL(decoded.fields.at("binding_id").text, input.binding_id);
	const auto original = body;
	input.generation++;
	BOOST_CHECK(!encode_bound_renew_request(input, proof, body));
	BOOST_CHECK_EQUAL(body, original);
	input.generation--;
	proof.prepared.proof.path = "/v1/renew";
	BOOST_CHECK(!encode_bound_renew_request(input, proof, body));
	proof.prepared.proof.path = "/v2/device-leases/renew";
	proof.signature += "=";
	BOOST_CHECK(!encode_bound_renew_request(input, proof, body));
	BOOST_CHECK_EQUAL(body, original);
}

BOOST_AUTO_TEST_CASE(exchange_wire_matches_backend_vector_and_preserves_sensitive_output_on_failure) {
	const auto v = vector("exchange.json");
	const auto b = v.get_child("body");
	const auto p = v.get_child("proof");
	BoundExchangeSecret input;
	input.value = {b.get<std::string>("attempt_handle"), b.get<std::string>("code"),
				   b.get<std::string>("code_verifier"), b.get<std::string>("redirect_uri"),
				   b.get<std::string>("operation_id")};
	BoundSignedProof proof;
	proof.key_id = p.get<std::string>("key_id");
	proof.signature = v.get<std::string>("proof_signature");
	BOOST_REQUIRE_EQUAL(prepare_bound_proof_v2(input.value,
											   {p.get<std::string>("challenge_id"), p.get<std::string>("nonce"),
												p.get<std::uint64_t>("expires_at")},
											   p.get<std::string>("audience"), proof.key_id, proof.prepared),
						LCC_DEVICE_OK);
	SensitiveVector out;
	BOOST_REQUIRE(encode_bound_exchange_challenge(input.value, out));
	BOOST_CHECK_EQUAL(std::string(out.value.begin(), out.value.end()),
					  vector("exchange_wire.json").get<std::string>("challenge_request"));
	BOOST_REQUIRE(encode_bound_exchange_request(input.value, proof, out));
	const auto expected = vector("exchange_wire.json").get<std::string>("exchange_request");
	BOOST_CHECK_EQUAL(std::string(out.value.begin(), out.value.end()), expected);
	input.value.code[0] = 'B';
	BOOST_CHECK(!encode_bound_exchange_request(input.value, proof, out));
	BOOST_CHECK_EQUAL(std::string(out.value.begin(), out.value.end()), expected);
	for (const auto& uri :
		 {"http://localhost:1234/callback", "http://127.0.0.1:80/callback", "http://127.0.0.1:1234/../callback",
		  "http://127.0.0.1:1234/%63allback", "http://127.0.0.1:1234/callback?x=1", "http://[::1]:65536/callback"}) {
		input.value.redirect_uri = uri;
		BOOST_CHECK(!encode_bound_exchange_challenge(input.value, out));
	}
	BOOST_CHECK_EQUAL(std::string(out.value.begin(), out.value.end()), expected);
}
BOOST_AUTO_TEST_CASE(exchange_response_codes_distinguish_retry_from_new_enrollment_and_capacity) {
	BoundWireResponse out;
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::enrollment_challenge, 200, challenge(), out));
	BOOST_CHECK(out.detail == BoundWireDetail::none);
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::exchange, 200,
											   replace(renewal(), "device_renewed", "device_activated"), out));
	BOOST_CHECK(out.detail == BoundWireDetail::none);
	// A full license stays a conflict; only its detail says that every device slot is in use.
	// Each decode starts without a detail, so one refusal never leaks into the next response.
	using Case = std::tuple<BoundWireOperation, unsigned, std::string, BoundWireKind, BoundWireDetail>;
	for (const auto& item : std::vector<Case>{
			 {BoundWireOperation::enrollment_challenge, 404, "authorization_unavailable",
			  BoundWireKind::authorization_unavailable, BoundWireDetail::none},
			 {BoundWireOperation::exchange, 410, "authorization_expired", BoundWireKind::authorization_unavailable,
			  BoundWireDetail::none},
			 {BoundWireOperation::exchange, 410, "challenge_expired", BoundWireKind::retry, BoundWireDetail::none},
			 {BoundWireOperation::exchange, 401, "invalid_proof", BoundWireKind::retry, BoundWireDetail::none},
			 {BoundWireOperation::exchange, 409, "device_limit_reached", BoundWireKind::conflict,
			  BoundWireDetail::device_limit},
			 {BoundWireOperation::exchange, 503, "temporarily_unavailable", BoundWireKind::retry,
			  BoundWireDetail::none},
			 {BoundWireOperation::exchange, 404, "binding_unavailable", BoundWireKind::authority_denied,
			  BoundWireDetail::none},
			 {BoundWireOperation::exchange, 409, "idempotency_conflict", BoundWireKind::conflict,
			  BoundWireDetail::none}}) {
		BOOST_REQUIRE(
			decode_bound_device_response(std::get<0>(item), std::get<1>(item), error(std::get<2>(item)), out));
		BOOST_CHECK(out.kind == std::get<3>(item));
		BOOST_CHECK_MESSAGE(out.detail == std::get<4>(item), "detail for " << std::get<2>(item));
	}
	// Renewal never reports a device limit: the server refuses capacity only at exchange.
	BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::renew, 409, error("device_limit_reached"), out));
	BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::exchange, 409, error("revision_conflict"), out));
	BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::enrollment_challenge, 404,
											  error("binding_unavailable"), out));
	BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::renew, 410, error("authorization_expired"), out));
}

BOOST_AUTO_TEST_CASE(response_schema_checks_echoes_without_granting_unsigned_authority) {
	BoundWireResponse out;
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::renew_challenge, 200, challenge(), out));
	BOOST_CHECK(out.kind == BoundWireKind::challenge);
	BOOST_CHECK_EQUAL(out.challenge.expires_at, 2000000060U);
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::renew_challenge, 200,
											   replace(challenge(), "challenge_created", "ch\\u0061llenge_created"),
											   out));
	const auto body = renewal();
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::renew, 200, body, out));
	BOOST_CHECK(out.kind == BoundWireKind::lease);
	BOOST_CHECK_EQUAL(out.lease, vector().get<std::string>("token"));
	// Trace IDs may come from the original recovered response. Device ID is
	// only a syntactic echo; neither is used as signed authorization context.
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::renew, 200,
											   replace(body, trace, "11111111-1111-4111-8111-111111111111"), out));
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::renew, 200,
											   replace(body, trace, "recovered-request:17"), out));
	const auto saved = out.lease;
	for (const auto& bad :
		 {replace(body, "\"generation\":1", "\"generation\":\"1\""),
		  replace(body, "\"generation\":1", "\"generation\":2"), replace(body, "2000086520", "2000086521"),
		  replace(body, "2000043200", "2000043201"), replace(body, "\"CAD\"", "\"OTHER\""),
		  replace(body, "device_renewed", "device_activated"), replace(body, "\"ok\":true", "\"ok\":\"true\""),
		  replace(body, "\"ok\":true", "\"ok\":true,\"extra\":false")}) {
		BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::renew, 200, bad, out));
		BOOST_CHECK_EQUAL(out.lease, saved);
	}
	BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::renew, 503, body, out));
	BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::renew, 200, challenge(), out));
}

BOOST_AUTO_TEST_CASE(status_code_and_operation_must_agree_before_classification) {
	using Case = std::tuple<unsigned, const char*, BoundWireKind>;
	const std::vector<Case> cases{{503, "temporarily_unavailable", BoundWireKind::retry},
								  {429, "rate_limited", BoundWireKind::retry},
								  {410, "challenge_expired", BoundWireKind::retry},
								  {401, "invalid_proof", BoundWireKind::retry},
								  {401, "proof_required", BoundWireKind::retry},
								  {403, "access_denied", BoundWireKind::authority_denied},
								  {403, "device_retired", BoundWireKind::authority_denied},
								  {404, "binding_unavailable", BoundWireKind::authority_denied},
								  {409, "revision_conflict", BoundWireKind::authority_denied},
								  {409, "idempotency_conflict", BoundWireKind::conflict},
								  {400, "invalid_request", BoundWireKind::request_rejected},
								  {400, "unsupported_protocol", BoundWireKind::request_rejected}};
	BoundWireResponse out;
	for (const auto& item : cases) {
		BOOST_REQUIRE(
			decode_bound_device_response(BoundWireOperation::renew, std::get<0>(item), error(std::get<1>(item)), out));
		BOOST_CHECK(out.kind == std::get<2>(item));
		BOOST_CHECK(out.detail == BoundWireDetail::none);
		BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::renew, 200, error(std::get<1>(item)), out));
	}
	BOOST_REQUIRE(
		decode_bound_device_response(BoundWireOperation::renew_challenge, 404, error("binding_unavailable"), out));
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::renew_challenge, 403, error("access_denied"), out));
	BOOST_CHECK(
		!decode_bound_device_response(BoundWireOperation::renew_challenge, 409, error("revision_conflict"), out));
	BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::renew, 503, error("access_denied"), out));
	BOOST_CHECK(!decode_bound_device_response(BoundWireOperation::renew, 403, error("unknown_error"), out));
}
