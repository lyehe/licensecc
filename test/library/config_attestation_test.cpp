#define BOOST_TEST_MODULE config_attestation_test

#include <boost/test/unit_test.hpp>

#include <cstdint>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <licensecc_properties.h>
#include <licensecc_properties_test.h>
#include "../../extern/license-generator/src/base_lib/crypto_helper.hpp"
#include "../../src/library/config_attestation/ConfigAttestation.hpp"
#include "../../src/library/os/os.h"
#include "../../src/library/os/signature_verifier.hpp"

namespace license {
namespace test {
using namespace std;
using config_attestation::ConfigVerifyFailure;

static string sign_payload(const string& payload) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->loadPrivateKey_file(LCC_PROJECT_PRIVATE_KEY);
	return crypto->signString(payload);
}

static string sha256_hex(const vector<uint8_t>& bytes) {
	return license::os::signature_sha256_hex(bytes);
}

static vector<config_attestation::ConfigAttestationPublicKey> project_public_keys_for_tests() {
	config_attestation::ConfigAttestationPublicKey key;
	key.key_id = license::os::embedded_public_key_id();
	key.public_key_der = license::os::embedded_public_key_der();
	key.bits = license::os::embedded_public_key_bits();
	return vector<config_attestation::ConfigAttestationPublicKey>(1, key);
}

struct ConfigAttestationFixture {
	ConfigAttestationFixture() {
		config_attestation::set_trusted_public_keys_for_tests(project_public_keys_for_tests());
	}
	~ConfigAttestationFixture() {
		config_attestation::set_trusted_public_keys_for_tests(
			vector<config_attestation::ConfigAttestationPublicKey>());
	}
};
BOOST_TEST_GLOBAL_FIXTURE(ConfigAttestationFixture);

static config_attestation::ConfigAttestationExpected base_expected(uint64_t now = 1000) {
	config_attestation::ConfigAttestationExpected e;
	e.project = LCC_PROJECT_NAME;
	e.feature = "CONFIG";
	e.license_fingerprint = string(64, 'a');
	e.device_hash = "";
	const string body = "{\"flag\":true}";
	e.config_bytes.assign(body.begin(), body.end());
	e.now_epoch_seconds = now;
	return e;
}

static config_attestation::ConfigAttestationClaims make_claims(const config_attestation::ConfigAttestationExpected& e,
															   const string& config_id = "app-config",
															   uint64_t config_seq = 5, uint64_t issued_at = 900,
															   uint64_t expires_at = 1100) {
	config_attestation::ConfigAttestationClaims c;
	c.purpose = "licensecc-config-attestation";
	c.version = "1";
	c.algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	c.key_id = license::os::embedded_public_key_id();
	c.project = e.project;
	c.feature = e.feature;
	c.license_fingerprint = e.license_fingerprint;
	c.device_hash = e.device_hash;
	c.config_id = config_id;
	c.config_seq = config_seq;
	c.config_hash = string("sha256:") + sha256_hex(e.config_bytes);
	c.issued_at = issued_at;
	c.expires_at = expires_at;
	return c;
}

static string token_for(const config_attestation::ConfigAttestationClaims& c) {
	const string payload = config_attestation::build_canonical_config_payload(c);
	BOOST_REQUIRE(!payload.empty());
	return config_attestation::build_config_envelope(payload, sign_payload(payload));
}

BOOST_AUTO_TEST_CASE(canonical_config_payload_is_byte_exact) {
	config_attestation::ConfigAttestationClaims c;
	c.purpose = "licensecc-config-attestation";
	c.version = "1";
	c.algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	c.key_id = "sha256:test-key";
	c.project = "DEFAULT";
	c.feature = "CONFIG";
	c.license_fingerprint = string(64, 'a');
	c.device_hash = string(64, 'b');
	c.config_id = "app-config";
	c.config_seq = 42;
	c.config_hash = string("sha256:") + string(64, 'c');
	c.issued_at = 1000;
	c.expires_at = 1300;

	const string expected = "purpose=licensecc-config-attestation\n"
							"version=1\n"
							"alg=rsa-pkcs1-sha256\n"
							"key-id=sha256:test-key\n"
							"project=DEFAULT\n"
							"feature=CONFIG\n"
							"license-fingerprint=" +
							string(64, 'a') + "\n" + "device-hash=" + string(64, 'b') + "\n" +
							"config-id=app-config\n"
							"config-seq=42\n"
							"config-hash=sha256:" +
							string(64, 'c') + "\n" + "issued-at=1000\n" + "expires-at=1300\n";

	BOOST_CHECK_EQUAL(config_attestation::build_canonical_config_payload(c), expected);
}

BOOST_AUTO_TEST_CASE(verifier_accepts_valid_token_and_rejects_envelope_and_signature_tampering) {
	auto e = base_expected();
	const string token = token_for(make_claims(e));
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;
	config_attestation::ConfigAttestationClaims out;

	BOOST_CHECK(config_attestation::verify_config_envelope(token, e, &out, error, failure));
	BOOST_CHECK(error.empty());
	BOOST_CHECK_EQUAL(out.config_id, "app-config");

	BOOST_CHECK(!config_attestation::verify_config_envelope("bad." + token, e, nullptr, error, failure));
	BOOST_CHECK(failure == ConfigVerifyFailure::Envelope);

	string tampered = token;
	const size_t first = tampered.find('.');
	const size_t second = tampered.find('.', first + 1);
	BOOST_REQUIRE(second != string::npos);
	tampered[second + 1] = tampered[second + 1] == 'A' ? 'B' : 'A';
	BOOST_CHECK(!config_attestation::verify_config_envelope(tampered, e, nullptr, error, failure));
	BOOST_CHECK(failure == ConfigVerifyFailure::Signature);
}

BOOST_AUTO_TEST_CASE(golden_round_trip_and_signature_error_noun_is_stable) {
	// Characterization test pinned BEFORE the shared signed-token core extraction.
	// A known payload round-trips through build_config_envelope -> verify_config_envelope
	// with the expected claims, and a signature-tampered envelope yields the exact
	// existing error string. This locks the error-noun behavior the shared core's
	// error_noun parameter must preserve.
	auto e = base_expected();
	const auto claims = make_claims(e);
	const string token = token_for(claims);

	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;
	config_attestation::ConfigAttestationClaims out;
	BOOST_CHECK(config_attestation::verify_config_envelope(token, e, &out, error, failure));
	BOOST_CHECK(error.empty());
	BOOST_CHECK(failure == ConfigVerifyFailure::None);
	BOOST_CHECK_EQUAL(out.purpose, "licensecc-config-attestation");
	BOOST_CHECK_EQUAL(out.config_id, "app-config");
	BOOST_CHECK_EQUAL(out.config_seq, 5u);
	BOOST_CHECK_EQUAL(out.config_hash, claims.config_hash);

	// Flip one base64 signature character so the signature no longer verifies.
	string tampered = token;
	const size_t first = tampered.find('.');
	const size_t second = tampered.find('.', first + 1);
	BOOST_REQUIRE(second != string::npos);
	tampered[second + 1] = tampered[second + 1] == 'A' ? 'B' : 'A';

	error.clear();
	failure = ConfigVerifyFailure::None;
	BOOST_CHECK(!config_attestation::verify_config_envelope(tampered, e, nullptr, error, failure));
	BOOST_CHECK(failure == ConfigVerifyFailure::Signature);
	BOOST_CHECK_EQUAL(error, "config token signature verification failed");
}

BOOST_AUTO_TEST_CASE(verifier_rejects_binding_mismatch) {
	auto e = base_expected();
	const string token = token_for(make_claims(e));
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;

	auto expect_binding_denied = [&](config_attestation::ConfigAttestationExpected bad) {
		BOOST_CHECK(!config_attestation::verify_config_envelope(token, bad, nullptr, error, failure));
		BOOST_CHECK(failure == ConfigVerifyFailure::Binding);
	};
	{ auto bad = e; bad.project = "OTHER"; expect_binding_denied(bad); }
	{ auto bad = e; bad.feature = "OTHER"; expect_binding_denied(bad); }
	{ auto bad = e; bad.license_fingerprint = string(64, 'b'); expect_binding_denied(bad); }
	{ auto bad = e; bad.device_hash = string(64, 'c'); expect_binding_denied(bad); }
}

BOOST_AUTO_TEST_CASE(verifier_rejects_config_byte_tamper) {
	auto e = base_expected();
	const string token = token_for(make_claims(e));
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;

	auto tampered = e;
	tampered.config_bytes[0] = static_cast<uint8_t>(tampered.config_bytes[0] ^ 0x01);
	BOOST_CHECK(!config_attestation::verify_config_envelope(token, tampered, nullptr, error, failure));
	BOOST_CHECK(failure == ConfigVerifyFailure::HashMismatch);

	BOOST_CHECK(config_attestation::verify_config_envelope(token, e, nullptr, error, failure));
}

BOOST_AUTO_TEST_CASE(verifier_enforces_expiry_window) {
	auto e = base_expected(1000);
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;

	{
		const string t = token_for(make_claims(e, "app-config", 5, 900, 950));
		BOOST_CHECK(!config_attestation::verify_config_envelope(t, e, nullptr, error, failure));
		BOOST_CHECK(failure == ConfigVerifyFailure::Expired);
	}
	{
		const string t = token_for(make_claims(e, "app-config", 5, 900, 0));
		BOOST_CHECK(config_attestation::verify_config_envelope(t, e, nullptr, error, failure));
	}
	{
		const string t = token_for(make_claims(e, "app-config", 5, 1000 + 301, 0));
		BOOST_CHECK(!config_attestation::verify_config_envelope(t, e, nullptr, error, failure));
		BOOST_CHECK(failure == ConfigVerifyFailure::Expired);
	}
}

BOOST_AUTO_TEST_CASE(verifier_enforces_config_seq_floor) {
	auto e = base_expected();
	const string token = token_for(make_claims(e, "app-config", 5, 900, 1100));
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;

	auto below = e;
	below.min_config_seq = 6;
	BOOST_CHECK(!config_attestation::verify_config_envelope(token, below, nullptr, error, failure));
	BOOST_CHECK(failure == ConfigVerifyFailure::Rollback);

	auto at = e;
	at.min_config_seq = 5;
	BOOST_CHECK(config_attestation::verify_config_envelope(token, at, nullptr, error, failure));
}

BOOST_AUTO_TEST_CASE(verifier_accepts_large_config) {
	auto e = base_expected();
	e.config_bytes.assign(static_cast<size_t>(1024) * 1024, 0x5A);
	const string token = token_for(make_claims(e));
	string error;
	ConfigVerifyFailure failure = ConfigVerifyFailure::None;

	BOOST_CHECK(config_attestation::verify_config_envelope(token, e, nullptr, error, failure));
	BOOST_CHECK(error.empty());
}

BOOST_AUTO_TEST_CASE(golden_config_token_signed_by_node_verifies_in_cpp) {
	const string base = string(PROJECT_TEST_SRC_DIR) + "/vectors/config_attestation/";
	auto read_file = [&](const string& name) {
		ifstream in((base + name).c_str(), ios::binary);
		BOOST_REQUIRE_MESSAGE(in.is_open(), "open " + base + name);
		return string((istreambuf_iterator<char>(in)), istreambuf_iterator<char>());
	};
	auto trim = [](string s) { while (!s.empty() && (s.back()=='\n'||s.back()=='\r'||s.back()==' ')) s.pop_back(); return s; };
	auto hex_to_bytes = [](const string& hex) {
		vector<uint8_t> out;
		for (size_t i = 0; i + 1 < hex.size(); i += 2)
			out.push_back(static_cast<uint8_t>(stoul(hex.substr(i, 2), nullptr, 16)));
		return out;
	};

	const string token = trim(read_file("golden.token"));
	const string key_id = trim(read_file("golden.key_id"));
	const string config = read_file("golden.config");  // exact bytes, no trim
	const vector<uint8_t> public_key_der = hex_to_bytes(trim(read_file("golden.public_key.pkcs1.der.hex")));

	config_attestation::ConfigAttestationExpected expected;
	expected.project = "DEFAULT";
	expected.feature = "EXPORT";
	expected.license_fingerprint = string(64, 'a');
	expected.device_hash = "";
	expected.config_bytes.assign(config.begin(), config.end());
	expected.now_epoch_seconds = 1500;  // inside [1000,2000]
	expected.min_config_seq = 9;
	config_attestation::ConfigAttestationPublicKey key;
	key.key_id = key_id;
	key.public_key_der = public_key_der;
	key.bits = 3072;
	expected.trusted_public_keys.push_back(key);

	config_attestation::ConfigAttestationClaims claims;
	string error;
	config_attestation::ConfigVerifyFailure failure = config_attestation::ConfigVerifyFailure::None;
	BOOST_REQUIRE_MESSAGE(
		config_attestation::verify_config_envelope(token, expected, &claims, error, failure), error);
	BOOST_CHECK_EQUAL(claims.config_id, "app-config");
	BOOST_CHECK_EQUAL(claims.config_seq, 9u);
	BOOST_CHECK_EQUAL(claims.key_id, key_id);
}

}  // namespace test
}  // namespace license
