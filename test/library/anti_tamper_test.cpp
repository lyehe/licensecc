#define BOOST_TEST_MODULE anti_tamper_test

#include <licensecc/licensecc.h>

#include <cstdlib>
#include <cstddef>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include <boost/test/unit_test.hpp>

#include <licensecc_properties_test.h>
#include "../../src/library/locate/LocatorFactory.hpp"
#include "../../src/library/os/os.h"

namespace license {
namespace test {
using namespace std;

struct RuntimePolicyGuard {
	RuntimePolicyGuard() {
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
	}
};

static bool has_status_event(const LicenseInfo& info, LCC_EVENT_TYPE event_type) {
	for (int i = 0; i < LCC_API_AUDIT_EVENT_NUM; ++i) {
		if (info.status[i].event_type == event_type) {
			return true;
		}
	}
	return false;
}

static const AuditEvent* find_status_event(const LicenseInfo& info, LCC_EVENT_TYPE event_type,
										   LCC_SEVERITY severity) {
	for (int i = 0; i < LCC_API_AUDIT_EVENT_NUM; ++i) {
		if (info.status[i].event_type == event_type && info.status[i].severity == severity) {
			return &info.status[i];
		}
	}
	return nullptr;
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

static bool failing_integrity_callback(void* user_data, char* detail_out, size_t detail_out_size) {
	if (user_data != nullptr) {
		int* calls = static_cast<int*>(user_data);
		++(*calls);
	}
	const char detail[] = "host check failed";
	if (detail_out != nullptr && detail_out_size > 0) {
		const size_t max_count = detail_out_size - 1;
		const size_t detail_size = strlen(detail);
		const size_t count = detail_size < max_count ? detail_size : max_count;
		memcpy(detail_out, detail, count);
		detail_out[count] = '\0';
	}
	return false;
}

static bool long_unterminated_detail_callback(void* user_data, char* detail_out, size_t detail_out_size) {
	(void)user_data;
	if (detail_out != nullptr && detail_out_size > 0) {
		memset(detail_out, 'A', detail_out_size);
	}
	return false;
}

BOOST_AUTO_TEST_CASE(disabled_policy_ignores_host_callback) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("anti-tamper-disabled-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();
	LicenseInfo info{};

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.tamper_policy = LCC_TAMPER_DISABLED;
	int calls = 0;
	options.host_integrity_check = failing_integrity_callback;
	options.host_integrity_user_data = &calls;

	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(calls, 0);
	BOOST_CHECK(!has_status_event(info, LICENSE_TAMPER_DETECTED));
	BOOST_CHECK_EQUAL(info.license_version, 200);

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(audit_policy_records_tamper_warning_and_allows_license) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("anti-tamper-audit-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();
	LicenseInfo info{};

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	int calls = 0;
	options.host_integrity_check = failing_integrity_callback;
	options.host_integrity_user_data = &calls;

	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(calls, 1);
	BOOST_CHECK(find_status_event(info, LICENSE_TAMPER_DETECTED, SVRT_WARN) != nullptr);
	BOOST_CHECK_EQUAL(info.license_version, 200);

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(enforce_policy_records_tamper_error_and_denies_license) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("anti-tamper-enforce-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();
	LicenseInfo info{};

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.tamper_policy = LCC_TAMPER_ENFORCE;
	int calls = 0;
	options.host_integrity_check = failing_integrity_callback;
	options.host_integrity_user_data = &calls;

	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_TAMPER_DETECTED);
	BOOST_CHECK_EQUAL(calls, 1);
	BOOST_CHECK(find_status_event(info, LICENSE_TAMPER_DETECTED, SVRT_ERROR) != nullptr);
	BOOST_CHECK_EQUAL(info.license_version, 0);

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(callback_detail_is_bounded_and_terminated) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("anti-tamper-detail-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();
	LicenseInfo info{};

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.host_integrity_check = long_unterminated_detail_callback;

	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	const AuditEvent* event = find_status_event(info, LICENSE_TAMPER_DETECTED, SVRT_WARN);
	BOOST_REQUIRE(event != nullptr);
	BOOST_CHECK_EQUAL(strlen(event->param2), static_cast<size_t>(LCC_API_AUDIT_EVENT_PARAM2));

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(invalid_options_fail_closed_with_malformed) {
	RuntimePolicyGuard guard;
	CallerInformations caller = default_caller();

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.size = 0;
	LicenseInfo size_info{};
	BOOST_CHECK_EQUAL(acquire_license_ex(&caller, nullptr, &size_info, &options), LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(size_info, LICENSE_MALFORMED));

	lcc_init_license_check_options(&options);
	options.version = LCC_LICENSE_CHECK_OPTIONS_VERSION + 1;
	LicenseInfo version_info{};
	BOOST_CHECK_EQUAL(acquire_license_ex(&caller, nullptr, &version_info, &options), LICENSE_MALFORMED);
	BOOST_CHECK(has_status_event(version_info, LICENSE_MALFORMED));
}

BOOST_AUTO_TEST_CASE(v1_options_size_remains_accepted_and_ignores_online_tail) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("anti-tamper-v1-options-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.size = static_cast<uint32_t>(offsetof(LicenseCheckOptions, online_policy));
	options.version = 1;
	options.tamper_policy = LCC_TAMPER_AUDIT;
	int calls = 0;
	options.host_integrity_check = failing_integrity_callback;
	options.host_integrity_user_data = &calls;
	options.online_policy = LCC_ONLINE_REQUIRE;
	options.online_check = nullptr;

	LicenseInfo info{};
	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK_EQUAL(calls, 1);
	BOOST_CHECK(find_status_event(info, LICENSE_TAMPER_DETECTED, SVRT_WARN) != nullptr);
	BOOST_CHECK(!has_status_event(info, LICENSE_ONLINE_REQUIRED));

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(invalid_license_result_is_not_masked_by_tamper_callback) {
	RuntimePolicyGuard guard;
	CallerInformations caller = default_caller();
	LicenseLocation location;
	lcc_init_license_location(&location, LICENSE_PLAIN_DATA);
	BOOST_REQUIRE(lcc_set_license_location_data(&location, LICENSE_PLAIN_DATA, "not ini"));

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.tamper_policy = LCC_TAMPER_ENFORCE;
	int calls = 0;
	options.host_integrity_check = failing_integrity_callback;
	options.host_integrity_user_data = &calls;

	LicenseInfo info{};
	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	BOOST_CHECK_EQUAL(result, LICENSE_MALFORMED);
	BOOST_CHECK_EQUAL(calls, 0);
	BOOST_CHECK(!has_status_event(info, LICENSE_TAMPER_DETECTED));
}

BOOST_AUTO_TEST_CASE(strict_source_shadowing_flag_reports_malformed_fallback_shadowing) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("anti-tamper-source-shadow-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();
	lcc_set_environment_license_sources_enabled(true);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, "!!!!");
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);
	options.tamper_flags = LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING;

	LicenseInfo audit_info{};
	BOOST_CHECK_EQUAL(acquire_license_ex(&caller, &location, &audit_info, &options), LICENSE_OK);
	BOOST_CHECK(find_status_event(audit_info, LICENSE_TAMPER_DETECTED, SVRT_WARN) != nullptr);

	options.tamper_policy = LCC_TAMPER_ENFORCE;
	LicenseInfo enforce_info{};
	BOOST_CHECK_EQUAL(acquire_license_ex(&caller, &location, &enforce_info, &options), LICENSE_TAMPER_DETECTED);
	BOOST_CHECK(find_status_event(enforce_info, LICENSE_TAMPER_DETECTED, SVRT_ERROR) != nullptr);

	std::remove(valid_path.c_str());
}

BOOST_AUTO_TEST_CASE(legacy_acquire_license_does_not_emit_tamper_signal) {
	RuntimePolicyGuard guard;
	const string valid_path = issue_valid_license_file("anti-tamper-legacy-valid");
	LicenseLocation location = license_path_location(valid_path);
	CallerInformations caller = default_caller();
	lcc_set_environment_license_sources_enabled(true);
	SETENV(LCC_LICENSE_DATA_ENV_VAR, "!!!!");
	UNSETENV(LCC_LICENSE_LOCATION_ENV_VAR);

	LicenseInfo info{};
	const LCC_EVENT_TYPE result = acquire_license(&caller, &location, &info);
	BOOST_CHECK_EQUAL(result, LICENSE_OK);
	BOOST_CHECK(!has_status_event(info, LICENSE_TAMPER_DETECTED));

	std::remove(valid_path.c_str());
}

}  // namespace test
}  // namespace license
