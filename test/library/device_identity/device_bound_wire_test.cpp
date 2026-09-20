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
								  r.get<std::string>("code_challenge")};
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
	input.device_label = "quote\" slash\\ line\ninside";
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
	BOOST_REQUIRE(decode_bound_device_response(BoundWireOperation::exchange, 200,
											   replace(renewal(), "device_renewed", "device_activated"), out));
	for (const auto& item : std::vector<std::tuple<BoundWireOperation, unsigned, std::string, BoundWireKind>>{
			 {BoundWireOperation::enrollment_challenge, 404, "authorization_unavailable",
			  BoundWireKind::authorization_unavailable},
			 {BoundWireOperation::exchange, 410, "authorization_expired", BoundWireKind::authorization_unavailable},
			 {BoundWireOperation::exchange, 410, "challenge_expired", BoundWireKind::retry},
			 {BoundWireOperation::exchange, 401, "invalid_proof", BoundWireKind::retry},
			 {BoundWireOperation::exchange, 409, "device_limit_reached", BoundWireKind::conflict},
			 {BoundWireOperation::exchange, 404, "binding_unavailable", BoundWireKind::authority_denied},
			 {BoundWireOperation::exchange, 409, "idempotency_conflict", BoundWireKind::conflict}}) {
		BOOST_REQUIRE(
			decode_bound_device_response(std::get<0>(item), std::get<1>(item), error(std::get<2>(item)), out));
		BOOST_CHECK(out.kind == std::get<3>(item));
	}
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
								  {403, "legacy_protocol_disabled", BoundWireKind::authority_denied},
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
