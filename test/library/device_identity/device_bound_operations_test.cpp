#define BOOST_TEST_MODULE device_bound_operations_test
#include <boost/property_tree/json_parser.hpp>
#include <boost/test/unit_test.hpp>
#include <boost/multiprecision/cpp_int.hpp>
#include "bound_protocol.hpp"
#include "device_identity_handle.hpp"
#include <algorithm>
#include <cstring>
#include <fstream>
#include <memory>
#include <type_traits>
#include <iomanip>

using namespace license::device_identity;
namespace {
boost::property_tree::ptree fixture(const char* file) {
	std::ifstream stream(std::string(LCC_DEVICE_IDENTITY_VECTOR_ROOT) + "/device_bound/v1/" + file);
	BOOST_REQUIRE(stream.good());
	boost::property_tree::ptree value;
	boost::property_tree::read_json(stream, value);
	return value;
}
BoundExchangeInput exchange(const boost::property_tree::ptree& b) {
	return {b.get<std::string>("attempt_handle"), b.get<std::string>("code"), b.get<std::string>("code_verifier"),
			b.get<std::string>("redirect_uri"), b.get<std::string>("operation_id")};
}
BoundRenewInput renew(const boost::property_tree::ptree& b) {
	return {b.get<std::string>("binding_id"), b.get<std::uint64_t>("generation"), b.get<std::string>("operation_id")};
}
BoundChallenge challenge(const boost::property_tree::ptree& p) {
	return {p.get<std::string>("challenge_id"), p.get<std::string>("nonce"), p.get<std::uint64_t>("expires_at")};
}
template <class Input>
void check_operation(const Input& input, const boost::property_tree::ptree& vector) {
	const auto p = vector.get_child("proof");
	const auto key_id = p.get<std::string>("key_id");
	const auto audience = p.get<std::string>("audience");
	auto c = challenge(p);
	SensitiveVector bytes;
	BOOST_REQUIRE(bound_operation_digest_input_v1(input, key_id, bytes));
	BOOST_CHECK_EQUAL(lowercase_hex(bytes.value.data(), bytes.value.size()),
					  vector.get<std::string>("operation_digest_input_hex"));
	BoundPreparedProof prepared;
	BOOST_REQUIRE_EQUAL(prepare_bound_proof_v2(input, c, audience, key_id, prepared), LCC_DEVICE_OK);
	BOOST_CHECK_EQUAL(prepared.operation_digest, vector.get<std::string>("operation_digest"));
	BOOST_CHECK_EQUAL(prepared.proof.body_sha256, p.get<std::string>("body_sha256"));
	BOOST_CHECK_EQUAL(prepared.proof.path, p.get<std::string>("path"));
	BOOST_CHECK_EQUAL(prepared.proof.operation_id, input.operation_id);
	std::vector<std::uint8_t> proof_bytes;
	BOOST_REQUIRE(bound_proof_input_v2(prepared.proof, key_id, proof_bytes));
	BOOST_CHECK_EQUAL(lowercase_hex(proof_bytes.data(), proof_bytes.size()),
					  vector.get<std::string>("proof_input_hex"));
	const auto old = prepared;
	c.nonce[0] = c.nonce[0] == 'A' ? 'B' : 'A';
	c.expires_at++;
	BOOST_REQUIRE_EQUAL(prepare_bound_proof_v2(input, c, audience, key_id, prepared), LCC_DEVICE_OK);
	BOOST_CHECK_EQUAL(prepared.operation_digest, old.operation_digest);
	BOOST_CHECK_EQUAL(prepared.proof.body_sha256, old.proof.body_sha256);
	std::vector<std::uint8_t> retry_bytes;
	BOOST_REQUIRE(bound_proof_input_v2(prepared.proof, key_id, retry_bytes));
	BOOST_CHECK(retry_bytes != proof_bytes);
	c.nonce += "=";
	BOOST_CHECK_EQUAL(prepare_bound_proof_v2(input, c, audience, key_id, prepared), LCC_DEVICE_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(prepared.operation_digest, old.operation_digest);
}
P256Signature scalars(const std::string& r, const std::string& s) {
	std::vector<std::uint8_t> bytes;
	BOOST_REQUIRE(parse_lowercase_hex(r + s, bytes));
	BOOST_REQUIRE_EQUAL(bytes.size(), 64U);
	P256Signature value;
	std::copy(bytes.begin(), bytes.end(), value.begin());
	return value;
}
std::vector<std::uint8_t> url_bytes(std::string text) {
	std::replace(text.begin(), text.end(), '-', '+');
	std::replace(text.begin(), text.end(), '_', '/');
	while (text.size() % 4) text += '=';
	std::vector<std::uint8_t> bytes;
	BOOST_REQUIRE(decode_canonical_base64(text, bytes));
	return bytes;
}
P256Signature twin(const P256Signature& signature) {
	const boost::multiprecision::cpp_int order("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
	const boost::multiprecision::cpp_int s("0x" + lowercase_hex(signature.data() + 32, 32));
	std::ostringstream formatted;
	formatted << std::hex << std::setfill('0') << std::setw(64) << (order - s);
	return scalars(lowercase_hex(signature.data(), 32), formatted.str());
}
class ControlledProvider final : public DeviceKeyProvider {
public:
	LCC_DEVICE_RESULT result = LCC_DEVICE_OK;
	unsigned calls = 0;
	P256Signature signature{};
	LCC_DEVICE_RESULT sign_digest(const P256Digest&, P256Signature& out) noexcept override {
		++calls;
		out = signature;
		return result;
	}
	LCC_DEVICE_RESULT open(const ProviderOpenRequest&) noexcept override { return LCC_DEVICE_INTERNAL_ERROR; }
	LCC_DEVICE_RESULT create(const ProviderOpenRequest&) noexcept override { return LCC_DEVICE_INTERNAL_ERROR; }
	LCC_DEVICE_RESULT public_spki(P256Spki&) noexcept override { return LCC_DEVICE_INTERNAL_ERROR; }
	LCC_DEVICE_RESULT metadata(ProviderMetadata&) noexcept override { return LCC_DEVICE_INTERNAL_ERROR; }
	LCC_DEVICE_RESULT delete_with_expected_id(const ProviderOpenRequest&, const std::string&) noexcept override {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
};
}  // namespace

BOOST_AUTO_TEST_CASE(provider_failures_preserve_output_and_high_s_fixture_normalizes_before_publication) {
	const auto v = fixture("protocol.json"), p = v.get_child("proof");
	const auto input = renew(v.get_child("body"));
	LccDeviceIdentity identity;
	const auto public_bytes = url_bytes(v.get<std::string>("device_spki"));
	BOOST_REQUIRE(canonicalize_p256_spki(public_bytes.data(), public_bytes.size(), identity.spki));
	identity.device_key_id = device_key_id(identity.spki);
	identity.project = "CAD";
	BOOST_REQUIRE_EQUAL(identity.device_key_id, p.get<std::string>("key_id"));
	auto provider = std::make_unique<ControlledProvider>();
	auto* control = provider.get();
	const auto signature_bytes = url_bytes(v.get<std::string>("proof_signature"));
	P256Signature original;
	BOOST_REQUIRE_EQUAL(signature_bytes.size(), original.size());
	std::copy(signature_bytes.begin(), signature_bytes.end(), original.begin());
	BOOST_REQUIRE(p1363_signature_is_low_s(original));
	control->signature = twin(original);
	BOOST_CHECK(!p1363_signature_is_low_s(control->signature));
	std::vector<std::uint8_t> proof_bytes;
	BOOST_REQUIRE(parse_lowercase_hex(v.get<std::string>("proof_input_hex"), proof_bytes));
	P256Digest digest;
	BOOST_REQUIRE(sha256(proof_bytes.data(), proof_bytes.size(), digest));
	BOOST_CHECK(verify_p256_p1363(identity.spki, digest, original));
	BOOST_CHECK(verify_p256_p1363(identity.spki, digest, control->signature));
	identity.provider = std::move(provider);
	BoundLocalContext context{"CAD", p.get<std::string>("audience")};
	BoundSignedProof output;
	BOOST_REQUIRE_EQUAL(sign_bound_proof_v2(&identity, context, input, challenge(p), output), LCC_DEVICE_OK);
	BOOST_CHECK_EQUAL(output.signature, v.get<std::string>("proof_signature"));
	BOOST_CHECK_EQUAL(control->calls, 1U);
	const auto before = output;
	BOOST_CHECK_EQUAL(sign_bound_proof_v2(&identity, {"OTHER", context.audience}, input, challenge(p), output),
					  LCC_DEVICE_POLICY_VIOLATION);
	auto invalid = input;
	invalid.generation = 0;
	BOOST_CHECK_EQUAL(sign_bound_proof_v2(&identity, context, invalid, challenge(p), output),
					  LCC_DEVICE_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(control->calls, 1U);
	for (const auto error : {LCC_DEVICE_KEY_LOST, LCC_DEVICE_BUSY, LCC_DEVICE_ACCESS_DENIED, LCC_DEVICE_SIGN_FAILED,
							 LCC_DEVICE_INTERNAL_ERROR}) {
		control->result = error;
		BOOST_CHECK_EQUAL(sign_bound_proof_v2(&identity, context, input, challenge(p), output), error);
		BOOST_CHECK_EQUAL(output.signature, before.signature);
		BOOST_CHECK_EQUAL(output.key_id, before.key_id);
		BOOST_CHECK_EQUAL(output.prepared.operation_digest, before.prepared.operation_digest);
	}
	control->result = LCC_DEVICE_OK;
	control->signature.fill(0);
	BOOST_CHECK_EQUAL(sign_bound_proof_v2(&identity, context, input, challenge(p), output), LCC_DEVICE_SIGN_FAILED);
	control->signature = scalars(std::string(63, '0') + '1', std::string(63, '0') + '1');
	BOOST_CHECK_EQUAL(sign_bound_proof_v2(&identity, context, input, challenge(p), output), LCC_DEVICE_SIGN_FAILED);
	BOOST_CHECK_EQUAL(output.signature, before.signature);
}

BOOST_AUTO_TEST_CASE(typed_operations_match_the_complete_shared_vectors) {
	const auto e = fixture("exchange.json"), r = fixture("protocol.json");
	check_operation(exchange(e.get_child("body")), e);
	check_operation(renew(r.get_child("body")), r);
	static_assert(!std::is_copy_constructible<SensitiveVector>::value, "secret transcripts must not copy implicitly");
}

BOOST_AUTO_TEST_CASE(every_exchange_field_changes_the_immutable_operation) {
	const auto v = fixture("exchange.json");
	const auto input = exchange(v.get_child("body"));
	const auto p = v.get_child("proof");
	const auto key = p.get<std::string>("key_id"), audience = p.get<std::string>("audience");
	BoundPreparedProof original;
	BOOST_REQUIRE_EQUAL(prepare_bound_proof_v2(input, challenge(p), audience, key, original), LCC_DEVICE_OK);
	for (auto field :
		 {&BoundExchangeInput::attempt_handle, &BoundExchangeInput::code, &BoundExchangeInput::code_verifier,
		  &BoundExchangeInput::redirect_uri, &BoundExchangeInput::operation_id}) {
		auto changed = input;
		(changed.*field)[0] = (changed.*field)[0] == 'A' ? 'B' : 'A';
		BoundPreparedProof candidate;
		BOOST_REQUIRE_EQUAL(prepare_bound_proof_v2(changed, challenge(p), audience, key, candidate), LCC_DEVICE_OK);
		BOOST_CHECK(candidate.operation_digest != original.operation_digest);
		BOOST_CHECK(candidate.proof.body_sha256 != original.proof.body_sha256);
	}
	SensitiveVector bytes;
	bytes.value = {1, 2, 3};
	auto invalid = input;
	invalid.code_verifier += "=";
	BOOST_CHECK(!bound_operation_body_v1(invalid, bytes));
	BOOST_CHECK(bytes.value == std::vector<std::uint8_t>({1, 2, 3}));
	invalid = input;
	invalid.redirect_uri = std::string(1025, 'x');
	BOOST_CHECK(!bound_operation_body_v1(invalid, bytes));
	BoundRenewInput renewal{std::string(22, 'A'), 0, std::string(43, 'A')};
	BOOST_CHECK(!bound_operation_body_v1(renewal, bytes));
	renewal.generation = 9007199254740991ULL;
	BOOST_REQUIRE(bound_operation_body_v1(renewal, bytes));
	renewal.generation++;
	BOOST_CHECK(!bound_operation_body_v1(renewal, bytes));
}

BOOST_AUTO_TEST_CASE(low_s_normalization_preserves_v1_acceptance_and_rejects_invalid_scalars) {
	const std::string zero(64, '0'), one = std::string(63, '0') + "1";
	const std::string order = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551";
	const std::string max = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632550";
	const std::string half = "7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8";
	const std::string above_half = "7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a9";
	auto signature = scalars(one, max);
	BOOST_CHECK(p1363_signature_in_range(signature));
	BOOST_CHECK(!p1363_signature_is_low_s(signature));
	P256Signature normalized{};
	BOOST_REQUIRE(normalize_p1363_low_s(signature, normalized));
	BOOST_CHECK(normalized == scalars(one, one));
	BOOST_CHECK(p1363_signature_is_low_s(normalized));
	BOOST_REQUIRE(normalize_p1363_low_s(normalized, normalized));
	BOOST_CHECK(normalized == scalars(one, one));
	BOOST_REQUIRE(normalize_p1363_low_s(scalars(one, half), normalized));
	BOOST_CHECK(normalized == scalars(one, half));
	BOOST_REQUIRE(normalize_p1363_low_s(scalars(one, above_half), normalized));
	BOOST_CHECK(normalized == scalars(one, half));
	for (const auto invalid : {scalars(zero, one), scalars(one, zero), scalars(order, one), scalars(one, order)}) {
		const auto before = normalized;
		BOOST_CHECK(!normalize_p1363_low_s(invalid, normalized));
		BOOST_CHECK(normalized == before);
		BOOST_CHECK(!p1363_signature_is_low_s(invalid));
	}
}

#if LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER
BOOST_AUTO_TEST_CASE(provider_signing_uses_local_identity_and_returns_only_verified_low_s) {
	LccDeviceIdentityOptions options;
	lcc_init_device_identity_options(&options);
	options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
	options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
	options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
	std::strcpy(options.application_id, "licensecc.test.bound-signing");
	std::strcpy(options.project, "CAD");
	LccDeviceIdentity* raw = nullptr;
	BOOST_REQUIRE_EQUAL(lcc_device_identity_open(&options, &raw), LCC_DEVICE_OK);
	std::unique_ptr<LccDeviceIdentity, decltype(&lcc_device_identity_close)> handle(raw, lcc_device_identity_close);
	P256Spki public_key;
	std::size_t size = public_key.size();
	BOOST_REQUIRE_EQUAL(lcc_device_identity_get_public_spki(raw, public_key.data(), &size), LCC_DEVICE_OK);
	const auto v = fixture("protocol.json");
	const auto input = renew(v.get_child("body"));
	const auto c = challenge(v.get_child("proof"));
	BoundLocalContext context{"CAD", "https://license.example.test"};
	BoundSignedProof output;
	for (int i = 0; i < 24; ++i) {
		BOOST_REQUIRE_EQUAL(sign_bound_proof_v2(raw, context, input, c, output), LCC_DEVICE_OK);
		BOOST_CHECK_EQUAL(output.key_id, device_key_id(public_key));
		BOOST_REQUIRE_EQUAL(output.signature.size(), 86U);
		std::string padded = output.signature;
		std::replace(padded.begin(), padded.end(), '-', '+');
		std::replace(padded.begin(), padded.end(), '_', '/');
		padded += "==";
		std::vector<std::uint8_t> bytes;
		BOOST_REQUIRE(decode_canonical_base64(padded, bytes));
		P256Signature signature;
		std::copy(bytes.begin(), bytes.end(), signature.begin());
		BOOST_CHECK(p1363_signature_is_low_s(signature));
		BOOST_REQUIRE(bound_proof_input_v2(output.prepared.proof, output.key_id, bytes));
		P256Digest digest;
		BOOST_REQUIRE(sha256(bytes.data(), bytes.size(), digest));
		BOOST_CHECK(verify_p256_p1363(public_key, digest, signature));
	}
	const auto before = output;
	BOOST_CHECK_EQUAL(sign_bound_proof_v2(nullptr, context, input, c, output), LCC_DEVICE_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(sign_bound_proof_v2(raw, {"WRONG", context.audience}, input, c, output),
					  LCC_DEVICE_POLICY_VIOLATION);
	auto invalid = input;
	invalid.generation = 0;
	BOOST_CHECK_EQUAL(sign_bound_proof_v2(raw, context, invalid, c, output), LCC_DEVICE_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(output.signature, before.signature);
	BOOST_CHECK_EQUAL(output.prepared.operation_digest, before.prepared.operation_digest);
	const auto exchange_vector = fixture("exchange.json");
	BOOST_REQUIRE_EQUAL(sign_bound_proof_v2(raw, context, exchange(exchange_vector.get_child("body")),
											challenge(exchange_vector.get_child("proof")), output),
						LCC_DEVICE_OK);
	BOOST_CHECK_EQUAL(output.prepared.proof.path, "/v2/device-authorizations/exchange");
}
#endif
