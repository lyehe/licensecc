#define BOOST_TEST_MODULE config_public_api_test

#include <licensecc/licensecc.h>

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <boost/test/unit_test.hpp>

#include <licensecc_properties.h>
#include <licensecc_properties_test.h>
#include "../../extern/license-generator/src/base_lib/crypto_helper.hpp"
#include "../../src/library/LicenseReader.hpp"
#include "../../src/library/base/base64.h"
#include "../../src/library/config_attestation/ConfigAttestation.hpp"
#include "../../src/library/os/os.h"
#include "../../src/library/os/signature_verifier.hpp"

namespace license {
namespace test {
using namespace std;

BOOST_AUTO_TEST_CASE(config_init_helpers_set_size_version_and_defaults) {
	LccConfigInput input;
	lcc_init_config_input(&input);
	BOOST_CHECK_EQUAL(input.size, sizeof(LccConfigInput));
	BOOST_CHECK_EQUAL(input.version, LCC_CONFIG_INPUT_VERSION);
	BOOST_CHECK(input.token == nullptr);
	BOOST_CHECK_EQUAL(input.device_hash[0], '\0');

	LccConfigVerifyOptions options;
	lcc_init_config_verify_options(&options);
	BOOST_CHECK_EQUAL(options.size, sizeof(LccConfigVerifyOptions));
	BOOST_CHECK_EQUAL(options.version, LCC_CONFIG_VERIFY_OPTIONS_VERSION);
	BOOST_CHECK_EQUAL(options.reserved, 0u);

	LccConfigDecision decision;
	lcc_init_config_decision(&decision);
	BOOST_CHECK_EQUAL(decision.size, sizeof(LccConfigDecision));
	BOOST_CHECK_EQUAL(decision.decision, LCC_LICENSE_DECISION_DENY);

	BOOST_CHECK(lcc_set_config_device_hash(&input, string(64, 'a').c_str()));
	BOOST_CHECK_EQUAL(string(input.device_hash), string(64, 'a'));
	BOOST_CHECK(lcc_set_config_device_hash(&input, ""));
	BOOST_CHECK_EQUAL(input.device_hash[0], '\0');
	BOOST_CHECK(!lcc_set_config_device_hash(&input, string(65, 'a').c_str()));
}

BOOST_AUTO_TEST_CASE(verify_config_rejects_malformed_input) {
	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	LicenseInfo info{};
	LccConfigDecision decision;
	lcc_init_config_decision(&decision);

	// null input
	BOOST_CHECK_EQUAL(lcc_verify_config(&caller, nullptr, &info, nullptr, &decision, nullptr), LICENSE_MALFORMED);
	BOOST_CHECK_EQUAL(decision.decision, LCC_LICENSE_DECISION_DENY);

	// bad size
	LccConfigInput input;
	lcc_init_config_input(&input);
	input.token = "lcccfg1.x.y";
	const unsigned char bytes[] = {1, 2, 3};
	input.config_bytes = bytes;
	input.config_len = sizeof(bytes);
	input.size = 1;
	BOOST_CHECK_EQUAL(lcc_verify_config(&caller, nullptr, &info, &input, &decision, nullptr), LICENSE_MALFORMED);
}

static const char* const kConfigFeature = "CONFIG";

static std::string issue_config_license(const std::string& name) {
    std::filesystem::create_directories(LCC_LICENSES_BASE);
    const std::string path = std::string(LCC_LICENSES_BASE) + "/" + name + ".lic";
    std::remove(path.c_str());
    std::stringstream ss;
    ss << LCC_EXE << " license issue";
    ss << " --" PARAM_PRIMARY_KEY " " << LCC_PROJECT_PRIVATE_KEY;
    ss << " --" PARAM_LICENSE_OUTPUT " " << path;
    ss << " --" PARAM_PROJECT_FOLDER " " << LCC_PROJECT_FOLDER;
    ss << " --" PARAM_FEATURE_NAMES " " << kConfigFeature;
    BOOST_REQUIRE_EQUAL(std::system(ss.str().c_str()), 0);
    return path;
}

// Mirrors fingerprint_for_license() in licensecc.cpp.
static std::string fingerprint_of_issued_license(const std::string& path) {
    LicenseLocation location;
    lcc_init_license_location(&location, LICENSE_PATH);
    BOOST_REQUIRE(lcc_set_license_path(&location, path.c_str()));
    const license::LicenseReader reader(&location);
    std::vector<license::FullLicenseInfo> licenses;
    reader.readLicenses(std::string(kConfigFeature), licenses);
    BOOST_REQUIRE(!licenses.empty());
    std::vector<uint8_t> sig = license::unbase64(licenses.front().license_signature);
    if (sig.empty()) {
        sig.assign(licenses.front().license_signature.begin(), licenses.front().license_signature.end());
    }
    return license::os::signature_sha256_hex(sig);
}

static std::string sign_config_payload(const std::string& payload) {
    std::unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
    crypto->loadPrivateKey_file(LCC_PROJECT_PRIVATE_KEY);
    return crypto->signString(payload);
}

static void inject_project_config_key() {
    license::config_attestation::ConfigAttestationPublicKey key;
    key.key_id = license::os::embedded_public_key_id();
    key.public_key_der = license::os::embedded_public_key_der();
    key.bits = license::os::embedded_public_key_bits();
    license::config_attestation::set_trusted_public_keys_for_tests(
        std::vector<license::config_attestation::ConfigAttestationPublicKey>(1, key));
}

static std::string config_token_for(const std::string& fingerprint, const std::vector<uint8_t>& config_bytes,
                                    const std::string& device_hash = "") {
    license::config_attestation::ConfigAttestationClaims c;
    c.purpose = "licensecc-config-attestation";
    c.version = "1";
    c.algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
    c.key_id = license::os::embedded_public_key_id();
    c.project = LCC_PROJECT_NAME;
    c.feature = kConfigFeature;
    c.license_fingerprint = fingerprint;
    c.device_hash = device_hash;
    c.config_id = "app-config";
    c.config_seq = 3;
    c.config_hash = std::string("sha256:") + license::os::signature_sha256_hex(config_bytes);
    c.issued_at = 1000000000;   // 2001-09-09, safely in the past for real-clock verification
    c.expires_at = 4102444800;  // 2100-01-01, finite expiry (never-expires tokens are rejected)
    const std::string payload = license::config_attestation::build_canonical_config_payload(c);
    BOOST_REQUIRE(!payload.empty());
    return license::config_attestation::build_config_envelope(payload, sign_config_payload(payload));
}

static CallerInformations config_caller() {
    CallerInformations caller;
    lcc_init_caller_informations(&caller);
    BOOST_REQUIRE(lcc_set_caller_feature_name(&caller, kConfigFeature));
    return caller;
}

BOOST_AUTO_TEST_CASE(verify_config_allows_valid_token_and_denies_tamper) {
    inject_project_config_key();
    const std::string path = issue_config_license("config-api-valid");
    const std::string fingerprint = fingerprint_of_issued_license(path);
    const std::string body = "{\"flag\":true}";
    const std::vector<uint8_t> config_bytes(body.begin(), body.end());
    const std::string token = config_token_for(fingerprint, config_bytes);

    LicenseLocation location;
    lcc_init_license_location(&location, LICENSE_PATH);
    BOOST_REQUIRE(lcc_set_license_path(&location, path.c_str()));
    CallerInformations caller = config_caller();

    LccConfigInput input;
    lcc_init_config_input(&input);
    input.token = token.c_str();
    input.config_bytes = config_bytes.data();
    input.config_len = config_bytes.size();

    LicenseInfo info{};
    LccConfigDecision decision;
    lcc_init_config_decision(&decision);
    BOOST_CHECK_EQUAL(lcc_verify_config(&caller, &location, &info, &input, &decision, nullptr), LICENSE_OK);
    BOOST_CHECK_EQUAL(decision.decision, LCC_LICENSE_DECISION_ALLOW);
    BOOST_CHECK(decision.bound_to_license);
    BOOST_CHECK(!decision.bound_to_device);
    BOOST_CHECK_EQUAL(std::string(decision.config_id), "app-config");
    BOOST_CHECK_EQUAL(decision.config_seq, 3u);

    std::vector<uint8_t> tampered = config_bytes;
    tampered[0] = static_cast<uint8_t>(tampered[0] ^ 0x01);
    input.config_bytes = tampered.data();
    input.config_len = tampered.size();
    LccConfigDecision deny;
    lcc_init_config_decision(&deny);
    BOOST_CHECK_EQUAL(lcc_verify_config(&caller, &location, &info, &input, &deny, nullptr),
                      LICENSE_CONFIG_HASH_MISMATCH);
    BOOST_CHECK_EQUAL(deny.decision, LCC_LICENSE_DECISION_DENY);

    license::config_attestation::set_trusted_public_keys_for_tests({});
    std::remove(path.c_str());
}

BOOST_AUTO_TEST_CASE(verify_config_denies_when_local_license_missing) {
    inject_project_config_key();
    const std::string body = "{}";
    const std::vector<uint8_t> config_bytes(body.begin(), body.end());
    const std::string token = config_token_for(std::string(64, 'a'), config_bytes);

    CallerInformations caller = config_caller();
    LccConfigInput input;
    lcc_init_config_input(&input);
    input.token = token.c_str();
    input.config_bytes = config_bytes.data();
    input.config_len = config_bytes.size();

    LicenseInfo info{};
    LccConfigDecision decision;
    lcc_init_config_decision(&decision);
    // No license location and env lookup disabled in hardened projects -> license fails first.
    const LCC_EVENT_TYPE result = lcc_verify_config(&caller, nullptr, &info, &input, &decision, nullptr);
    BOOST_CHECK_NE(result, LICENSE_OK);
    BOOST_CHECK_EQUAL(decision.decision, LCC_LICENSE_DECISION_DENY);
    license::config_attestation::set_trusted_public_keys_for_tests({});
}

}  // namespace test
}  // namespace license
