/*
 * public_api_test.cpp
 *
 * Tests for the consumer-facing helpers in licensecc.h: lcc_strerror() and
 * print_error().
 */
#define BOOST_TEST_MODULE public_api_test

#include <licensecc/licensecc.h>

#ifdef min
#error "licensecc public headers must not define the Windows min macro"
#endif
#ifdef max
#error "licensecc public headers must not define the Windows max macro"
#endif

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <filesystem>
#include <iterator>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <boost/test/unit_test.hpp>

#include <licensecc_properties_test.h>
#include "../../src/library/base/EventRegistry.h"
#include "../../src/library/base/string_utils.h"
#include "../../src/library/locate/LocatorFactory.hpp"
#include "../../src/library/os/os.h"

namespace license {
namespace test {
using namespace std;

static bool has_status_event(const LicenseInfo& info, LCC_EVENT_TYPE event_type) {
	for (int i = 0; i < LCC_API_AUDIT_EVENT_NUM; ++i) {
		if (info.status[i].event_type == event_type) {
			return true;
		}
	}
	return false;
}

static LicenseInfo prefilled_license_info() {
	LicenseInfo info{};
	const string stale_status = "stale-status";
	const string stale_expiry = "2099-12-31";
	const string stale_data = "stale-data";
	info.status[0].severity = SVRT_ERROR;
	info.status[0].event_type = LICENSE_OK;
	std::copy(stale_status.begin(), stale_status.end(), info.status[0].license_reference);
	std::copy(stale_expiry.begin(), stale_expiry.end(), info.expiry_date);
	info.days_left = 1234;
	info.has_expiry = true;
	info.linked_to_pc = true;
	info.license_type = LCC_REMOTE;
	std::copy(stale_data.begin(), stale_data.end(), info.proprietary_data);
	info.license_version = 999;
	return info;
}

static string read_binary_file(const string& path) {
	ifstream in(path.c_str(), ios::binary);
	return string((istreambuf_iterator<char>(in)), istreambuf_iterator<char>());
}

static string write_temp_file(const string& file_name, const string& content) {
	const string file_path = string(PROJECT_TEST_TEMP_DIR) + "/" + file_name;
	ofstream out(file_path.c_str(), ios::binary | ios::trunc);
	BOOST_REQUIRE_MESSAGE(out.is_open(), "Can write temporary file " + file_path);
	out << content;
	return file_path;
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

BOOST_AUTO_TEST_CASE(lcc_strerror_known_and_unknown) {
	BOOST_CHECK(string(lcc_strerror(PRODUCT_EXPIRED)).find("expired") != string::npos);
	BOOST_CHECK(string(lcc_strerror(LICENSE_OK)).find("OK") != string::npos);
	BOOST_CHECK(string(lcc_strerror(LICENSE_TAMPER_DETECTED)).find("tamper") != string::npos);
	BOOST_CHECK(string(lcc_strerror(LICENSE_ONLINE_VERIFICATION_FAILED)).find("online") != string::npos);
	// an out-of-range value must still return a non-null, non-empty string
	const char *unknown = lcc_strerror(static_cast<LCC_EVENT_TYPE>(9999));
	BOOST_REQUIRE(unknown != nullptr);
	BOOST_CHECK(strlen(unknown) > 0);
}

BOOST_AUTO_TEST_CASE(public_header_uses_licensecc_owned_path_size) {
	BOOST_CHECK_EQUAL(sizeof(AuditEvent{}.license_reference), static_cast<size_t>(LCC_API_PATH_SIZE));
}

BOOST_AUTO_TEST_CASE(public_abi_layout_profile_is_stable) {
#if defined(_WIN32)
	const size_t expected_path_size = 260;
	const size_t expected_audit_event_size = 524;
	const size_t expected_license_info_size = 2668;
	const size_t expected_license_info_expiry_offset = 2620;
	const size_t expected_license_info_days_left_offset = 2632;
	const size_t expected_license_info_has_expiry_offset = 2636;
	const size_t expected_license_info_linked_to_pc_offset = 2637;
	const size_t expected_license_info_license_type_offset = 2640;
	const size_t expected_license_info_proprietary_data_offset = 2644;
	const size_t expected_license_info_license_version_offset = 2664;
#else
	const size_t expected_path_size = 1024;
	const size_t expected_audit_event_size = 1288;
	const size_t expected_license_info_size = 6488;
	const size_t expected_license_info_expiry_offset = 6440;
	const size_t expected_license_info_days_left_offset = 6452;
	const size_t expected_license_info_has_expiry_offset = 6456;
	const size_t expected_license_info_linked_to_pc_offset = 6457;
	const size_t expected_license_info_license_type_offset = 6460;
	const size_t expected_license_info_proprietary_data_offset = 6464;
	const size_t expected_license_info_license_version_offset = 6484;
#endif

	BOOST_CHECK_EQUAL(static_cast<size_t>(LCC_API_PATH_SIZE), expected_path_size);
	BOOST_CHECK_EQUAL(static_cast<size_t>(LCC_API_MAX_LICENSE_DATA_LENGTH), static_cast<size_t>(4096));
	BOOST_CHECK_EQUAL(static_cast<size_t>(LCC_API_PC_IDENTIFIER_SIZE), static_cast<size_t>(19));
	BOOST_CHECK_EQUAL(static_cast<size_t>(LCC_API_PROPRIETARY_DATA_SIZE), static_cast<size_t>(16));
	BOOST_CHECK_EQUAL(static_cast<size_t>(LCC_API_AUDIT_EVENT_NUM), static_cast<size_t>(5));
	BOOST_CHECK_EQUAL(static_cast<size_t>(LCC_API_AUDIT_EVENT_PARAM2), static_cast<size_t>(255));
	BOOST_CHECK_EQUAL(static_cast<size_t>(LCC_API_VERSION_LENGTH), static_cast<size_t>(15));
	BOOST_CHECK_EQUAL(static_cast<size_t>(LCC_API_FEATURE_NAME_SIZE), static_cast<size_t>(15));
	BOOST_CHECK_EQUAL(static_cast<size_t>(LCC_API_EXPIRY_DATE_SIZE), static_cast<size_t>(10));
	BOOST_CHECK_EQUAL(static_cast<size_t>(LCC_API_ERROR_BUFFER_SIZE), static_cast<size_t>(256));
	BOOST_CHECK_EQUAL(LCC_SUPPORTED_LICENSE_FORMAT_MIN, 200);
	BOOST_CHECK_EQUAL(LCC_SUPPORTED_LICENSE_FORMAT_MAX, 201);

	BOOST_CHECK_EQUAL(sizeof(AuditEvent), expected_audit_event_size);
	BOOST_CHECK_EQUAL(offsetof(AuditEvent, severity), static_cast<size_t>(0));
	BOOST_CHECK_EQUAL(offsetof(AuditEvent, event_type), static_cast<size_t>(4));
	BOOST_CHECK_EQUAL(offsetof(AuditEvent, license_reference), static_cast<size_t>(8));
	BOOST_CHECK_EQUAL(offsetof(AuditEvent, param2), static_cast<size_t>(8 + LCC_API_PATH_SIZE));

	BOOST_CHECK_EQUAL(sizeof(LicenseLocation), static_cast<size_t>(4100));
	BOOST_CHECK_EQUAL(offsetof(LicenseLocation, license_data_type), static_cast<size_t>(0));
	BOOST_CHECK_EQUAL(offsetof(LicenseLocation, licenseData), static_cast<size_t>(4));

	BOOST_CHECK_EQUAL(sizeof(CallerInformations), static_cast<size_t>(36));
	BOOST_CHECK_EQUAL(offsetof(CallerInformations, version), static_cast<size_t>(0));
	BOOST_CHECK_EQUAL(offsetof(CallerInformations, feature_name), static_cast<size_t>(16));
	BOOST_CHECK_EQUAL(offsetof(CallerInformations, magic), static_cast<size_t>(32));

	BOOST_CHECK_EQUAL(sizeof(LicenseInfo), expected_license_info_size);
	BOOST_CHECK_EQUAL(offsetof(LicenseInfo, status), static_cast<size_t>(0));
	BOOST_CHECK_EQUAL(offsetof(LicenseInfo, expiry_date), expected_license_info_expiry_offset);
	BOOST_CHECK_EQUAL(offsetof(LicenseInfo, days_left), expected_license_info_days_left_offset);
	BOOST_CHECK_EQUAL(offsetof(LicenseInfo, has_expiry), expected_license_info_has_expiry_offset);
	BOOST_CHECK_EQUAL(offsetof(LicenseInfo, linked_to_pc), expected_license_info_linked_to_pc_offset);
	BOOST_CHECK_EQUAL(offsetof(LicenseInfo, license_type), expected_license_info_license_type_offset);
	BOOST_CHECK_EQUAL(offsetof(LicenseInfo, proprietary_data), expected_license_info_proprietary_data_offset);
	BOOST_CHECK_EQUAL(offsetof(LicenseInfo, license_version), expected_license_info_license_version_offset);

	BOOST_CHECK_EQUAL(sizeof(ExecutionEnvironmentInfo), static_cast<size_t>(12));
	BOOST_CHECK_EQUAL(offsetof(ExecutionEnvironmentInfo, cloud_provider), static_cast<size_t>(0));
	BOOST_CHECK_EQUAL(offsetof(ExecutionEnvironmentInfo, virtualization), static_cast<size_t>(4));
	BOOST_CHECK_EQUAL(offsetof(ExecutionEnvironmentInfo, virtualization_detail), static_cast<size_t>(8));

	BOOST_CHECK_EQUAL(sizeof(LccOnlineRequest), static_cast<size_t>(360));
	BOOST_CHECK_EQUAL(offsetof(LccOnlineRequest, size), static_cast<size_t>(0));
	BOOST_CHECK_EQUAL(offsetof(LccOnlineRequest, version), static_cast<size_t>(4));
	BOOST_CHECK_EQUAL(offsetof(LccOnlineRequest, project), static_cast<size_t>(8));
	BOOST_CHECK_EQUAL(offsetof(LccOnlineRequest, feature), static_cast<size_t>(136));
	BOOST_CHECK_EQUAL(offsetof(LccOnlineRequest, license_fingerprint), static_cast<size_t>(152));
	BOOST_CHECK_EQUAL(offsetof(LccOnlineRequest, device_hash), static_cast<size_t>(217));
	BOOST_CHECK_EQUAL(offsetof(LccOnlineRequest, nonce), static_cast<size_t>(282));
	BOOST_CHECK_EQUAL(offsetof(LccOnlineRequest, policy), static_cast<size_t>(348));
	BOOST_CHECK_EQUAL(offsetof(LccOnlineRequest, flags), static_cast<size_t>(352));
	BOOST_CHECK_EQUAL(offsetof(LccOnlineRequest, timeout_ms), static_cast<size_t>(356));

	BOOST_CHECK_EQUAL(sizeof(LicenseCheckOptions), static_cast<size_t>(136));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, size), static_cast<size_t>(0));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, version), static_cast<size_t>(4));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, tamper_policy), static_cast<size_t>(8));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, tamper_flags), static_cast<size_t>(12));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, host_integrity_check), static_cast<size_t>(16));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, host_integrity_user_data), static_cast<size_t>(24));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, online_policy), static_cast<size_t>(32));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, online_flags), static_cast<size_t>(36));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, online_timeout_ms), static_cast<size_t>(40));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, online_check), static_cast<size_t>(48));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, online_user_data), static_cast<size_t>(56));
	BOOST_CHECK_EQUAL(offsetof(LicenseCheckOptions, online_device_hash), static_cast<size_t>(64));
}

