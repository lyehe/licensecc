#define BOOST_TEST_MODULE device_bound_vectors_test
#include <boost/property_tree/json_parser.hpp>
#include <boost/test/unit_test.hpp>
#include "bound_protocol.hpp"
#include "p256_crypto.hpp"
#include <sstream>
#include <fstream>
#include <limits>
#include <algorithm>

using namespace license::device_identity;
namespace {
boost::property_tree::ptree fixture(const char* file) {
	std::ifstream stream(std::string(LCC_DEVICE_IDENTITY_VECTOR_ROOT) + "/device_bound/v1/" + file);
	BOOST_REQUIRE(stream.good());
	boost::property_tree::ptree value;
	boost::property_tree::read_json(stream, value);
	return value;
}
BoundProofInput proof(const boost::property_tree::ptree& value) {
	return {value.get<std::string>("audience"),		value.get<std::string>("path"),
			value.get<std::string>("operation_id"), value.get<std::string>("body_sha256"),
			value.get<std::string>("challenge_id"), value.get<std::string>("nonce"),
			value.get<std::uint64_t>("expires_at")};
}
EnrollmentComparisonInput comparison(const boost::property_tree::ptree& value) {
	return {value.get<std::string>("attempt_handle"), value.get<std::string>("client_id"),
			value.get<std::string>("project"),		  value.get<std::string>("redirect_uri"),
			value.get<std::string>("state"),		  value.get<std::string>("code_challenge")};
}
std::vector<std::uint8_t> vector_bytes(std::string value) {
	std::replace(value.begin(), value.end(), '-', '+');
	std::replace(value.begin(), value.end(), '_', '/');
	while (value.size() % 4) value.push_back('=');
	std::vector<std::uint8_t> result;
	BOOST_REQUIRE(decode_canonical_base64(value, result));
	return result;
}
}  // namespace

BOOST_AUTO_TEST_CASE(exchange_and_renew_transcripts_match_server_bytes) {
	for (const char* file : {"protocol.json", "exchange.json"}) {
		const auto value = fixture(file);
		const auto fields = value.get_child("proof");
		auto input = proof(fields);
		std::vector<std::uint8_t> bytes;
		BOOST_REQUIRE(bound_proof_input_v2(input, fields.get<std::string>("key_id"), bytes));
		BOOST_CHECK_EQUAL(lowercase_hex(bytes.data(), bytes.size()), value.get<std::string>("proof_input_hex"));
		const auto public_bytes = vector_bytes(value.get<std::string>("device_spki"));
		const auto signature = vector_bytes(value.get<std::string>("proof_signature"));
		P256Spki public_key;
		P256Digest digest;
		BOOST_REQUIRE(canonicalize_p256_spki(public_bytes.data(), public_bytes.size(), public_key));
		BOOST_CHECK_EQUAL(device_key_id(public_key), fields.get<std::string>("key_id"));
		BOOST_REQUIRE(sha256(bytes.data(), bytes.size(), digest));
		BOOST_REQUIRE(verify_p256_p1363(public_key, digest, signature.data(), signature.size()));
		for (auto field : {&BoundProofInput::audience, &BoundProofInput::operation_id, &BoundProofInput::body_sha256,
						   &BoundProofInput::challenge_id, &BoundProofInput::nonce}) {
			auto changed = input;
			(changed.*field)[0] = (changed.*field)[0] == 'a' ? 'b' : 'a';
			std::vector<std::uint8_t> changed_bytes;
			BOOST_REQUIRE(bound_proof_input_v2(changed, fields.get<std::string>("key_id"), changed_bytes));
			BOOST_REQUIRE(sha256(changed_bytes.data(), changed_bytes.size(), digest));
			BOOST_CHECK(!verify_p256_p1363(public_key, digest, signature.data(), signature.size()));
		}
		const auto original = bytes;
		input.path = "/v1/renew";
		BOOST_CHECK(!bound_proof_input_v2(input, fields.get<std::string>("key_id"), bytes));
		BOOST_CHECK(bytes == original);
		input = proof(fields);
		input.expires_at = std::numeric_limits<std::uint64_t>::max();
		BOOST_CHECK(!bound_proof_input_v2(input, fields.get<std::string>("key_id"), bytes));
		input.expires_at = 9007199254740991ULL;
		BOOST_REQUIRE(bound_proof_input_v2(input, fields.get<std::string>("key_id"), bytes));
		input.expires_at++;
		BOOST_CHECK(!bound_proof_input_v2(input, fields.get<std::string>("key_id"), bytes));
		for (const std::string bad :
			 std::initializer_list<std::string>{"", "A", std::string(43, 'B'), std::string(43, 'A') + "="}) {
			input = proof(fields);
			input.operation_id = bad;
			BOOST_CHECK(!bound_proof_input_v2(input, fields.get<std::string>("key_id"), bytes));
		}
		input = proof(fields);
		input.challenge_id = input.nonce;
		BOOST_CHECK(!bound_proof_input_v2(input, fields.get<std::string>("key_id"), bytes));
		input = proof(fields);
		input.nonce = input.challenge_id;
		BOOST_CHECK(!bound_proof_input_v2(input, fields.get<std::string>("key_id"), bytes));
		input = proof(fields);
		input.challenge_id += "=";
		BOOST_CHECK(!bound_proof_input_v2(input, fields.get<std::string>("key_id"), bytes));
	}
}

