#define BOOST_TEST_MODULE device_bound_lease_test
#include <boost/property_tree/json_parser.hpp>
#include <boost/test/unit_test.hpp>
#include "bound_lease.hpp"
#include "bound_encoding.hpp"
#include "p256_crypto.hpp"
#include <algorithm>
#include <fstream>
#include <limits>

using namespace license::device_identity;
namespace {
boost::property_tree::ptree fixture() {
	std::ifstream stream(std::string(LCC_DEVICE_IDENTITY_VECTOR_ROOT) + "/device_bound/v1/protocol.json");
	BOOST_REQUIRE(stream.good());
	boost::property_tree::ptree v;
	boost::property_tree::read_json(stream, v);
	return v;
}
std::vector<std::uint8_t> bytes(const std::string& text, std::size_t limit = 4096) {
	std::vector<std::uint8_t> out;
	BOOST_REQUIRE(bound_encoding::decode_base64url(text, limit, out));
	return out;
}
BoundLeaseExpected expected(const boost::property_tree::ptree& c) {
	return {c.get<std::string>("issuer"),
			c.get<std::string>("audience"),
			c.get<std::string>("project"),
			c.get<std::string>("feature"),
			c.get<std::string>("license-fingerprint"),
			c.get<std::string>("binding-id"),
			c.get<std::string>("device-key-id"),
			c.get<std::string>("operation-id"),
			c.get<std::uint64_t>("generation"),
			c.get<std::uint64_t>("revocation-seq")};
}
std::string envelope(const std::string& payload, const ParsedBoundLease& parsed) {
	return "lccdl1." + bound_encoding::base64url(payload) + "." +
		   bound_encoding::base64url(std::string(parsed.signature.begin(), parsed.signature.end()));
}
std::string replace_field(std::string payload, const std::string& field, const std::string& value) {
	const auto begin = payload.find(field + "=");
	BOOST_REQUIRE(begin != std::string::npos);
	const auto end = payload.find('\n', begin);
	payload.replace(begin + field.size() + 1, end - begin - field.size() - 1, value);
	return payload;
}
std::vector<std::uint8_t> tlv(std::uint8_t tag, const std::vector<std::uint8_t>& value) {
	std::vector<std::uint8_t> out{tag};
	if (value.size() < 128)
		out.push_back(static_cast<std::uint8_t>(value.size()));
	else if (value.size() < 256) {
		out.push_back(0x81);
		out.push_back(static_cast<std::uint8_t>(value.size()));
	} else {
		out.push_back(0x82);
		out.push_back(static_cast<std::uint8_t>(value.size() >> 8));
		out.push_back(static_cast<std::uint8_t>(value.size()));
	}
	out.insert(out.end(), value.begin(), value.end());
	return out;
}
std::vector<std::uint8_t> wrap_rsa(std::vector<std::uint8_t> rsa,
								   std::vector<std::uint8_t> algorithm = {0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48,
																		  0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05,
																		  0x00},
								   std::uint8_t unused = 0) {
	rsa.insert(rsa.begin(), unused);
	const auto bits = tlv(3, rsa);
	algorithm.insert(algorithm.end(), bits.begin(), bits.end());
	return tlv(0x30, algorithm);
}
std::vector<std::uint8_t> synthetic_rsa(std::size_t modulus_bytes,
										const std::vector<std::uint8_t>& exponent_value = {1, 0, 1}) {
	std::vector<std::uint8_t> modulus(modulus_bytes + 1, 0x81);
	modulus[0] = 0;
	auto rsa = tlv(2, modulus), exponent = tlv(2, exponent_value);
	rsa.insert(rsa.end(), exponent.begin(), exponent.end());
	return tlv(0x30, rsa);
}
std::vector<std::uint8_t> synthetic_spki(std::size_t modulus_bytes) { return wrap_rsa(synthetic_rsa(modulus_bytes)); }
}  // namespace