BOOST_AUTO_TEST_CASE(public_abi_enum_values_are_stable) {
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_OK), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_FILE_NOT_FOUND), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_SERVER_NOT_FOUND), 2);
	BOOST_CHECK_EQUAL(static_cast<int>(ENVIRONMENT_VARIABLE_NOT_DEFINED), 3);
	BOOST_CHECK_EQUAL(static_cast<int>(FILE_FORMAT_NOT_RECOGNIZED), 4);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_MALFORMED), 5);
	BOOST_CHECK_EQUAL(static_cast<int>(PRODUCT_NOT_LICENSED), 6);
	BOOST_CHECK_EQUAL(static_cast<int>(PRODUCT_EXPIRED), 7);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_CORRUPTED), 8);
	BOOST_CHECK_EQUAL(static_cast<int>(IDENTIFIERS_MISMATCH), 9);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_TAMPER_DETECTED), 10);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_ONLINE_REQUIRED), 11);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_ONLINE_VERIFICATION_FAILED), 12);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_ONLINE_ASSERTION_INVALID), 13);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_ONLINE_CACHE_EXPIRED), 14);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_SPECIFIED), 100);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_FOUND), 101);
	BOOST_CHECK_EQUAL(static_cast<int>(PRODUCT_FOUND), 102);
	BOOST_CHECK_EQUAL(static_cast<int>(SIGNATURE_VERIFIED), 103);

	BOOST_CHECK_EQUAL(static_cast<int>(LCC_LOCAL), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_REMOTE), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(SVRT_INFO), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(SVRT_WARN), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(SVRT_ERROR), 2);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_PATH), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_PLAIN_DATA), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(LICENSE_ENCODED), 2);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_TAMPER_DISABLED), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_TAMPER_ENFORCE), 2);
	BOOST_CHECK_EQUAL(static_cast<uint32_t>(LCC_TAMPER_FLAG_NONE), 0U);
	BOOST_CHECK_EQUAL(static_cast<uint32_t>(LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING), 1U);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_ONLINE_DISABLED), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_ONLINE_REQUIRE), 2);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_ONLINE_CB_OK), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_ONLINE_CB_TIMEOUT), 2);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_ONLINE_CB_BUFFER_TOO_SMALL), 3);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_ONLINE_CB_HOST_DECLINED), 4);
	BOOST_CHECK_EQUAL(static_cast<int>(LCC_ONLINE_CB_MALFORMED_RESPONSE), 5);
	BOOST_CHECK_EQUAL(static_cast<uint32_t>(LCC_ONLINE_FLAG_NONE), 0U);
	BOOST_CHECK_EQUAL(static_cast<uint32_t>(LCC_ONLINE_REQUEST_VERSION), 1U);
	BOOST_CHECK_EQUAL(static_cast<uint32_t>(LCC_ONLINE_DEFAULT_TIMEOUT_MS), 3000U);
	BOOST_CHECK_EQUAL(static_cast<uint32_t>(LCC_ONLINE_MAX_TIMEOUT_MS), 30000U);
	BOOST_CHECK_EQUAL(static_cast<uint32_t>(LCC_LICENSE_CHECK_OPTIONS_VERSION), 2U);

	BOOST_CHECK_EQUAL(static_cast<int>(STRATEGY_DEFAULT), -1);
	BOOST_CHECK_EQUAL(static_cast<int>(STRATEGY_NONE), -2);
	BOOST_CHECK_EQUAL(static_cast<int>(STRATEGY_ETHERNET), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(STRATEGY_IP_ADDRESS), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(STRATEGY_DISK), 2);
	BOOST_CHECK_EQUAL(static_cast<int>(STRATEGY_CPU_SIZE), 3);
	BOOST_CHECK_EQUAL(static_cast<int>(STRATEGY_HOST_NAME), 4);

	BOOST_CHECK_EQUAL(static_cast<int>(BARE_TO_METAL), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(VMWARE), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(VIRTUALBOX), 2);
	BOOST_CHECK_EQUAL(static_cast<int>(V_XEN), 3);
	BOOST_CHECK_EQUAL(static_cast<int>(KVM), 4);
	BOOST_CHECK_EQUAL(static_cast<int>(HV), 5);
	BOOST_CHECK_EQUAL(static_cast<int>(PARALLELS), 6);
	BOOST_CHECK_EQUAL(static_cast<int>(V_OTHER), 7);
	BOOST_CHECK_EQUAL(static_cast<int>(PROV_UNKNOWN), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(ON_PREMISE), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(GOOGLE_CLOUD), 2);
	BOOST_CHECK_EQUAL(static_cast<int>(AZURE_CLOUD), 3);
	BOOST_CHECK_EQUAL(static_cast<int>(AWS), 4);
	BOOST_CHECK_EQUAL(static_cast<int>(ALI_CLOUD), 5);
	BOOST_CHECK_EQUAL(static_cast<int>(NONE), 0);
	BOOST_CHECK_EQUAL(static_cast<int>(CONTAINER), 1);
	BOOST_CHECK_EQUAL(static_cast<int>(VM), 2);
}

