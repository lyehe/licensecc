
#define BOOST_TEST_MODULE standard_license_test

#include <boost/test/unit_test.hpp>
#include <boost/filesystem.hpp>

#include <licensecc/licensecc.h>
#include <licensecc_properties_test.h>
#include <licensecc_properties.h>
#include <algorithm>
#include <iostream>
#include <fstream>
#include <cstring>
#include <utility>
#include "../../src/library/ini/SimpleIni.h"
#include "../../src/library/base/base.h"
#include "../../src/library/base/base64.h"
#include "generate-license.h"
#include "../../src/library/base/file_utils.hpp"
#include "../../src/library/locate/LocatorFactory.hpp"
#include "../../src/library/os/os.h"
#include "../../src/library/base/string_utils.h"

namespace license {
namespace test {
namespace fs = boost::filesystem;
using namespace license;
using namespace std;

static void replace_in_file(const string& file_path, const string& from, const string& to) {
	string content = get_file_contents(file_path.c_str(), 65536);
	const size_t pos = content.find(from);
	BOOST_REQUIRE_MESSAGE(pos != string::npos, "Expected license text not found: " + from);
	content.replace(pos, from.size(), to);
	ofstream out(file_path.c_str(), ios::binary | ios::trunc);
	BOOST_REQUIRE_MESSAGE(out.is_open(), "Can open license for tampering: " + file_path);
	out << content;
}

static string default_feature_name() {
	return toupper_copy(trim_copy(LCC_PROJECT_NAME));
}

static void write_file(const string& file_path, const string& content) {
	ofstream out(file_path.c_str(), ios::binary | ios::trunc);
	BOOST_REQUIRE_MESSAGE(out.is_open(), "Can write license: " + file_path);
	out << content;
}

static string read_license_file(const string& file_path) {
	return get_file_contents(file_path.c_str(), 65536);
}

static string suffix_to_exceed_license_limit(const string& current_content, const string& tamper) {
	const size_t target_size = static_cast<size_t>(LCC_API_MAX_LICENSE_DATA_LENGTH) + 1;
	BOOST_REQUIRE_LE(current_content.size() + tamper.size(), target_size);
	return tamper + string(target_size - current_content.size() - tamper.size(), 'A');
}

static string write_signed_extra_data_license(const string& license_name, const string& extra_data) {
	const string license_version = to_string(LCC_LICENSE_FORMAT_VERSION);
	const string signature_payload =
		default_feature_name() + PARAM_EXTRA_DATA + extra_data + LICENSE_VERSION + license_version;
	const string signature = sign_data(signature_payload, license_name + "_signature");
	const fs::path licenses_base(LCC_LICENSES_BASE);
	if (!fs::exists(licenses_base)) {
		BOOST_REQUIRE_MESSAGE(fs::create_directories(licenses_base), "test folders created " + licenses_base.string());
	}
	const fs::path license_path(licenses_base / (license_name + ".lic"));
	ofstream out(license_path.string().c_str(), ios::binary | ios::trunc);
	BOOST_REQUIRE_MESSAGE(out.is_open(), "Can write signed extra-data license");
	out << "[" << default_feature_name() << "]\n";
	out << LICENSE_VERSION << " = " << license_version << "\n";
	out << PARAM_EXTRA_DATA << " = " << extra_data << "\n";
	out << LICENSE_SIGNATURE << " = " << signature << "\n";
	return license_path.string();
}

static void append_to_file(const string& file_path, const string& suffix) {
	ofstream out(file_path.c_str(), ios::binary | ios::app);
	BOOST_REQUIRE_MESSAGE(out.is_open(), "Can open license for tampering: " + file_path);
	out << suffix;
}

static string remove_line_starting_with(string content, const string& prefix) {
	size_t line_start = 0;
	while (line_start < content.size()) {
		const size_t line_end = content.find('\n', line_start);
		const size_t line_size = line_end == string::npos ? string::npos : line_end - line_start + 1;
		if (content.compare(line_start, prefix.size(), prefix) == 0) {
			content.erase(line_start, line_size);
			return content;
		}
		if (line_end == string::npos) {
			break;
		}
		line_start = line_end + 1;
	}
	BOOST_FAIL("Expected license line not found: " + prefix);
	return content;
}

static string replace_line_starting_with(string content, const string& prefix, const string& replacement) {
	size_t line_start = 0;
	while (line_start < content.size()) {
		const size_t line_end = content.find('\n', line_start);
		const size_t line_size = line_end == string::npos ? content.size() - line_start : line_end - line_start;
		if (content.compare(line_start, prefix.size(), prefix) == 0) {
			content.replace(line_start, line_size, replacement);
			return content;
		}
		if (line_end == string::npos) {
			break;
		}
		line_start = line_end + 1;
	}
	BOOST_FAIL("Expected license line not found: " + prefix);
	return content;
}

static LCC_EVENT_TYPE acquire_from_path(const string& licLocation) {
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	return acquire_license(nullptr, &location, &license);
}

static LCC_EVENT_TYPE acquire_from_plain_data(const string& license_data) {
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PLAIN_DATA};
	std::copy(license_data.begin(), license_data.end(), location.licenseData);
	return acquire_license(nullptr, &location, &license);
}

static LCC_EVENT_TYPE acquire_from_encoded_data(const string& license_data) {
	const string encoded = base64(license_data.data(), license_data.size());
	LicenseInfo license;
	LicenseLocation location = {LICENSE_ENCODED};
	std::copy(encoded.begin(), encoded.end(), location.licenseData);
	return acquire_license(nullptr, &location, &license);
}

static LCC_EVENT_TYPE acquire_from_plain_data_no_throw(const string& license_data) {
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PLAIN_DATA};
	std::copy(license_data.begin(), license_data.end(), location.licenseData);
	LCC_EVENT_TYPE result = LICENSE_OK;
	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &license));
	return result;
}

