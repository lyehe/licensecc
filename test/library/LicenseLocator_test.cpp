#define BOOST_TEST_MODULE "test_license_locator"
#define __STDC_WANT_LIB_EXT1__ 1
#include <string.h>

#include <algorithm>
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

/**
 * LICENSE_ENCODED round-trip: the decoded license must be exactly the bytes
 * that were encoded. Regression: the decoded buffer was turned into a string
 * without a length, reading past the end of the buffer.
 */
BOOST_AUTO_TEST_CASE(external_definition_encoded_content_roundtrip) {
	std::ifstream src(MOCK_LICENSE, std::ios::binary);
	const std::string referenceContent((std::istreambuf_iterator<char>(src)), std::istreambuf_iterator<char>());
	string encoded = license::base64(referenceContent.data(), referenceContent.size());
	// the encoder emits newlines; the ENCODED contract (and the b64 format regex) is single-line
	encoded.erase(std::remove(encoded.begin(), encoded.end(), '\n'), encoded.end());
	BOOST_REQUIRE_MESSAGE(encoded.size() < LCC_API_MAX_LICENSE_DATA_LENGTH, "mock license fits licenseData");

	license::EventRegistry registry;
	LicenseLocation licLocation = {LICENSE_ENCODED};
	std::copy(encoded.begin(), encoded.end(), licLocation.licenseData);
	ExternalDefinition externalDefinition(&licLocation);
	vector<string> licenseInfos = externalDefinition.license_locations(registry);
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	const string licenseRealContent = externalDefinition.retrieve_license_content(licenseInfos[0]);
	BOOST_CHECK_MESSAGE(referenceContent == licenseRealContent, "decoded content is exactly the encoded input");
}

/**
 * Invalid base64 passed as LICENSE_ENCODED must be rejected gracefully with
 * empty content. Regression: an empty decode buffer produced
 * std::string(nullptr), which is undefined behavior.
 */
BOOST_AUTO_TEST_CASE(external_definition_encoded_invalid_base64_rejected) {
	const string invalid("a");  // too short to be base64
	license::EventRegistry registry;
	LicenseLocation licLocation = {LICENSE_ENCODED};
	std::copy(invalid.begin(), invalid.end(), licLocation.licenseData);
	ExternalDefinition externalDefinition(&licLocation);
	vector<string> licenseInfos = externalDefinition.license_locations(registry);
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	const string licenseRealContent = externalDefinition.retrieve_license_content(licenseInfos[0]);
	BOOST_CHECK_MESSAGE(licenseRealContent.empty(), "invalid base64 yields empty content, not a crash");
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

/**
 * Base64 license content in LCC_LICENSE_DATA_ENV_VAR must decode back to
 * exactly the original bytes, and the reported location must reference the
 * DATA variable. Regression: locations/events named the LOCATION variable,
 * and the decode built a std::string without a length (buffer over-read).
 */
BOOST_AUTO_TEST_CASE(environment_var_data_base64) {
	std::ifstream src(MOCK_LICENSE, std::ios::binary);
	const std::string referenceContent((std::istreambuf_iterator<char>(src)), std::istreambuf_iterator<char>());
	string encoded = license::base64(referenceContent.data(), referenceContent.size());
	encoded.erase(std::remove(encoded.begin(), encoded.end(), '\n'), encoded.end());
	SETENV(LCC_LICENSE_DATA_ENV_VAR, encoded.c_str());

	license::EventRegistry registry;
	EnvironmentVarData envVarDataStrategy;
	vector<string> licenseInfos = envVarDataStrategy.license_locations(registry);
	BOOST_CHECK(registry.isGood());
	BOOST_REQUIRE_EQUAL(1, licenseInfos.size());
	BOOST_CHECK_MESSAGE(licenseInfos[0] == LCC_LICENSE_DATA_ENV_VAR,
						"location references the DATA env var, got: " + licenseInfos[0]);
	const string licenseRealContent = envVarDataStrategy.retrieve_license_content(licenseInfos[0]);
	BOOST_CHECK_MESSAGE(referenceContent == licenseRealContent, "decoded content is exactly the encoded input");
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
}

/**
 * When the DATA variable is not defined, the failure event must name
 * LCC_LICENSE_DATA_ENV_VAR. Regression: it reported LCC_LICENSE_LOCATION_ENV_VAR,
 * telling users to fix a variable they never meant to set.
 */
BOOST_AUTO_TEST_CASE(environment_var_data_not_defined_names_data_variable) {
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	license::EventRegistry registry;
	EnvironmentVarData envVarDataStrategy;
	vector<string> licenseInfos = envVarDataStrategy.license_locations(registry);
	BOOST_CHECK_EQUAL(0, licenseInfos.size());
	registry.turnWarningsIntoErrors();
	const AuditEvent *failure = registry.getLastFailure();
	BOOST_REQUIRE(failure != nullptr);
	BOOST_CHECK_MESSAGE(failure->event_type == ENVIRONMENT_VARIABLE_NOT_DEFINED, "not-defined event reported");
	BOOST_CHECK_MESSAGE(string(failure->license_reference) == LCC_LICENSE_DATA_ENV_VAR,
						"failure references the DATA env var, got: " + string(failure->license_reference));
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