BOOST_AUTO_TEST_CASE(public_api_symbols_are_linkable) {
	BOOST_CHECK(lcc_strerror != nullptr);
	BOOST_CHECK(lcc_init_caller_informations != nullptr);
	BOOST_CHECK(lcc_init_license_location != nullptr);
	BOOST_CHECK(lcc_init_license_info != nullptr);
	BOOST_CHECK(lcc_init_license_check_options != nullptr);
	BOOST_CHECK(lcc_set_caller_feature_name != nullptr);
	BOOST_CHECK(lcc_set_caller_version != nullptr);
	BOOST_CHECK(lcc_set_license_location_data != nullptr);
	BOOST_CHECK(lcc_set_license_path != nullptr);
	BOOST_CHECK(print_error != nullptr);
	BOOST_CHECK(identify_pc != nullptr);
	BOOST_CHECK(acquire_license != nullptr);
	BOOST_CHECK(acquire_license_ex != nullptr);
	BOOST_CHECK(lcc_set_environment_license_sources_enabled != nullptr);
	BOOST_CHECK(lcc_set_strict_source_fatal_enabled != nullptr);
	BOOST_CHECK(confirm_license != nullptr);
	BOOST_CHECK(release_license != nullptr);
}

BOOST_AUTO_TEST_CASE(public_helpers_initialize_structs_safely) {
	CallerInformations caller;
	std::memset(&caller, 0x7f, sizeof(caller));
	lcc_init_caller_informations(&caller);
	BOOST_CHECK_EQUAL(caller.magic, static_cast<unsigned int>(LCC_PROJECT_MAGIC_NUM));
	BOOST_CHECK_EQUAL(caller.feature_name[0], '\0');
	BOOST_CHECK_EQUAL(caller.version[0], '\0');

	LicenseLocation location;
	std::memset(&location, 0x7f, sizeof(location));
	lcc_init_license_location(&location, LICENSE_ENCODED);
	BOOST_CHECK_EQUAL(location.license_data_type, LICENSE_ENCODED);
	BOOST_CHECK_EQUAL(location.licenseData[0], '\0');

	LicenseInfo info = prefilled_license_info();
	lcc_init_license_info(&info);
	BOOST_CHECK_EQUAL(info.status[0].event_type, LICENSE_OK);
	BOOST_CHECK_EQUAL(info.expiry_date[0], '\0');
	BOOST_CHECK_EQUAL(info.days_left, 0U);
	BOOST_CHECK(!info.has_expiry);
	BOOST_CHECK(!info.linked_to_pc);
	BOOST_CHECK_EQUAL(info.license_type, LCC_LOCAL);
	BOOST_CHECK_EQUAL(info.proprietary_data[0], '\0');
	BOOST_CHECK_EQUAL(info.license_version, 0);

	LicenseCheckOptions options;
	std::memset(&options, 0x7f, sizeof(options));
	lcc_init_license_check_options(&options);
	BOOST_CHECK_EQUAL(options.size, static_cast<uint32_t>(sizeof(LicenseCheckOptions)));
	BOOST_CHECK_EQUAL(options.version, static_cast<uint32_t>(LCC_LICENSE_CHECK_OPTIONS_VERSION));
	BOOST_CHECK_EQUAL(options.tamper_policy, LCC_TAMPER_ENFORCE);
	BOOST_CHECK_EQUAL(options.tamper_flags, static_cast<uint32_t>(LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING));
	BOOST_CHECK(options.host_integrity_check == nullptr);
	BOOST_CHECK(options.host_integrity_user_data == nullptr);
	BOOST_CHECK_EQUAL(options.online_policy, LCC_ONLINE_DISABLED);
	BOOST_CHECK_EQUAL(options.online_flags, static_cast<uint32_t>(LCC_ONLINE_FLAG_NONE));
	BOOST_CHECK_EQUAL(options.online_timeout_ms, static_cast<uint32_t>(LCC_ONLINE_DEFAULT_TIMEOUT_MS));
	BOOST_CHECK(options.online_check == nullptr);
	BOOST_CHECK(options.online_user_data == nullptr);
	BOOST_CHECK_EQUAL(options.online_device_hash[0], '\0');

	lcc_init_caller_informations(nullptr);
	lcc_init_license_location(nullptr, LICENSE_PATH);
	lcc_init_license_info(nullptr);
	lcc_init_license_check_options(nullptr);
}

