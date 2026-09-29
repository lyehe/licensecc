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
		// v201 issuance (the only format now) reads the project's generated
		// public_key.h and refuses a private key below the 3072-bit floor, so the
		// fixture project needs a private key at or above that floor plus its
		// matching generated header. This is a dedicated fixture key generated
		// for this test project; it is unrelated to the 1024-bit key at
		// test/data/private_key.rsa, which other suites (including the core
		// runtime's signature-verifier golden vectors) still pin to exactly.
		const fs::path pkf = fs::path(PROJECT_TEST_SRC_DIR) / "data" / "private_key_3072.rsa";
		fs::copy_file(pkf, project_path / PRIVATE_KEY_FNAME);
		const fs::path include_folder = project_path / "include" / "licensecc" / project_path.filename();
		bool include_ok = fs::create_directories(include_folder);
		BOOST_REQUIRE_MESSAGE(include_ok, string("Error creating ") + include_folder.string());
		const fs::path pubkey_header = fs::path(PROJECT_TEST_SRC_DIR) / "data" / "public_key_3072.h";
		fs::copy_file(pubkey_header, include_folder / PUBLIC_KEY_INC_FNAME);
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

// v201 is now the only format License ever issues, so requesting it explicitly
// is a no-op. Kept so existing call sites below read the same as before the
// format became unconditional, without threading a removed option through them.
static void request_v201(License& license) { (void)license; }

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
	BOOST_CHECK_MESSAGE(ini.GetSectionSize("TEST_PROJECT") == 7, "Section TEST_PROJECT has 7 elements");
	BOOST_CHECK_MESSAGE(string(ini.GetValue("TEST_PROJECT", PARAM_EXPIRY_DATE, "X")) == "1929-01-11",
						"Section TEST_PROJECT has expiry date");
	// std::cout << ini.GetValue("TEST_PROJECT", PARAM_EXPIRY_DATE, "X") << endl;
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
	// v201 strictly validates a pre-existing output file (see write_license()),
	// so a stale file left in the working directory by an older build must not
	// be picked up as "existing license data" to extend.
	fs::remove(license_rel_path);
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
	BOOST_CHECK_MESSAGE(ini.GetSectionSize("MY_FANTASTIC_SOFTWARE") == 6,
						"Decoded section [MY_FANTASTIC_SOFTWARE] has 6 elements");
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
	BOOST_CHECK_MESSAGE(ini.GetSectionSize("MY_FANTASTIC_SOFTWARE") == 6,
						"Section [MY_FANTASTIC_SOFTWARE] has 6 elements");
	BOOST_CHECK_MESSAGE(ini.GetSectionSize("ANOTHER_FEATURE") == 6, "Section [ANOTHER_FEATURE] has 6 elements");
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

// Regenerating the fixture project key to 3072 bits (see the setup() comment
// above) exposed that this test never actually exercised client-signature opt-in
// semantics: with the old 1024-bit fixture key, write_license() always threw
// from the unrelated weak-key floor before client-signature validation ran, so
// BOOST_CHECK_THROW passed for the wrong reason regardless of the opt-in flags.
// With a sufficiently strong key, granting the opt-in must let issuance succeed.
BOOST_AUTO_TEST_CASE(weak_client_signature_modes_accept_opt_in) {
	License ip_license(nullptr, MyGlobalFixture::project_path.string());
	request_v201(ip_license);
	ip_license.set_allow_ip_binding(true);
	ip_license.add_parameter(PARAM_CLIENT_SIGNATURE, ip_client_signature());
	BOOST_CHECK_NO_THROW(ip_license.write_license());

	License env_license(nullptr, MyGlobalFixture::project_path.string());
	request_v201(env_license);
	env_license.set_allow_env_selected_binding(true);
	env_license.add_parameter(PARAM_CLIENT_SIGNATURE, env_selected_client_signature());
	BOOST_CHECK_NO_THROW(env_license.write_license());

	License weak_disk_label_license(nullptr, MyGlobalFixture::project_path.string());
	request_v201(weak_disk_label_license);
	weak_disk_label_license.set_allow_weak_disk_label_binding(true);
	weak_disk_label_license.add_parameter(PARAM_CLIENT_SIGNATURE, weak_disk_label_client_signature());
	BOOST_CHECK_NO_THROW(weak_disk_label_license.write_license());
	weak_disk_label_license.add_parameter(PARAM_CLIENT_SIGNATURE, weak_disk_mutable_client_signature());
	BOOST_CHECK_NO_THROW(weak_disk_label_license.write_license());
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
