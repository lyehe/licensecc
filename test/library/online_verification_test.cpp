#define BOOST_TEST_MODULE online_verification_test

#include <licensecc/licensecc.h>

#include <algorithm>
#include <ctime>
#include <cctype>
#include <cstdlib>
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
#include "../../src/library/locate/LocatorFactory.hpp"
#include "../../src/library/online_verification/OnlineVerification.hpp"
#include "../../src/library/os/os.h"
#include "../../src/library/os/signature_verifier.hpp"

namespace license {
namespace test {
using namespace std;

struct RuntimePolicyGuard {
	RuntimePolicyGuard() {
		online_verification::reset_revocation_floors_for_tests();
		locate::LocatorFactory::find_license_near_module(false);
		lcc_set_environment_license_sources_enabled(false);
		lcc_set_strict_source_fatal_enabled(false);
		UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
		UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	}

	~RuntimePolicyGuard() {
		UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
		UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
		lcc_set_strict_source_fatal_enabled(false);
		lcc_set_environment_license_sources_enabled(FIND_LICENSE_WITH_ENV_VAR);
		locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
		online_verification::reset_revocation_floors_for_tests();
	}
};

static bool has_status_event(const LicenseInfo& info, const LCC_EVENT_TYPE event_type) {
	for (int i = 0; i < LCC_API_AUDIT_EVENT_NUM; ++i) {
		if (info.status[i].event_type == event_type) {
			return true;
		}
	}
	return false;
}

static const AuditEvent* find_status_event(const LicenseInfo& info, const LCC_EVENT_TYPE event_type,
										   const LCC_SEVERITY severity) {
	for (int i = 0; i < LCC_API_AUDIT_EVENT_NUM; ++i) {
		if (info.status[i].event_type == event_type && info.status[i].severity == severity) {
			return &info.status[i];
		}
	}
	return nullptr;
}

static string sign_payload(const string& payload) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->loadPrivateKey_file(LCC_PROJECT_PRIVATE_KEY);
	return crypto->signString(payload);
}

static string read_online_fixture(const string& name) {
	const string path = string(PROJECT_TEST_SRC_DIR) + "/vectors/online_assertion/" + name;
	ifstream input(path.c_str(), ios::binary);
	BOOST_REQUIRE_MESSAGE(input.is_open(), "can open online assertion fixture " + path);
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

static vector<uint8_t> hex_to_bytes(const string& hex) {
	const string compact = compact_ascii_whitespace(hex);
	BOOST_REQUIRE_EQUAL(compact.size() % 2, 0);
	vector<uint8_t> out;
	out.reserve(compact.size() / 2);
	for (size_t i = 0; i < compact.size(); i += 2) {
		out.push_back(static_cast<uint8_t>((hex_nibble(compact[i]) << 4U) | hex_nibble(compact[i + 1])));
	}
	return out;
}

static string env_string(const char* name) {
	const char* value = getenv(name);
	return value == nullptr ? string() : string(value);
}

static online_verification::OnlineVerificationExpected expected_claims(const uint64_t now = 1000) {
	online_verification::OnlineVerificationExpected expected;
	expected.project = LCC_PROJECT_NAME;
	expected.feature = LCC_PROJECT_NAME;
	expected.license_fingerprint = string(LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE, 'a');
	expected.device_hash = "";
	expected.nonce = string(LCC_API_ONLINE_NONCE_SIZE, 'b');
	expected.now_epoch_seconds = now;
	return expected;
}

static vector<online_verification::OnlineVerificationPublicKey> project_public_keys_for_tests() {
	online_verification::OnlineVerificationPublicKey public_key;
	public_key.key_id = license::os::embedded_public_key_id();
	public_key.public_key_der = license::os::embedded_public_key_der();
	public_key.bits = license::os::embedded_public_key_bits();
	return vector<online_verification::OnlineVerificationPublicKey>(1, public_key);
}

struct OnlineVerifierTestFixture {
	OnlineVerifierTestFixture() {
		online_verification::set_trusted_public_keys_for_tests(project_public_keys_for_tests());
	}

	~OnlineVerifierTestFixture() {
		online_verification::set_trusted_public_keys_for_tests(vector<online_verification::OnlineVerificationPublicKey>());
		online_verification::reset_revocation_floors_for_tests();
	}
};

BOOST_TEST_GLOBAL_FIXTURE(OnlineVerifierTestFixture);

static string assertion_for(const online_verification::OnlineVerificationExpected& expected,
							const string& status = "ok", const uint64_t issued_at = 900,
							const uint64_t expires_at = 1100, const uint64_t cache_until = 1200,
							const uint64_t revocation_seq = 7) {
	online_verification::OnlineAssertionClaims claims;
	claims.purpose = "licensecc-online-assertion";
	claims.version = "1";
	claims.algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	claims.key_id = license::os::embedded_public_key_id();
	claims.project = expected.project;
	claims.feature = expected.feature;
	claims.license_fingerprint = expected.license_fingerprint;
	claims.device_hash = expected.device_hash;
	claims.nonce = expected.nonce;
	claims.status = status;
	claims.issued_at = issued_at;
	claims.expires_at = expires_at;
	claims.cache_until = cache_until;
	claims.revocation_seq = revocation_seq;
	const string payload = online_verification::build_canonical_assertion_payload(claims);
	BOOST_REQUIRE(!payload.empty());
	return online_verification::build_assertion_envelope(payload, sign_payload(payload));
}

static string issue_valid_license_file(const string& license_name) {
	std::filesystem::create_directories(LCC_LICENSES_BASE);
	const string file_path = string(LCC_LICENSES_BASE) + "/" + license_name + ".lic";
	std::remove(file_path.c_str());
	stringstream ss;
	ss << LCC_EXE << " license issue";
	ss << " --" PARAM_PRIMARY_KEY " " << LCC_PROJECT_PRIVATE_KEY;
	ss << " --" PARAM_LICENSE_OUTPUT " " << file_path;
	ss << " --" PARAM_PROJECT_FOLDER " " << LCC_TEST_LICENSES_PROJECT;
	const int ret = std::system(ss.str().c_str());
	BOOST_REQUIRE_EQUAL(ret, 0);
	BOOST_REQUIRE_MESSAGE(ifstream(file_path.c_str()).good(), "issued license exists: " + file_path);
	return file_path;
}

static LicenseLocation license_path_location(const string& file_path) {
	LicenseLocation location;
	lcc_init_license_location(&location, LICENSE_PATH);
	BOOST_REQUIRE_MESSAGE(lcc_set_license_path(&location, file_path.c_str()), "license path fits public buffer");
	return location;
}

static CallerInformations default_caller() {
	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	return caller;
}

struct CallbackState {
	int calls = 0;
	LCC_ONLINE_CALLBACK_STATUS status = LCC_ONLINE_CB_OK;
	bool mutate_nonce = false;
	uint64_t revocation_seq = 1;
	string replay_assertion;
	string last_assertion;
};

struct FloorStoreState {
	int load_calls = 0;
	int store_calls = 0;
	bool load_ok = true;
	bool store_ok = true;
	uint64_t floor = 0;
	LccRevocationFloorRecord last_loaded_key{};
	LccRevocationFloorRecord last_stored_record{};
};

static LCC_ONLINE_CALLBACK_STATUS copy_assertion_to_output(const string& assertion, char* assertion_out,
														   size_t* assertion_out_size) {
	if (assertion_out == nullptr || assertion_out_size == nullptr) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	if (assertion.size() + 1 > *assertion_out_size) {
		*assertion_out_size = assertion.size() + 1;
		return LCC_ONLINE_CB_BUFFER_TOO_SMALL;
	}
	memcpy(assertion_out, assertion.c_str(), assertion.size() + 1);
	*assertion_out_size = assertion.size() + 1;
	return LCC_ONLINE_CB_OK;
}

static LCC_ONLINE_CALLBACK_STATUS signing_callback(void* user_data, const LccOnlineRequest* request,
												   char* assertion_out, size_t* assertion_out_size) {
	CallbackState* state = static_cast<CallbackState*>(user_data);
	if (state != nullptr) {
		++state->calls;
		if (state->status != LCC_ONLINE_CB_OK) {
			return state->status;
		}
		if (!state->replay_assertion.empty()) {
			return copy_assertion_to_output(state->replay_assertion, assertion_out, assertion_out_size);
		}
	}
	if (request == nullptr || assertion_out == nullptr || assertion_out_size == nullptr) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}

	const uint64_t now = static_cast<uint64_t>(time(nullptr));
	online_verification::OnlineAssertionClaims claims;
	claims.purpose = "licensecc-online-assertion";
	claims.version = "1";
	claims.algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	claims.key_id = license::os::embedded_public_key_id();
	claims.project = request->project;
	claims.feature = request->feature;
	claims.license_fingerprint = request->license_fingerprint;
	claims.device_hash = request->device_hash;
	claims.nonce = request->nonce;
	if (state != nullptr && state->mutate_nonce && !claims.nonce.empty()) {
		claims.nonce[0] = claims.nonce[0] == '0' ? '1' : '0';
	}
	claims.status = "ok";
	claims.issued_at = now > 0 ? now - 1 : now;
	claims.expires_at = now + 3600;
	claims.cache_until = now + 3600;
	claims.revocation_seq = state == nullptr ? 1 : state->revocation_seq;
	const string payload = online_verification::build_canonical_assertion_payload(claims);
	const string assertion = online_verification::build_assertion_envelope(payload, sign_payload(payload));
	if (state != nullptr) {
		state->last_assertion = assertion;
	}
	return copy_assertion_to_output(assertion, assertion_out, assertion_out_size);
}

static bool floor_load_callback(void* user_data, const LccRevocationFloorRecord* key,
								uint64_t* revocation_seq_out) {
	FloorStoreState* state = static_cast<FloorStoreState*>(user_data);
	if (state == nullptr || key == nullptr || revocation_seq_out == nullptr) {
		return false;
	}
	++state->load_calls;
	state->last_loaded_key = *key;
	if (!state->load_ok) {
		return false;
	}
	*revocation_seq_out = state->floor;
	return true;
}

static bool floor_store_callback(void* user_data, const LccRevocationFloorRecord* record) {
	FloorStoreState* state = static_cast<FloorStoreState*>(user_data);
	if (state == nullptr || record == nullptr) {
		return false;
	}
	++state->store_calls;
	state->last_stored_record = *record;
	if (!state->store_ok) {
		return false;
	}
	state->floor = (std::max)(state->floor, record->revocation_seq);
	return true;
}

static LccLicenseDecisionOptions secure_decision_options(CallbackState& online_state,
														 FloorStoreState& floor_state) {
	LccLicenseDecisionOptions options;
	lcc_init_license_decision_options(&options);
	options.online_check = signing_callback;
	options.online_user_data = &online_state;
	options.revocation_floor_load = floor_load_callback;
	options.revocation_floor_store = floor_store_callback;
	options.revocation_floor_user_data = &floor_state;
	return options;
}

BOOST_AUTO_TEST_CASE(verifier_accepts_valid_assertion) {
	const online_verification::OnlineVerificationExpected expected = expected_claims();
	const string assertion = assertion_for(expected);
	string error;
	LCC_EVENT_TYPE failure = LICENSE_OK;
	bool used_cache = false;

	BOOST_CHECK(online_verification::verify_assertion_envelope(assertion, expected, nullptr, error, failure,
															   used_cache));
	BOOST_CHECK(!used_cache);
	BOOST_CHECK(error.empty());
}

BOOST_AUTO_TEST_CASE(generate_nonce_returns_distinct_hex_values) {
	const string first = online_verification::generate_nonce();
	const string second = online_verification::generate_nonce();
	BOOST_REQUIRE_EQUAL(first.size(), LCC_API_ONLINE_NONCE_SIZE);
	BOOST_REQUIRE_EQUAL(second.size(), LCC_API_ONLINE_NONCE_SIZE);
	BOOST_CHECK_NE(first, second);
	for (const unsigned char ch : first + second) {
		BOOST_CHECK((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'));
	}
}

BOOST_AUTO_TEST_CASE(canonical_online_assertion_payload_is_byte_exact) {
	online_verification::OnlineAssertionClaims claims;
	claims.purpose = "licensecc-online-assertion";
	claims.version = "1";
	claims.algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	claims.key_id = "sha256:test-key";
	claims.project = "DEFAULT";
	claims.feature = "EXPORT";
	claims.license_fingerprint = string(LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE, 'a');
	claims.device_hash = string(LCC_API_ONLINE_DEVICE_HASH_SIZE, 'b');
	claims.nonce = string(LCC_API_ONLINE_NONCE_SIZE, 'c');
	claims.status = "ok";
	claims.issued_at = 1000;
	claims.expires_at = 1300;
	claims.cache_until = 1600;
	claims.revocation_seq = 42;

	const string expected =
		"purpose=licensecc-online-assertion\n"
		"version=1\n"
		"alg=rsa-pkcs1-sha256\n"
		"key-id=sha256:test-key\n"
		"project=DEFAULT\n"
		"feature=EXPORT\n"
		"license-fingerprint=" + string(LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE, 'a') + "\n"
		"device-hash=" + string(LCC_API_ONLINE_DEVICE_HASH_SIZE, 'b') + "\n"
		"nonce=" + string(LCC_API_ONLINE_NONCE_SIZE, 'c') + "\n"
		"status=ok\n"
		"issued-at=1000\n"
		"expires-at=1300\n"
		"cache-until=1600\n"
		"revocation-seq=42\n";

	BOOST_CHECK_EQUAL(online_verification::build_canonical_assertion_payload(claims), expected);
}

BOOST_AUTO_TEST_CASE(shared_golden_assertion_verifies_in_cpp) {
	const string key_id = compact_ascii_whitespace(read_online_fixture("golden.key_id"));
	const string payload = read_online_fixture("golden.payload");
	const string assertion = compact_ascii_whitespace(read_online_fixture("golden.assertion"));
	const vector<uint8_t> public_key_der = hex_to_bytes(read_online_fixture("golden.public_key.pkcs1.der.hex"));

	online_verification::OnlineAssertionClaims claims;
	claims.purpose = "licensecc-online-assertion";
	claims.version = "1";
	claims.algorithm = license::os::LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	claims.key_id = key_id;
	claims.project = "DEFAULT";
	claims.feature = "EXPORT";
	claims.license_fingerprint = string(LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE, 'a');
	claims.device_hash = string(LCC_API_ONLINE_DEVICE_HASH_SIZE, 'b');
	claims.nonce = string(LCC_API_ONLINE_NONCE_SIZE, 'c');
	claims.status = "ok";
	claims.issued_at = 1000;
	claims.expires_at = 1300;
	claims.cache_until = 1600;
	claims.revocation_seq = 42;
	BOOST_CHECK_EQUAL(online_verification::build_canonical_assertion_payload(claims), payload);

	online_verification::OnlineVerificationExpected expected;
	expected.project = claims.project;
	expected.feature = claims.feature;
	expected.license_fingerprint = claims.license_fingerprint;
	expected.device_hash = claims.device_hash;
	expected.nonce = claims.nonce;
	expected.now_epoch_seconds = 1200;
	expected.min_revocation_seq = 42;
	online_verification::OnlineVerificationPublicKey public_key;
	public_key.key_id = key_id;
	public_key.public_key_der = public_key_der;
	public_key.bits = 3072;
	expected.trusted_public_keys.push_back(public_key);

	online_verification::OnlineAssertionClaims verified_claims;
	string error;
	LCC_EVENT_TYPE failure = LICENSE_OK;
	bool used_cache = false;
	BOOST_REQUIRE(online_verification::verify_assertion_envelope(assertion, expected, &verified_claims, error,
																 failure, used_cache));
	BOOST_CHECK(error.empty());
	BOOST_CHECK(!used_cache);
	BOOST_CHECK_EQUAL(verified_claims.revocation_seq, 42);
	BOOST_CHECK_EQUAL(verified_claims.key_id, key_id);
}

BOOST_AUTO_TEST_CASE(remote_worker_assertion_fixture_verifies_in_cpp_when_provided) {
	const string assertion = env_string("LCC_REMOTE_ONLINE_ASSERTION");
	if (assertion.empty()) {
		return;
	}
	const string key_id = env_string("LCC_REMOTE_ONLINE_KEY_ID");
	const string public_key_der_hex = env_string("LCC_REMOTE_ONLINE_PUBLIC_KEY_DER_HEX");
	const string fingerprint = env_string("LCC_REMOTE_ONLINE_LICENSE_FINGERPRINT");
	const string nonce = env_string("LCC_REMOTE_ONLINE_NONCE");
	const string project = env_string("LCC_REMOTE_ONLINE_PROJECT").empty() ? "DEFAULT" : env_string("LCC_REMOTE_ONLINE_PROJECT");
	const string feature = env_string("LCC_REMOTE_ONLINE_FEATURE").empty() ? "DEFAULT" : env_string("LCC_REMOTE_ONLINE_FEATURE");
	const string device_hash = env_string("LCC_REMOTE_ONLINE_DEVICE_HASH");
	BOOST_REQUIRE_MESSAGE(!key_id.empty(), "LCC_REMOTE_ONLINE_KEY_ID is required with LCC_REMOTE_ONLINE_ASSERTION");
	BOOST_REQUIRE_MESSAGE(!public_key_der_hex.empty(),
						  "LCC_REMOTE_ONLINE_PUBLIC_KEY_DER_HEX is required with LCC_REMOTE_ONLINE_ASSERTION");
	BOOST_REQUIRE_MESSAGE(!fingerprint.empty(),
						  "LCC_REMOTE_ONLINE_LICENSE_FINGERPRINT is required with LCC_REMOTE_ONLINE_ASSERTION");
	BOOST_REQUIRE_MESSAGE(!nonce.empty(), "LCC_REMOTE_ONLINE_NONCE is required with LCC_REMOTE_ONLINE_ASSERTION");

	online_verification::OnlineVerificationPublicKey public_key;
	public_key.key_id = key_id;
	public_key.public_key_der = hex_to_bytes(public_key_der_hex);
	public_key.bits = 3072;

	online_verification::OnlineVerificationExpected expected;
	expected.project = project;
	expected.feature = feature;
	expected.license_fingerprint = fingerprint;
	expected.device_hash = device_hash;
	expected.nonce = nonce;
	expected.now_epoch_seconds = static_cast<uint64_t>(time(nullptr));
	expected.trusted_public_keys.push_back(public_key);

	online_verification::OnlineAssertionClaims verified_claims;
	string error;
	LCC_EVENT_TYPE failure = LICENSE_OK;
	bool used_cache = false;
	BOOST_REQUIRE_MESSAGE(
		online_verification::verify_assertion_envelope(assertion, expected, &verified_claims, error, failure, used_cache),
		error);
	BOOST_CHECK(!used_cache);
	BOOST_CHECK_EQUAL(verified_claims.key_id, key_id);
	BOOST_CHECK_EQUAL(verified_claims.project, project);
	BOOST_CHECK_EQUAL(verified_claims.feature, feature);
	BOOST_CHECK_EQUAL(verified_claims.license_fingerprint, fingerprint);
	BOOST_CHECK_EQUAL(verified_claims.nonce, nonce);
	BOOST_CHECK_EQUAL(verified_claims.status, "ok");
}

BOOST_AUTO_TEST_CASE(dedicated_online_key_set_rejects_project_license_key_assertion) {
	const string key_id = compact_ascii_whitespace(read_online_fixture("golden.key_id"));
	const vector<uint8_t> public_key_der = hex_to_bytes(read_online_fixture("golden.public_key.pkcs1.der.hex"));

	online_verification::OnlineVerificationExpected expected;
	expected.project = "DEFAULT";
	expected.feature = "EXPORT";
	expected.license_fingerprint = string(LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE, 'a');
	expected.device_hash = string(LCC_API_ONLINE_DEVICE_HASH_SIZE, 'b');
	expected.nonce = string(LCC_API_ONLINE_NONCE_SIZE, 'c');
	expected.now_epoch_seconds = 1200;
	expected.min_revocation_seq = 42;
	online_verification::OnlineVerificationPublicKey public_key;
	public_key.key_id = key_id;
	public_key.public_key_der = public_key_der;
	public_key.bits = 3072;
	expected.trusted_public_keys.push_back(public_key);

	const string project_key_assertion = assertion_for(expected, "ok", 1000, 1300, 1600, 42);
	string error;
	LCC_EVENT_TYPE failure = LICENSE_OK;
	bool used_cache = false;
	BOOST_CHECK(!online_verification::verify_assertion_envelope(project_key_assertion, expected, nullptr, error,
																failure, used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK(!used_cache);
}

BOOST_AUTO_TEST_CASE(verifier_rejects_tampered_and_mismatched_assertions) {
	const online_verification::OnlineVerificationExpected expected = expected_claims();
	string assertion = assertion_for(expected);

	string error;
	LCC_EVENT_TYPE failure = LICENSE_OK;
	bool used_cache = false;
	BOOST_CHECK(!online_verification::verify_assertion_envelope("bad." + assertion, expected, nullptr, error,
																failure, used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);

	assertion = assertion_for(expected);
	const size_t dot = assertion.find('.');
	BOOST_REQUIRE_NE(dot, string::npos);
	assertion[dot + 1] = assertion[dot + 1] == 'A' ? 'B' : 'A';
	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion, expected, nullptr, error, failure,
																used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);

	online_verification::OnlineVerificationExpected wrong_nonce = expected;
	wrong_nonce.nonce[0] = 'c';
	assertion = assertion_for(expected);
	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion, wrong_nonce, nullptr, error, failure,
																used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);

	online_verification::OnlineVerificationExpected wrong_feature = expected;
	wrong_feature.feature = "EXPORT";
	assertion = assertion_for(expected);
	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion, wrong_feature, nullptr, error, failure,
																used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);

	online_verification::OnlineVerificationExpected wrong_fingerprint = expected;
	wrong_fingerprint.license_fingerprint[0] = 'b';
	assertion = assertion_for(expected);
	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion, wrong_fingerprint, nullptr, error, failure,
																used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);

	online_verification::OnlineVerificationExpected device_bound = expected;
	device_bound.device_hash = string(LCC_API_ONLINE_DEVICE_HASH_SIZE, 'c');
	online_verification::OnlineVerificationExpected wrong_device = device_bound;
	wrong_device.device_hash[0] = 'd';
	assertion = assertion_for(device_bound);
	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion, wrong_device, nullptr, error, failure,
																used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);
}

BOOST_AUTO_TEST_CASE(verifier_enforces_status_and_cache_window) {
	online_verification::OnlineVerificationExpected expected = expected_claims();
	string error;
	LCC_EVENT_TYPE failure = LICENSE_OK;
	bool used_cache = false;

	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion_for(expected, "denied"), expected,
																nullptr, error, failure, used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_VERIFICATION_FAILED);

	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion_for(expected, "ok", 800, 900, 950),
																expected, nullptr, error, failure, used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);

	expected.allow_cache = true;
	BOOST_CHECK(online_verification::verify_assertion_envelope(assertion_for(expected, "ok", 800, 900, 1100),
															   expected, nullptr, error, failure, used_cache));
	BOOST_CHECK(used_cache);

	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion_for(expected, "ok", 800, 900, 950),
																expected, nullptr, error, failure, used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_CACHE_EXPIRED);

	online_verification::OnlineVerificationExpected strict_cache = expected_claims();
	strict_cache.max_cache_seconds = 100;
	used_cache = false;
	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion_for(strict_cache, "ok", 900, 1000, 1201),
																strict_cache, nullptr, error, failure, used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK(!used_cache);
}