BOOST_AUTO_TEST_CASE(public_helpers_bound_fixed_buffer_setters) {
	CallerInformations caller;
	lcc_init_caller_informations(&caller);

	const string max_feature(LCC_API_FEATURE_NAME_SIZE, 'F');
	BOOST_CHECK(lcc_set_caller_feature_name(&caller, max_feature.c_str()));
	BOOST_CHECK_EQUAL(string(caller.feature_name), max_feature);

	const string too_long_feature(LCC_API_FEATURE_NAME_SIZE + 1, 'F');
	BOOST_CHECK(!lcc_set_caller_feature_name(&caller, too_long_feature.c_str()));
	BOOST_CHECK_EQUAL(caller.feature_name[0], '\0');
	BOOST_CHECK(!lcc_set_caller_feature_name(&caller, nullptr));
	BOOST_CHECK_EQUAL(caller.feature_name[0], '\0');
	BOOST_CHECK(!lcc_set_caller_feature_name(nullptr, "FEATURE"));

	const string max_version(LCC_API_VERSION_LENGTH, '1');
	BOOST_CHECK(lcc_set_caller_version(&caller, max_version.c_str()));
	BOOST_CHECK_EQUAL(string(caller.version), max_version);

	const string too_long_version(LCC_API_VERSION_LENGTH + 1, '1');
	BOOST_CHECK(!lcc_set_caller_version(&caller, too_long_version.c_str()));
	BOOST_CHECK_EQUAL(caller.version[0], '\0');
	BOOST_CHECK(!lcc_set_caller_version(nullptr, "1.2.3"));

	LicenseLocation location;
	const string max_license_data(LCC_API_MAX_LICENSE_DATA_LENGTH - 1, 'L');
	BOOST_CHECK(lcc_set_license_location_data(&location, LICENSE_PLAIN_DATA, max_license_data.c_str()));
	BOOST_CHECK_EQUAL(location.license_data_type, LICENSE_PLAIN_DATA);
	BOOST_CHECK_EQUAL(strlen(location.licenseData), max_license_data.size());

	const string too_long_license_data(LCC_API_MAX_LICENSE_DATA_LENGTH, 'L');
	BOOST_CHECK(!lcc_set_license_location_data(&location, LICENSE_ENCODED, too_long_license_data.c_str()));
	BOOST_CHECK_EQUAL(location.license_data_type, LICENSE_ENCODED);
	BOOST_CHECK_EQUAL(location.licenseData[0], '\0');
	BOOST_CHECK(!lcc_set_license_location_data(nullptr, LICENSE_PATH, "license.lic"));

	BOOST_CHECK(lcc_set_license_path(&location, "customer.lic"));
	BOOST_CHECK_EQUAL(location.license_data_type, LICENSE_PATH);
	BOOST_CHECK_EQUAL(string(location.licenseData), "customer.lic");
	BOOST_CHECK(!lcc_set_license_path(&location, nullptr));
	BOOST_CHECK_EQUAL(location.licenseData[0], '\0');
}

