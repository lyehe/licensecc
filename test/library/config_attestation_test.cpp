#define BOOST_TEST_MODULE config_attestation_test

#include <boost/test/unit_test.hpp>

#include <cstdint>
#include <memory>
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

}  // namespace test
}  // namespace license
