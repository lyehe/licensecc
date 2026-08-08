/*
 * lease_ring_test.cpp
 *
 * Golden coverage for the lease platform's hot/cold key ring (design doc D6).
 *
 * The hot/cold split is load-bearing: the cold-root key (the project's embedded
 * public_key.h key) signs perpetual/base licenses offline, while a separate
 * rotatable hot lease key signs short leases. Before this, nothing produced a
 * 2-key embedded ring; this test proves the GENERATED ring (populated from a
 * checked-in manifest via scripts/build_lease_ring.py and the LCC_BUILD_LEASE_RING_TEST
 * configuration) works end to end through the production embedded_public_key_ring()
 * / current_v201_signature_policy() / acquire_license() path -- NOT a hand-built
 * in-test policy.
 *
 * Built only when the build baked a real additional (hot) ring record.
 */
#define BOOST_TEST_MODULE test_lease_ring

#include <boost/test/unit_test.hpp>
#include <algorithm>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include <licensecc/licensecc.h>
#include <licensecc_properties_test.h>
#include <licensecc_properties.h>

#include "../../src/library/base/base64.h"
#include "../../src/library/base/string_utils.h"
#include "../../src/library/base/v201_canonical_payload.hpp"
#include "../../src/library/os/signature_verifier.hpp"
#include "../../extern/license-generator/src/base_lib/crypto_helper.hpp"

namespace license {
namespace test {
using namespace std;

#ifdef LCC_ADDITIONAL_PUBLIC_KEY_RECORDS

// The ephemeral hot lease key id + private-key path are injected by
// lcc_generate_test_lease_ring() (cmake/LeaseRing.cmake) so no key material is
// committed. The id equals public_key_id_from_der() of the generated public DER.
static string hot_key_id() { return string(LCC_LEASE_TEST_HOT_KEY_ID); }

static string project_name() { return string(LCC_PROJECT_NAME); }

static string default_feature_name() { return toupper_copy(trim_copy(project_name())); }

static string hot_private_key_path() { return string(LCC_LEASE_TEST_HOT_KEY_PATH); }

// Sign a payload with the HOT lease key (not the project/cold key).
static string sign_with_hot_key(const vector<uint8_t>& payload) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->loadPrivateKey_file(hot_private_key_path());
	const string payload_text(payload.begin(), payload.end());
	return crypto->signString(payload_text);
}

// Sign a payload with the COLD/project key (the embedded ring[0] key).
static string sign_with_cold_key(const vector<uint8_t>& payload) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->loadPrivateKey_file(LCC_PROJECT_PRIVATE_KEY);
	const string payload_text(payload.begin(), payload.end());
	return crypto->signString(payload_text);
}

static vector<license::v201::CanonicalField> v201_fields_for_key_id(const string& key_id) {
	return {
		{LICENSE_VERSION, "201"},
		{LICENSE_CANONICAL_VERSION, "1"},
		{LICENSE_SIGNATURE_VERSION, "1"},
		{LICENSE_SIGNATURE_ALGORITHM, license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256},
		{LICENSE_KEY_ID, key_id},
		{"project", project_name()},
		{"feature", default_feature_name()},
	};
}

// Build a v201 verification request that forces ring selection by key-id (no
// external public-key DER, so it must come from embedded_public_key_ring()).
static license::os::SignatureVerificationRequest ring_request(const string& key_id, const vector<uint8_t>& payload,
															   const string& signature_b64) {
	license::os::SignatureVerificationRequest request;
	request.payload = payload;
	request.signature = unbase64(signature_b64);
	request.declared_algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	request.key_id = key_id;
	request.license_version = 201;
	request.policy = license::os::current_v201_signature_policy();
	return request;
}

static string v201_license_signed_by(const string& key_id, const string& signature) {
	const vector<pair<string, string>> storage = {
		{LICENSE_VERSION, "201"},		   {LICENSE_CANONICAL_VERSION, "1"},
		{LICENSE_SIGNATURE_VERSION, "1"},  {LICENSE_SIGNATURE_ALGORITHM, license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256},
		{LICENSE_KEY_ID, key_id},
	};
	string text = string("[") + default_feature_name() + "]\n";
	for (const pair<string, string>& field : storage) {
		text += field.first + " = " + field.second + "\n";
	}
	text += string(LICENSE_SIGNATURE) + " = " + signature + "\n";
	return text;
}

static LCC_EVENT_TYPE acquire_from_plain_data(const string& license_text, LicenseInfo& license) {
	LicenseLocation location = {LICENSE_PLAIN_DATA};
	BOOST_REQUIRE_LT(license_text.size(), sizeof(location.licenseData));
	copy(license_text.begin(), license_text.end(), location.licenseData);
	return acquire_license(nullptr, &location, &license);
}

