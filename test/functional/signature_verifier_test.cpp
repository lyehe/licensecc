
/*
 * LicenseVerifier_test.cpp
 *
 *  Created on: Nov 17, 2019
 *      Author: GC
 */
#define BOOST_TEST_MODULE test_signature_verifier

#include <boost/test/unit_test.hpp>
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <vector>
#include <licensecc/licensecc.h>
#include <licensecc_properties_test.h>
#include <licensecc_properties.h>

#include "../../src/library/base/base64.h"
#include "../../src/library/base/string_utils.h"
#include "../../src/library/base/v201_canonical_payload.hpp"
#include "../../src/library/os/signature_verifier.hpp"
#include "../../extern/license-generator/src/base_lib/crypto_helper.hpp"
#include "generate-license.h"

namespace license {
namespace test {
using namespace std;

static const char* kGoldenV201KeyId = "sha256:9d1797cf21f0341f364b7af016a745580fd36b78b17cd1630d1049879fe9ecf2";

static string project_name() {
	return string(LCC_PROJECT_NAME);
}

static string default_feature_name() {
	return toupper_copy(trim_copy(project_name()));
}

static license::os::SignatureVerificationRequest legacy_request(const vector<uint8_t>& payload,
																 const vector<uint8_t>& signature) {
	license::os::SignatureVerificationRequest request;
	request.payload = payload;
	request.signature = signature;
	request.declared_algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	request.key_id = license::os::embedded_public_key_id();
	request.license_version = 200;
	request.policy = license::os::legacy_v200_signature_policy();
	return request;
}

static license::os::SignatureVerificationRequest legacy_request(const string& payload, const string& signature) {
	const vector<uint8_t> payload_bytes(payload.begin(), payload.end());
	return legacy_request(payload_bytes, unbase64(signature));
}

static void bind_request_to_public_key_der(license::os::SignatureVerificationRequest& request,
										   const vector<uint8_t>& public_key_der) {
	request.public_key_der = public_key_der;
	request.key_id = license::os::public_key_id_from_der(public_key_der);
	request.policy.allowed_key_ids.clear();
	request.policy.allowed_key_ids.push_back(request.key_id);
	request.policy.allow_external_public_key_der = true;
}

static license::os::SignatureVerificationRequest v201_request_for_public_key_der(const string& payload,
																				 const string& signature,
																				 const vector<uint8_t>& public_key_der) {
	license::os::SignatureVerificationRequest request = legacy_request(payload, signature);
	request.license_version = 201;
	request.policy = license::os::current_v201_signature_policy();
	bind_request_to_public_key_der(request, public_key_der);
	return request;
}

static string sign_payload_bytes(const vector<uint8_t>& payload) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->loadPrivateKey_file(LCC_PROJECT_PRIVATE_KEY);
	const string payload_text(payload.begin(), payload.end());
	return crypto->signString(payload_text);
}

static string read_v201_fixture(const string& name) {
	const string path = string(PROJECT_TEST_SRC_DIR) + "/vectors/v201/" + name;
	ifstream input(path.c_str(), ios::binary);
	BOOST_REQUIRE_MESSAGE(input.is_open(), "can open v201 fixture " + path);
	return string((istreambuf_iterator<char>(input)), istreambuf_iterator<char>());
}

static string compact_ascii_whitespace(const string& value) {
	string out;
	for (const unsigned char ch : value) {
		if (!isspace(ch)) {
			out.push_back(static_cast<char>(ch));
		}
	}
	return out;
}

static uint8_t hex_nibble(const char ch) {
	if (ch >= '0' && ch <= '9') {
		return static_cast<uint8_t>(ch - '0');
	}
	if (ch >= 'a' && ch <= 'f') {
		return static_cast<uint8_t>(ch - 'a' + 10);
	}
	if (ch >= 'A' && ch <= 'F') {
		return static_cast<uint8_t>(ch - 'A' + 10);
	}
	BOOST_REQUIRE_MESSAGE(false, "invalid hex fixture character");
	return 0;
}

static vector<uint8_t> hex_to_bytes(const string& fixture_text) {
	const string hex = compact_ascii_whitespace(fixture_text);
	BOOST_REQUIRE_EQUAL(hex.size() % 2, static_cast<size_t>(0));
	vector<uint8_t> bytes;
	bytes.reserve(hex.size() / 2);
	for (size_t i = 0; i < hex.size(); i += 2) {
		bytes.push_back(static_cast<uint8_t>((hex_nibble(hex[i]) << 4) | hex_nibble(hex[i + 1])));
	}
	return bytes;
}

static string sign_fixture_payload_bytes(const vector<uint8_t>& payload) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->loadPrivateKey_file(string(PROJECT_TEST_SRC_DIR) + "/../extern/license-generator/test/data/private_key.rsa");
	const string payload_text(payload.begin(), payload.end());
	return crypto->signString(payload_text);
}

static vector<license::v201::CanonicalField> v201_golden_minimal_fields() {
	return {
		{LICENSE_VERSION, "201"},
		{LICENSE_CANONICAL_VERSION, "1"},
		{LICENSE_SIGNATURE_VERSION, "1"},
		{LICENSE_SIGNATURE_ALGORITHM, license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256},
		{LICENSE_KEY_ID, kGoldenV201KeyId},
		{"project", "MY_PRODUCT"},
		{"feature", "MY_PRODUCT"},
	};
}