BOOST_AUTO_TEST_CASE(verifier_accepts_nonce_mismatch_only_as_valid_cache) {
	online_verification::OnlineVerificationExpected expected = expected_claims();
	online_verification::OnlineVerificationExpected cached_request = expected;
	cached_request.nonce[0] = cached_request.nonce[0] == 'b' ? 'c' : 'b';
	string error;
	LCC_EVENT_TYPE failure = LICENSE_OK;
	bool used_cache = false;
	const string assertion = assertion_for(expected, "ok", 900, 1100, 1200);

	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion, cached_request, nullptr, error,
																failure, used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK(!used_cache);

	cached_request.allow_cache = true;
	BOOST_CHECK(online_verification::verify_assertion_envelope(assertion, cached_request, nullptr, error, failure,
															   used_cache));
	BOOST_CHECK(used_cache);

	cached_request.now_epoch_seconds = 1300;
	used_cache = false;
	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion, cached_request, nullptr, error,
																failure, used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK(!used_cache);
}

BOOST_AUTO_TEST_CASE(verifier_rejects_assertions_below_revocation_floor) {
	online_verification::OnlineVerificationExpected expected = expected_claims();
	expected.min_revocation_seq = 8;
	string error;
	LCC_EVENT_TYPE failure = LICENSE_OK;
	bool used_cache = false;

	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion_for(expected, "ok", 900, 1100, 1200, 7),
																expected, nullptr, error, failure, used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK(!used_cache);

	BOOST_CHECK(online_verification::verify_assertion_envelope(assertion_for(expected, "ok", 900, 1100, 1200, 8),
															   expected, nullptr, error, failure, used_cache));

	online_verification::OnlineVerificationExpected cached_request = expected;
	cached_request.allow_cache = true;
	cached_request.nonce[0] = cached_request.nonce[0] == 'b' ? 'c' : 'b';
	used_cache = false;
	BOOST_CHECK(!online_verification::verify_assertion_envelope(assertion_for(expected, "ok", 900, 1100, 1200, 7),
																cached_request, nullptr, error, failure, used_cache));
	BOOST_CHECK_EQUAL(failure, LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK(!used_cache);
}

BOOST_AUTO_TEST_CASE(evaluate_advances_revocation_floor_and_rejects_rollback) {
	online_verification::reset_revocation_floors_for_tests();
	online_verification::OnlineVerificationRequest request;
	request.policy = online_verification::OnlinePolicy::Require;
	request.online_check = signing_callback;
	request.project = LCC_PROJECT_NAME;
	request.feature = LCC_PROJECT_NAME;
	request.license_fingerprint = string(LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE, 'a');
	request.device_hash = "";

	CallbackState state;
	request.online_user_data = &state;

	state.revocation_seq = 5;
	online_verification::OnlineVerificationResult result = online_verification::evaluate(request);
	BOOST_REQUIRE(!result.failed());
	BOOST_CHECK_EQUAL(online_verification::revocation_floor_for_tests(request.project, request.feature,
																	  request.license_fingerprint),
					  5U);

	state.revocation_seq = 4;
	result = online_verification::evaluate(request);
	BOOST_CHECK(result.failed());
	BOOST_CHECK_EQUAL(result.event_type, LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK_EQUAL(online_verification::revocation_floor_for_tests(request.project, request.feature,
																	  request.license_fingerprint),
					  5U);

	state.revocation_seq = 6;
	result = online_verification::evaluate(request);
	BOOST_CHECK(!result.failed());
	BOOST_CHECK_EQUAL(online_verification::revocation_floor_for_tests(request.project, request.feature,
																	  request.license_fingerprint),
					  6U);
	online_verification::reset_revocation_floors_for_tests();
}

BOOST_AUTO_TEST_CASE(evaluate_enforces_external_minimum_revocation_floor) {
	online_verification::reset_revocation_floors_for_tests();
	online_verification::OnlineVerificationRequest request;
	request.policy = online_verification::OnlinePolicy::Require;
	request.online_check = signing_callback;
	request.project = LCC_PROJECT_NAME;
	request.feature = LCC_PROJECT_NAME;
	request.license_fingerprint = string(LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE, 'a');
	request.device_hash = "";
	request.minimum_revocation_seq = 9;

	CallbackState state;
	state.revocation_seq = 8;
	request.online_user_data = &state;
	online_verification::OnlineVerificationResult result = online_verification::evaluate(request);
	BOOST_CHECK(result.failed());
	BOOST_CHECK_EQUAL(result.event_type, LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK_EQUAL(online_verification::revocation_floor_for_tests(request.project, request.feature,
																	  request.license_fingerprint),
					  0U);

	state.revocation_seq = 9;
	result = online_verification::evaluate(request);
	BOOST_REQUIRE(!result.failed());
	BOOST_CHECK_EQUAL(result.accepted_revocation_seq, 9U);
	BOOST_CHECK_EQUAL(online_verification::revocation_floor_for_tests(request.project, request.feature,
																	  request.license_fingerprint),
					  9U);
	online_verification::reset_revocation_floors_for_tests();
}

BOOST_AUTO_TEST_CASE(evaluate_rejects_replayed_assertion_below_seen_revocation_floor) {
	online_verification::reset_revocation_floors_for_tests();
	online_verification::OnlineVerificationRequest request;
	request.policy = online_verification::OnlinePolicy::Require;
	request.online_check = signing_callback;
	request.project = LCC_PROJECT_NAME;
	request.feature = LCC_PROJECT_NAME;
	request.license_fingerprint = string(LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE, 'a');
	request.device_hash = "";

	CallbackState state;
	state.revocation_seq = 7;
	request.online_user_data = &state;
	online_verification::OnlineVerificationResult result = online_verification::evaluate(request);
	BOOST_REQUIRE(!result.failed());
	const string cached_seq7 = state.last_assertion;
	BOOST_REQUIRE(!cached_seq7.empty());

	state.revocation_seq = 8;
	result = online_verification::evaluate(request);
	BOOST_REQUIRE(!result.failed());
	BOOST_CHECK_EQUAL(online_verification::revocation_floor_for_tests(request.project, request.feature,
																	  request.license_fingerprint),
					  8U);

	CallbackState replay;
	replay.replay_assertion = cached_seq7;
	request.online_user_data = &replay;
	result = online_verification::evaluate(request);
	BOOST_CHECK(result.failed());
	BOOST_CHECK_EQUAL(result.event_type, LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK(!result.used_cache);
	BOOST_CHECK_EQUAL(online_verification::revocation_floor_for_tests(request.project, request.feature,
																	  request.license_fingerprint),
					  8U);
	online_verification::reset_revocation_floors_for_tests();
}

BOOST_AUTO_TEST_CASE(no_online_callback_leaves_online_verification_disabled) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("online-disabled-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();
	LicenseInfo info{};

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);

	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK(!has_status_event(info, LICENSE_ONLINE_VERIFICATION_FAILED));

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(online_callback_requires_valid_assertion_by_default) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("online-default-transport-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();
	LicenseInfo info{};

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	CallbackState state;
	state.status = LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	options.online_check = signing_callback;
	options.online_user_data = &state;

	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_ONLINE_VERIFICATION_FAILED);
	BOOST_CHECK_EQUAL(state.calls, 1);
	BOOST_CHECK(find_status_event(info, LICENSE_ONLINE_VERIFICATION_FAILED, SVRT_ERROR) != nullptr);
	BOOST_CHECK_EQUAL(info.license_version, 0);

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(require_policy_denies_on_transport_failure) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("online-require-transport-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();
	LicenseInfo info{};

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.online_policy = LCC_ONLINE_REQUIRE;
	CallbackState state;
	state.status = LCC_ONLINE_CB_TIMEOUT;
	options.online_check = signing_callback;
	options.online_user_data = &state;

	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_ONLINE_VERIFICATION_FAILED);
	BOOST_CHECK_EQUAL(state.calls, 1);
	BOOST_CHECK(find_status_event(info, LICENSE_ONLINE_VERIFICATION_FAILED, SVRT_ERROR) != nullptr);
	BOOST_CHECK_EQUAL(info.license_version, 0);

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(require_policy_accepts_valid_assertion_and_rejects_bad_binding) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("online-require-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.online_policy = LCC_ONLINE_REQUIRE;
	CallbackState state;
	options.online_check = signing_callback;
	options.online_user_data = &state;

	LicenseInfo ok_info{};
	BOOST_CHECK_EQUAL(acquire_license_ex(&caller, &location, &ok_info, &options), LICENSE_OK);
	BOOST_CHECK_EQUAL(state.calls, 1);
	BOOST_CHECK_EQUAL(ok_info.license_version, 200);

	state.mutate_nonce = true;
	LicenseInfo bad_info{};
	BOOST_CHECK_EQUAL(acquire_license_ex(&caller, &location, &bad_info, &options),
					  LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK(find_status_event(bad_info, LICENSE_ONLINE_ASSERTION_INVALID, SVRT_ERROR) != nullptr);

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(decision_wrapper_requires_online_and_persistent_floor_callbacks) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("decision-requires-callbacks");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();
	LicenseInfo info{};
	LccLicenseDecision decision;
	lcc_init_license_decision(&decision);

	const LCC_EVENT_TYPE result = lcc_acquire_license_decision(&caller, &location, &info, &decision, nullptr);
	BOOST_CHECK_EQUAL(result, LICENSE_ONLINE_REQUIRED);
	BOOST_CHECK_EQUAL(decision.decision, LCC_LICENSE_DECISION_DENY);
	BOOST_CHECK_EQUAL(decision.event_type, LICENSE_ONLINE_REQUIRED);
	BOOST_CHECK(decision.tamper_enforced);
	BOOST_CHECK(find_status_event(info, LICENSE_ONLINE_REQUIRED, SVRT_ERROR) != nullptr);
	BOOST_CHECK_EQUAL(info.license_version, 0);

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(decision_wrapper_persists_floor_and_rejects_restart_rollback) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("decision-persistent-floor-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();

	CallbackState online_state;
	online_state.revocation_seq = 12;
	FloorStoreState floor_state;
	floor_state.floor = 9;
	LccLicenseDecisionOptions options = secure_decision_options(online_state, floor_state);

	LicenseInfo ok_info{};
	LccLicenseDecision ok_decision;
	const LCC_EVENT_TYPE ok = lcc_acquire_license_decision(&caller, &location, &ok_info, &ok_decision, &options);
	BOOST_REQUIRE_EQUAL(ok, LICENSE_OK);
	BOOST_CHECK_EQUAL(ok_decision.decision, LCC_LICENSE_DECISION_ALLOW);
	BOOST_CHECK(ok_decision.online_verified);
	BOOST_CHECK(ok_decision.revocation_floor_loaded);
	BOOST_CHECK(ok_decision.revocation_floor_stored);
	BOOST_CHECK(ok_decision.tamper_enforced);
	BOOST_CHECK_EQUAL(ok_decision.revocation_floor.revocation_seq, 12U);
	BOOST_CHECK_EQUAL(floor_state.floor, 12U);
	BOOST_CHECK_EQUAL(floor_state.load_calls, 1);
	BOOST_CHECK_EQUAL(floor_state.store_calls, 1);
	BOOST_CHECK_EQUAL(ok_info.license_version, 200);

	online_verification::reset_revocation_floors_for_tests();
	online_state.revocation_seq = 11;
	LicenseInfo rollback_info{};
	LccLicenseDecision rollback_decision;
	const LCC_EVENT_TYPE rollback =
		lcc_acquire_license_decision(&caller, &location, &rollback_info, &rollback_decision, &options);
	BOOST_CHECK_EQUAL(rollback, LICENSE_ONLINE_ASSERTION_INVALID);
	BOOST_CHECK_EQUAL(rollback_decision.decision, LCC_LICENSE_DECISION_DENY);
	BOOST_CHECK(rollback_decision.revocation_floor_loaded);
	BOOST_CHECK(!rollback_decision.revocation_floor_stored);
	BOOST_CHECK_EQUAL(floor_state.load_calls, 2);
	BOOST_CHECK_EQUAL(floor_state.store_calls, 1);
	BOOST_CHECK_EQUAL(rollback_info.license_version, 0);
	BOOST_CHECK(find_status_event(rollback_info, LICENSE_ONLINE_ASSERTION_INVALID, SVRT_ERROR) != nullptr);

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(decision_wrapper_denies_when_floor_store_fails) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("decision-floor-store-fails");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();

	CallbackState online_state;
	online_state.revocation_seq = 3;
	FloorStoreState floor_state;
	floor_state.store_ok = false;
	LccLicenseDecisionOptions options = secure_decision_options(online_state, floor_state);

	LicenseInfo info{};
	LccLicenseDecision decision;
	const LCC_EVENT_TYPE result = lcc_acquire_license_decision(&caller, &location, &info, &decision, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_ONLINE_VERIFICATION_FAILED);
	BOOST_CHECK_EQUAL(decision.decision, LCC_LICENSE_DECISION_DENY);
	BOOST_CHECK(decision.online_verified);
	BOOST_CHECK(decision.revocation_floor_loaded);
	BOOST_CHECK(!decision.revocation_floor_stored);
	BOOST_CHECK_EQUAL(floor_state.load_calls, 1);
	BOOST_CHECK_EQUAL(floor_state.store_calls, 1);
	BOOST_CHECK_EQUAL(info.license_version, 0);
	BOOST_CHECK(find_status_event(info, LICENSE_ONLINE_VERIFICATION_FAILED, SVRT_ERROR) != nullptr);

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(local_license_failure_takes_precedence_over_online_callback) {
	RuntimePolicyGuard guard;
	CallerInformations caller = default_caller();
	LicenseLocation location;
	lcc_init_license_location(&location, LICENSE_PLAIN_DATA);
	BOOST_REQUIRE(lcc_set_license_location_data(&location, LICENSE_PLAIN_DATA, "not ini"));

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.online_policy = LCC_ONLINE_REQUIRE;
	CallbackState state;
	options.online_check = signing_callback;
	options.online_user_data = &state;

	LicenseInfo info{};
	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK_EQUAL(state.calls, 0);
	BOOST_CHECK(!has_status_event(info, LICENSE_ONLINE_VERIFICATION_FAILED));
	BOOST_CHECK(!has_status_event(info, LICENSE_ONLINE_ASSERTION_INVALID));
}

BOOST_AUTO_TEST_CASE(decision_wrapper_preserves_local_license_failure_precedence) {
	RuntimePolicyGuard guard;
	CallerInformations caller = default_caller();
	LicenseLocation location;
	lcc_init_license_location(&location, LICENSE_PLAIN_DATA);
	BOOST_REQUIRE(lcc_set_license_location_data(&location, LICENSE_PLAIN_DATA, "not ini"));

	CallbackState online_state;
	FloorStoreState floor_state;
	LccLicenseDecisionOptions options = secure_decision_options(online_state, floor_state);

	LicenseInfo info{};
	LccLicenseDecision decision;
	const LCC_EVENT_TYPE result = lcc_acquire_license_decision(&caller, &location, &info, &decision, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK_EQUAL(decision.decision, LCC_LICENSE_DECISION_DENY);
	BOOST_CHECK_EQUAL(online_state.calls, 0);
	BOOST_CHECK_EQUAL(floor_state.load_calls, 0);
	BOOST_CHECK_EQUAL(floor_state.store_calls, 0);
	BOOST_CHECK(!has_status_event(info, LICENSE_ONLINE_VERIFICATION_FAILED));
	BOOST_CHECK(!has_status_event(info, LICENSE_ONLINE_ASSERTION_INVALID));
}

BOOST_AUTO_TEST_CASE(invalid_online_options_fail_closed) {
	RuntimePolicyGuard guard;
	CallerInformations caller = default_caller();

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.online_policy = LCC_ONLINE_REQUIRE;
	options.online_check = nullptr;

	LicenseInfo info{};
	BOOST_CHECK_EQUAL(acquire_license_ex(&caller, nullptr, &info, &options), LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));

	lcc_init_license_check_options(&options);
	std::strcpy(options.online_device_hash, "not-hex");
	lcc_init_license_info(&info);
	BOOST_CHECK_EQUAL(acquire_license_ex(&caller, nullptr, &info, &options), LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
}

}  // namespace test
}  // namespace license