// The generated ring carries BOTH the embedded cold-root key and the hot lease key.
BOOST_AUTO_TEST_CASE(generated_ring_contains_cold_and_hot_keys) {
	const vector<license::os::SignaturePublicKey> ring = license::os::embedded_public_key_ring();
	BOOST_REQUIRE_GE(ring.size(), static_cast<size_t>(2));

	bool has_cold = false;
	bool has_hot = false;
	for (const license::os::SignaturePublicKey& key : ring) {
		if (key.key_id == license::os::embedded_public_key_id()) has_cold = true;
		if (key.key_id == hot_key_id()) has_hot = true;
	}
	BOOST_CHECK_MESSAGE(has_cold, "cold-root embedded key present in ring");
	BOOST_CHECK_MESSAGE(has_hot, "hot lease key present in generated ring");
}

// A v201 lease signed by the HOT key verifies through the ring, selected by key-id.
BOOST_AUTO_TEST_CASE(hot_key_lease_verifies_through_generated_ring) {
	const license::v201::CanonicalPayloadResult payload =
		license::v201::build_canonical_payload(v201_fields_for_key_id(hot_key_id()));
	BOOST_REQUIRE_MESSAGE(payload.ok, payload.error);
	const string signature_b64 = sign_with_hot_key(payload.bytes);

	license::os::SignatureVerificationRequest request = ring_request(hot_key_id(), payload.bytes, signature_b64);
	BOOST_CHECK(license::os::signature_request_allowed(request));
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);

	// Negative: drop/retire the hot key-id -> fail closed.
	license::os::SignatureVerificationRequest retired = ring_request(hot_key_id(), payload.bytes, signature_b64);
	retired.policy.retired_key_ids.push_back(hot_key_id());
	BOOST_CHECK_EQUAL(license::os::verify_signature(retired), FUNC_RET_ERROR);

	// Negative: payload mutation -> fail closed.
	license::os::SignatureVerificationRequest mutated = ring_request(hot_key_id(), payload.bytes, signature_b64);
	mutated.payload[0] ^= 0x01;
	BOOST_CHECK_EQUAL(license::os::verify_signature(mutated), FUNC_RET_ERROR);

	// Negative: a hot-key signature presented under the cold key-id must not verify.
	license::os::SignatureVerificationRequest wrong_id = ring_request(license::os::embedded_public_key_id(),
																	  payload.bytes, signature_b64);
	BOOST_CHECK_EQUAL(license::os::verify_signature(wrong_id), FUNC_RET_ERROR);
}

// Full end-to-end: a hot-key-signed v201 license acquires through acquire_license().
BOOST_AUTO_TEST_CASE(hot_key_lease_acquires_through_acquire_license) {
	const license::v201::CanonicalPayloadResult payload =
		license::v201::build_canonical_payload(v201_fields_for_key_id(hot_key_id()));
	BOOST_REQUIRE_MESSAGE(payload.ok, payload.error);
	const string signature_b64 = sign_with_hot_key(payload.bytes);

	LicenseInfo license{};
	const LCC_EVENT_TYPE result = acquire_from_plain_data(v201_license_signed_by(hot_key_id(), signature_b64), license);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(license.license_version, LCC_LICENSE_FORMAT_VERSION_V201);
}

// Sanity: the cold-root key still verifies its own license (the split did not break the cold path).
BOOST_AUTO_TEST_CASE(cold_key_license_still_verifies_after_ring_extension) {
	const string cold_key_id = license::os::embedded_public_key_id();
	const license::v201::CanonicalPayloadResult payload =
		license::v201::build_canonical_payload(v201_fields_for_key_id(cold_key_id));
	BOOST_REQUIRE_MESSAGE(payload.ok, payload.error);
	const string signature_b64 = sign_with_cold_key(payload.bytes);

	LicenseInfo license{};
	const LCC_EVENT_TYPE result = acquire_from_plain_data(v201_license_signed_by(cold_key_id, signature_b64), license);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
}

// Cross-language e2e (#8): a lease signed in JavaScript (the lease Worker's signer,
// lease-sign.mjs) with the same hot key verifies through the real C++ acquire_license path.
// The fixture is produced at configure time when node is available; otherwise this case
// logs a skip rather than silently passing.
BOOST_AUTO_TEST_CASE(js_signed_lease_verifies_in_cpp_cross_language) {
	const std::string js_path(LCC_LEASE_TEST_JS_LICENSE);
	if (js_path.empty()) {
		BOOST_TEST_MESSAGE("cross-language case skipped: no node at configure time (no JS lease fixture)");
		return;
	}
	std::ifstream input(js_path.c_str(), std::ios::binary);
	BOOST_REQUIRE_MESSAGE(input.is_open(), "can open JS-signed lease fixture: " + js_path);
	const std::string license_text((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());

	// Confirm it really is the JS lease bound to the hot key, then verify it end to end.
	BOOST_CHECK_NE(license_text.find(std::string(LICENSE_KEY_ID) + " = " + hot_key_id()), std::string::npos);
	BOOST_CHECK_NE(license_text.find(std::string(PARAM_EXPIRY_DATE) + " = 2035-12-31"), std::string::npos);

	LicenseInfo license{};
	const LCC_EVENT_TYPE result = acquire_from_plain_data(license_text, license);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(license.license_version, LCC_LICENSE_FORMAT_VERSION_V201);
}

#endif  // LCC_ADDITIONAL_PUBLIC_KEY_RECORDS

}  // namespace test
}  // namespace license