static vector<license::v201::CanonicalField> v201_golden_full_fields() {
	vector<license::v201::CanonicalField> fields = v201_golden_minimal_fields();
	fields.push_back({PARAM_BEGIN_DATE, "2024-01-02"});
	fields.push_back({PARAM_EXPIRY_DATE, "2035-12-31"});
	fields.push_back({PARAM_VERSION_FROM, "1.2.3"});
	fields.push_back({PARAM_VERSION_TO, "9.9.9"});
	fields.push_back({PARAM_CLIENT_SIGNATURE, "AEBC-Q0RF-Rkc="});
	fields.push_back({PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH, "strong-disk-serial-or-uuid"});
	fields.push_back({PARAM_EXTRA_DATA, "alpha"});
	return fields;
}

static const char* signature_backend_name() {
#ifdef _WIN32
	return "windows-cryptoapi";
#else
	return "openssl";
#endif
}

static const char* function_return_name(const FUNCTION_RETURN result) {
	switch (result) {
		case FUNC_RET_OK:
			return "FUNC_RET_OK";
		case FUNC_RET_NOT_AVAIL:
			return "FUNC_RET_NOT_AVAIL";
		case FUNC_RET_ERROR:
			return "FUNC_RET_ERROR";
		case FUNC_RET_BUFFER_TOO_SMALL:
			return "FUNC_RET_BUFFER_TOO_SMALL";
		default:
			return "FUNC_RET_UNKNOWN";
	}
}

static const char* event_name(const LCC_EVENT_TYPE result) {
	switch (result) {
		case LICENSE_OK:
			return "LICENSE_OK";
		case LICENSE_MALFORMED:
			return "LICENSE_MALFORMED";
		case LICENSE_CORRUPTED:
			return "LICENSE_CORRUPTED";
		default:
			return "OTHER_LCC_EVENT";
	}
}

static void report_parity_vector(const string& name, const FUNCTION_RETURN expected, const FUNCTION_RETURN actual) {
	cout << "licensecc-parity backend=" << signature_backend_name() << " vector=" << name
		 << " expected=" << function_return_name(expected) << " actual=" << function_return_name(actual)
		 << " result=" << (expected == actual ? "pass" : "fail") << '\n';
	BOOST_CHECK_EQUAL(actual, expected);
}

static void report_parity_vector(const string& name, const LCC_EVENT_TYPE expected, const LCC_EVENT_TYPE actual) {
	cout << "licensecc-parity backend=" << signature_backend_name() << " vector=" << name
		 << " expected=" << event_name(expected) << " actual=" << event_name(actual)
		 << " result=" << (expected == actual ? "pass" : "fail") << '\n';
	BOOST_CHECK_EQUAL(actual, expected);
}

static license::os::SignatureVerificationRequest v201_golden_request(
	const string& name, const vector<license::v201::CanonicalField>& fields) {
	const license::v201::CanonicalPayloadResult payload = license::v201::build_canonical_payload(fields);
	BOOST_REQUIRE_MESSAGE(payload.ok, payload.error);
	BOOST_CHECK_EQUAL(license::v201::canonical_payload_hex(payload.bytes),
					  compact_ascii_whitespace(read_v201_fixture(name + ".payload.hex")));

	const string signature_b64 = compact_ascii_whitespace(read_v201_fixture(name + ".signature.b64"));
	const vector<uint8_t> public_key_der = hex_to_bytes(read_v201_fixture("public_key.pkcs1.der.hex"));
	BOOST_CHECK_EQUAL(license::os::public_key_id_from_der(public_key_der), compact_ascii_whitespace(read_v201_fixture("public_key.id")));
	BOOST_CHECK_EQUAL(compact_ascii_whitespace(read_v201_fixture(name + ".expected-result")), "FUNC_RET_OK");

	license::os::SignatureVerificationRequest request;
	request.payload = payload.bytes;
	request.signature = unbase64(signature_b64);
	request.public_key_der = public_key_der;
	request.declared_algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	request.key_id = kGoldenV201KeyId;
	request.license_version = 201;
	request.policy.license_version = 201;
	request.policy.allowed_algorithms.push_back(license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256);
	request.policy.allowed_key_ids.push_back(kGoldenV201KeyId);
	request.policy.allow_external_public_key_der = true;
	return request;
}

static void verify_v201_golden_vector(const string& name, const vector<license::v201::CanonicalField>& fields) {
	license::os::SignatureVerificationRequest request = v201_golden_request(name, fields);
	const string signature_b64 = compact_ascii_whitespace(read_v201_fixture(name + ".signature.b64"));

	BOOST_CHECK_EQUAL(sign_fixture_payload_bytes(request.payload), signature_b64);

	const string license_text = read_v201_fixture(name + ".license");
	BOOST_CHECK_NE(license_text.find(string(LICENSE_SIGNATURE_ALGORITHM) + " = " +
									 license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256),
				   string::npos);
	BOOST_CHECK_NE(license_text.find(string(LICENSE_KEY_ID) + " = " + kGoldenV201KeyId), string::npos);
	BOOST_CHECK_NE(license_text.find(string(LICENSE_SIGNATURE) + " = " + signature_b64), string::npos);

	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);

	const vector<uint8_t> original_payload = request.payload;
	request.payload[0] ^= 0x01;
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
	request.payload = original_payload;
	request.signature[0] ^= 0x01;
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

static vector<license::v201::CanonicalField> v201_minimal_fields() {
	return {
		{LICENSE_VERSION, "201"},
		{LICENSE_CANONICAL_VERSION, "1"},
		{LICENSE_SIGNATURE_VERSION, "1"},
		{LICENSE_SIGNATURE_ALGORITHM, license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256},
		{LICENSE_KEY_ID, license::os::embedded_public_key_id()},
		{"project", project_name()},
		{"feature", default_feature_name()},
	};
}

