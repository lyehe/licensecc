
#define BOOST_TEST_MODULE test_standard_license

#include <boost/test/unit_test.hpp>
#include <boost/filesystem.hpp>

#include <licensecc/licensecc.h>
#include <licensecc_properties_test.h>
#include <licensecc_properties.h>

#include <cstring>
#include <vector>
#include "../../src/library/ini/SimpleIni.h"
#include "generate-license.h"
#include "../../src/library/base/file_utils.hpp"
#include "../../src/library/base/base.h"
#include "../../src/library/hw_identifier/hw_identifier.hpp"

using namespace std;
namespace fs = boost::filesystem;

namespace license {
namespace test {

static CallerInformations caller_for_version(const char* version) {
	CallerInformations callInfo;
	lcc_init_caller_informations(&callInfo);
	BOOST_REQUIRE_MESSAGE(lcc_set_caller_version(&callInfo, version), "test caller version fits public API buffer");
	return callInfo;
}

static string error_summary(const LicenseInfo& license) {
	char buffer[LCC_API_ERROR_BUFFER_SIZE];
	print_error(buffer, &license);
	return string(buffer);
}

static bool try_identify_pc(const LCC_API_HW_IDENTIFICATION_STRATEGY strategy, string& identifier) {
	size_t buffer_size = 0;
	identify_pc(strategy, nullptr, &buffer_size, nullptr);
	if (buffer_size == 0) {
		return false;
	}
	vector<char> buffer(buffer_size, '\0');
	if (!identify_pc(strategy, buffer.data(), &buffer_size, nullptr)) {
		return false;
	}
	identifier = buffer.data();
	return !identifier.empty();
}

static string current_strong_pc_identifier() {
	string identifier;
	if (try_identify_pc(STRATEGY_DISK, identifier)) {
		return identifier;
	}
	if (try_identify_pc(STRATEGY_ETHERNET, identifier)) {
		return identifier;
	}
	BOOST_FAIL("Current host cannot generate a strong disk or ethernet hardware identifier for v201 E2E test");
	return string();
}

static LCC_EVENT_TYPE acquire_path_with_version(const string& licLocation, const char* version, LicenseInfo& license) {
	LicenseLocation location = {LICENSE_PATH};
	BOOST_REQUIRE_MESSAGE(lcc_set_license_path(&location, licLocation.c_str()), "license path fits public API buffer");
	CallerInformations caller = caller_for_version(version);
	return acquire_license(&caller, &location, &license);
}

static LCC_EVENT_TYPE acquire_plain_with_version(const string& license_text, const char* version, LicenseInfo& license) {
	LicenseLocation location = {LICENSE_PLAIN_DATA};
	BOOST_REQUIRE_MESSAGE(lcc_set_license_location_data(&location, LICENSE_PLAIN_DATA, license_text.c_str()),
						  "license text fits public API buffer");
	CallerInformations caller = caller_for_version(version);
	return acquire_license(&caller, &location, &license);
}

static string replace_once(string content, const string& from, const string& to) {
	const size_t pos = content.find(from);
	BOOST_REQUIRE_MESSAGE(pos != string::npos, "Expected generated v201 field not found: " + from);
	content.replace(pos, from.size(), to);
	return content;
}

static string different_source_strength(const string& source_strength) {
	return source_strength == "strong-ethernet-mac" ? "strong-disk-serial-or-uuid" : "strong-ethernet-mac";
}

/**
 * Test a generic license with no expiry neither client id. The license is read from file
 */
BOOST_AUTO_TEST_CASE(test_generic_license_read_file) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("standard_license", extraArgs);
	/* */
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(license.has_expiry, false);
	BOOST_CHECK_EQUAL(license.linked_to_pc, false);
}

/**
 * Test a generic license with no expiry neither client id. The license is passed in trhough the licenseData structure.
 */
BOOST_AUTO_TEST_CASE(test_read_license_data) {
	const vector<string> extraArgs;
	const fs::path licLocation = fs::path(generate_license("standard_license1", extraArgs));
	const string licLocationStr = licLocation.string();
	string license_data = get_file_contents(licLocationStr.c_str(), 65536);
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PLAIN_DATA};
	std::copy(license_data.begin(), license_data.end(), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(license.has_expiry, false);
	BOOST_CHECK_EQUAL(license.linked_to_pc, false);
}

/**
 * Pass the license data to the application.
 */
BOOST_AUTO_TEST_CASE(base64_encoded) {
	const string licLocation("standard_b64.lic");
	vector<string> extraArgs;
	extraArgs.push_back("-b");
	const string lic_location = generate_license(licLocation, extraArgs);
	const string license_data(license::get_file_contents(lic_location.c_str(), 65536));
	LicenseInfo license;
	LicenseLocation licenseLocation{};
	licenseLocation.license_data_type = LICENSE_ENCODED;
	std::copy(license_data.begin(), license_data.end(), licenseLocation.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &licenseLocation, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::LICENSE_OK);
	BOOST_CHECK_EQUAL(license.has_expiry, false);
	BOOST_CHECK_EQUAL(license.linked_to_pc, false);
}

BOOST_AUTO_TEST_CASE(generated_v201_license_verifies) {
	const vector<string> extraArgs = {"--license-version", "201", "--target-license-format-max", "201"};
	const string licLocation = generate_license("generated_v201", extraArgs);

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(license.license_version, LCC_LICENSE_FORMAT_VERSION_V201);
}

BOOST_AUTO_TEST_CASE(generated_full_v201_license_verifies_and_signed_optional_fields_are_bound) {
	const string client_signature = current_strong_pc_identifier();
	const string client_signature_source_strength =
		hw_identifier::HwIdentifier(client_signature).source_strength_metadata();
	const vector<string> extraArgs = {"--license-version",
									  "201",
									  "--target-license-format-max",
									  "201",
									  "--valid-from",
									  "2020-01-01",
									  "--valid-to",
									  "2050-12-31",
									  "--start-version",
									  "1.2.0",
									  "--end-version",
									  "2.0.0",
									  "--client-signature",
									  client_signature,
									  "--extra-data",
									  "alpha"};
	const string licLocation = generate_license("generated_full_v201", extraArgs);

	LicenseInfo license;
	const LCC_EVENT_TYPE result = acquire_path_with_version(licLocation, "1.3.0", license);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(license.license_version, LCC_LICENSE_FORMAT_VERSION_V201);
	BOOST_CHECK_EQUAL(license.has_expiry, true);
	BOOST_CHECK_EQUAL(license.linked_to_pc, true);
	BOOST_CHECK_EQUAL(string(license.proprietary_data), "alpha");

	const string generated = get_file_contents(licLocation.c_str(), 65536);
	BOOST_CHECK_NE(generated.find("client-signature-source-strength = " + client_signature_source_strength),
				   string::npos);
	const vector<pair<string, string>> tampered_fields = {
		{"valid-from = 2020-01-01", "valid-from = 2020-01-02"},
		{"valid-to = 2050-12-31", "valid-to = 2050-12-30"},
		{"start-version = 1.2.0", "start-version = 1.2.1"},
		{"end-version = 2.0.0", "end-version = 1.9.9"},
		{"client-signature = " + client_signature, "client-signature = ZZZZ-ZZZZ-ZZZZ"},
		{"client-signature-source-strength = " + client_signature_source_strength,
		 "client-signature-source-strength = " + different_source_strength(client_signature_source_strength)},
		{"extra-data = alpha", "extra-data = bravo"},
	};
	for (size_t i = 0; i < tampered_fields.size(); ++i) {
		BOOST_TEST_CONTEXT("tampered generated v201 field " << tampered_fields[i].first) {
			LicenseInfo tampered_license;
			const string tampered = replace_once(generated, tampered_fields[i].first, tampered_fields[i].second);
			const LCC_EVENT_TYPE tampered_result = acquire_plain_with_version(tampered, "1.3.0", tampered_license);
			BOOST_CHECK_EQUAL(tampered_result, LICENSE_CORRUPTED);
			BOOST_CHECK_MESSAGE(error_summary(tampered_license).find("license signature didn't match") != string::npos,
								"tamper diagnostic is visible: " + error_summary(tampered_license));
		}
	}
}

// old boost version can't parse the comma separated list.. only centos 7 and Ubuntu 16.04
#if (BOOST_VERSION > 106500)
BOOST_AUTO_TEST_CASE(multiple_features) {
	vector<string> extraArgs;
	extraArgs.push_back("-f");
	extraArgs.push_back(LCC_PROJECT_NAME ",feature1,feature2");
	const fs::path licLocation = fs::path(generate_license("multi_feature", extraArgs));
	const string licLocationStr = licLocation.string();
	string license_data = get_file_contents(licLocationStr.c_str(), 65536);
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PLAIN_DATA};
	std::copy(license_data.begin(), license_data.end(), location.licenseData);
	CallerInformations callInfo;
	strcpy(callInfo.feature_name, "feature1");
	callInfo.magic = 0;
	callInfo.version[0] = '\0';
	LCC_EVENT_TYPE result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::LICENSE_OK);
	strcpy(callInfo.feature_name, "feature2");
	result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::LICENSE_OK);
	strcpy(callInfo.feature_name, "feature3");
	result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::PRODUCT_NOT_LICENSED);
}
#endif