BOOST_AUTO_TEST_CASE(print_error_renders_failures) {
	EventRegistry er;
	er.addEvent(PRODUCT_NOT_LICENSED, "some.lic", "Version before 1.2.0");
	er.turnWarningsIntoErrors();
	LicenseInfo info;
	er.exportLastEvents(info.status, LCC_API_AUDIT_EVENT_NUM);

	char buffer[LCC_API_ERROR_BUFFER_SIZE];
	const LicenseInfo& const_info = info;
	print_error(buffer, &const_info);
	const string out(buffer);
	BOOST_CHECK_MESSAGE(out.find("not licensed") != string::npos, "describes the failure, got: " + out);
	BOOST_CHECK_MESSAGE(out.find("Version before 1.2.0") != string::npos, "includes the failure detail, got: " + out);
	BOOST_CHECK_MESSAGE(out.find("some.lic") != string::npos, "includes the reference, got: " + out);
}

BOOST_AUTO_TEST_CASE(print_error_distinguishes_common_failure_classes) {
	struct Case {
		LCC_EVENT_TYPE event_type;
		const char* detail;
		const char* expected;
	};
	const Case cases[] = {
		{LICENSE_MALFORMED, "Invalid lic_ver", "can't be fully read: Invalid lic_ver"},
		{LICENSE_CORRUPTED, "", "signature didn't match"},
		{PRODUCT_EXPIRED, "Expired 2020-01-01", "license expired: Expired 2020-01-01"},
		{IDENTIFIERS_MISMATCH, "", "hardware identifier"},
		{PRODUCT_NOT_LICENSED, "Version after 2.0.0", "not licensed: Version after 2.0.0"},
	};
	for (const Case& test_case : cases) {
		LicenseInfo info{};
		info.status[0].severity = SVRT_ERROR;
		info.status[0].event_type = test_case.event_type;
		std::strcpy(info.status[0].license_reference, "customer.lic");
		std::strcpy(info.status[0].param2, test_case.detail);

		char buffer[LCC_API_ERROR_BUFFER_SIZE];
		print_error(buffer, &info);
		const string out(buffer);
		BOOST_CHECK_MESSAGE(out.find(test_case.expected) != string::npos, out);
	}
}

BOOST_AUTO_TEST_CASE(print_error_null_safe) {
	char buffer[LCC_API_ERROR_BUFFER_SIZE];
	print_error(buffer, nullptr);
	BOOST_CHECK(strlen(buffer) > 0);  // defined, non-empty, NUL-terminated
	print_error(nullptr, nullptr);    // must not crash
}