static string v201_license_from_storage_fields(const vector<pair<string, string>>& storage_fields,
											   const string& signature_override = "") {
	vector<license::v201::CanonicalField> canonical_fields;
	for (const pair<string, string>& field : storage_fields) {
		canonical_fields.push_back({field.first, field.second});
	}
	canonical_fields.push_back({"project", project_name()});
	canonical_fields.push_back({"feature", default_feature_name()});
	const license::v201::CanonicalPayloadResult canonical =
		license::v201::build_canonical_payload(canonical_fields);
	BOOST_REQUIRE_MESSAGE(canonical.ok, canonical.error);
	const string signature = signature_override.empty() ? sign_payload_bytes(canonical.bytes) : signature_override;

	string license_text = string("[") + default_feature_name() + "]\n";
	for (const pair<string, string>& field : storage_fields) {
		license_text += field.first + " = " + field.second + "\n";
	}
	license_text += string(LICENSE_SIGNATURE) + " = " + signature + "\n";
	return license_text;
}

static string v201_minimal_license(const string& signature_override = "") {
	return v201_license_from_storage_fields({
		{LICENSE_VERSION, "201"},
		{LICENSE_CANONICAL_VERSION, "1"},
		{LICENSE_SIGNATURE_VERSION, "1"},
		{LICENSE_SIGNATURE_ALGORITHM, license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256},
		{LICENSE_KEY_ID, license::os::embedded_public_key_id()},
	}, signature_override);
}

static string v201_license_with_unsigned_storage_lines(const string& storage_lines) {
	string license_text = v201_minimal_license();
	const string signature_marker = string(LICENSE_SIGNATURE) + " = ";
	const size_t signature_pos = license_text.rfind(signature_marker);
	BOOST_REQUIRE_MESSAGE(signature_pos != string::npos, "v201 test license contains signature line");
	license_text.insert(signature_pos, storage_lines);
	return license_text;
}

static CallerInformations caller_for_version(const char* version) {
	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	BOOST_REQUIRE_MESSAGE(lcc_set_caller_version(&caller, version), "test caller version fits public API buffer");
	return caller;
}

static string error_summary(const LicenseInfo& license) {
	char buffer[LCC_API_ERROR_BUFFER_SIZE];
	print_error(buffer, &license);
	return string(buffer);
}

static bool has_status_event(const LicenseInfo& license, const LCC_EVENT_TYPE event_type) {
	for (const AuditEvent& event : license.status) {
		if (event.event_type == event_type) {
			return true;
		}
	}
	return false;
}

static LCC_EVENT_TYPE acquire_from_plain_data_with_caller(const string& license_text,
														  const CallerInformations* caller,
														  LicenseInfo& license) {
	LicenseLocation location = {LICENSE_PLAIN_DATA};
	BOOST_REQUIRE_LT(license_text.size(), sizeof(location.licenseData));
	copy(license_text.begin(), license_text.end(), location.licenseData);
	return acquire_license(caller, &location, &license);
}

static LCC_EVENT_TYPE acquire_from_plain_data(const string& license_text, LicenseInfo& license) {
	return acquire_from_plain_data_with_caller(license_text, nullptr, license);
}

static LCC_EVENT_TYPE acquire_from_plain_data_with_version(const string& license_text, const char* version,
														  LicenseInfo& license) {
	CallerInformations caller = caller_for_version(version);
	return acquire_from_plain_data_with_caller(license_text, &caller, license);
}

BOOST_AUTO_TEST_CASE(verify_signature_ok) {
	const string test_data("test_data");
	const string signature = sign_data(test_data, string("verify_signature"));

	FUNCTION_RETURN result = license::os::verify_signature(test_data, signature);
	BOOST_CHECK_MESSAGE(result == FUNC_RET_OK, "signature verified");
}

BOOST_AUTO_TEST_CASE(verify_signature_data_mismatch) {
	const string test_data("test_data");
	const string signature = sign_data(test_data, string("verify_signature"));

	FUNCTION_RETURN result = license::os::verify_signature(string("other data"), signature);
	BOOST_CHECK_MESSAGE(result == FUNC_RET_ERROR, "signature NOT verified");
}

BOOST_AUTO_TEST_CASE(verify_signature_modified) {
	const string test_data("test_data");
	string signature = sign_data(test_data, string("verify_signature"));
	signature[2] = signature[2] + 1;
	FUNCTION_RETURN result = license::os::verify_signature(test_data, signature);
	BOOST_CHECK_MESSAGE(result == FUNC_RET_ERROR, "signature NOT verified");
}

