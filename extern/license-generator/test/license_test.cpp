#define BOOST_TEST_MODULE test_license

#include <algorithm>
#include <boost/filesystem.hpp>
#include <boost/test/unit_test.hpp>
#include <boost/version.hpp>
#if (BOOST_VERSION > 107000)
#include <boost/test/tools/output_test_stream.hpp>
#else
#include <boost/test/output_test_stream.hpp>
#endif
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
#include <build_properties.h>

#include "../src/base_lib/base.h"
#include "../src/base_lib/base64.h"
#include "../src/ini/SimpleIni.h"
#include "../src/license_generator/license.hpp"
#include "cout_redirect.hpp"

namespace license {
namespace test {
namespace fs = boost::filesystem;
using namespace license;
using namespace std;

struct MyGlobalFixture {
	MyGlobalFixture() {}

	void setup() {
		BOOST_TEST_MESSAGE("setup temp project ");
		if (fs::exists(project_path)) {
			fs::remove_all(project_path);
		}
		bool ok = fs::create_directories(licenses_path);
		BOOST_REQUIRE_MESSAGE(ok, string("Error creating ") + licenses_path.string());
		fs::path pkf = fs::path(PROJECT_TEST_SRC_DIR) / "data" / PRIVATE_KEY_FNAME;
		fs::copy_file(pkf, project_path / PRIVATE_KEY_FNAME);
	}

	void teardown() {
		/*if (fs::exists(project_path)) {
			fs::remove_all(project_path);
		}*/
	}