static bool has_status_event(const LicenseInfo& license, LCC_EVENT_TYPE event_type, LCC_SEVERITY severity) {
	for (int i = 0; i < LCC_API_AUDIT_EVENT_NUM; ++i) {
		if (license.status[i].event_type == event_type && license.status[i].severity == severity) {
			return true;
		}
	}
	return false;
}

static string client_signature_for(vector<uint8_t> decoded) {
	string signature = base64(decoded.data(), decoded.size(), 5);
	replace(signature.begin(), signature.end(), '\n', '-');
	if (!signature.empty() && signature.back() == '-') {
		signature.pop_back();
	}
	return signature;
}

static string valid_client_signature() {
	return client_signature_for({0x00, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string alternate_valid_client_signature() {
	return client_signature_for({0x00, 0x40, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48});
}

/**
 * Test a generic license, passing a bad license number trough the api.
 * see projects/DEFAULT/include/licensecc/DEFAULT/licensecc_properties.h (magic should be 0)
 */
BOOST_AUTO_TEST_CASE(test_bad_magic_number) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("standard_license", extraArgs);
	/* */
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	// magic should be 0 for this build...
	CallerInformations callInfo{{0}, {0}, 42};
	const LCC_EVENT_TYPE result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_CORRUPTED);
}

BOOST_AUTO_TEST_CASE(test_reject_canonical_key_split_tamper) {
	vector<string> extraArgs;
	extraArgs.push_back("-e");
	extraArgs.push_back("2050-10-10");
	const string licLocation = generate_license("split_expiry_tamper", extraArgs);
	replace_in_file(licLocation, "valid-to = 2050-10-10", "valid = -to2050-10-10");

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_reject_unknown_license_key) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("unknown_key_tamper", extraArgs);
	append_to_file(licLocation, "\nunknown-key = value\n");

	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_reject_uppercase_license_key) {
	vector<string> extraArgs;
	extraArgs.push_back("-e");
	extraArgs.push_back("2050-10-10");
	const string licLocation = generate_license("uppercase_key_tamper", extraArgs);
	replace_in_file(licLocation, "valid-to = 2050-10-10", "Valid-to = 2050-10-10");

	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_reject_missing_empty_and_duplicate_signature) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("signature_shape_tamper", extraArgs);
	const string original = read_license_file(licLocation);

	write_file(licLocation, remove_line_starting_with(original, string(LICENSE_SIGNATURE) + " = "));
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);

	write_file(licLocation, replace_line_starting_with(original, string(LICENSE_SIGNATURE) + " = ",
													  string(LICENSE_SIGNATURE) + " = "));
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);

	write_file(licLocation, original + "\n" + LICENSE_SIGNATURE + " = " + "AAAA\n");
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_reject_invalid_signature_base64) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("invalid_signature_base64_tamper", extraArgs);
	const string original = read_license_file(licLocation);

	write_file(licLocation, replace_line_starting_with(original, string(LICENSE_SIGNATURE) + " = ",
													  string(LICENSE_SIGNATURE) + " = !!!!"));
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_reject_malformed_license_version) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("malformed_license_version_tamper", extraArgs);
	replace_in_file(licLocation, "lic_ver = 200", "lic_ver = not-a-version");

	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_reject_noncanonical_license_version_values) {
	const vector<pair<string, string>> replacements = {{"noncanonical_license_version_octal", "lic_ver = 0200"},
													  {"noncanonical_license_version_plus", "lic_ver = +200"},
													  {"noncanonical_license_version_suffix", "lic_ver = 200x"},
													  {"noncanonical_license_version_leading_space", "lic_ver =  200"},
													  {"noncanonical_license_version_trailing_space", "lic_ver = 200 "}};
	for (const auto& replacement : replacements) {
		const vector<string> extraArgs;
		const string licLocation = generate_license(replacement.first, extraArgs);
		replace_in_file(licLocation, "lic_ver = 200", replacement.second);
		BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);
	}
}