BOOST_AUTO_TEST_CASE(verify_signature_rejects_malformed_inputs) {
	const string test_data("test_data");
	BOOST_CHECK_EQUAL(license::os::verify_signature(test_data, ""), FUNC_RET_ERROR);
	BOOST_CHECK_EQUAL(license::os::verify_signature(test_data, "!!!!"), FUNC_RET_ERROR);
	BOOST_CHECK_EQUAL(license::os::verify_signature(test_data, "AA=A"), FUNC_RET_ERROR);
	BOOST_CHECK_EQUAL(license::os::verify_signature(test_data, "QR=="), FUNC_RET_ERROR);
	BOOST_CHECK_EQUAL(license::os::verify_signature(test_data, "QUF="), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_rejects_wrong_sized_inputs) {
	const string test_data("test_data");
	const string signature = sign_data(test_data, string("verify_signature"));

	const string truncated_signature = signature.substr(0, signature.size() - 4);
	BOOST_CHECK_EQUAL(license::os::verify_signature(test_data, truncated_signature), FUNC_RET_ERROR);

	const vector<uint8_t> oversized_signature(129, 0xab);
	const string oversized_signature_b64 = base64(oversized_signature.data(), oversized_signature.size(), 0);
	BOOST_CHECK_EQUAL(license::os::verify_signature(test_data, oversized_signature_b64), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_rejects_random_key_sized_blob) {
	const string test_data("test_data");
	vector<uint8_t> random_signature(128);
	for (size_t i = 0; i < random_signature.size(); ++i) {
		random_signature[i] = static_cast<uint8_t>((i * 37U + 11U) & 0xffU);
	}
	const string random_signature_b64 = base64(random_signature.data(), random_signature.size(), 0);
	BOOST_CHECK_EQUAL(license::os::verify_signature(test_data, random_signature_b64), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_rejects_structured_key_sized_blobs) {
	const string test_data("test_data");
	const vector<uint8_t> payload(test_data.begin(), test_data.end());
	const size_t key_sizes[] = {1024, 2048};
	for (const size_t key_size : key_sizes) {
		unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
		crypto->generateKeyPair(key_size);

		vector<uint8_t> zero_signature(key_size / 8, 0x00);
		license::os::SignatureVerificationRequest request = legacy_request(payload, zero_signature);
		bind_request_to_public_key_der(request, crypto->exportPublicKey());
		BOOST_TEST_CONTEXT("all-zero RSA signature bytes " << key_size) {
			BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
		}

		vector<uint8_t> ones_signature(key_size / 8, 0xff);
		request = legacy_request(payload, ones_signature);
		bind_request_to_public_key_der(request, crypto->exportPublicKey());
		BOOST_TEST_CONTEXT("all-0xff RSA signature bytes " << key_size) {
			BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
		}
	}
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_handles_payload_edge_cases) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair(3072);

	const vector<string> payloads = {
		string(),
		string("prefix", 6) + string("\0", 1) + string("suffix", 6),
		string(1024 * 1024, 'L'),
	};

	for (size_t i = 0; i < payloads.size(); ++i) {
		const string& payload = payloads[i];
		const string signature = crypto->signString(payload);
		license::os::SignatureVerificationRequest request = legacy_request(payload, signature);
		bind_request_to_public_key_der(request, crypto->exportPublicKey());
		BOOST_TEST_CONTEXT("payload edge case " << i) {
			BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);

			request.payload.push_back(static_cast<uint8_t>('x'));
			BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
		}
	}
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_rejects_alternate_payload_spelling) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair(3072);

	const string canonical_payload = string(LCC_PROJECT_NAME) + "lic_ver" + "200";
	const string alternate_payload = string(LCC_PROJECT_NAME) + "lic_ver " + "200";
	const string signature = crypto->signString(canonical_payload);

	license::os::SignatureVerificationRequest request = legacy_request(canonical_payload, signature);
	bind_request_to_public_key_der(request, crypto->exportPublicKey());
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);

	request = legacy_request(alternate_payload, signature);
	bind_request_to_public_key_der(request, crypto->exportPublicKey());
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_accepts_legacy_v200_request) {
	const string test_data("test_data");
	const string signature = sign_data(test_data, string("verify_signature_policy"));
	const license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);

	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);
	BOOST_CHECK_MESSAGE(license::os::embedded_public_key_id().find("sha256:") == 0,
						"embedded v200 policy uses generated public-key id");
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_rejects_unknown_algorithm_and_aliases) {
	const string test_data("test_data");
	const string signature = sign_data(test_data, string("verify_signature_policy_algorithm"));
	license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);

	request.declared_algorithm = "RSA-PKCS1-SHA256";
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);

	request.declared_algorithm = "rsa";
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_rejects_unimplemented_algorithm_even_if_allowlisted) {
	const string test_data("test_data");
	const string signature = sign_data(test_data, string("verify_signature_policy_algorithm_mismatch"));
	license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);

	request.declared_algorithm = "rsa-pss-sha256";
	request.policy.allowed_algorithms.push_back("rsa-pss-sha256");
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_rejects_unknown_key_and_version) {
	const string test_data("test_data");
	const string signature = sign_data(test_data, string("verify_signature_policy_key"));
	license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);

	request.key_id = "unknown-key";
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);

	request = legacy_request(test_data, signature);
	request.license_version = 201;
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_rejects_duplicate_and_retired_key_ids) {
	const string test_data("test_data");
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair(3072);
	const string signature = crypto->signString(test_data);

	license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);
	bind_request_to_public_key_der(request, crypto->exportPublicKey());
	BOOST_REQUIRE_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);

	request.policy.allowed_key_ids.push_back(request.key_id);
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);

	request = legacy_request(test_data, signature);
	bind_request_to_public_key_der(request, crypto->exportPublicKey());
	request.policy.retired_key_ids.push_back(request.key_id);
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);

	request = legacy_request(test_data, signature);
	bind_request_to_public_key_der(request, crypto->exportPublicKey());
	request.policy.retired_key_ids.push_back("sha256:2222222222222222222222222222222222222222222222222222222222222222");
	request.policy.retired_key_ids.push_back("sha256:2222222222222222222222222222222222222222222222222222222222222222");
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_selects_public_key_by_key_id) {
	const string test_data("test_data");
	unique_ptr<CryptoHelper> first_key(CryptoHelper::getInstance());
	first_key->generateKeyPair(3072);
	const vector<uint8_t> first_public_key = first_key->exportPublicKey();
	const string first_key_id = license::os::public_key_id_from_der(first_public_key);

	unique_ptr<CryptoHelper> second_key(CryptoHelper::getInstance());
	second_key->generateKeyPair(3072);
	const vector<uint8_t> second_public_key = second_key->exportPublicKey();
	const string second_key_id = license::os::public_key_id_from_der(second_public_key);
	const string second_signature = second_key->signString(test_data);

	license::os::SignatureVerificationRequest request = legacy_request(test_data, second_signature);
	request.public_key_der.clear();
	request.key_id = second_key_id;
	request.policy.allowed_key_ids.clear();
	request.policy.allowed_key_ids.push_back(first_key_id);
	request.policy.allowed_key_ids.push_back(second_key_id);
	request.policy.public_keys.clear();
	request.policy.public_keys.push_back(
		license::os::SignaturePublicKey(first_key_id, first_public_key, 3072));
	request.policy.public_keys.push_back(
		license::os::SignaturePublicKey(second_key_id, second_public_key, 3072));

	BOOST_CHECK(license::os::signature_request_allowed(request));
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);

	request.key_id = first_key_id;
	BOOST_CHECK(license::os::signature_request_allowed(request));
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_rejects_duplicate_public_key_ring_entries) {
	const string test_data("test_data");
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair(3072);
	const vector<uint8_t> public_key = crypto->exportPublicKey();
	const string key_id = license::os::public_key_id_from_der(public_key);
	const string signature = crypto->signString(test_data);

	license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);
	request.public_key_der.clear();
	request.key_id = key_id;
	request.policy.allowed_key_ids.clear();
	request.policy.allowed_key_ids.push_back(key_id);
	request.policy.public_keys.clear();
	request.policy.public_keys.push_back(license::os::SignaturePublicKey(key_id, public_key, 3072));
	request.policy.public_keys.push_back(license::os::SignaturePublicKey(key_id, public_key, 3072));

	BOOST_CHECK(!license::os::signature_request_allowed(request));
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_rejects_key_id_public_key_mismatch) {
	const string test_data("test_data");
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair(3072);
	const string signature = crypto->signString(test_data);
	const vector<uint8_t> public_key = crypto->exportPublicKey();

	license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);
	bind_request_to_public_key_der(request, public_key);
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);

	request.key_id = license::os::embedded_public_key_id();
	request.policy.allowed_key_ids.clear();
	request.policy.allowed_key_ids.push_back(request.key_id);
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_rejects_ungated_external_public_key_der) {
	const string test_data("test_data");
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair(3072);
	const string signature = crypto->signString(test_data);
	const vector<uint8_t> public_key = crypto->exportPublicKey();

	license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);
	request.public_key_der = public_key;
	request.key_id = license::os::public_key_id_from_der(public_key);
	request.policy.allowed_key_ids.clear();
	request.policy.allowed_key_ids.push_back(request.key_id);
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);

	request.policy.allow_external_public_key_der = true;
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);
}