BOOST_AUTO_TEST_CASE(unimplemented_authorization_apis_fail_closed) {
	char feature[] = "feature";
	LicenseLocation location{};
	BOOST_CHECK_NE(confirm_license(feature, &location), LICENSE_OK);
	BOOST_CHECK_NE(release_license(feature, location), LICENSE_OK);
}

BOOST_AUTO_TEST_CASE(mstrnlen_s_does_not_read_past_capacity) {
	const char terminated[] = {'a', 'b', '\0', 'c'};
	const char unterminated[] = {'a', 'b', 'c', 'd'};

	BOOST_CHECK_EQUAL(mstrnlen_s(terminated, sizeof(terminated)), static_cast<size_t>(2));
	BOOST_CHECK_EQUAL(mstrnlen_s(unterminated, sizeof(unterminated)), sizeof(unterminated));
	BOOST_CHECK_EQUAL(mstrnlen_s(nullptr, 16), static_cast<size_t>(0));
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_unterminated_feature_name_without_throwing) {
	CallerInformations caller{};
	std::fill(caller.feature_name, caller.feature_name + sizeof(caller.feature_name), 'F');
	LicenseInfo info = prefilled_license_info();
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(&caller, nullptr, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
	BOOST_CHECK_EQUAL(info.proprietary_data[0], '\0');
	BOOST_CHECK_EQUAL(info.license_version, 0);
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_unterminated_caller_version_without_throwing) {
	CallerInformations caller{};
	std::fill(caller.version, caller.version + sizeof(caller.version), '1');
	LicenseInfo info = prefilled_license_info();
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(&caller, nullptr, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
	BOOST_CHECK_EQUAL(info.proprietary_data[0], '\0');
	BOOST_CHECK_EQUAL(info.license_version, 0);
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_invalid_external_type_without_throwing) {
	LicenseLocation location{};
	location.license_data_type = static_cast<LCC_LICENSE_DATA_TYPE>(999);
	const char data[] = "not a supported license source";
	std::copy(data, data + strlen(data), location.licenseData);
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
}

BOOST_AUTO_TEST_CASE(acquire_license_resets_prefilled_output_on_failure) {
	LicenseLocation location{};
	location.license_data_type = static_cast<LCC_LICENSE_DATA_TYPE>(999);
	const char data[] = "not a supported license source";
	std::copy(data, data + strlen(data), location.licenseData);
	LicenseInfo info = prefilled_license_info();
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
	BOOST_CHECK_EQUAL(info.expiry_date[0], '\0');
	BOOST_CHECK_EQUAL(info.days_left, 0U);
	BOOST_CHECK(!info.has_expiry);
	BOOST_CHECK(!info.linked_to_pc);
	BOOST_CHECK_EQUAL(info.license_type, LCC_LOCAL);
	BOOST_CHECK_EQUAL(info.proprietary_data[0], '\0');
	BOOST_CHECK_EQUAL(info.license_version, 0);
	BOOST_CHECK(string(info.status[0].license_reference).find("stale-status") == string::npos);
}

BOOST_AUTO_TEST_CASE(acquire_license_accepts_null_output_on_failure) {
	LicenseLocation location{};
	location.license_data_type = static_cast<LCC_LICENSE_DATA_TYPE>(999);
	const char data[] = "not a supported license source";
	std::copy(data, data + strlen(data), location.licenseData);
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, nullptr));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
}

BOOST_AUTO_TEST_CASE(acquire_license_reports_missing_external_file_without_throwing) {
	LicenseLocation location{};
	location.license_data_type = LICENSE_PATH;
	const string missing_path = string(PROJECT_TEST_TEMP_DIR) + "/missing-public-api-license.lic";
	std::copy(missing_path.begin(), missing_path.end(), location.licenseData);
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_FILE_NOT_FOUND);
	BOOST_CHECK(has_status_event(info, LICENSE_FILE_NOT_FOUND));
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_invalid_encoded_external_data_without_throwing) {
	LicenseLocation location{};
	location.license_data_type = LICENSE_ENCODED;
	const char data[] = "!!!!";
	std::copy(data, data + strlen(data), location.licenseData);
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_encoded_external_non_ini_data_without_throwing) {
	LicenseLocation location{};
	location.license_data_type = LICENSE_ENCODED;
	const char data[] = "bm90IGluaQ==";  // "not ini"
	std::copy(data, data + strlen(data), location.licenseData);
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_plain_external_non_ini_data_without_throwing) {
	LicenseLocation location{};
	location.license_data_type = LICENSE_PLAIN_DATA;
	const char data[] = "not ini";
	std::copy(data, data + strlen(data), location.licenseData);
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_embedded_nul_external_data_without_throwing) {
	LicenseLocation location{};
	location.license_data_type = LICENSE_PLAIN_DATA;
	const string prefix = "[DEFAULT]\nlic_ver = 200\n";
	const string suffix = "sig = QUJDRA==\n";
	std::copy(prefix.begin(), prefix.end(), location.licenseData);
	location.licenseData[prefix.size()] = '\0';
	std::copy(suffix.begin(), suffix.end(), location.licenseData + prefix.size() + 1);
	LicenseInfo info = prefilled_license_info();
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_NE(result, LICENSE_OK);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED) || has_status_event(info, LICENSE_CORRUPTED));
	BOOST_CHECK_EQUAL(info.proprietary_data[0], '\0');
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_non_terminated_external_data_without_throwing) {
	LicenseLocation location{};
	location.license_data_type = LICENSE_PLAIN_DATA;
	std::fill(location.licenseData, location.licenseData + sizeof(location.licenseData), 'A');
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_oversized_license_file_without_truncation) {
	const string file_path = string(PROJECT_TEST_TEMP_DIR) + "/public-api-oversized.lic";
	ofstream out(file_path.c_str(), ios::binary | ios::trunc);
	BOOST_REQUIRE_MESSAGE(out.is_open(), "Can write oversized license fixture");
	out << "[" << LCC_PROJECT_NAME << "]\n";
	out << string(LCC_API_MAX_LICENSE_DATA_LENGTH + 1, 'A');
	out.close();

	LicenseLocation location{};
	location.license_data_type = LICENSE_PATH;
	std::copy(file_path.begin(), file_path.end(), location.licenseData);
	LicenseInfo info = prefilled_license_info();
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
	BOOST_CHECK_EQUAL(info.proprietary_data[0], '\0');
	std::remove(file_path.c_str());
}