BOOST_AUTO_TEST_CASE(version_limits_accept_matching_version) {
	vector<string> extraArgs;
	extraArgs.push_back("--start-version");
	extraArgs.push_back("1.2.0");
	extraArgs.push_back("--end-version");
	extraArgs.push_back("1.4.0");
	const fs::path licLocation = fs::path(generate_license("version_in_range", extraArgs));
	const string licLocationStr = licLocation.string();

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocationStr.begin(), licLocationStr.end(), location.licenseData);
	CallerInformations callInfo = caller_for_version("1.3.5");
	const LCC_EVENT_TYPE result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::LICENSE_OK);
}

BOOST_AUTO_TEST_CASE(version_limits_accept_exact_boundaries) {
	vector<string> extraArgs;
	extraArgs.push_back("--start-version");
	extraArgs.push_back("1.2.0");
	extraArgs.push_back("--end-version");
	extraArgs.push_back("1.4.0");
	const fs::path licLocation = fs::path(generate_license("version_exact_boundaries", extraArgs));
	const string licLocationStr = licLocation.string();

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocationStr.begin(), licLocationStr.end(), location.licenseData);

	CallerInformations callInfo = caller_for_version("1.2.0");
	LCC_EVENT_TYPE result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::LICENSE_OK);

	callInfo = caller_for_version("1.4.0");
	result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::LICENSE_OK);
}

