#define BOOST_TEST_MODULE device_identity_vectors_test

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>
#include <boost/test/unit_test.hpp>
#include <licensecc/device_identity.h>

#include "device_key_provider.hpp"
#include "p256_crypto.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iterator>
#include <new>
#include <string>
#include <type_traits>
#include <vector>

namespace {

using license::device_identity::DeviceNamespace;
using license::device_identity::P256Digest;
using license::device_identity::P256Signature;
using license::device_identity::P256Spki;
using license::device_identity::SensitiveArray;
using license::device_identity::SensitiveVector;

static_assert(!std::is_copy_constructible<SensitiveArray<32>>::value,
			  "sensitive arrays must not create untracked digest copies");
static_assert(!std::is_move_constructible<SensitiveArray<32>>::value,
			  "sensitive arrays must not move without wiping their source");
static_assert(!std::is_trivially_destructible<SensitiveArray<32>>::value,
			  "sensitive arrays require a wiping destructor");
static_assert(!std::is_copy_constructible<SensitiveVector>::value,
			  "sensitive vectors must not create untracked scratch copies");
static_assert(!std::is_move_constructible<SensitiveVector>::value,
			  "sensitive vectors must not move without wiping their source");
static_assert(!std::is_trivially_destructible<SensitiveVector>::value, "sensitive vectors require a wiping destructor");

std::string read_binary(const std::string& relative_path) {
	const std::string path = std::string(LCC_DEVICE_IDENTITY_VECTOR_ROOT) + "/" + relative_path;
	std::ifstream input(path.c_str(), std::ios::binary);
	BOOST_REQUIRE_MESSAGE(input.is_open(), "can open vector " + path);
	return std::string((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
}

std::string strip_line_endings(std::string value) {
	while (!value.empty() && (value.back() == '\r' || value.back() == '\n')) {
		value.pop_back();
	}
	return value;
}

template <std::size_t N>
void set_field(char (&field)[N], const std::string& value) {
	BOOST_REQUIRE(value.size() < N);
	std::memcpy(field, value.c_str(), value.size() + 1U);
}

LccDeviceProofInput input_from_manifest(const boost::property_tree::ptree& manifest, std::uint32_t audience) {
	LccDeviceProofInput input;
	lcc_init_device_proof_input(&input);
	input.audience = audience;
	input.request_timestamp = manifest.get<std::uint64_t>("request_timestamp");
	input.client_hardening = manifest.get<std::uint32_t>("client_hardening");
	set_field(input.project, manifest.get<std::string>("project"));
	set_field(input.feature, manifest.get<std::string>("feature"));
	set_field(input.license_fingerprint, manifest.get<std::string>("license_fingerprint"));
	set_field(input.device_hash, manifest.get<std::string>("device_hash"));
	set_field(input.nonce, manifest.get<std::string>("nonce"));
	return input;
}

}  // namespace

BOOST_AUTO_TEST_CASE(sensitive_scratch_buffers_share_the_destructor_wipe_primitive) {
	using DigestScratch = SensitiveArray<32>;
	static_assert(sizeof(DigestScratch) == 32U, "digest wrapper has unexpected padding");
	alignas(DigestScratch) std::array<unsigned char, sizeof(DigestScratch)> storage{};
	auto* digest = new (storage.data()) DigestScratch();
	std::fill(digest->value.begin(), digest->value.end(), 0xa5U);
	digest->~DigestScratch();
	BOOST_TEST(std::all_of(storage.begin(), storage.end(), [](unsigned char value) { return value == 0U; }));

	SensitiveVector scratch(47U);
	std::fill(scratch.value.begin(), scratch.value.end(), 0x5aU);
	scratch.clear();
	BOOST_TEST(std::all_of(scratch.value.begin(), scratch.value.end(), [](std::uint8_t value) { return value == 0U; }));
}

BOOST_AUTO_TEST_CASE(provider_metadata_contract_table_is_exact_and_rejects_substitutions) {
	struct Expected {
		std::uint32_t backend;
		std::uint32_t assurance;
		const char* provider;
	};
	const Expected expected[] = {
		{LCC_DEVICE_BACKEND_WINDOWS_TPM, LCC_DEVICE_ASSURANCE_REPORTED_HARDWARE, "windows-platform-ksp"},
		{LCC_DEVICE_BACKEND_TPM2_OPENSSL, LCC_DEVICE_ASSURANCE_REPORTED_HARDWARE, "tpm2-openssl"},
		{LCC_DEVICE_BACKEND_SOFTWARE_TEST, LCC_DEVICE_ASSURANCE_SOFTWARE, "software-test"},
	};
	for (const Expected& item : expected) {
		const auto* contract = license::device_identity::provider_contract_for_backend(item.backend);
		BOOST_REQUIRE(contract != nullptr);
		BOOST_TEST(contract->backend == item.backend);
		BOOST_TEST(contract->assurance == item.assurance);
		BOOST_TEST(std::string(contract->provider) == item.provider);
		BOOST_TEST(std::string(contract->algorithm) == "ecdsa-p256-sha256");

		license::device_identity::ProviderMetadata metadata;
		metadata.backend = item.backend;
		metadata.scope = LCC_DEVICE_SCOPE_USER;
		metadata.assurance = item.assurance;
		metadata.provider = item.provider;
		metadata.algorithm = contract->algorithm;
		license::device_identity::ProviderOpenRequest request;
		request.backend = item.backend;
		request.scope = LCC_DEVICE_SCOPE_USER;
		BOOST_TEST(license::device_identity::provider_metadata_matches_contract(metadata, request));
		const license::device_identity::ProviderMetadata canonical = metadata;
		metadata.provider += "-substitute";
		BOOST_TEST(!license::device_identity::provider_metadata_matches_contract(metadata, request));
		metadata = canonical;
		metadata.algorithm += "-substitute";
		BOOST_TEST(!license::device_identity::provider_metadata_matches_contract(metadata, request));
		metadata = canonical;
		metadata.assurance = item.assurance == LCC_DEVICE_ASSURANCE_SOFTWARE ? LCC_DEVICE_ASSURANCE_REPORTED_HARDWARE
																			 : LCC_DEVICE_ASSURANCE_SOFTWARE;
		BOOST_TEST(!license::device_identity::provider_metadata_matches_contract(metadata, request));
		metadata = canonical;
		metadata.backend = LCC_DEVICE_BACKEND_AUTO;
		BOOST_TEST(!license::device_identity::provider_metadata_matches_contract(metadata, request));
		metadata = canonical;
		metadata.scope = LCC_DEVICE_SCOPE_MACHINE;
		BOOST_TEST(!license::device_identity::provider_metadata_matches_contract(metadata, request));
	}
	BOOST_TEST(license::device_identity::provider_contract_for_backend(LCC_DEVICE_BACKEND_AUTO) == nullptr);
}

BOOST_AUTO_TEST_CASE(namespace_v1_table_matches_normative_bytes_and_names) {
	boost::property_tree::ptree root;
	boost::property_tree::read_json(std::string(LCC_DEVICE_IDENTITY_VECTOR_ROOT) + "/device_identity/namespace_v1.json",
									root);
	BOOST_TEST(root.get<unsigned int>("schema_version") == 1U);
	BOOST_TEST(root.get<std::string>("application_id") == "licensecc.test");
	BOOST_TEST(root.get<std::string>("project") == "DEFAULT");

	std::size_t count = 0U;
	for (const auto& entry : root.get_child("vectors")) {
		const auto& vector = entry.second;
		const std::string scope_text = vector.get<std::string>("scope");
		const std::uint32_t scope = scope_text == "user" ? LCC_DEVICE_SCOPE_USER : LCC_DEVICE_SCOPE_MACHINE;
		DeviceNamespace names;
		BOOST_REQUIRE(license::device_identity::derive_namespace_v1("licensecc.test", "DEFAULT", scope, names));
		BOOST_TEST(license::device_identity::lowercase_hex(reinterpret_cast<const std::uint8_t*>(names.payload.data()),
														   names.payload.size()) ==
				   vector.get<std::string>("namespace_payload_hex"));
		BOOST_TEST(names.hash == vector.get<std::string>("namespace_hash"));
		BOOST_TEST(names.windows_name == vector.get<std::string>("windows_name"));
		BOOST_TEST(names.linux_filename == vector.get<std::string>("linux_filename"));
		BOOST_TEST(names.lock_name == vector.get<std::string>("lock_name"));
		++count;
	}
	BOOST_TEST(count == 2U);
}

BOOST_AUTO_TEST_CASE(task1_request_proof_fixture_builds_and_verifies) {
	boost::property_tree::ptree manifest;
	boost::property_tree::read_json(std::string(LCC_DEVICE_IDENTITY_VECTOR_ROOT) + "/device_proof/v1/manifest.json",
									manifest);

	std::vector<std::uint8_t> spki_bytes;
	BOOST_REQUIRE(license::device_identity::parse_lowercase_hex(
		strip_line_endings(read_binary("device_proof/v1/public_key.spki.der.hex")), spki_bytes));
	P256Spki spki{};
	BOOST_REQUIRE(license::device_identity::canonicalize_p256_spki(spki_bytes.data(), spki_bytes.size(), spki));
	BOOST_TEST(license::device_identity::device_key_id(spki) == manifest.get<std::string>("device_key_id"));

	std::vector<std::uint8_t> signature_bytes;
	BOOST_REQUIRE(license::device_identity::parse_lowercase_hex(
		strip_line_endings(read_binary("device_proof/v1/signature.p1363.hex")), signature_bytes));
	BOOST_REQUIRE(signature_bytes.size() == 64U);
	P256Signature signature{};
	std::copy(signature_bytes.begin(), signature_bytes.end(), signature.begin());

	struct AudienceVector {
		std::uint32_t audience;
		const char* fixture;
	};
	const AudienceVector vectors[] = {
		{LCC_DEVICE_PROOF_AUDIENCE_VERIFY, "online.payload"},
		{LCC_DEVICE_PROOF_AUDIENCE_LEASE, "lease.payload"},
		{LCC_DEVICE_PROOF_AUDIENCE_SEAT, "seat.payload"},
	};
	for (const AudienceVector& vector : vectors) {
		const LccDeviceProofInput input = input_from_manifest(manifest, vector.audience);
		std::vector<std::uint8_t> payload;
		BOOST_REQUIRE(license::device_identity::build_request_proof_payload_v1(
						  input, manifest.get<std::string>("device_key_id"), payload) == LCC_DEVICE_OK);
		const std::string expected = read_binary(std::string("device_proof/v1/") + vector.fixture);
		BOOST_TEST(std::string(payload.begin(), payload.end()) == expected);
		P256Digest digest{};
		BOOST_REQUIRE(license::device_identity::sha256(payload.data(), payload.size(), digest));
		const bool expected_valid = vector.audience == LCC_DEVICE_PROOF_AUDIENCE_VERIFY;
		BOOST_TEST(license::device_identity::verify_p256_p1363(spki, digest, signature) == expected_valid);
	}

	std::vector<std::uint8_t> decoded;
	BOOST_REQUIRE(license::device_identity::decode_canonical_base64(
		strip_line_endings(read_binary("device_proof/v1/signature.p1363.b64")), decoded));
	BOOST_TEST(decoded == signature_bytes);
}

BOOST_AUTO_TEST_CASE(strict_p256_negative_corpus_fails_closed) {
	std::vector<std::uint8_t> spki_bytes;
	BOOST_REQUIRE(license::device_identity::parse_lowercase_hex(
		strip_line_endings(read_binary("device_proof/v1/public_key.spki.der.hex")), spki_bytes));
	P256Spki spki{};
	BOOST_REQUIRE(license::device_identity::canonicalize_p256_spki(spki_bytes.data(), spki_bytes.size(), spki));
	const std::string payload_text = read_binary("device_proof/v1/online.payload");
	P256Digest digest{};
	BOOST_REQUIRE(license::device_identity::sha256(reinterpret_cast<const std::uint8_t*>(payload_text.data()),
												   payload_text.size(), digest));
	std::vector<std::uint8_t> signature_bytes;
	BOOST_REQUIRE(license::device_identity::parse_lowercase_hex(
		strip_line_endings(read_binary("device_proof/v1/signature.p1363.hex")), signature_bytes));
	P256Signature signature{};
	std::copy(signature_bytes.begin(), signature_bytes.end(), signature.begin());
	BOOST_REQUIRE(license::device_identity::verify_p256_p1363(spki, digest, signature));

	P256Spki malformed = spki;
	malformed[6] ^= 1U;
	P256Spki ignored{};
	BOOST_TEST(!license::device_identity::canonicalize_p256_spki(malformed.data(), malformed.size(), ignored));
	P256Spki wrong_curve = spki;
	wrong_curve[22] = 0x01U;
	BOOST_TEST(!license::device_identity::canonicalize_p256_spki(wrong_curve.data(), wrong_curve.size(), ignored));
	P256Spki compressed_point = spki;
	compressed_point[26] = 0x02U;
	BOOST_TEST(
		!license::device_identity::canonicalize_p256_spki(compressed_point.data(), compressed_point.size(), ignored));
	P256Spki invalid_point = spki;
	std::fill(invalid_point.begin() + 27U, invalid_point.end(), 0U);
	BOOST_TEST(!license::device_identity::canonicalize_p256_spki(invalid_point.data(), invalid_point.size(), ignored));
	BOOST_TEST(!license::device_identity::canonicalize_p256_spki(spki.data(), spki.size() - 1U, ignored));
	std::vector<std::uint8_t> trailing(spki.begin(), spki.end());
	trailing.push_back(0U);
	BOOST_TEST(!license::device_identity::canonicalize_p256_spki(trailing.data(), trailing.size(), ignored));

	P256Signature zero_r = signature;
	std::fill(zero_r.begin(), zero_r.begin() + 32, 0U);
	BOOST_TEST(!license::device_identity::verify_p256_p1363(spki, digest, zero_r));
	P256Signature zero_s = signature;
	std::fill(zero_s.begin() + 32, zero_s.end(), 0U);
	BOOST_TEST(!license::device_identity::verify_p256_p1363(spki, digest, zero_s));
	P256Signature order_r = signature;
	const std::array<std::uint8_t, 32> order = {{0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
												 0xff, 0xff, 0xff, 0xff, 0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17,
												 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51}};
	std::copy(order.begin(), order.end(), order_r.begin());
	BOOST_TEST(!license::device_identity::verify_p256_p1363(spki, digest, order_r));
	P256Signature order_s = signature;
	std::copy(order.begin(), order.end(), order_s.begin() + 32U);
	BOOST_TEST(!license::device_identity::verify_p256_p1363(spki, digest, order_s));
	std::array<std::uint8_t, 32> above_order = order;
	++above_order.back();
	P256Signature above_order_r = signature;
	std::copy(above_order.begin(), above_order.end(), above_order_r.begin());
	BOOST_TEST(!license::device_identity::verify_p256_p1363(spki, digest, above_order_r));
	P256Signature above_order_s = signature;
	std::copy(above_order.begin(), above_order.end(), above_order_s.begin() + 32U);
	BOOST_TEST(!license::device_identity::verify_p256_p1363(spki, digest, above_order_s));
	BOOST_TEST(!license::device_identity::verify_p256_p1363(spki, digest, signature.data(), signature.size() - 1U));
	std::array<std::uint8_t, 65> long_signature{};
	std::copy(signature.begin(), signature.end(), long_signature.begin());
	BOOST_TEST(
		!license::device_identity::verify_p256_p1363(spki, digest, long_signature.data(), long_signature.size()));

	std::vector<std::uint8_t> der;
	BOOST_REQUIRE(license::device_identity::p1363_signature_to_der(signature, der));
	P256Signature round_trip{};
	BOOST_REQUIRE(license::device_identity::der_signature_to_p1363(der.data(), der.size(), round_trip));
	BOOST_TEST(round_trip == signature);
	der.push_back(0U);
	BOOST_TEST(!license::device_identity::der_signature_to_p1363(der.data(), der.size(), round_trip));
	const std::uint8_t negative_integer[] = {0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01};
	BOOST_TEST(
		!license::device_identity::der_signature_to_p1363(negative_integer, sizeof(negative_integer), round_trip));
	const std::uint8_t redundant_zero[] = {0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01};
	BOOST_TEST(!license::device_identity::der_signature_to_p1363(redundant_zero, sizeof(redundant_zero), round_trip));
	const std::uint8_t zero_length_integer[] = {0x30, 0x05, 0x02, 0x00, 0x02, 0x01, 0x01};
	BOOST_TEST(!license::device_identity::der_signature_to_p1363(zero_length_integer, sizeof(zero_length_integer),
																 round_trip));
	std::array<std::uint8_t, 40> oversized_integer{};
	oversized_integer[0] = 0x30U;
	oversized_integer[1] = 0x26U;
	oversized_integer[2] = 0x02U;
	oversized_integer[3] = 0x21U;
	oversized_integer[4] = 0x01U;
	oversized_integer[37] = 0x02U;
	oversized_integer[38] = 0x01U;
	oversized_integer[39] = 0x01U;
	BOOST_TEST(!license::device_identity::der_signature_to_p1363(oversized_integer.data(), oversized_integer.size(),
																 round_trip));
	const std::uint8_t nonminimal_sequence_length[] = {0x30, 0x81, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01};
	BOOST_TEST(!license::device_identity::der_signature_to_p1363(nonminimal_sequence_length,
																 sizeof(nonminimal_sequence_length), round_trip));

	P256Digest double_digest{};
	BOOST_REQUIRE(license::device_identity::sha256(digest.data(), digest.size(), double_digest));
	BOOST_TEST(!license::device_identity::verify_p256_p1363(spki, double_digest, signature));
	std::vector<std::uint8_t> decoded;
	BOOST_TEST(!license::device_identity::decode_canonical_base64("AB==", decoded));
	BOOST_TEST(!license::device_identity::decode_canonical_base64("AAAA\n", decoded));
	BOOST_TEST(!license::device_identity::decode_canonical_base64("AA=A", decoded));
	BOOST_TEST(!license::device_identity::decode_canonical_base64("A===", decoded));
	BOOST_TEST(!license::device_identity::decode_canonical_base64("AA_-", decoded));
}

#if LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER
BOOST_AUTO_TEST_CASE(software_provider_builds_a_valid_randomized_proof) {
	boost::property_tree::ptree manifest;
	boost::property_tree::read_json(std::string(LCC_DEVICE_IDENTITY_VECTOR_ROOT) + "/device_proof/v1/manifest.json",
									manifest);
	LccDeviceIdentityOptions options;
	lcc_init_device_identity_options(&options);
	options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
	options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
	options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
	set_field(options.application_id, "licensecc.test.vectors");
	set_field(options.project, "DEFAULT");
	LccDeviceIdentity* handle = nullptr;
	BOOST_REQUIRE(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_OK);

	LccDeviceIdentityMetadata metadata;
	lcc_init_device_identity_metadata(&metadata);
	BOOST_REQUIRE(lcc_device_identity_get_metadata(handle, &metadata) == LCC_DEVICE_OK);
	P256Spki spki{};
	std::size_t spki_size = spki.size();
	BOOST_REQUIRE(lcc_device_identity_get_public_spki(handle, spki.data(), &spki_size) == LCC_DEVICE_OK);

	LccDeviceProofInput input = input_from_manifest(manifest, LCC_DEVICE_PROOF_AUDIENCE_VERIFY);
	LccDeviceProof proof;
	lcc_init_device_proof(&proof);
	BOOST_REQUIRE(lcc_device_identity_build_request_proof_v1(handle, &input, &proof) == LCC_DEVICE_OK);
	std::vector<std::uint8_t> signature_bytes;
	BOOST_REQUIRE(license::device_identity::decode_canonical_base64(proof.request_signature, signature_bytes));
	BOOST_REQUIRE(signature_bytes.size() == 64U);
	P256Signature signature{};
	std::copy(signature_bytes.begin(), signature_bytes.end(), signature.begin());
	std::vector<std::uint8_t> payload;
	BOOST_REQUIRE(license::device_identity::build_request_proof_payload_v1(input, proof.device_key_id, payload) ==
				  LCC_DEVICE_OK);
	P256Digest digest{};
	BOOST_REQUIRE(license::device_identity::sha256(payload.data(), payload.size(), digest));
	BOOST_TEST(license::device_identity::verify_p256_p1363(spki, digest, signature));

	lcc_device_identity_close(handle);
	options.flags = 0U;
	BOOST_TEST(lcc_device_identity_delete_key(&options, metadata.device_key_id) == LCC_DEVICE_OK);
}
#endif