BOOST_AUTO_TEST_CASE(acquire_license_ignores_environment_sources_by_default) {
	BOOST_CHECK_EQUAL(FIND_LICENSE_WITH_ENV_VAR, false);
	locate::LocatorFactory::find_license_near_module(false);
	lcc_set_environment_license_sources_enabled(FIND_LICENSE_WITH_ENV_VAR);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, "!!!!");
	SETENV(LCC_LICENSE_LOCATION_ENV_VAR, PROJECT_TEST_SRC_DIR "/library/test_reader.ini");
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, nullptr, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_FILE_NOT_FOUND);
	BOOST_CHECK(!has_status_event(info, LICENSE_MALFORMED));

	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	lcc_set_environment_license_sources_enabled(FIND_LICENSE_WITH_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_invalid_environment_data_without_throwing) {
	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(true);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, "!!!!");
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, nullptr, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));

	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
	locate::LocatorFactory::find_license_with_env_var(FIND_LICENSE_WITH_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(acquire_license_rejects_encoded_environment_non_ini_data_without_throwing) {
	locate::LocatorFactory::find_license_near_module(false);
	locate::LocatorFactory::find_license_with_env_var(true);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, "bm90IGluaQ==");
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, nullptr, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));

	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
	locate::LocatorFactory::find_license_with_env_var(FIND_LICENSE_WITH_ENV_VAR);
}

BOOST_AUTO_TEST_CASE(acquire_license_can_disable_environment_sources) {
	locate::LocatorFactory::find_license_near_module(false);
	lcc_set_environment_license_sources_enabled(false);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, "!!!!");
	SETENV(LCC_LICENSE_LOCATION_ENV_VAR, PROJECT_TEST_SRC_DIR "/library/test_reader.ini");
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, nullptr, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_FILE_NOT_FOUND);
	BOOST_CHECK(!has_status_event(info, LICENSE_MALFORMED));

	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	lcc_set_environment_license_sources_enabled(FIND_LICENSE_WITH_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
}

BOOST_AUTO_TEST_CASE(disabled_environment_source_cannot_rescue_bad_explicit_source) {
	const string valid_license = read_binary_file(PROJECT_TEST_SRC_DIR "/library/test_reader.ini");
	BOOST_REQUIRE(!valid_license.empty());
	locate::LocatorFactory::find_license_near_module(false);
	lcc_set_environment_license_sources_enabled(false);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, valid_license.c_str());
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);

	LicenseLocation location{};
	location.license_data_type = LICENSE_PLAIN_DATA;
	const char bad_license[] = "not ini";
	std::copy(bad_license, bad_license + strlen(bad_license), location.licenseData);
	LicenseInfo info{};
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));

	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	lcc_set_environment_license_sources_enabled(FIND_LICENSE_WITH_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
}

BOOST_AUTO_TEST_CASE(strict_source_fatal_rejects_malformed_environment_with_valid_explicit_source) {
	const string valid_license_path = issue_valid_license_file("strict-source-fatal-valid-explicit");
	locate::LocatorFactory::find_license_near_module(false);
	lcc_set_environment_license_sources_enabled(true);
	lcc_set_strict_source_fatal_enabled(true);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, "!!!!");
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);

	LicenseLocation location{};
	location.license_data_type = LICENSE_PATH;
	std::copy(valid_license_path.begin(), valid_license_path.end(), location.licenseData);
	LicenseInfo info = prefilled_license_info();
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
	BOOST_CHECK_EQUAL(info.proprietary_data[0], '\0');
	BOOST_CHECK_EQUAL(info.license_version, 0);

	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	std::remove(valid_license_path.c_str());
	lcc_set_strict_source_fatal_enabled(false);
	lcc_set_environment_license_sources_enabled(FIND_LICENSE_WITH_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
}