BOOST_AUTO_TEST_CASE(version_limits_reject_version_before_range) {
	vector<string> extraArgs;
	extraArgs.push_back("--start-version");
	extraArgs.push_back("1.2.0");
	const fs::path licLocation = fs::path(generate_license("version_before_range", extraArgs));
	const string licLocationStr = licLocation.string();

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocationStr.begin(), licLocationStr.end(), location.licenseData);
	CallerInformations callInfo = caller_for_version("1.1.9");
	const LCC_EVENT_TYPE result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::PRODUCT_NOT_LICENSED);
	BOOST_CHECK_MESSAGE(error_summary(license).find("Version before 1.2.0") != string::npos,
						"version-before diagnostic is visible: " + error_summary(license));
}

BOOST_AUTO_TEST_CASE(version_limits_reject_version_after_range) {
	vector<string> extraArgs;
	extraArgs.push_back("--end-version");
	extraArgs.push_back("2.0.0");
	const fs::path licLocation = fs::path(generate_license("version_after_range", extraArgs));
	const string licLocationStr = licLocation.string();

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocationStr.begin(), licLocationStr.end(), location.licenseData);
	CallerInformations callInfo = caller_for_version("2.0.1");
	const LCC_EVENT_TYPE result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::PRODUCT_NOT_LICENSED);
	BOOST_CHECK_MESSAGE(error_summary(license).find("Version after 2.0.0") != string::npos,
						"version-after diagnostic is visible: " + error_summary(license));
}

BOOST_AUTO_TEST_CASE(version_limits_reject_missing_caller_version) {
	vector<string> extraArgs;
	extraArgs.push_back("--start-version");
	extraArgs.push_back("1.2.0");
	const fs::path licLocation = fs::path(generate_license("version_missing_caller", extraArgs));
	const string licLocationStr = licLocation.string();

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocationStr.begin(), licLocationStr.end(), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::PRODUCT_NOT_LICENSED);
	BOOST_CHECK_MESSAGE(error_summary(license).find("Caller version not provided") != string::npos,
						"missing-version diagnostic is visible: " + error_summary(license));
}

BOOST_AUTO_TEST_CASE(version_limits_reject_malformed_caller_version) {
	vector<string> extraArgs;
	extraArgs.push_back("--start-version");
	extraArgs.push_back("1.2.0");
	const fs::path licLocation = fs::path(generate_license("version_malformed_caller", extraArgs));
	const string licLocationStr = licLocation.string();

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocationStr.begin(), licLocationStr.end(), location.licenseData);
	CallerInformations callInfo = caller_for_version("1.bad");
	const LCC_EVENT_TYPE result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LCC_EVENT_TYPE::PRODUCT_NOT_LICENSED);
	BOOST_CHECK_MESSAGE(error_summary(license).find("Caller version malformed") != string::npos,
						"malformed-version diagnostic is visible: " + error_summary(license));

	callInfo = caller_for_version("1.");
	const LCC_EVENT_TYPE trailing_dot_result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(trailing_dot_result, LCC_EVENT_TYPE::PRODUCT_NOT_LICENSED);
	BOOST_CHECK_MESSAGE(error_summary(license).find("Caller version malformed") != string::npos,
						"trailing-dot diagnostic is visible: " + error_summary(license));
}

//
// BOOST_AUTO_TEST_CASE( hw_identifier ) {
//	const string licLocation(PROJECT_TEST_TEMP_DIR "/hw_identifier.lic");
//	const vector<string> extraArgs = { "-s", "Jaaa-aaaa-MG9F-ZhB1" };
//	generate_license(licLocation, extraArgs);
//
//	LicenseInfo license;
//	LicenseLocation licenseLocation;
//	licenseLocation.licenseFileLocation = licLocation.c_str();
//	licenseLocation.licenseData = "";
//	const EVENT_TYPE result = acquire_license("TEST", &licenseLocation,
//			&license);
//	BOOST_CHECK_EQUAL(result, IDENTIFIERS_MISMATCH);
//	BOOST_CHECK_EQUAL(license.has_expiry, false);
//	BOOST_CHECK_EQUAL(license.linked_to_pc, true);
//}
}  // namespace test
}  // namespace license
