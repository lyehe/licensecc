/*
 * generate-license.c
 *
 *  Created on: Apr 13, 2014
 *
 */

#include <boost/test/unit_test.hpp>
#include <boost/filesystem.hpp>
#include <boost/algorithm/string.hpp>
#include <sstream>
#include <fstream>
#include <iostream>

#include <licensecc_properties_test.h>
#include <licensecc_properties.h>

#include "../../src/library/base/base64.h"
#include "../../src/library/base/base.h"
#include "../../src/library/ini/SimpleIni.h"
#include "generate-license.h"

namespace fs = boost::filesystem;
using namespace std;

namespace license {
namespace test {

static bool args_contain_base64(const vector<string>& args) {
	for (const string& arg : args) {
		if (arg == "-b" || arg == "--" PARAM_BASE64) {
			return true;
		}
	}
	return false;
}

static void prepare_test_project_metadata() {
	const fs::path source_public_key =
		fs::path(LCC_PROJECTS_BASE_DIR) / LCC_PROJECT_NAME / "include" / "licensecc" / LCC_PROJECT_NAME / "public_key.h";
	BOOST_REQUIRE_MESSAGE(fs::is_regular_file(source_public_key),
						  "Generated public key metadata not found: " + source_public_key.string());

	const fs::path destination_public_key =
		fs::path(LCC_TEST_LICENSES_PROJECT) / "include" / "licensecc" / LCC_PROJECT_NAME / "public_key.h";
	BOOST_REQUIRE_MESSAGE(fs::create_directories(destination_public_key.parent_path()) ||
							  fs::is_directory(destination_public_key.parent_path()),
						  "Created test project metadata directory: " +
							  destination_public_key.parent_path().string());
	if (fs::exists(destination_public_key)) {
		fs::remove(destination_public_key);
	}
	fs::copy_file(source_public_key, destination_public_key);
}

string generate_license(const string& license_name, const vector<string>& other_args) {
	fs::path lcc_exe(LCC_EXE);
	BOOST_REQUIRE_MESSAGE(fs::is_regular_file(lcc_exe), "License generator not found: " LCC_EXE);
	prepare_test_project_metadata();
	fs::path licenses_base(LCC_LICENSES_BASE);
	if (!fs::exists(licenses_base)) {
		BOOST_REQUIRE_MESSAGE(fs::create_directories(licenses_base), "test folders created " + licenses_base.string());
	}
	const string license_name_norm = boost::ends_with(license_name, ".lic") ? license_name : (license_name + ".lic");
	const fs::path license_fname(licenses_base / license_name_norm);
	const string license_fname_s = license_fname.string();
	remove(license_fname_s.c_str());

	stringstream ss;
	ss << LCC_EXE << " license issue";
	ss << " --" PARAM_PRIMARY_KEY " " << LCC_PROJECT_PRIVATE_KEY;
	ss << " --" PARAM_LICENSE_OUTPUT " " << license_fname_s;
	ss << " --" PARAM_PROJECT_FOLDER " " << LCC_TEST_LICENSES_PROJECT;

	for (size_t i = 0; i < other_args.size(); i++) {
		ss << " " << other_args[i];
	}
	cout << "executing :" << ss.str() << endl;
	const int retCode = std::system(ss.str().c_str());
	BOOST_REQUIRE_EQUAL(retCode, 0);
	BOOST_REQUIRE_MESSAGE(fs::exists(license_fname), "license exists");
	CSimpleIniA ini;
	SI_Error rc = SI_FAIL;
	if (args_contain_base64(other_args)) {
		std::ifstream ifs(license_fname_s.c_str(), ios::binary);
		const string encoded((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
		const vector<uint8_t> decoded = unbase64(encoded);
		BOOST_REQUIRE_MESSAGE(!decoded.empty(), "base64 license decodes");
		const string license_data(reinterpret_cast<const char*>(decoded.data()), decoded.size());
		rc = ini.LoadData(license_data);
	} else {
		rc = ini.LoadFile(license_fname.c_str());
	}
	BOOST_REQUIRE_GE(rc, 0);
	const int sectionSize = ini.GetSectionSize(LCC_PROJECT_NAME);
	BOOST_CHECK_GT(sectionSize, 0);
	return license_fname.string();
}

string sign_data(const string& data, const string& test_name) {
	fs::path lcc_exe(LCC_EXE);
	BOOST_REQUIRE_MESSAGE(fs::is_regular_file(lcc_exe), "License generator not found: " LCC_EXE);
	fs::path licenses_base(LCC_LICENSES_BASE);
	if (!fs::exists(licenses_base)) {
		BOOST_REQUIRE_MESSAGE(fs::create_directories(licenses_base), "test folders created " + licenses_base.string());
	}

	const fs::path outputFile(fs::path(PROJECT_TEST_TEMP_DIR) / (test_name + ".tmp"));
	const string output_file_s = outputFile.string();
	remove(output_file_s.c_str());

	stringstream ss;
	ss << LCC_EXE << " test sign";
	ss << " --" PARAM_PRIMARY_KEY " " << LCC_PROJECT_PRIVATE_KEY;
	ss << " -d " << data;
	ss << " -o " << output_file_s;

	cout << "executing :" << ss.str() << endl;
	const int retCode = std::system(ss.str().c_str());
	BOOST_CHECK_EQUAL(retCode, 0);
	BOOST_ASSERT(fs::exists(outputFile));
	std::ifstream ifs(output_file_s.c_str());
	std::string content((std::istreambuf_iterator<char>(ifs)), (std::istreambuf_iterator<char>()));
	return content;
}

}  // namespace test
}  // namespace license