BOOST_AUTO_TEST_CASE(strict_source_fatal_rejects_malformed_explicit_source_with_valid_environment_source) {
	const string valid_license_path = issue_valid_license_file("strict-source-fatal-valid-environment");
	locate::LocatorFactory::find_license_near_module(false);
	lcc_set_environment_license_sources_enabled(true);
	lcc_set_strict_source_fatal_enabled(true);
	SETENV(LCC_LICENSE_LOCATION_ENV_VAR, valid_license_path.c_str());
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);

	LicenseLocation location{};
	location.license_data_type = LICENSE_PLAIN_DATA;
	const char bad_license[] = "not ini";
	std::copy(bad_license, bad_license + strlen(bad_license), location.licenseData);
	LicenseInfo info = prefilled_license_info();
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
	BOOST_CHECK_EQUAL(info.proprietary_data[0], '\0');
	BOOST_CHECK_EQUAL(info.license_version, 0);

	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	std::remove(valid_license_path.c_str());
	lcc_set_strict_source_fatal_enabled(false);
	lcc_set_environment_license_sources_enabled(FIND_LICENSE_WITH_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
}

BOOST_AUTO_TEST_CASE(strict_source_fatal_rejects_malformed_path_candidate_before_valid_path) {
	const string malformed_path = write_temp_file(
		"strict-source-fatal-malformed.lic",
		string("[") + LCC_PROJECT_NAME + "]\nlic_ver = 200\nunknown-key = value\nsig = QUJDRA==\n");
	const string valid_path = issue_valid_license_file("strict-source-fatal-valid-path");
	locate::LocatorFactory::find_license_near_module(false);
	lcc_set_environment_license_sources_enabled(false);
	lcc_set_strict_source_fatal_enabled(true);

	LicenseLocation location{};
	location.license_data_type = LICENSE_PATH;
	const string path_list = malformed_path + ";" + valid_path;
	std::copy(path_list.begin(), path_list.end(), location.licenseData);
	LicenseInfo info = prefilled_license_info();
	LCC_EVENT_TYPE result = LICENSE_OK;

	BOOST_CHECK_NO_THROW(result = acquire_license(nullptr, &location, &info));
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(info, LICENSE_MALFORMED));
	BOOST_CHECK_EQUAL(info.proprietary_data[0], '\0');
	BOOST_CHECK_EQUAL(info.license_version, 0);

	std::remove(malformed_path.c_str());
	std::remove(valid_path.c_str());
	lcc_set_strict_source_fatal_enabled(false);
	lcc_set_environment_license_sources_enabled(FIND_LICENSE_WITH_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
}

BOOST_AUTO_TEST_CASE(runtime_policy_toggles_are_atomic_for_parallel_license_checks) {
	const string valid_license_path = issue_valid_license_file("policy-toggle-atomic-valid");
	UNSETENV(LCC_LICENSE_DATA_ENV_VAR);
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(false);

	LicenseLocation location{};
	location.license_data_type = LICENSE_PATH;
	std::copy(valid_license_path.begin(), valid_license_path.end(), location.licenseData);

	std::atomic_bool failed{false};
	std::atomic_bool start{false};
	auto toggler = [&]() {
		while (!start.load(std::memory_order_acquire)) {
		}
		for (int i = 0; i < 500; ++i) {
			lcc_set_environment_license_sources_enabled((i % 2) == 0);
			lcc_set_strict_source_fatal_enabled((i % 3) == 0);
		}
	};
	auto reader = [&]() {
		while (!start.load(std::memory_order_acquire)) {
		}
		for (int i = 0; i < 100; ++i) {
			LicenseInfo info = prefilled_license_info();
			const LCC_EVENT_TYPE result = acquire_license(nullptr, &location, &info);
			if (result != LICENSE_OK || info.license_version != 200) {
				failed.store(true, std::memory_order_relaxed);
			}
		}
	};

	std::thread toggle_thread(toggler);
	std::vector<std::thread> readers;
	for (int i = 0; i < 4; ++i) {
		readers.emplace_back(reader);
	}
	start.store(true, std::memory_order_release);
	toggle_thread.join();
	for (auto& thread : readers) {
		thread.join();
	}

	std::remove(valid_license_path.c_str());
	lcc_set_strict_source_fatal_enabled(false);
	lcc_set_environment_license_sources_enabled(FIND_LICENSE_WITH_ENV_VAR);
	locate::LocatorFactory::find_license_near_module(FIND_LICENSE_NEAR_MODULE);
	BOOST_CHECK(!failed.load(std::memory_order_relaxed));
}

BOOST_AUTO_TEST_CASE(identify_pc_rejects_null_and_short_buffers_without_throwing) {
	bool identified = true;
	BOOST_CHECK_NO_THROW(identified = identify_pc(STRATEGY_DEFAULT, nullptr, nullptr, nullptr));
	BOOST_CHECK(!identified);

	size_t required_size = 0;
	identified = true;
	BOOST_CHECK_NO_THROW(identified = identify_pc(STRATEGY_DEFAULT, nullptr, &required_size, nullptr));
	BOOST_CHECK(!identified);
	BOOST_CHECK_EQUAL(required_size, static_cast<size_t>(LCC_API_PC_IDENTIFIER_SIZE + 1));

	char short_buffer[1] = {'X'};
	required_size = sizeof(short_buffer);
	identified = true;
	BOOST_CHECK_NO_THROW(identified = identify_pc(STRATEGY_DEFAULT, short_buffer, &required_size, nullptr));
	BOOST_CHECK(!identified);
	BOOST_CHECK_EQUAL(required_size, static_cast<size_t>(LCC_API_PC_IDENTIFIER_SIZE + 1));
	BOOST_CHECK_EQUAL(short_buffer[0], 'X');
}

}  // namespace test
}  // namespace license