BOOST_AUTO_TEST_CASE(comparison_matches_independent_python_bytes_digest_and_display) {
	const auto value = fixture("enrollment_comparison.json");
	const auto fields = value.get_child("input");
	const auto input = comparison(fields);
	const auto key_id = fields.get<std::string>("key_id");
	std::vector<std::uint8_t> bytes;
	BOOST_REQUIRE(enrollment_comparison_input(input, key_id, bytes));
	BOOST_CHECK_EQUAL(lowercase_hex(bytes.data(), bytes.size()), value.get<std::string>("input_hex"));
	P256Digest digest;
	BOOST_REQUIRE(sha256(bytes.data(), bytes.size(), digest));
	BOOST_CHECK_EQUAL(lowercase_hex(digest.data(), digest.size()), value.get<std::string>("sha256_hex"));
	std::string code;
	BOOST_REQUIRE(enrollment_comparison_code(input, key_id, code));
	BOOST_CHECK_EQUAL(code, value.get<std::string>("comparison_code"));
	for (auto field : {&EnrollmentComparisonInput::attempt_handle, &EnrollmentComparisonInput::state,
					   &EnrollmentComparisonInput::code_challenge, &EnrollmentComparisonInput::client_id,
					   &EnrollmentComparisonInput::project, &EnrollmentComparisonInput::redirect_uri}) {
		auto changed = input;
		(changed.*field)[0] = (changed.*field)[0] == 'A' ? 'B' : 'A';
		std::string other;
		BOOST_REQUIRE(enrollment_comparison_code(changed, key_id, other));
		BOOST_CHECK(other != code);
	}
	std::string other;
	BOOST_REQUIRE(enrollment_comparison_code(input, "sha256:" + std::string(64, 'b'), other));
	BOOST_CHECK(other != code);
	for (const std::string bad :
		 {std::string("\xc0\xaf", 2), std::string("\xed\xa0\x80", 3), std::string("\xe0\x80\xaf", 3),
		  std::string("\xf0\x80\x80\xaf", 4), std::string("\xe2\x41\xac", 3), std::string("\xf4\x90\x80\x80", 4),
		  std::string("\xe2\x82", 2), std::string(1025, 'x')}) {
		auto changed = input;
		changed.redirect_uri = bad;
		other = "unchanged";
		BOOST_CHECK(!enrollment_comparison_code(changed, key_id, other));
		BOOST_CHECK_EQUAL(other, "unchanged");
	}
	auto changed = input;
	changed.redirect_uri.clear();
	for (int i = 0; i < 512; ++i) changed.redirect_uri += "\xc3\xa9";
	BOOST_REQUIRE(enrollment_comparison_code(changed, key_id, other));
	changed.redirect_uri += "x";
	BOOST_CHECK(!enrollment_comparison_code(changed, key_id, other));
}

BOOST_AUTO_TEST_CASE(feature_intent_matches_independent_comparison_vector) {
	const auto value = fixture("enrollment_comparison_feature.json");
	const auto fields = value.get_child("input");
	auto input = comparison(fields);
	input.requested_feature = fields.get<std::string>("requested_feature");
	const auto key = fields.get<std::string>("key_id");
	std::vector<std::uint8_t> bytes;
	BOOST_REQUIRE(enrollment_comparison_input(input, key, bytes));
	BOOST_CHECK_EQUAL(lowercase_hex(bytes.data(), bytes.size()), value.get<std::string>("input_hex"));
	std::string code;
	BOOST_REQUIRE(enrollment_comparison_code(input, key, code));
	BOOST_CHECK_EQUAL(code, value.get<std::string>("comparison_code"));
	input.requested_feature = "BATCH_RUN";
	std::string changed;
	BOOST_REQUIRE(enrollment_comparison_code(input, key, changed));
	BOOST_CHECK_NE(code, changed);
	input.requested_feature = "feature too long";
	BOOST_CHECK(!enrollment_comparison_code(input, key, changed));
}
