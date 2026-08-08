#define BOOST_TEST_MODULE "test_license_locator"
#define __STDC_WANT_LIB_EXT1__ 1
#include <string.h>

#include <iostream>
#include <iterator>
#include <cstdio>
#include <fstream>
#include <vector>
#include <boost/filesystem.hpp>
#include <boost/optional.hpp>
#include <boost/test/unit_test.hpp>
#include <stdlib.h>

#include <licensecc_properties.h>
#include <licensecc_properties_test.h>

#include "../../src/library/os/os.h"
#include "../../src/library/base/base64.h"
#include "../../src/library/base/EventRegistry.h"
#include "../../src/library/locate/ApplicationFolder.hpp"
#include "../../src/library/locate/EnvironmentVarLocation.hpp"
#include "../../src/library/locate/EnvironmentVarData.hpp"
#include "../../src/library/locate/ExternalDefinition.hpp"

#define MOCK_LICENSE PROJECT_TEST_SRC_DIR "/library/test_reader.ini"

namespace test {
using namespace license::locate;
using namespace std;
using namespace boost::filesystem;

static boost::optional<path> find_file(const path &dir_path, const path &file_name) {
	const recursive_directory_iterator end;
	const auto it = find_if(recursive_directory_iterator(dir_path), end,
							[&file_name](const directory_entry &e) { return e.path().filename() == file_name; });
	return it == end ? boost::optional<path>() : it->path();
}

static path write_temp_file(const string &file_name, const string &content) {
	const path file_path = path(PROJECT_TEST_TEMP_DIR) / file_name;
	std::ofstream out(file_path.string().c_str(), std::ios::binary | std::ios::trunc);
	BOOST_REQUIRE_MESSAGE(out.is_open(), "Can write temporary file " + file_path.string());
	out << content;
	return file_path;
}

static string sized_ini_payload(const size_t size) {
	const string header = string("[") + LCC_PROJECT_NAME + "]\n";
	BOOST_REQUIRE_GE(size, header.size());
	return header + string(size - header.size(), 'A');
}

/*****************************************************************************
 * Application Folder tests
 *****************************************************************************/
BOOST_AUTO_TEST_CASE(read_license_near_module) {
	const string testExeFolder = PROJECT_BINARY_DIR "/test/library";
	bool exeFileFound = false;
	string referenceExeFileName;
	string referenceLicenseFileName;
	// Verify we're pointing the correct executable, in windows isn't clear where it's built
#ifdef _WIN32
	boost::optional<path> exeLocation(find_file(path(testExeFolder), path(BOOST_TEST_MODULE ".exe")));
	exeFileFound = exeLocation.has_value();
	if (exeFileFound) {
		referenceExeFileName = exeLocation.get().string();
		referenceLicenseFileName =
			referenceExeFileName.replace(referenceExeFileName.find(BOOST_TEST_MODULE ".exe"),
										 string(BOOST_TEST_MODULE ".exe").size(), BOOST_TEST_MODULE ".lic");
	}
#else
	referenceExeFileName = testExeFolder + "/" + BOOST_TEST_MODULE;
	std::ifstream f(referenceExeFileName.c_str());
	exeFileFound = f.good();
	referenceLicenseFileName = testExeFolder + "/" + BOOST_TEST_MODULE ".lic";
#endif
	BOOST_WARN_MESSAGE(!exeFileFound, "File [" + referenceExeFileName + "] NOT found");
	if (exeFileFound) {
		// copy test license near module
		std::ifstream src(MOCK_LICENSE, std::ios::binary);
		std::ofstream dst(referenceLicenseFileName, std::ios::binary);
		dst << src.rdbuf();
		dst.close();

		license::EventRegistry registry;
		ApplicationFolder applicationFolder;
		vector<string> licenseInfos = applicationFolder.license_locations(registry);
		BOOST_CHECK(registry.isGood());
		BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
		string currentLocation = licenseInfos[0];
		BOOST_CHECK_MESSAGE(equivalent(path(referenceLicenseFileName), path(currentLocation)),
							"file " + currentLocation + "found at expected location");
		string licenseRealContent = applicationFolder.retrieve_license_content(currentLocation);
		src.seekg(0, ios::beg);
		std::string referenceContent((std::istreambuf_iterator<char>(src)), std::istreambuf_iterator<char>());
		BOOST_CHECK_MESSAGE(referenceContent.compare(licenseRealContent) == 0, "File content is same");
		remove(referenceLicenseFileName.c_str());
	}
}

/*****************************************************************************
 * External_Definition tests
 *****************************************************************************/

BOOST_AUTO_TEST_CASE(external_definition) {
	// an application can define multiple license locations separated by ';'
	string applicationDefinedString = MOCK_LICENSE ";/this/one/doesnt/exist";

	// read test license
	std::ifstream src(MOCK_LICENSE, std::ios::binary);
	std::string referenceContent((std::istreambuf_iterator<char>(src)), std::istreambuf_iterator<char>());
	license::EventRegistry registry;
	LicenseLocation licLocation = {LICENSE_PATH};
	std::copy(applicationDefinedString.begin(), applicationDefinedString.end(), licLocation.licenseData);
	ExternalDefinition externalDefinition(&licLocation);
	vector<string> licenseInfos = externalDefinition.license_locations(registry);
	BOOST_CHECK(registry.isGood());
	BOOST_CHECK_EQUAL(1, licenseInfos.size());
	string currentLocation = licenseInfos[0];
	BOOST_CHECK_MESSAGE(string(MOCK_LICENSE).compare(currentLocation) == 0, "file found at expected location");
	string licenseRealContent = externalDefinition.retrieve_license_content(currentLocation);
	BOOST_CHECK_MESSAGE(referenceContent.compare(licenseRealContent) == 0, "File content is same");
}

/**
 * The license file doesn't exist. Check that the locator reports the right error
 */
BOOST_AUTO_TEST_CASE(external_definition_not_found) {
	string applicationDefinedString = PROJECT_TEST_SRC_DIR "/this/file/doesnt/exist";
	license::EventRegistry registry;
	LicenseLocation licLocation = {LICENSE_PATH};
	std::copy(applicationDefinedString.begin(), applicationDefinedString.end(), licLocation.licenseData);
	ExternalDefinition externalDefinition(&licLocation);
	vector<string> licenseInfos = externalDefinition.license_locations(registry);

	BOOST_CHECK_MESSAGE(registry.isGood(), "No fatal error for now, only warnings");
	registry.turnWarningsIntoErrors();
	BOOST_REQUIRE_MESSAGE(!registry.isGood(), "Error detected");
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_CHECK_MESSAGE(registry.getLastFailure()->event_type == LICENSE_FILE_NOT_FOUND, "Error detected");
}

BOOST_AUTO_TEST_CASE(external_definition_encoded_data) {
	std::ifstream src(MOCK_LICENSE, std::ios::binary);
	std::string referenceContent((std::istreambuf_iterator<char>(src)), std::istreambuf_iterator<char>());
	const std::string encoded = license::base64(referenceContent.data(), referenceContent.size());

	license::EventRegistry registry;
	LicenseLocation licLocation = {LICENSE_ENCODED};
	strncpy(licLocation.licenseData, encoded.c_str(), sizeof(licLocation.licenseData) - 1);
	ExternalDefinition externalDefinition(&licLocation);
	vector<string> licenseInfos = externalDefinition.license_locations(registry);
	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	string licenseRealContent = externalDefinition.retrieve_license_content(licenseInfos[0]);
	BOOST_CHECK_MESSAGE(referenceContent.compare(licenseRealContent) == 0, "Encoded content is decoded by length");
}

BOOST_AUTO_TEST_CASE(external_definition_invalid_encoded_data) {
	license::EventRegistry registry;
	LicenseLocation licLocation = {LICENSE_ENCODED};
	strncpy(licLocation.licenseData, "!!!!", sizeof(licLocation.licenseData) - 1);
	ExternalDefinition externalDefinition(&licLocation);
	vector<string> licenseInfos = externalDefinition.license_locations(registry);
	BOOST_CHECK_MESSAGE(registry.isGood(), "Malformed encoded data is reported as a warning at locator level");
	registry.turnWarningsIntoErrors();
	BOOST_REQUIRE_MESSAGE(!registry.isGood(), "Malformed encoded data is detected");
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_CHECK_MESSAGE(registry.getLastFailure()->event_type == LICENSE_MALFORMED, "Malformed encoded data reported");
}

BOOST_AUTO_TEST_CASE(external_definition_allows_exact_limit_license_file) {
	const path exact_path =
		write_temp_file("external-exact-limit.lic", sized_ini_payload(LCC_API_MAX_LICENSE_DATA_LENGTH));
	license::EventRegistry registry;
	LicenseLocation licLocation = {LICENSE_PATH};
	const string applicationDefinedString = exact_path.string();
	std::copy(applicationDefinedString.begin(), applicationDefinedString.end(), licLocation.licenseData);

	ExternalDefinition externalDefinition(&licLocation);
	vector<string> licenseInfos = externalDefinition.license_locations(registry);

	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	BOOST_CHECK_EQUAL(exact_path.string(), licenseInfos[0]);
	remove(exact_path);
}

BOOST_AUTO_TEST_CASE(external_definition_rejects_oversized_license_file) {
	const path oversized_path =
		write_temp_file("external-oversized.lic", sized_ini_payload(LCC_API_MAX_LICENSE_DATA_LENGTH + 1));
	license::EventRegistry registry;
	LicenseLocation licLocation = {LICENSE_PATH};
	const string applicationDefinedString = oversized_path.string();
	std::copy(applicationDefinedString.begin(), applicationDefinedString.end(), licLocation.licenseData);

	ExternalDefinition externalDefinition(&licLocation);
	vector<string> licenseInfos = externalDefinition.license_locations(registry);

	registry.turnWarningsIntoErrors();
	BOOST_REQUIRE_MESSAGE(!registry.isGood(), "Oversized file is detected");
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_REQUIRE(registry.getLastFailure() != nullptr);
	BOOST_CHECK_EQUAL(registry.getLastFailure()->event_type, LICENSE_MALFORMED);
	remove(oversized_path);
}

BOOST_AUTO_TEST_CASE(external_definition_accepts_largest_terminated_plain_data) {
	const string payload = sized_ini_payload(LCC_API_MAX_LICENSE_DATA_LENGTH - 1);
	license::EventRegistry registry;
	LicenseLocation licLocation = {LICENSE_PLAIN_DATA};
	std::copy(payload.begin(), payload.end(), licLocation.licenseData);

	ExternalDefinition externalDefinition(&licLocation);
	vector<string> licenseInfos = externalDefinition.license_locations(registry);

	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	BOOST_CHECK_EQUAL(payload, externalDefinition.retrieve_license_content(licenseInfos[0]));
}

BOOST_AUTO_TEST_CASE(external_definition_rejects_full_plain_data_buffer_without_terminator) {
	license::EventRegistry registry;
	LicenseLocation licLocation = {LICENSE_PLAIN_DATA};
	const string payload = sized_ini_payload(sizeof(licLocation.licenseData));
	std::copy(payload.begin(), payload.end(), licLocation.licenseData);

	ExternalDefinition externalDefinition(&licLocation);
	vector<string> licenseInfos = externalDefinition.license_locations(registry);

	registry.turnWarningsIntoErrors();
	BOOST_REQUIRE_MESSAGE(!registry.isGood(), "Full explicit data buffer without NUL is detected");
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_REQUIRE(registry.getLastFailure() != nullptr);
	BOOST_CHECK_EQUAL(registry.getLastFailure()->event_type, LICENSE_MALFORMED);
}

/*****************************************************************************
 * EnvironmentVarLocation tests
 *****************************************************************************/
BOOST_AUTO_TEST_CASE(environment_var_location) {
	// an application can define multiple license locations separated by ';'
	const char *environment_variable_value = MOCK_LICENSE ";/this/one/doesnt/exist";
#ifdef _WIN32
	_putenv_s(LCC_LICENSE_LOCATION_ENV_VAR, environment_variable_value);
#else
	setenv(LCC_LICENSE_LOCATION_ENV_VAR, environment_variable_value, 1);
#endif
	// read test license
	std::ifstream src(MOCK_LICENSE, std::ios::binary);
	std::string referenceContent((std::istreambuf_iterator<char>(src)), std::istreambuf_iterator<char>());
	license::EventRegistry registry;

	EnvironmentVarLocation envVarLocationStrategy;
	vector<string> licenseInfos = envVarLocationStrategy.license_locations(registry);
	BOOST_CHECK(registry.isGood());
	BOOST_CHECK_EQUAL(1, licenseInfos.size());
	string currentLocation = licenseInfos[0];
	BOOST_CHECK_MESSAGE(string(MOCK_LICENSE).compare(currentLocation) == 0, "file found at expected location");
	string licenseRealContent = envVarLocationStrategy.retrieve_license_content(currentLocation);
	BOOST_CHECK_MESSAGE(referenceContent.compare(licenseRealContent) == 0, "File content is same");
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
}

/**
 * The license file doesn't exist. Check that the locator reports the right error
 */
BOOST_AUTO_TEST_CASE(environment_var_location_not_found) {
	const char *environment_variable_value = PROJECT_TEST_SRC_DIR "/this/file/doesnt/exist";
	SETENV(LCC_LICENSE_LOCATION_ENV_VAR, environment_variable_value);

	license::EventRegistry registry;
	EnvironmentVarLocation envVarLocationStrategy;
	vector<string> licenseInfos = envVarLocationStrategy.license_locations(registry);
	BOOST_CHECK_MESSAGE(registry.isGood(), "No fatal error for now, only warnings");
	registry.turnWarningsIntoErrors();
	BOOST_REQUIRE_MESSAGE(!registry.isGood(), "Error detected");
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_CHECK_MESSAGE(registry.getLastFailure()->event_type == LICENSE_FILE_NOT_FOUND, "Error detected");
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(environment_var_location_allows_exact_limit_license_file) {
	const path exact_path =
		write_temp_file("environment-location-exact-limit.lic", sized_ini_payload(LCC_API_MAX_LICENSE_DATA_LENGTH));
	SETENV(LCC_LICENSE_LOCATION_ENV_VAR, exact_path.string().c_str());

	license::EventRegistry registry;
	EnvironmentVarLocation envVarLocationStrategy;
	vector<string> licenseInfos = envVarLocationStrategy.license_locations(registry);

	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	BOOST_CHECK_EQUAL(exact_path.string(), licenseInfos[0]);

	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	remove(exact_path);
}

BOOST_AUTO_TEST_CASE(environment_var_location_rejects_oversized_license_file) {
	const path oversized_path =
		write_temp_file("environment-location-oversized.lic", sized_ini_payload(LCC_API_MAX_LICENSE_DATA_LENGTH + 1));
	SETENV(LCC_LICENSE_LOCATION_ENV_VAR, oversized_path.string().c_str());

	license::EventRegistry registry;
	EnvironmentVarLocation envVarLocationStrategy;
	vector<string> licenseInfos = envVarLocationStrategy.license_locations(registry);

	registry.turnWarningsIntoErrors();
	BOOST_REQUIRE_MESSAGE(!registry.isGood(), "Oversized file is detected");
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_REQUIRE(registry.getLastFailure() != nullptr);
	BOOST_CHECK_EQUAL(registry.getLastFailure()->event_type, LICENSE_MALFORMED);

	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	remove(oversized_path);
}

/*****************************************************************************
 * EnvironmentVarData tests
 *****************************************************************************/
/**
 * The license content is provided directly in LCC_LICENSE_DATA_ENV_VAR.
 * Regression: retrieve_license_content() used to read the wrong (location)
 * environment variable, which was typically unset -> std::string(nullptr) crash.
 */
BOOST_AUTO_TEST_CASE(environment_var_data) {
	std::ifstream src(MOCK_LICENSE, std::ios::binary);
	const std::string referenceContent((std::istreambuf_iterator<char>(src)), std::istreambuf_iterator<char>());
	SETENV(LCC_LICENSE_DATA_ENV_VAR, referenceContent.c_str());

	license::EventRegistry registry;
	EnvironmentVarData envVarDataStrategy;
	vector<string> licenseInfos = envVarDataStrategy.license_locations(registry);
	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	const string licenseRealContent = envVarDataStrategy.retrieve_license_content(licenseInfos[0]);
	BOOST_CHECK_MESSAGE(referenceContent.compare(licenseRealContent) == 0,
						"env-var data content matches what was provided");
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(environment_var_data_accepts_base64_line_breaks) {
	std::ifstream src(MOCK_LICENSE, std::ios::binary);
	const std::string referenceContent((std::istreambuf_iterator<char>(src)), std::istreambuf_iterator<char>());
	const std::string encoded = license::base64(referenceContent.data(), referenceContent.size(), 5);
	BOOST_REQUIRE(encoded.find('\n') != std::string::npos);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, encoded.c_str());

	license::EventRegistry registry;
	EnvironmentVarData envVarDataStrategy;
	vector<string> licenseInfos = envVarDataStrategy.license_locations(registry);
	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	const string licenseRealContent = envVarDataStrategy.retrieve_license_content(licenseInfos[0]);
	BOOST_CHECK_MESSAGE(referenceContent.compare(licenseRealContent) == 0,
						"line-broken base64 env-var data decodes to original content");
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(environment_var_data_accepts_exact_limit_plain_data) {
	const string exact = sized_ini_payload(LCC_API_MAX_LICENSE_DATA_LENGTH);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, exact.c_str());

	license::EventRegistry registry;
	EnvironmentVarData envVarDataStrategy;
	vector<string> licenseInfos = envVarDataStrategy.license_locations(registry);
	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	const string licenseRealContent = envVarDataStrategy.retrieve_license_content(licenseInfos[0]);
	BOOST_CHECK_EQUAL(exact, licenseRealContent);
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(environment_var_data_rejects_oversized_plain_data) {
	const string oversized = sized_ini_payload(LCC_API_MAX_LICENSE_DATA_LENGTH + 1);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, oversized.c_str());

	license::EventRegistry registry;
	EnvironmentVarData envVarDataStrategy;
	vector<string> licenseInfos = envVarDataStrategy.license_locations(registry);

	registry.turnWarningsIntoErrors();
	BOOST_REQUIRE_MESSAGE(!registry.isGood(), "Oversized environment data is detected");
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_REQUIRE(registry.getLastFailure() != nullptr);
	BOOST_CHECK_EQUAL(registry.getLastFailure()->event_type, LICENSE_MALFORMED);
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
}

/**
 * The license file doesn't exist. Check that the locator reports the right error
 */
BOOST_AUTO_TEST_CASE(environment_var_location_not_defined) {
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	license::EventRegistry registry;
	EnvironmentVarLocation environmentVarLocation;
	vector<string> licenseInfos = environmentVarLocation.license_locations(registry);

	BOOST_CHECK_MESSAGE(registry.isGood(), "No fatal error for now, only warnings");
	registry.turnWarningsIntoErrors();
	BOOST_REQUIRE_MESSAGE(!registry.isGood(), "Error detected");
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	BOOST_CHECK_MESSAGE(registry.getLastFailure()->event_type == ENVIRONMENT_VARIABLE_NOT_DEFINED, "Error detected");
}

}  // namespace test