BOOST_AUTO_TEST_CASE(native_lease_verifies_shared_rsa_spki_vector_and_strict_expected_context) {
	const auto v = fixture();
	const auto token = v.get<std::string>("token");
	const std::vector<BoundLeaseTrustKey> keys{{bytes(v.get<std::string>("lease_signer_spki")), false}};
	const auto e = expected(v.get_child("claims"));
	ParsedBoundLease parsed;
	BOOST_REQUIRE(decode_bound_lease(token, parsed));
	BOOST_CHECK_EQUAL(lowercase_hex(parsed.payload.data(), parsed.payload.size()),
					  v.get<std::string>("lease_payload_hex"));
	BOOST_CHECK_EQUAL(parsed.claims.signer_key_id, v.get<std::string>("claims.key-id"));
	BoundLeaseClaims claims;
	BOOST_REQUIRE(verify_bound_lease(token, keys, e, parsed.claims.issued_at, claims));
	BOOST_CHECK_EQUAL(claims.lease_id, parsed.claims.lease_id);
	BOOST_CHECK(verify_bound_lease(token, keys, e, parsed.claims.expires_at - 1, claims));
	for (const auto time : std::initializer_list<std::uint64_t>{parsed.claims.issued_at - 1, parsed.claims.expires_at,
																parsed.claims.expires_at + 120, 9007199254740992ULL})
		BOOST_CHECK(!verify_bound_lease(token, keys, e, time, claims));
	for (auto field :
		 {&BoundLeaseExpected::issuer, &BoundLeaseExpected::audience, &BoundLeaseExpected::project,
		  &BoundLeaseExpected::feature, &BoundLeaseExpected::license_fingerprint, &BoundLeaseExpected::binding_id,
		  &BoundLeaseExpected::device_key_id, &BoundLeaseExpected::operation_id}) {
		auto changed = e;
		(changed.*field) += "x";
		BOOST_CHECK(!verify_bound_lease(token, keys, changed, parsed.claims.issued_at, claims));
		changed.*field = "";
		BOOST_CHECK(!verify_bound_lease(token, keys, changed, parsed.claims.issued_at, claims));
	}
	auto changed = e;
	changed.generation++;
	BOOST_CHECK(!verify_bound_lease(token, keys, changed, parsed.claims.issued_at, claims));
	changed = e;
	changed.min_revocation_seq++;
	BOOST_CHECK(!verify_bound_lease(token, keys, changed, parsed.claims.issued_at, claims));
	BOOST_CHECK(!verify_bound_lease(token, keys, {}, parsed.claims.issued_at, claims));
	BOOST_CHECK_EQUAL(claims.lease_id, parsed.claims.lease_id);
}

BOOST_AUTO_TEST_CASE(lease_parser_rejects_noncanonical_fields_encodings_and_windows) {
	const auto v = fixture();
	const auto token = v.get<std::string>("token");
	ParsedBoundLease parsed;
	BOOST_REQUIRE(decode_bound_lease(token, parsed));
	const std::string payload(parsed.payload.begin(), parsed.payload.end());
	ParsedBoundLease output = parsed;
	for (const auto& malformed :
		 {token + "=", token + ".extra", std::string("lccdl2") + token.substr(6), std::string(8193, 'A')})
		BOOST_CHECK(!decode_bound_lease(malformed, output));
	for (const auto& malformed : {payload.substr(0, payload.size() - 1), payload + "\n", payload + "unknown=1\n",
								  std::string("\xef\xbb\xbf") + payload})
		BOOST_CHECK(!decode_bound_lease(envelope(malformed, parsed), output));
	for (const auto& value : {"01", "+1", "-0", "1.0", "9007199254740992"})
		BOOST_CHECK(!decode_bound_lease(envelope(replace_field(payload, "generation", value), parsed), output));
	for (const auto& field : {"binding-id", "lease-id", "operation-id"}) {
		for (const auto& value : {std::string("bad"), std::string(22, 'B'), std::string(43, 'B')})
			BOOST_CHECK(!decode_bound_lease(
				envelope(replace_field(payload, field, bound_encoding::base64url(value)), parsed), output));
	}
	BOOST_CHECK(!decode_bound_lease(
		envelope(replace_field(payload, "issuer", bound_encoding::base64url(std::string("\xed\xa0\x80", 3))), parsed),
		output));
	BOOST_CHECK(!decode_bound_lease(envelope(replace_field(payload, "audience", ""), parsed), output));
	BOOST_CHECK(!decode_bound_lease(
		envelope(replace_field(payload, "purpose", bound_encoding::base64url("lease")), parsed), output));
	BOOST_CHECK(!decode_bound_lease(
		envelope(replace_field(payload, "renew-after", std::to_string(parsed.claims.issued_at)), parsed), output));
	BOOST_CHECK(!decode_bound_lease(
		envelope(replace_field(payload, "expires-at", std::to_string(parsed.claims.issued_at + 86401)), parsed),
		output));
	auto excessive = replace_field(payload, "issued-at", "9007199254740989");
	excessive = replace_field(excessive, "renew-after", "9007199254740990");
	excessive = replace_field(excessive, "expires-at", "9007199254740991");
	BOOST_CHECK(!decode_bound_lease(envelope(excessive, parsed), output));
	BOOST_CHECK_EQUAL(output.claims.signer_key_id, parsed.claims.signer_key_id);
}