BOOST_AUTO_TEST_CASE(verify_legacy_v200_signature_policy_enforces_minimum_key_bits) {
	const string test_data("test_data");
	const size_t rejected_key_sizes[] = {1024, 2048};
	const size_t accepted_key_sizes[] = {3072, 4096};

	for (const size_t key_size : rejected_key_sizes) {
		unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
		crypto->generateKeyPair(key_size);
		const string signature = crypto->signString(test_data);
		license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);
		bind_request_to_public_key_der(request, crypto->exportPublicKey());

		BOOST_TEST_CONTEXT("legacy v200 rejects RSA key size " << key_size) {
			BOOST_CHECK(!license::os::signature_request_allowed(request));
			BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
		}
	}

	for (const size_t key_size : accepted_key_sizes) {
		unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
		crypto->generateKeyPair(key_size);
		const string signature = crypto->signString(test_data);
		license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);
		bind_request_to_public_key_der(request, crypto->exportPublicKey());

		BOOST_TEST_CONTEXT("legacy v200 accepts RSA key size " << key_size) {
			BOOST_CHECK(license::os::signature_request_allowed(request));
			BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);
			BOOST_CHECK_EQUAL(request.signature.size(), key_size / 8);

			request.signature[0] ^= 0x01;
			BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
		}
	}
}

BOOST_AUTO_TEST_CASE(verify_v201_signature_policy_enforces_minimum_key_bits) {
	const string test_data("test_data");
	const size_t rejected_key_sizes[] = {1024, 2048};
	const size_t accepted_key_sizes[] = {3072, 4096};

	BOOST_REQUIRE_GE(license::os::embedded_public_key_bits(),
					 license::os::current_v201_signature_policy().min_public_key_bits);

	for (const size_t key_size : rejected_key_sizes) {
		unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
		crypto->generateKeyPair(key_size);
		const string signature = crypto->signString(test_data);
		license::os::SignatureVerificationRequest request =
			v201_request_for_public_key_der(test_data, signature, crypto->exportPublicKey());

		BOOST_TEST_CONTEXT("v201 rejects RSA key size " << key_size) {
			BOOST_CHECK(!license::os::signature_request_allowed(request));
			BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
		}
	}

	for (const size_t key_size : accepted_key_sizes) {
		unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
		crypto->generateKeyPair(key_size);
		const string signature = crypto->signString(test_data);
		license::os::SignatureVerificationRequest request =
			v201_request_for_public_key_der(test_data, signature, crypto->exportPublicKey());

		BOOST_TEST_CONTEXT("v201 accepts RSA key size " << key_size) {
			BOOST_CHECK(license::os::signature_request_allowed(request));
			BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);
		}
	}
}