BOOST_AUTO_TEST_CASE(test_reject_unsupported_license_version) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("unsupported_license_version_tamper", extraArgs);
	replace_in_file(licLocation, "lic_ver = 200", "lic_ver = 201");

	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_reject_duplicate_license_key) {
	vector<string> extraArgs;
	extraArgs.push_back("-e");
	extraArgs.push_back("2050-10-10");
	const string licLocation = generate_license("duplicate_expiry_tamper", extraArgs);
	append_to_file(licLocation, "\nvalid-to = 2050-10-10\n");

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_reject_malformed_date_without_throwing) {
	vector<string> extraArgs;
	extraArgs.push_back("-e");
	extraArgs.push_back("2050-10-10");
	const string licLocation = generate_license("malformed_date_tamper", extraArgs);
	replace_in_file(licLocation, "valid-to = 2050-10-10", "valid-to = not-a-date");

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_reject_noncanonical_or_impossible_date_values) {
	const vector<pair<string, string>> replacements = {{"noncanonical_date_compact", "valid-to = 20501010"},
													  {"noncanonical_date_slash", "valid-to = 2050/10/10"},
													  {"impossible_date_normalized", "valid-to = 2050-02-30"},
													  {"impossible_date_zero_day", "valid-to = 2050-10-00"},
													  {"malformed_date_suffix", "valid-to = 2050-10-10x"},
													  {"noncanonical_date_leading_space", "valid-to =  2050-10-10"},
													  {"noncanonical_date_trailing_space", "valid-to = 2050-10-10 "}};
	for (const auto& replacement : replacements) {
		vector<string> extraArgs;
		extraArgs.push_back("-e");
		extraArgs.push_back("2050-10-10");
		const string licLocation = generate_license(replacement.first, extraArgs);
		replace_in_file(licLocation, "valid-to = 2050-10-10", replacement.second);
		BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);
	}
}

BOOST_AUTO_TEST_CASE(test_reject_valid_date_field_mutations) {
	vector<string> extraArgs;
	extraArgs.push_back("--valid-from");
	extraArgs.push_back("2020-01-01");
	extraArgs.push_back("-e");
	extraArgs.push_back("2050-10-10");
	const string licLocation = generate_license("valid_date_field_mutation", extraArgs);
	const string original = read_license_file(licLocation);

	write_file(licLocation, replace_line_starting_with(original, "valid-from = ",
													  "valid-from = 2020-01-02"));
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_CORRUPTED);

	write_file(licLocation, replace_line_starting_with(original, "valid-to = ", "valid-to = 2050-10-11"));
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_CORRUPTED);
}

BOOST_AUTO_TEST_CASE(test_reject_extra_data_mutation) {
	vector<string> extraArgs;
	extraArgs.push_back("-x");
	extraArgs.push_back("alpha");
	const string licLocation = generate_license("extra_data_tamper", extraArgs);
	replace_in_file(licLocation, "extra-data = alpha", "extra-data = bravo");

	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_CORRUPTED);
}