BOOST_AUTO_TEST_CASE(lease_parser_rejects_ambiguous_field_order_and_inner_encoding) {
	BOOST_CHECK(!bound_encoding::token("", 0));
	BOOST_CHECK(!bound_encoding::token("", std::numeric_limits<std::size_t>::max()));
	BOOST_CHECK(!bound_encoding::token("AA", 1));
	BOOST_CHECK(bound_encoding::token(std::string(22, 'A'), 16));
	BOOST_CHECK(bound_encoding::token(std::string(43, 'A'), 32));
	const auto v = fixture();
	ParsedBoundLease parsed;
	BOOST_REQUIRE(decode_bound_lease(v.get<std::string>("token"), parsed));
	const std::string payload(parsed.payload.begin(), parsed.payload.end());
	const auto first_end = payload.find('\n') + 1;
	const auto second_end = payload.find('\n', first_end) + 1;
	const auto first = payload.substr(0, first_end);
	const auto second = payload.substr(first_end, second_end - first_end);
	auto crlf = payload;
	crlf.insert(crlf.find('\n'), "\r");
	ParsedBoundLease out = parsed;
	for (const auto& malformed :
		 {second + first + payload.substr(second_end), first + first + payload.substr(second_end), crlf,
		  replace_field(payload, "issuer", "YQ=="), replace_field(payload, "issuer", "YR"),
		  replace_field(payload, "issuer", "_w")}) {
		BOOST_CHECK(!decode_bound_lease(envelope(malformed, parsed), out));
	}
	BOOST_CHECK_EQUAL_COLLECTIONS(out.payload.begin(), out.payload.end(), parsed.payload.begin(), parsed.payload.end());
}

BOOST_AUTO_TEST_CASE(trust_is_dedicated_bounded_canonical_and_retirement_is_in_spki_space) {
	const auto v = fixture();
	const auto token = v.get<std::string>("token");
	const auto e = expected(v.get_child("claims"));
	const auto key = bytes(v.get<std::string>("lease_signer_spki"));
	const auto now = v.get<std::uint64_t>("claims.issued-at");
	BoundLeaseClaims out;
	out.lease_id = "unchanged";
	BOOST_CHECK(!verify_bound_lease(token, {}, e, now, out));
	BOOST_CHECK(!verify_bound_lease(token, {{key, true}}, e, now, out));
	BOOST_CHECK(!verify_bound_lease(token, {{key, false}, {key, false}}, e, now, out));
	BOOST_CHECK(!verify_bound_lease(token, std::vector<BoundLeaseTrustKey>(9, {key, false}), e, now, out));
	for (const auto bad_size : {256U, 512U})
		BOOST_CHECK(!verify_bound_lease(token, {{key, false}, {synthetic_spki(bad_size), false}}, e, now, out));
	auto malformed = key;
	malformed.push_back(0);
	BOOST_CHECK(!verify_bound_lease(token, {{key, false}, {malformed, false}}, e, now, out));
	malformed = key;
	malformed[4] = 0x31;
	BOOST_CHECK(!verify_bound_lease(token, {{malformed, false}}, e, now, out));
	auto corrupted = token;
	corrupted.back() = corrupted.back() == 'A' ? 'B' : 'A';
	BOOST_CHECK(!verify_bound_lease(corrupted, {{key, false}}, e, now, out));
	ParsedBoundLease parsed;
	BOOST_REQUIRE(decode_bound_lease(token, parsed));
	const auto payload = replace_field(std::string(parsed.payload.begin(), parsed.payload.end()), "lease-id",
									   bound_encoding::base64url(std::string(22, 'A')));
	BOOST_CHECK(!verify_bound_lease(envelope(payload, parsed), {{key, false}}, e, now, out));
	BOOST_CHECK_EQUAL(out.lease_id, "unchanged");
}