	~MyGlobalFixture(){};
	const static fs::path project_path;
	const static fs::path licenses_path;
	const static string licenses_path_str;
};

const fs::path MyGlobalFixture::project_path(fs::path(fs::path(PROJECT_TEST_TEMP_DIR) / "test_project"));
const fs::path MyGlobalFixture::licenses_path(project_path / "licenses");
const std::string MyGlobalFixture::licenses_path_str(licenses_path.string());

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

static string ip_client_signature() {
	return client_signature_for({0x00, 0x20, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string unsupported_strategy_client_signature() {
	return client_signature_for({0x00, 0x60, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string env_selected_client_signature() {
	return client_signature_for({0x40, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string weak_disk_label_client_signature() {
	return client_signature_for({0x01, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string weak_disk_mutable_client_signature() {
	return client_signature_for({0x02, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string control_flag_client_signature(uint8_t control_flags) {
	return client_signature_for({control_flags, 0x40, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47});
}

static string read_binary_file(const fs::path &path) {
	ifstream in(path.string().c_str(), ios::binary);
	return string((istreambuf_iterator<char>(in)), istreambuf_iterator<char>());
}

static string normalize_newlines(const string &contents) {
	string normalized;
	for (size_t i = 0; i < contents.size(); ++i) {
		if (contents[i] == '\r' && i + 1U < contents.size() && contents[i + 1U] == '\n') {
			continue;
		}
		normalized.push_back(contents[i]);
	}
	return normalized;
}

static void request_v201(License& license) {
	license.add_parameter(PARAM_LICENSE_FORMAT_VERSION, "201");
	license.add_parameter(PARAM_TARGET_LICENSE_FORMAT_MAX, "201");
}

// this test is incompatible with older version of boost
#ifdef BOOST_TEST_GLOBAL_FIXTURE

BOOST_TEST_GLOBAL_FIXTURE(MyGlobalFixture);

/**
 * Test date normalization
 */
BOOST_AUTO_TEST_CASE(license_structure) {
	const fs::path licLocation = MyGlobalFixture::licenses_path / "test.lic";
	const string lic_location_str = licLocation.string();
	License license(&lic_location_str, MyGlobalFixture::project_path.string());
	license.add_parameter(PARAM_EXPIRY_DATE, "19290111");
	license.write_license();

	BOOST_REQUIRE_MESSAGE(fs::exists(licLocation), "license has been created");
	CSimpleIniA ini;
	ini.LoadFile(licLocation.c_str());
	BOOST_CHECK_MESSAGE(ini.GetSectionSize("TEST_PROJECT") == 3, "Section TEST_PROJECT has 3 elements");
	BOOST_CHECK_MESSAGE(string(ini.GetValue("TEST_PROJECT", PARAM_EXPIRY_DATE, "X")) == "1929-01-11",
						"Section TEST_PROJECT has expiry date");
	// std::cout << ini.GetValue("TEST_PROJECT", PARAM_EXPIRY_DATE, "X") << endl;
}

BOOST_AUTO_TEST_CASE(issue_warns_on_insecure_project_key) {
	// The test fixture project key is 1024-bit, so issuance must warn that the licensecc runtime
	// (which enforces a 3072-bit floor on both v200 and v201) will reject the resulting license.
	const fs::path licLocation = MyGlobalFixture::licenses_path / "insecure_warn.lic";
	const string lic_location_str = licLocation.string();
	boost::test_tools::output_test_stream captured;
	std::streambuf* old_cerr = std::cerr.rdbuf(captured.rdbuf());
	try {
		License license(&lic_location_str, MyGlobalFixture::project_path.string());
		license.write_license();
	} catch (...) {
		std::cerr.rdbuf(old_cerr);
		throw;
	}
	std::cerr.rdbuf(old_cerr);
	BOOST_CHECK_MESSAGE(captured.str().find("NOT verify") != string::npos,
						"insecure project-key issuance warning printed to stderr: " + captured.str());
}

BOOST_AUTO_TEST_CASE(legacy_v200_fixed_key_output_matches_characterization_fixture) {
	const fs::path licLocation = MyGlobalFixture::licenses_path / "legacy_v200_characterization.lic";
	const string lic_location_str = licLocation.string();
	const fs::path fixture = fs::path(PROJECT_TEST_SRC_DIR) / "data" / "v200" / "legacy_fixed_key.lic";
	License license(&lic_location_str, MyGlobalFixture::project_path.string());
	BOOST_CHECK_NO_THROW(license.add_parameter(PARAM_LICENSE_FORMAT_VERSION, "200"));
	BOOST_CHECK_NO_THROW(license.write_license());
	BOOST_REQUIRE_MESSAGE(fs::exists(fixture), "fixed-key v200 characterization fixture exists");
	// SimpleIni's historic serializer terminates a section with a blank line.
	// Keep that byte-level v200 quirk in the characterization without storing an
	// otherwise lint-hostile blank line at the end of the source fixture.
	const string expected = normalize_newlines(read_binary_file(fixture)) + "\n";
	BOOST_CHECK_EQUAL(normalize_newlines(read_binary_file(licLocation)), expected);
}

BOOST_AUTO_TEST_CASE(legacy_v200_keeps_historical_input_normalization) {
	const fs::path licLocation = MyGlobalFixture::licenses_path / "legacy_v200_input_compatibility.lic";
	const string lic_location_str = licLocation.string();
	License license(&lic_location_str, MyGlobalFixture::project_path.string());
	license.add_parameter(PARAM_EXPIRY_DATE, "2020-02-30");
	license.add_parameter(PARAM_VERSION_FROM, "1..2");
	license.add_parameter(PARAM_CLIENT_SIGNATURE, "legacy-client-signature");
	BOOST_CHECK_NO_THROW(license.write_license());
	CSimpleIniA ini;
	BOOST_REQUIRE_EQUAL(ini.LoadFile(licLocation.c_str()), SI_Error::SI_OK);
	BOOST_CHECK_EQUAL(string(ini.GetValue("TEST_PROJECT", PARAM_EXPIRY_DATE, "")), "2020-02-30");
	BOOST_CHECK_EQUAL(string(ini.GetValue("TEST_PROJECT", PARAM_VERSION_FROM, "")), "1..2");
	BOOST_CHECK_EQUAL(string(ini.GetValue("TEST_PROJECT", PARAM_CLIENT_SIGNATURE, "")), "legacy-client-signature");
}

BOOST_AUTO_TEST_CASE(legacy_v200_appends_noncanonical_existing_fixture) {
	const fs::path licLocation = MyGlobalFixture::licenses_path / "legacy_v200_append.lic";
	const string lic_location_str = licLocation.string();
	const fs::path fixture = fs::path(PROJECT_TEST_SRC_DIR) / "data" / "v200" / "legacy_append_noncanonical.lic";
	fs::copy_file(fixture, licLocation);

	// Pin 0227 loaded this file as generic INI and appended a newly signed
	// section.  In particular it did not reject the safe-but-noncanonical
	// legacy section, custom key, or old signature encoding.
	License license(&lic_location_str, MyGlobalFixture::project_path.string());
	license.add_parameter(PARAM_FEATURE_NAMES, "new-feature");
	BOOST_CHECK_NO_THROW(license.write_license());

	const string written = read_binary_file(licLocation);
	BOOST_CHECK_MESSAGE(written.find("[legacy.feature]") != string::npos,
						"legacy section casing/punctuation is retained");
	BOOST_CHECK_MESSAGE(written.find("legacy-custom-key = preserve-me") != string::npos,
						"legacy custom field is retained");
	BOOST_CHECK_MESSAGE(written.find("[NEW-FEATURE]") != string::npos,
						"new v200 section is appended using historical normalization");
}

BOOST_AUTO_TEST_CASE(v201_refuses_weak_fixed_key_without_mutating_output) {
	const fs::path licLocation = MyGlobalFixture::licenses_path / "v201_weak_key.lic";
	const string lic_location_str = licLocation.string();
	fs::remove(licLocation);
	// Seed a valid legacy file, so the failure also proves that v201 refusal
	// cannot truncate a previously issued license.
	License legacy(&lic_location_str, MyGlobalFixture::project_path.string());
	legacy.write_license();
	const string before = read_binary_file(licLocation);
	License license(&lic_location_str, MyGlobalFixture::project_path.string());
	license.add_parameter(PARAM_LICENSE_FORMAT_VERSION, "201");
	license.add_parameter(PARAM_TARGET_LICENSE_FORMAT_MAX, "201");
	try {
		license.write_license();
		BOOST_FAIL("weak v201 issuance unexpectedly succeeded");
	} catch (const runtime_error& ex) {
		BOOST_CHECK_MESSAGE(string(ex.what()).find("will not be rotated automatically") != string::npos,
						string("weak v201 diagnostic explains migration: ") + ex.what());
	}
	BOOST_CHECK_EQUAL(read_binary_file(licLocation), before);
}

BOOST_AUTO_TEST_CASE(generate_license_subdir) {
	const fs::path licLocation = MyGlobalFixture::licenses_path / "test_folder" / "test.lic";
	const string lic_location_str = licLocation.string();
	License license(&lic_location_str, MyGlobalFixture::project_path.string());
	license.add_parameter(PARAM_EXPIRY_DATE, "1929-11-11");
	license.write_license();

	BOOST_CHECK_MESSAGE(fs::exists(licLocation), "license has been created");
}

BOOST_AUTO_TEST_CASE(generate_license_with_relative_path) {
	const fs::path license_rel_path = fs::path("license.lic");
	const string license_rel_path_str = license_rel_path.string();
	License license(&license_rel_path_str, MyGlobalFixture::project_path.string());
	license.add_parameter(PARAM_FEATURE_NAMES, "my_fantastic_softwAre");
	license.write_license();
	BOOST_REQUIRE_MESSAGE(fs::exists(license_rel_path), "license has been created");
}

BOOST_AUTO_TEST_CASE(license_stdout) {
	boost::test_tools::output_test_stream output;
	{
		cout_redirect guard(output.rdbuf());

		License license(nullptr, MyGlobalFixture::project_path.string());
		license.add_parameter(PARAM_FEATURE_NAMES, "my_fantastic_softwAre");
		license.write_license();
	}
	string stdout_str = output.str();
	BOOST_CHECK_MESSAGE(stdout_str.find("[MY_FANTASTIC_SOFTWARE]") != string::npos,
						"license has been written to stdout " + stdout_str);
}

BOOST_AUTO_TEST_CASE(generate_base64_license_output) {
	const fs::path licFile = MyGlobalFixture::licenses_path / "base64_direct.lic";
	const string lic_location_str = licFile.string();
	License license(&lic_location_str, MyGlobalFixture::project_path.string(), true);
	license.add_parameter(PARAM_FEATURE_NAMES, "my_fantastic_softwAre");
	license.write_license();
	BOOST_REQUIRE_MESSAGE(fs::exists(licFile), "license has been created");

	const string encoded = read_binary_file(licFile);
	BOOST_CHECK_MESSAGE(encoded.find("[MY_FANTASTIC_SOFTWARE]") == string::npos,
						"base64 output must not contain plain INI sections");
	const vector<uint8_t> decoded_bytes = unbase64(encoded);
	BOOST_REQUIRE_MESSAGE(!decoded_bytes.empty(), "base64 output decodes");
	const string decoded(reinterpret_cast<const char *>(decoded_bytes.data()), decoded_bytes.size());
	CSimpleIniA ini;
	BOOST_REQUIRE_EQUAL(ini.LoadData(decoded), SI_Error::SI_OK);
	BOOST_CHECK_MESSAGE(ini.GetSectionSize("MY_FANTASTIC_SOFTWARE") == 2,
						"Decoded section [MY_FANTASTIC_SOFTWARE] has 2 elements");
}

BOOST_AUTO_TEST_CASE(base64_license_stdout) {
	boost::test_tools::output_test_stream output;
	{
		cout_redirect guard(output.rdbuf());

		License license(nullptr, MyGlobalFixture::project_path.string(), true);
		license.add_parameter(PARAM_FEATURE_NAMES, "my_fantastic_softwAre");
		license.write_license();
	}
	const string encoded = output.str();
	BOOST_CHECK_MESSAGE(encoded.find("[MY_FANTASTIC_SOFTWARE]") == string::npos,
						"base64 stdout must not contain plain INI sections");
	const vector<uint8_t> decoded_bytes = unbase64(encoded);
	BOOST_REQUIRE_MESSAGE(!decoded_bytes.empty(), "base64 stdout decodes");
	const string decoded(reinterpret_cast<const char *>(decoded_bytes.data()), decoded_bytes.size());
	BOOST_CHECK_MESSAGE(decoded.find("[MY_FANTASTIC_SOFTWARE]") != string::npos,
						"decoded stdout contains the license section");
}

BOOST_AUTO_TEST_CASE(generate_license_features) {
	const fs::path licFile = MyGlobalFixture::licenses_path / "myclient2.lic";
	const string lic_location_str = licFile.string();
	License license(&lic_location_str, MyGlobalFixture::project_path.string());
	license.add_parameter(PARAM_FEATURE_NAMES, "my_fantastic_softwAre,another_feature");
	license.write_license();
	BOOST_REQUIRE_MESSAGE(fs::exists(licFile), "license has been created");
	CSimpleIniA ini;
	ini.LoadFile(licFile.c_str());
	BOOST_CHECK_MESSAGE(ini.GetSectionSize("MY_FANTASTIC_SOFTWARE") == 2,
						"Section [MY_FANTASTIC_SOFTWARE] has 2 elements");
	BOOST_CHECK_MESSAGE(ini.GetSectionSize("ANOTHER_FEATURE") == 2, "Section [ANOTHER_FEATURE] has 2 elements");
}

BOOST_AUTO_TEST_CASE(validate_feature_names) {
	License valid(nullptr, MyGlobalFixture::project_path.string());
	request_v201(valid);
	BOOST_CHECK_NO_THROW(valid.add_parameter(PARAM_FEATURE_NAMES, "Feature_1,feature-2,feature.3"));

	const vector<string> invalid_feature_lists = {"", "feature,", ",feature", "feature,,other", "feature name",
											  "feature\nname", "feature,FEATURE"};
	for (const string &feature_list : invalid_feature_lists) {
		License license(nullptr, MyGlobalFixture::project_path.string());
		request_v201(license);
		license.add_parameter(PARAM_FEATURE_NAMES, feature_list);
		BOOST_CHECK_THROW(license.write_license(), invalid_argument);
	}
	for (const string &feature_list : {string("feature/name"), string("feature\\name"), string("feature[name]")}) {
		License license(nullptr, MyGlobalFixture::project_path.string());
		BOOST_CHECK_THROW(license.add_parameter(PARAM_FEATURE_NAMES, feature_list), invalid_argument);
	}
}

BOOST_AUTO_TEST_CASE(extend_license) {
	const fs::path licFile = MyGlobalFixture::licenses_path / "myclient.lic";
	const string lic_location_str = licFile.string();
	License license(&lic_location_str, MyGlobalFixture::project_path.string());
	license.add_parameter(PARAM_EXPIRY_DATE, "1929-11-11");
	const string client_signature = valid_client_signature();
	license.add_parameter(PARAM_CLIENT_SIGNATURE, client_signature);
	license.write_license();
	BOOST_REQUIRE_MESSAGE(fs::exists(licFile), "license has been created");
	CSimpleIniA ini;
	ini.LoadFile(licFile.c_str());
	BOOST_CHECK_MESSAGE(string(ini.GetValue("TEST_PROJECT", PARAM_EXPIRY_DATE)) == "1929-11-11", "Date was written");

	License license_renew(&lic_location_str, MyGlobalFixture::project_path.string());
	const string new_date("2020-05-01");
	license_renew.add_parameter(PARAM_EXPIRY_DATE, new_date.c_str());
	license_renew.write_license();
	ini.Reset();
	ini.LoadFile(licFile.c_str());
	BOOST_CHECK_MESSAGE(ini.GetValue("TEST_PROJECT", PARAM_EXPIRY_DATE) == new_date, "license extended");
	BOOST_CHECK_MESSAGE(ini.GetValue("TEST_PROJECT", PARAM_CLIENT_SIGNATURE) == client_signature, "license extended");
}

BOOST_AUTO_TEST_CASE(reject_malformed_client_signature) {
	const vector<string> malformed = {"XXX-XXX-XXX", "", "AEBCQ0RFRkc=", "AEBC-Q0RF-Rkc=-", "AE=C-Q0RF-Rkc=",
									  "A!BC-Q0RF-Rkc=", string("AEBC-Q0RF-Rkc=\n")};
	for (const string &value : malformed) {
		License license(nullptr, MyGlobalFixture::project_path.string());
		request_v201(license);
		license.add_parameter(PARAM_CLIENT_SIGNATURE, value);
		BOOST_CHECK_THROW(license.write_license(), invalid_argument);
	}
}

BOOST_AUTO_TEST_CASE(reject_invalid_client_signature_semantics) {
	const vector<string> invalid = {unsupported_strategy_client_signature(), env_selected_client_signature(),
									 ip_client_signature(), weak_disk_label_client_signature(), weak_disk_mutable_client_signature()};
	for (const string &value : invalid) {
		License license(nullptr, MyGlobalFixture::project_path.string());
		request_v201(license);
		license.add_parameter(PARAM_CLIENT_SIGNATURE, value);
		BOOST_CHECK_THROW(license.write_license(), invalid_argument);
	}
	const vector<uint8_t> invalid_control_flags = {0x01, 0x02, 0x03, 0x3f, 0x80, 0xc0};
	for (const uint8_t control_flags : invalid_control_flags) {
		License license(nullptr, MyGlobalFixture::project_path.string());
		request_v201(license);
		license.add_parameter(PARAM_CLIENT_SIGNATURE, control_flag_client_signature(control_flags));
		BOOST_CHECK_THROW(license.write_license(), invalid_argument);
	}

	License env_opt_in_license(nullptr, MyGlobalFixture::project_path.string());
	request_v201(env_opt_in_license);
	env_opt_in_license.set_allow_env_selected_binding(true);
	env_opt_in_license.add_parameter(PARAM_CLIENT_SIGNATURE, control_flag_client_signature(0xc0));
	BOOST_CHECK_THROW(env_opt_in_license.write_license(), invalid_argument);

	License valid(nullptr, MyGlobalFixture::project_path.string());
	request_v201(valid);
	BOOST_CHECK_NO_THROW(valid.add_parameter(PARAM_CLIENT_SIGNATURE, valid_client_signature()));
}

BOOST_AUTO_TEST_CASE(weak_client_signature_modes_require_opt_in) {
	License ip_license(nullptr, MyGlobalFixture::project_path.string());
	request_v201(ip_license);
	ip_license.set_allow_ip_binding(true);
	ip_license.add_parameter(PARAM_CLIENT_SIGNATURE, ip_client_signature());
	BOOST_CHECK_THROW(ip_license.write_license(), runtime_error);

	License env_license(nullptr, MyGlobalFixture::project_path.string());
	request_v201(env_license);
	env_license.set_allow_env_selected_binding(true);
	env_license.add_parameter(PARAM_CLIENT_SIGNATURE, env_selected_client_signature());
	BOOST_CHECK_THROW(env_license.write_license(), runtime_error);

	License weak_disk_label_license(nullptr, MyGlobalFixture::project_path.string());
	request_v201(weak_disk_label_license);
	weak_disk_label_license.set_allow_weak_disk_label_binding(true);
	weak_disk_label_license.add_parameter(PARAM_CLIENT_SIGNATURE, weak_disk_label_client_signature());
	BOOST_CHECK_THROW(weak_disk_label_license.write_license(), runtime_error);
	weak_disk_label_license.add_parameter(PARAM_CLIENT_SIGNATURE, weak_disk_mutable_client_signature());
	BOOST_CHECK_THROW(weak_disk_label_license.write_license(), runtime_error);
}

BOOST_AUTO_TEST_CASE(reject_unknown_license_output_parameters) {
	License license(nullptr, MyGlobalFixture::project_path.string());
	BOOST_CHECK_THROW(license.add_parameter("unknown-key", "value"), invalid_argument);
	BOOST_CHECK_THROW(license.add_parameter("custom-date", "2020-01-01"), invalid_argument);
	BOOST_CHECK_THROW(license.add_parameter("custom-version", "1.2.3"), invalid_argument);
}

BOOST_AUTO_TEST_CASE(validate_extra_data_parameter) {
	License valid(nullptr, MyGlobalFixture::project_path.string());
	request_v201(valid);
	BOOST_CHECK_NO_THROW(valid.add_parameter(PARAM_EXTRA_DATA, "printable 123"));
	License max_length(nullptr, MyGlobalFixture::project_path.string());
	request_v201(max_length);
	BOOST_CHECK_NO_THROW(max_length.add_parameter(PARAM_EXTRA_DATA, string(LCC_API_PROPRIETARY_DATA_SIZE, 'x')));

	const vector<string> invalid_values = {"", " leading", "trailing ", "line\nbreak", "tab\tvalue",
										   string(LCC_API_PROPRIETARY_DATA_SIZE + 1, 'x')};
	for (const string &value : invalid_values) {
		License license(nullptr, MyGlobalFixture::project_path.string());
		request_v201(license);
		license.add_parameter(PARAM_EXTRA_DATA, value);
		BOOST_CHECK_THROW(license.write_license(), invalid_argument);
	}
}

BOOST_AUTO_TEST_CASE(validate_custom_limit_parameter) {
	License valid(nullptr, MyGlobalFixture::project_path.string());
	request_v201(valid);
	BOOST_CHECK_NO_THROW(valid.add_parameter(PARAM_CUSTOM_LIMIT, "cpu-max-8_memory-mib-max-4096"));

	License legacy(nullptr, MyGlobalFixture::project_path.string());
	legacy.add_parameter(PARAM_CUSTOM_LIMIT, "cpu-max-8");
	BOOST_CHECK_THROW(legacy.write_license(), invalid_argument);

	const vector<string> invalid_values = {"", " leading", "trailing ", "line\nbreak", "tab\tvalue",
									   string(LCC_API_CUSTOM_LIMIT_SIZE + 1, 'x')};
	for (const string &value : invalid_values) {
		License license(nullptr, MyGlobalFixture::project_path.string());
		request_v201(license);
		license.add_parameter(PARAM_CUSTOM_LIMIT, value);
		BOOST_CHECK_THROW(license.write_license(), invalid_argument);
	}
}

BOOST_AUTO_TEST_CASE(validate_version_limit_parameters) {
	const vector<string> invalid_versions = {"", "1..2", "1.2.3.4", "12345", "1.abc", ".1", "1."};
	for (const string &version : invalid_versions) {
		License license(nullptr, MyGlobalFixture::project_path.string());
		request_v201(license);
		license.add_parameter(PARAM_VERSION_FROM, version);
		BOOST_CHECK_THROW(license.write_license(), invalid_argument);
	}

	License valid_range(nullptr, MyGlobalFixture::project_path.string());
	request_v201(valid_range);
	BOOST_CHECK_NO_THROW(valid_range.add_parameter(PARAM_VERSION_FROM, "1.2"));
	BOOST_CHECK_NO_THROW(valid_range.add_parameter(PARAM_VERSION_TO, "1.2.0"));
	BOOST_CHECK_NO_THROW(valid_range.add_parameter(PARAM_VERSION_FROM, "0"));

	License inverted_end(nullptr, MyGlobalFixture::project_path.string());
	request_v201(inverted_end);
	BOOST_CHECK_NO_THROW(inverted_end.add_parameter(PARAM_VERSION_FROM, "2.0"));
	BOOST_CHECK_NO_THROW(inverted_end.add_parameter(PARAM_VERSION_TO, "1.9"));
	BOOST_CHECK_THROW(inverted_end.write_license(), invalid_argument);

	License inverted_start(nullptr, MyGlobalFixture::project_path.string());
	request_v201(inverted_start);
	BOOST_CHECK_NO_THROW(inverted_start.add_parameter(PARAM_VERSION_TO, "1.9"));
	BOOST_CHECK_NO_THROW(inverted_start.add_parameter(PARAM_VERSION_FROM, "2.0"));
	BOOST_CHECK_THROW(inverted_start.write_license(), invalid_argument);
}

BOOST_AUTO_TEST_CASE(validate_license_file_version_parameter) {
	License v200_license(nullptr, MyGlobalFixture::project_path.string());
	BOOST_CHECK_NO_THROW(v200_license.add_parameter(PARAM_LICENSE_FORMAT_VERSION, "200"));

	License v201_license(nullptr, MyGlobalFixture::project_path.string());
	BOOST_CHECK_NO_THROW(v201_license.add_parameter(PARAM_LICENSE_FORMAT_VERSION, "201"));
	BOOST_CHECK_THROW(v201_license.write_license(), invalid_argument);

	License v201_target_license(nullptr, MyGlobalFixture::project_path.string());
	BOOST_CHECK_NO_THROW(v201_target_license.add_parameter(PARAM_LICENSE_FORMAT_VERSION, "201"));
	BOOST_CHECK_NO_THROW(v201_target_license.add_parameter(PARAM_TARGET_LICENSE_FORMAT_MAX, "201"));

	const vector<string> invalid_versions = {"", "199", "0200", "+200", "200x"};
	for (const string &version : invalid_versions) {
		License license(nullptr, MyGlobalFixture::project_path.string());
		BOOST_CHECK_THROW(license.add_parameter(PARAM_LICENSE_FORMAT_VERSION, version), invalid_argument);
		BOOST_CHECK_THROW(license.add_parameter(PARAM_TARGET_LICENSE_FORMAT_MAX, version), invalid_argument);
	}
}

BOOST_AUTO_TEST_CASE(validate_date_parameters) {
	const vector<string> invalid_dates = {"",		   "2020-02-30", "2021-02-29", "2020-00-01",
										  "2020-01-00", "2020-13-01", "2020/1/01", "2020-01-01x"};
	for (const string &date : invalid_dates) {
		License license(nullptr, MyGlobalFixture::project_path.string());
		request_v201(license);
		license.add_parameter(PARAM_EXPIRY_DATE, date);
		BOOST_CHECK_THROW(license.write_license(), invalid_argument);
	}

	License leap_year(nullptr, MyGlobalFixture::project_path.string());
	request_v201(leap_year);
	BOOST_CHECK_NO_THROW(leap_year.add_parameter(PARAM_EXPIRY_DATE, "2020-02-29"));

	License slash_form(nullptr, MyGlobalFixture::project_path.string());
	request_v201(slash_form);
	BOOST_CHECK_NO_THROW(slash_form.add_parameter(PARAM_BEGIN_DATE, "2020/02/29"));

	License inverted_end(nullptr, MyGlobalFixture::project_path.string());
	request_v201(inverted_end);
	BOOST_CHECK_NO_THROW(inverted_end.add_parameter(PARAM_BEGIN_DATE, "2020-02-29"));
	BOOST_CHECK_NO_THROW(inverted_end.add_parameter(PARAM_EXPIRY_DATE, "2020-02-28"));
	BOOST_CHECK_THROW(inverted_end.write_license(), invalid_argument);

	License inverted_start(nullptr, MyGlobalFixture::project_path.string());
	request_v201(inverted_start);
	BOOST_CHECK_NO_THROW(inverted_start.add_parameter(PARAM_EXPIRY_DATE, "2020-02-28"));
	BOOST_CHECK_NO_THROW(inverted_start.add_parameter(PARAM_BEGIN_DATE, "2020-02-29"));
	BOOST_CHECK_THROW(inverted_start.write_license(), invalid_argument);
}

#else
BOOST_AUTO_TEST_CASE(mock) { BOOST_CHECKPOINT("Mock test for older boost versions"); }
#endif
}  // namespace test
}  // namespace license