BOOST_AUTO_TEST_CASE(test_accept_max_length_signed_extra_data) {
	const string extra_data(LCC_API_PROPRIETARY_DATA_SIZE, 'x');
	const string licLocation = write_signed_extra_data_license("max_length_extra_data", extra_data);
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);

	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);

	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(string(license.proprietary_data), extra_data);
}

BOOST_AUTO_TEST_CASE(test_reject_signed_malformed_or_oversized_extra_data) {
	const vector<pair<string, string>> invalid_values = {
		{"empty_extra_data", ""},
		{"oversized_extra_data", string(LCC_API_PROPRIETARY_DATA_SIZE + 1, 'x')},
	};
	for (const auto& invalid_value : invalid_values) {
		BOOST_TEST_CONTEXT(invalid_value.first) {
			const string licLocation = write_signed_extra_data_license(invalid_value.first, invalid_value.second);
			LicenseInfo license;
			LicenseLocation location = {LICENSE_PATH};
			std::copy(licLocation.begin(), licLocation.end(), location.licenseData);

			const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);

			BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
			BOOST_CHECK_EQUAL(license.proprietary_data[0], '\0');
		}
	}
}

BOOST_AUTO_TEST_CASE(test_reject_feature_section_mutation) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("feature_section_tamper", extraArgs);
	replace_in_file(licLocation, string("[") + default_feature_name() + "]", "[FEATURE1]");

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	CallerInformations callInfo{};
	strcpy(callInfo.feature_name, "FEATURE1");
	callInfo.magic = 0;
	const LCC_EVENT_TYPE result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_CORRUPTED);
}

BOOST_AUTO_TEST_CASE(test_reject_version_bound_field_mutations) {
	vector<string> extraArgs;
	extraArgs.push_back("--start-version");
	extraArgs.push_back("1.2.0");
	extraArgs.push_back("--end-version");
	extraArgs.push_back("1.4.0");
	const string licLocation = generate_license("version_bound_field_mutation", extraArgs);
	const string original = read_license_file(licLocation);

	write_file(licLocation, replace_line_starting_with(original, "start-version = ",
													  "start-version = 1.2.1"));
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_CORRUPTED);

	write_file(licLocation, replace_line_starting_with(original, "end-version = ", "end-version = 1.4.1"));
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_CORRUPTED);
}

BOOST_AUTO_TEST_CASE(test_reject_client_signature_field_mutation) {
	const string client_signature = valid_client_signature();
	vector<string> extraArgs;
	extraArgs.push_back("-s");
	extraArgs.push_back(client_signature);
	const string licLocation = generate_license("client_signature_field_mutation", extraArgs);

	replace_in_file(licLocation, "client-signature = " + client_signature,
					"client-signature = " + alternate_valid_client_signature());
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_CORRUPTED);
}

BOOST_AUTO_TEST_CASE(test_reject_signature_byte_mutations) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("signature_byte_mutation", extraArgs);
	const string original = read_license_file(licLocation);

	write_file(licLocation, replace_line_starting_with(original, string(LICENSE_SIGNATURE) + " = ",
													  string(LICENSE_SIGNATURE) + " = AAAA"));
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_CORRUPTED);

	write_file(licLocation, replace_line_starting_with(original, string(LICENSE_SIGNATURE) + " = ",
													  string(LICENSE_SIGNATURE) + " = QUFBQUFBQUFB"));
	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_CORRUPTED);
}