BOOST_AUTO_TEST_CASE(verify_v201_signature_policy_rejects_malformed_key_size_metadata) {
	const string test_data("test_data");
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair(3072);
	const string signature = crypto->signString(test_data);

	license::os::SignatureVerificationRequest request =
		v201_request_for_public_key_der(test_data, signature, crypto->exportPublicKey());
	BOOST_REQUIRE_GT(request.public_key_der.size(), 4);
	BOOST_REQUIRE(license::os::signature_request_allowed(request));
	BOOST_REQUIRE_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);

	request.public_key_der[1] = 0x82;
	request.public_key_der.insert(request.public_key_der.begin() + 2, 0x00);
	request.key_id = license::os::public_key_id_from_der(request.public_key_der);
	request.policy.allowed_key_ids.clear();
	request.policy.allowed_key_ids.push_back(request.key_id);

	BOOST_CHECK(!license::os::signature_request_allowed(request));
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_signature_policy_rejects_malformed_public_key_der) {
	const string test_data("test_data");
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair(3072);
	const string signature = crypto->signString(test_data);

	license::os::SignatureVerificationRequest request = legacy_request(test_data, signature);
	bind_request_to_public_key_der(request, crypto->exportPublicKey());
	BOOST_REQUIRE_GT(request.public_key_der.size(), 4);
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_OK);

	request.public_key_der[1] = 0x82;
	request.public_key_der.insert(request.public_key_der.begin() + 2, 0x00);
	request.key_id = license::os::public_key_id_from_der(request.public_key_der);
	request.policy.allowed_key_ids.clear();
	request.policy.allowed_key_ids.push_back(request.key_id);
	BOOST_CHECK_EQUAL(license::os::verify_signature(request), FUNC_RET_ERROR);
}

BOOST_AUTO_TEST_CASE(verify_v201_minimal_license_ok) {
	LicenseInfo license{};
	const LCC_EVENT_TYPE result = acquire_from_plain_data(v201_minimal_license(), license);

	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(license.license_version, LCC_LICENSE_FORMAT_VERSION_V201);
}

BOOST_AUTO_TEST_CASE(verify_v201_reordered_storage_ok) {
	const string license_text = v201_license_from_storage_fields({
		{LICENSE_KEY_ID, license::os::embedded_public_key_id()},
		{LICENSE_SIGNATURE_ALGORITHM, license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256},
		{LICENSE_SIGNATURE_VERSION, "1"},
		{LICENSE_CANONICAL_VERSION, "1"},
		{LICENSE_VERSION, "201"},
	});
	LicenseInfo license{};
	const LCC_EVENT_TYPE result = acquire_from_plain_data(license_text, license);

	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(license.license_version, LCC_LICENSE_FORMAT_VERSION_V201);
}

BOOST_AUTO_TEST_CASE(verify_v201_golden_signed_vectors) {
	verify_v201_golden_vector("minimal", v201_golden_minimal_fields());
	verify_v201_golden_vector("full", v201_golden_full_fields());
}

BOOST_AUTO_TEST_CASE(signature_negative_vector_parity_report) {
	cout << "licensecc-parity backend=" << signature_backend_name() << " begin\n";

	const string payload_text("parity-payload");
	const string payload_signature = sign_data(payload_text, "parity_report");
	report_parity_vector("legacy-valid-signature", FUNC_RET_OK,
						 license::os::verify_signature(legacy_request(payload_text, payload_signature)));
	report_parity_vector("signature-empty", FUNC_RET_ERROR, license::os::verify_signature(payload_text, ""));
	report_parity_vector("signature-malformed-base64", FUNC_RET_ERROR,
						 license::os::verify_signature(payload_text, "!!!!"));
	report_parity_vector("signature-truncated", FUNC_RET_ERROR,
						 license::os::verify_signature(payload_text, payload_signature.substr(0, payload_signature.size() - 4)));

	license::os::SignatureVerificationRequest request = legacy_request(payload_text, payload_signature);
	request.declared_algorithm = "RSA-PKCS1-SHA256";
	report_parity_vector("algorithm-alias-rejected", FUNC_RET_ERROR, license::os::verify_signature(request));

	request = legacy_request(payload_text, payload_signature);
	request.key_id = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
	report_parity_vector("unknown-key-rejected", FUNC_RET_ERROR, license::os::verify_signature(request));

	license::os::SignatureVerificationRequest minimal = v201_golden_request("minimal", v201_golden_minimal_fields());
	report_parity_vector("v201-golden-minimal", FUNC_RET_OK, license::os::verify_signature(minimal));
	minimal.payload[0] ^= 0x01;
	report_parity_vector("v201-golden-minimal-payload-mutated", FUNC_RET_ERROR,
						 license::os::verify_signature(minimal));

	license::os::SignatureVerificationRequest full = v201_golden_request("full", v201_golden_full_fields());
	report_parity_vector("v201-golden-full", FUNC_RET_OK, license::os::verify_signature(full));
	full.signature[0] ^= 0x01;
	report_parity_vector("v201-golden-full-signature-mutated", FUNC_RET_ERROR, license::os::verify_signature(full));

	const string v200_payload = default_feature_name() + LICENSE_VERSION + "200";
	const string v200_signature = sign_data(v200_payload, "parity_v201_with_v200_signature");
	LicenseInfo license{};
	report_parity_vector("v201-with-v200-signature", LICENSE_CORRUPTED,
						 acquire_from_plain_data(v201_minimal_license(v200_signature), license));

	string algorithm_alias = v201_minimal_license();
	const string expected_algorithm =
		string(LICENSE_SIGNATURE_ALGORITHM) + " = " + license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	const size_t algorithm_pos = algorithm_alias.find(expected_algorithm);
	BOOST_REQUIRE_NE(algorithm_pos, string::npos);
	algorithm_alias.replace(algorithm_pos, expected_algorithm.size(),
							string(LICENSE_SIGNATURE_ALGORITHM) + " = RSA-PKCS1-SHA256");
	report_parity_vector("v201-algorithm-alias-malformed", LICENSE_MALFORMED,
						 acquire_from_plain_data(algorithm_alias, license));

	string unknown_key = v201_minimal_license();
	const string expected_key = string(LICENSE_KEY_ID) + " = " + license::os::embedded_public_key_id();
	const size_t key_pos = unknown_key.find(expected_key);
	BOOST_REQUIRE_NE(key_pos, string::npos);
	unknown_key.replace(key_pos, expected_key.size(),
						string(LICENSE_KEY_ID) +
							" = sha256:1111111111111111111111111111111111111111111111111111111111111111");
	report_parity_vector("v201-unknown-key-corrupted", LICENSE_CORRUPTED,
						 acquire_from_plain_data(unknown_key, license));

	const string v200_with_v201_field = string("[") + default_feature_name() + "]\n"
										+ LICENSE_VERSION + " = 200\n"
										+ LICENSE_CANONICAL_VERSION + " = 1\n"
										+ LICENSE_SIGNATURE + " = QUJDRA==\n";
	report_parity_vector("v200-with-v201-field-malformed", LICENSE_MALFORMED,
						 acquire_from_plain_data(v200_with_v201_field, license));

	cout << "licensecc-parity backend=" << signature_backend_name() << " end\n";
}