BOOST_AUTO_TEST_CASE(trust_rotation_validates_every_spki_wrapper_and_rsa_integer) {
	const auto v = fixture();
	const auto token = v.get<std::string>("token");
	const auto e = expected(v.get_child("claims"));
	const auto key = bytes(v.get<std::string>("lease_signer_spki"));
	const auto now = v.get<std::uint64_t>("claims.issued-at");
	BoundLeaseClaims out;
	BOOST_REQUIRE(verify_bound_lease(token, {{synthetic_spki(384), true}, {key, false}}, e, now, out));
	std::vector<std::uint8_t> algorithm{0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
										0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00};
	std::vector<std::vector<std::uint8_t>> malformed;
	malformed.push_back(wrap_rsa(synthetic_rsa(384), algorithm, 1));
	auto altered = algorithm;
	altered[12] = 2;
	malformed.push_back(wrap_rsa(synthetic_rsa(384), altered));
	altered = algorithm;
	altered.resize(13);
	altered[1] = 11;
	malformed.push_back(wrap_rsa(synthetic_rsa(384), altered));
	altered = algorithm;
	altered[13] = 4;
	malformed.push_back(wrap_rsa(synthetic_rsa(384), altered));
	auto nonminimal = synthetic_spki(384);
	BOOST_REQUIRE_EQUAL(nonminimal[1], 0x82);
	nonminimal[1] = 0x83;
	nonminimal.insert(nonminimal.begin() + 2, 0);
	malformed.push_back(nonminimal);
	for (const std::vector<std::uint8_t>& exponent :
		 std::vector<std::vector<std::uint8_t>>{{0}, {1}, {2}, {0, 1, 0, 1}})
		malformed.push_back(wrap_rsa(synthetic_rsa(384, exponent)));
	for (const auto& bad : malformed)
		BOOST_CHECK(!verify_bound_lease(token, {{key, false}, {bad, false}}, e, now, out));
	BOOST_CHECK_EQUAL(out.lease_id, v.get<std::string>("claims.lease-id"));
}
BOOST_AUTO_TEST_CASE(resume_statement_authenticates_identity_without_restoring_lease_validity) {
	const auto v = fixture();
	const auto token = v.get<std::string>("token");
	const auto e = expected(v.get_child("claims"));
	const auto key = bytes(v.get<std::string>("lease_signer_spki"));
	BoundResumeExpected pinned{e.issuer, e.audience, e.project, e.feature, e.device_key_id};
	BoundResumeStatement statement;
	BOOST_REQUIRE(verify_bound_resume_statement(token, {{key, false}}, pinned, statement));
	BOOST_CHECK_EQUAL(statement.binding_id, e.binding_id);
	BOOST_CHECK_EQUAL(statement.license_fingerprint, e.license_fingerprint);
	BOOST_CHECK_EQUAL(statement.generation, e.generation);
	BOOST_CHECK_EQUAL(statement.revision_floor, e.min_revocation_seq);
	BoundLeaseClaims grant;
	BOOST_CHECK(!verify_bound_lease(token, {{key, false}}, e, v.get<std::uint64_t>("claims.expires-at"), grant));
	for (unsigned field = 0; field < 5; ++field) {
		auto wrong = pinned;
		std::string* fields[]{&wrong.issuer, &wrong.audience, &wrong.project, &wrong.feature, &wrong.device_key_id};
		fields[field]->append("x");
		BOOST_CHECK(!verify_bound_resume_statement(token, {{key, false}}, wrong, statement));
		BOOST_CHECK_EQUAL(statement.binding_id, e.binding_id);
	}
	BOOST_CHECK(!verify_bound_resume_statement(token, {{key, true}}, pinned, statement));
	BOOST_CHECK(!verify_bound_resume_statement(token, {}, pinned, statement));
	auto tampered = token;
	tampered.back() = tampered.back() == 'A' ? 'B' : 'A';
	BOOST_CHECK(!verify_bound_resume_statement(tampered, {{key, false}}, pinned, statement));
	BOOST_CHECK(!verify_bound_resume_statement(token + "=", {{key, false}}, pinned, statement));
	BOOST_CHECK_EQUAL(statement.binding_id, e.binding_id);
}