BOOST_AUTO_TEST_CASE(test_plain_and_encoded_data_use_strict_validation) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("strict_external_data_tamper", extraArgs);
	const string tampered = read_license_file(licLocation) + "\nunknown-key = value\n";

	BOOST_CHECK_EQUAL(acquire_from_plain_data(tampered), LICENSE_MALFORMED);
	BOOST_CHECK_EQUAL(acquire_from_encoded_data(tampered), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_oversized_file_append_tamper_fails_closed) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("oversized_file_append_tamper", extraArgs);
	const string original = read_license_file(licLocation);
	const string tamper = "\n[" + string(LCC_PROJECT_NAME) + "]\nunknown-key = value\n";
	append_to_file(licLocation, suffix_to_exceed_license_limit(original, tamper));

	BOOST_CHECK_EQUAL(acquire_from_path(licLocation), LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_oversized_environment_data_append_tamper_fails_closed) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("oversized_environment_append_tamper", extraArgs);
	const string original = read_license_file(licLocation);
	const string tamper = "\n[" + string(LCC_PROJECT_NAME) + "]\nunknown-key = value\n";
	const string oversized = original + suffix_to_exceed_license_limit(original, tamper);

	SETENV(LCC_LICENSE_DATA_ENV_VAR, oversized.c_str());
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(true);
	LicenseInfo license;
	const LCC_EVENT_TYPE result = acquire_license(nullptr, nullptr, &license);

	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
	locate::LocatorFactory::find_license_with_env_var(FIND_LICENSE_WITH_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(test_full_explicit_plain_data_buffer_append_tamper_fails_closed) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("full_explicit_plain_data_append_tamper", extraArgs);
	const string validLicense = read_license_file(licLocation);

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PLAIN_DATA};
	BOOST_REQUIRE_LT(validLicense.size(), sizeof(location.licenseData));
	std::fill(location.licenseData, location.licenseData + sizeof(location.licenseData), 'A');
	std::copy(validLicense.begin(), validLicense.end(), location.licenseData);

	LCC_EVENT_TYPE result = LICENSE_OK;
	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &license));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_malformed_v200_shapes_return_malformed_without_throwing) {
	const string header = string("[") + LCC_PROJECT_NAME + "]\n";
	const vector<pair<string, string>> malformed_licenses = {
		{"unknown-key", header + "lic_ver = 200\nunknown-key = value\nsig = QUJDRA==\n"},
		{"uppercase-key", header + "lic_ver = 200\nSig = QUJDRA==\n"},
		{"duplicate-sig", header + "lic_ver = 200\nsig = QUJDRA==\nsig = QUJDRA==\n"},
		{"missing-sig", header + "lic_ver = 200\n"},
		{"empty-sig", header + "lic_ver = 200\nsig = \n"},
		{"invalid-base64-sig", header + "lic_ver = 200\nsig = !!!!\n"},
		{"bad-lic-ver", header + "lic_ver = +200\nsig = QUJDRA==\n"},
		{"duplicate-lic-ver", header + "lic_ver = 200\nlic_ver = 200\nsig = QUJDRA==\n"},
		{"duplicate-section", header + "lic_ver = 200\n[" + LCC_PROJECT_NAME + "]\nsig = QUJDRA==\n"},
		{"empty-key", header + "lic_ver = 200\n = value\nsig = QUJDRA==\n"},
		{"padded-key", header + " lic_ver = 200\nsig = QUJDRA==\n"},
		{"split-key", header + "lic = _ver200\nsig = QUJDRA==\n"},
		{"inline-comment", header + "lic_ver = 200 ; comment\nsig = QUJDRA==\n"},
		{"bad-date", header + "lic_ver = 200\nvalid-to = 2050-02-30\nsig = QUJDRA==\n"},
	};
	for (const auto& malformed : malformed_licenses) {
		BOOST_TEST_CONTEXT(malformed.first) {
			BOOST_CHECK_EQUAL(acquire_from_plain_data_no_throw(malformed.second), LICENSE_MALFORMED);
		}
	}
}