BOOST_AUTO_TEST_CASE(verify_v201_rejects_v200_style_signature) {
	const string v200_payload = default_feature_name() + LICENSE_VERSION + "200";
	const string v200_signature = sign_data(v200_payload, "v201_with_v200_signature");
	LicenseInfo license{};
	const LCC_EVENT_TYPE result = acquire_from_plain_data(v201_minimal_license(v200_signature), license);

	BOOST_CHECK_EQUAL(result, LICENSE_CORRUPTED);
}

BOOST_AUTO_TEST_CASE(verify_v201_rejects_metadata_tampering) {
	const string valid_license = v201_minimal_license();

	string algorithm_alias = valid_license;
	const string expected_algorithm =
		string(LICENSE_SIGNATURE_ALGORITHM) + " = " + license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	const size_t algorithm_pos = algorithm_alias.find(expected_algorithm);
	BOOST_REQUIRE_MESSAGE(algorithm_pos != string::npos, "v201 test license contains signature algorithm");
	algorithm_alias.replace(algorithm_pos, expected_algorithm.size(),
							string(LICENSE_SIGNATURE_ALGORITHM) + " = RSA-PKCS1-SHA256");
	LicenseInfo algorithm_license{};
	BOOST_CHECK_EQUAL(acquire_from_plain_data(algorithm_alias, algorithm_license), LICENSE_MALFORMED);

	string unknown_key = valid_license;
	const string expected_key = string(LICENSE_KEY_ID) + " = " + license::os::embedded_public_key_id();
	const size_t key_pos = unknown_key.find(expected_key);
	BOOST_REQUIRE_MESSAGE(key_pos != string::npos, "v201 test license contains key id");
	unknown_key.replace(key_pos, expected_key.size(),
						string(LICENSE_KEY_ID) +
							" = sha256:1111111111111111111111111111111111111111111111111111111111111111");
	LicenseInfo key_license{};
	BOOST_CHECK_EQUAL(acquire_from_plain_data(unknown_key, key_license), LICENSE_CORRUPTED);

	string canonical_version = valid_license;
	const string expected_canonical = string(LICENSE_CANONICAL_VERSION) + " = 1";
	const size_t canonical_pos = canonical_version.find(expected_canonical);
	BOOST_REQUIRE_MESSAGE(canonical_pos != string::npos, "v201 test license contains canonical version");
	canonical_version.replace(canonical_pos, expected_canonical.size(),
							  string(LICENSE_CANONICAL_VERSION) + " = 2");
	LicenseInfo canonical_license{};
	BOOST_CHECK_EQUAL(acquire_from_plain_data(canonical_version, canonical_license), LICENSE_MALFORMED);

	string signature_version = valid_license;
	const string expected_signature_version = string(LICENSE_SIGNATURE_VERSION) + " = 1";
	const size_t signature_version_pos = signature_version.find(expected_signature_version);
	BOOST_REQUIRE_MESSAGE(signature_version_pos != string::npos, "v201 test license contains signature version");
	signature_version.replace(signature_version_pos, expected_signature_version.size(),
							  string(LICENSE_SIGNATURE_VERSION) + " = 2");
	LicenseInfo signature_version_license{};
	BOOST_CHECK_EQUAL(acquire_from_plain_data(signature_version, signature_version_license), LICENSE_MALFORMED);

	string license_version = valid_license;
	const string expected_license_version = string(LICENSE_VERSION) + " = 201";
	const size_t license_version_pos = license_version.find(expected_license_version);
	BOOST_REQUIRE_MESSAGE(license_version_pos != string::npos, "v201 test license contains license version");
	license_version.replace(license_version_pos, expected_license_version.size(), string(LICENSE_VERSION) + " = 200");
	LicenseInfo license_version_license{};
	BOOST_CHECK_EQUAL(acquire_from_plain_data(license_version, license_version_license), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(verify_v201_optional_field_semantics_fail_closed_at_documented_stage) {
	const string signed_malformed_client_signature = v201_license_from_storage_fields({
		{LICENSE_VERSION, "201"},
		{LICENSE_CANONICAL_VERSION, "1"},
		{LICENSE_SIGNATURE_VERSION, "1"},
		{LICENSE_SIGNATURE_ALGORITHM, license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256},
		{LICENSE_KEY_ID, license::os::embedded_public_key_id()},
		{PARAM_CLIENT_SIGNATURE, "XXX-XXX-XXX"},
		{PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH, "strong-disk-serial-or-uuid"},
	});
	LicenseInfo client_signature_license{};
	BOOST_CHECK_EQUAL(acquire_from_plain_data(signed_malformed_client_signature, client_signature_license),
					  LICENSE_MALFORMED);
	BOOST_CHECK_MESSAGE(has_status_event(client_signature_license, SIGNATURE_VERIFIED),
						"signed malformed client-signature reaches runtime limit verification: " +
							error_summary(client_signature_license));

	const string signed_mismatched_source_strength = v201_license_from_storage_fields({
		{LICENSE_VERSION, "201"},
		{LICENSE_CANONICAL_VERSION, "1"},
		{LICENSE_SIGNATURE_VERSION, "1"},
		{LICENSE_SIGNATURE_ALGORITHM, license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256},
		{LICENSE_KEY_ID, license::os::embedded_public_key_id()},
		{PARAM_CLIENT_SIGNATURE, "AEBC-Q0RF-Rkc="},
		{PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH, "strong-ethernet-mac"},
	});
	LicenseInfo source_strength_license{};
	BOOST_CHECK_EQUAL(acquire_from_plain_data(signed_mismatched_source_strength, source_strength_license),
					  LICENSE_MALFORMED);
	BOOST_CHECK_MESSAGE(has_status_event(source_strength_license, SIGNATURE_VERIFIED),
						"signed mismatched source-strength reaches runtime limit verification: " +
							error_summary(source_strength_license));

	const string signed_oversized_extra_data = v201_license_from_storage_fields({
		{LICENSE_VERSION, "201"},
		{LICENSE_CANONICAL_VERSION, "1"},
		{LICENSE_SIGNATURE_VERSION, "1"},
		{LICENSE_SIGNATURE_ALGORITHM, license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256},
		{LICENSE_KEY_ID, license::os::embedded_public_key_id()},
		{PARAM_EXTRA_DATA, string(LCC_API_PROPRIETARY_DATA_SIZE + 1, 'x')},
	});
	LicenseInfo oversized_extra_data_license{};
	BOOST_CHECK_EQUAL(acquire_from_plain_data(signed_oversized_extra_data, oversized_extra_data_license),
					  LICENSE_MALFORMED);
	BOOST_CHECK_MESSAGE(has_status_event(oversized_extra_data_license, SIGNATURE_VERIFIED),
						"signed oversized extra-data reaches runtime limit verification: " +
							error_summary(oversized_extra_data_license));
	BOOST_CHECK_EQUAL(oversized_extra_data_license.proprietary_data[0], '\0');

	const string empty_extra_data =
		v201_license_with_unsigned_storage_lines(string(PARAM_EXTRA_DATA) + " = \n");
	LicenseInfo empty_extra_data_license{};
	BOOST_CHECK_EQUAL(acquire_from_plain_data(empty_extra_data, empty_extra_data_license), LICENSE_MALFORMED);
	BOOST_CHECK_MESSAGE(has_status_event(empty_extra_data_license, SIGNATURE_VERIFIED),
						"empty extra-data is absent from the canonical payload but rejected by runtime limits: " +
							error_summary(empty_extra_data_license));
	BOOST_CHECK_EQUAL(empty_extra_data_license.proprietary_data[0], '\0');

	const pair<string, string> signed_empty_optional_cases[] = {
		{"empty client-signature", string(PARAM_CLIENT_SIGNATURE) + " = \n"},
		{"empty valid-from", string(PARAM_BEGIN_DATE) + " = \n"},
		{"empty valid-to", string(PARAM_EXPIRY_DATE) + " = \n"},
		{"empty start-version", string(PARAM_VERSION_FROM) + " = \n"},
		{"empty end-version", string(PARAM_VERSION_TO) + " = \n"},
	};
	for (const pair<string, string>& test_case : signed_empty_optional_cases) {
		BOOST_TEST_CONTEXT(test_case.first) {
			LicenseInfo license{};
			const string license_text = v201_license_with_unsigned_storage_lines(test_case.second);
			const LCC_EVENT_TYPE result = acquire_from_plain_data_with_version(license_text, "1.5.0", license);
			BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
			BOOST_CHECK_MESSAGE(has_status_event(license, SIGNATURE_VERIFIED),
								"empty optional fields differ from absent fields and fail during limits: " +
									error_summary(license));
		}
	}

	const pair<string, string> pre_crypto_malformed_cases[] = {
		{"bad valid-to", string(PARAM_EXPIRY_DATE) + " = 2050-02-30\n"},
		{"inverted date range", string(PARAM_BEGIN_DATE) + " = 2050-01-01\n" + PARAM_EXPIRY_DATE + " = 2020-01-01\n"},
		{"bad start-version", string(PARAM_VERSION_FROM) + " = 1.bad\n"},
		{"inverted version range",
		 string(PARAM_VERSION_FROM) + " = 2.0\n" + PARAM_VERSION_TO + " = 1.10\n"},
	};
	for (const pair<string, string>& test_case : pre_crypto_malformed_cases) {
		BOOST_TEST_CONTEXT(test_case.first) {
			LicenseInfo license{};
			const string license_text = v201_license_with_unsigned_storage_lines(test_case.second);
			const LCC_EVENT_TYPE result = acquire_from_plain_data_with_version(license_text, "1.5.0", license);
			BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
			BOOST_CHECK_MESSAGE(!has_status_event(license, SIGNATURE_VERIFIED),
								"canonical optional-field failures are rejected before signature verification: " +
									error_summary(license));
		}
	}
}

BOOST_AUTO_TEST_CASE(verify_v200_rejects_v201_only_fields) {
	const string license_text = string("[") + default_feature_name() + "]\n"
								+ LICENSE_VERSION + " = 200\n"
								+ LICENSE_CANONICAL_VERSION + " = 1\n"
								+ LICENSE_SIGNATURE + " = QUJDRA==\n";
	LicenseInfo license{};

	BOOST_CHECK_EQUAL(acquire_from_plain_data(license_text, license), LICENSE_MALFORMED);
}

}  // namespace test

} /* namespace license */