BOOST_AUTO_TEST_CASE(test_environment_data_uses_strict_validation) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("strict_environment_data_tamper", extraArgs);
	const string tampered = read_license_file(licLocation) + "\nunknown-key = value\n";

	SETENV(LCC_LICENSE_DATA_ENV_VAR, tampered.c_str());
	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(true);
	LicenseInfo license;
	const LCC_EVENT_TYPE result = acquire_license(nullptr, nullptr, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
	locate::LocatorFactory::find_license_with_env_var(FIND_LICENSE_WITH_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(test_environment_path_uses_strict_validation) {
	const vector<string> extraArgs;
	const string licLocation = generate_license("strict_environment_path_tamper", extraArgs);
	append_to_file(licLocation, "\nunknown-key = value\n");

	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	SETENV(LCC_LICENSE_LOCATION_ENV_VAR, licLocation.c_str());
	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(true);
	LicenseInfo license;
	const LCC_EVENT_TYPE result = acquire_license(nullptr, nullptr, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
	locate::LocatorFactory::find_license_with_env_var(FIND_LICENSE_WITH_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(test_valid_file_candidate_wins_with_malformed_file_warning) {
	const vector<string> extraArgs;
	const string validLicLocation = generate_license("multi_source_valid_file", extraArgs);
	const string malformedLicLocation = string(LCC_LICENSES_BASE) + "/multi_source_malformed_file.lic";
	write_file(malformedLicLocation, read_license_file(validLicLocation) + "\nunknown-key = value\n");

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	const string pathList = malformedLicLocation + ";" + validLicLocation;
	std::copy(pathList.begin(), pathList.end(), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);

	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK(has_status_event(license, LICENSE_MALFORMED, SVRT_WARN));
}

BOOST_AUTO_TEST_CASE(test_valid_external_candidate_wins_with_malformed_environment_warning) {
	const vector<string> extraArgs;
	const string validLicLocation = generate_license("multi_source_valid_external", extraArgs);
	const string validLicense = read_license_file(validLicLocation);

	SETENV(LCC_LICENSE_DATA_ENV_VAR, "!!!!");
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(true);
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PLAIN_DATA};
	std::copy(validLicense.begin(), validLicense.end(), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);

	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK(has_status_event(license, LICENSE_MALFORMED, SVRT_WARN));
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
	locate::LocatorFactory::find_license_with_env_var(FIND_LICENSE_WITH_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(test_valid_environment_candidate_wins_with_malformed_external_warning) {
	const vector<string> extraArgs;
	const string validLicLocation = generate_license("multi_source_valid_environment", extraArgs);
	const string validLicense = read_license_file(validLicLocation);

	SETENV(LCC_LICENSE_DATA_ENV_VAR, validLicense.c_str());
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(true);
	LicenseInfo license;
	LicenseLocation location = {LICENSE_PLAIN_DATA};
	const char malformed[] = "not ini";
	std::copy(malformed, malformed + strlen(malformed), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);

	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK(has_status_event(license, LICENSE_MALFORMED, SVRT_WARN));
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
	locate::LocatorFactory::find_license_with_env_var(FIND_LICENSE_WITH_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(test_reject_malformed_version_bound) {
	vector<string> extraArgs;
	extraArgs.push_back("--start-version");
	extraArgs.push_back("1.2.0");
	const string licLocation = generate_license("malformed_version_tamper", extraArgs);
	replace_in_file(licLocation, "start-version = 1.2.0", "start-version = 1.bad");

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	CallerInformations callInfo{};
	strcpy(callInfo.version, "1.2.0");
	callInfo.magic = 0;
	const LCC_EVENT_TYPE result = acquire_license(&callInfo, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(test_reject_signed_malformed_client_signature) {
	const string client_signature = "XXX-XXX-XXX";
	const string license_version = to_string(LCC_LICENSE_FORMAT_VERSION);
	const string signature_payload = default_feature_name() + PARAM_CLIENT_SIGNATURE + client_signature +
									 LICENSE_VERSION + license_version;
	const string signature = sign_data(signature_payload, "signed_malformed_client_signature");
	const fs::path licenses_base(LCC_LICENSES_BASE);
	if (!fs::exists(licenses_base)) {
		BOOST_REQUIRE_MESSAGE(fs::create_directories(licenses_base), "test folders created " + licenses_base.string());
	}
	const fs::path license_path(licenses_base / "signed_malformed_client_signature.lic");
	ofstream out(license_path.string().c_str(), ios::binary | ios::trunc);
	BOOST_REQUIRE_MESSAGE(out.is_open(), "Can write malformed client signature license");
	out << "[" << default_feature_name() << "]\n";
	out << LICENSE_VERSION << " = " << license_version << "\n";
	out << PARAM_CLIENT_SIGNATURE << " = " << client_signature << "\n";
	out << LICENSE_SIGNATURE << " = " << signature << "\n";
	out.close();

	LicenseInfo license;
	LicenseLocation location = {LICENSE_PATH};
	const string licLocation = license_path.string();
	std::copy(licLocation.begin(), licLocation.end(), location.licenseData);
	const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &license);
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
}

}  // namespace test
}  // namespace license
