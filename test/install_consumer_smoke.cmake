function(_require_defined name)
	if(NOT DEFINED ${name} OR "${${name}}" STREQUAL "")
		message(FATAL_ERROR "${name} is required")
	endif()
endfunction()

function(_to_abs out path)
	get_filename_component(_abs "${path}" ABSOLUTE)
	set(${out} "${_abs}" PARENT_SCOPE)
endfunction()

function(_assert_under path root description)
	_to_abs(_path_abs "${path}")
	_to_abs(_root_abs "${root}")
	file(TO_CMAKE_PATH "${_path_abs}" _path_cmake)
	file(TO_CMAKE_PATH "${_root_abs}" _root_cmake)
	string(FIND "${_path_cmake}/" "${_root_cmake}/" _pos)
	if(NOT _pos EQUAL 0)
		message(FATAL_ERROR "${description} must be under ${_root_abs}: ${_path_abs}")
	endif()
endfunction()

function(_remove_safe path root description)
	_assert_under("${path}" "${root}" "${description}")
	file(REMOVE_RECURSE "${path}")
endfunction()

function(_run_checked description)
	execute_process(
		COMMAND ${ARGN}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR
			"${description} failed with exit code ${_result}\n"
			"Command: ${ARGN}\n"
			"stdout:\n${_stdout}\n"
			"stderr:\n${_stderr}")
	endif()
endfunction()

function(_append_generator_args out_var)
	if(DEFINED LICENSECC_GENERATOR AND NOT "${LICENSECC_GENERATOR}" STREQUAL "")
		list(APPEND ${out_var} -G "${LICENSECC_GENERATOR}")
	endif()
	if(DEFINED LICENSECC_GENERATOR_PLATFORM AND NOT "${LICENSECC_GENERATOR_PLATFORM}" STREQUAL "")
		list(APPEND ${out_var} -A "${LICENSECC_GENERATOR_PLATFORM}")
	endif()
	if(DEFINED LICENSECC_GENERATOR_TOOLSET AND NOT "${LICENSECC_GENERATOR_TOOLSET}" STREQUAL "")
		list(APPEND ${out_var} -T "${LICENSECC_GENERATOR_TOOLSET}")
	endif()
	set(${out_var} "${${out_var}}" PARENT_SCOPE)
endfunction()

function(_expect_configure_failure_from_source name expected_message source_dir prefix)
	set(_build_dir "${_smoke_root}/${name}")
	_remove_safe("${_build_dir}" "${_smoke_root}" "${name} build dir")

	set(_configure_command
		"${CMAKE_COMMAND}"
		-S "${source_dir}"
		-B "${_build_dir}"
		"-DCMAKE_PREFIX_PATH=${prefix}"
	)
	list(APPEND _configure_command ${ARGN})
	_append_generator_args(_configure_command)

	execute_process(
		COMMAND ${_configure_command}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	string(CONCAT _combined "${_stdout}\n${_stderr}")
	if(_result EQUAL 0)
		message(FATAL_ERROR "${name} unexpectedly configured successfully")
	endif()
	if(NOT _combined MATCHES "${expected_message}")
		message(FATAL_ERROR
			"${name} failed, but did not report the expected package error.\n"
			"Expected regex: ${expected_message}\n"
			"stdout:\n${_stdout}\n"
			"stderr:\n${_stderr}")
	endif()
endfunction()

function(_expect_configure_failure name expected_message)
	_expect_configure_failure_from_source(
		"${name}"
		"${expected_message}"
		"${LICENSECC_SOURCE_DIR}/examples/minimal"
		"${LICENSECC_INSTALL_PREFIX}"
		${ARGN}
	)
endfunction()

function(_write_generated_consumer source_dir find_package_line)
	_remove_safe("${source_dir}" "${_smoke_root}" "generated consumer source")
	file(MAKE_DIRECTORY "${source_dir}")
	file(COPY "${LICENSECC_SOURCE_DIR}/examples/minimal/main.cpp" DESTINATION "${source_dir}")
	file(WRITE "${source_dir}/CMakeLists.txt"
"cmake_minimum_required(VERSION 3.16)
project(licensecc_generated_consumer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

${find_package_line}

add_executable(minimal main.cpp)
target_link_libraries(minimal PRIVATE licensecc::licensecc_static)
")
endfunction()

function(_write_identity_consumer source_dir find_package_lines expected_project expected_magic expected_profile expected_public_key_sha expected_public_key_der_sha expected_public_key_id expected_abi expected_build_config)
	_remove_safe("${source_dir}" "${_smoke_root}" "identity consumer source")
	file(MAKE_DIRECTORY "${source_dir}")
	file(COPY "${LICENSECC_SOURCE_DIR}/examples/minimal/main.cpp" DESTINATION "${source_dir}")
	file(WRITE "${source_dir}/CMakeLists.txt"
"cmake_minimum_required(VERSION 3.16)
project(licensecc_identity_consumer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

${find_package_lines}

if(NOT TARGET licensecc::licensecc_static)
	message(FATAL_ERROR \"licensecc::licensecc_static was not imported\")
endif()
if(NOT licensecc_PROJECT_NAME STREQUAL \"${expected_project}\")
	message(FATAL_ERROR \"licensecc_PROJECT_NAME mismatch: \${licensecc_PROJECT_NAME}\")
endif()
if(NOT licensecc_PROJECT_MAGIC_NUM STREQUAL \"${expected_magic}\")
	message(FATAL_ERROR \"licensecc_PROJECT_MAGIC_NUM mismatch: \${licensecc_PROJECT_MAGIC_NUM}\")
endif()
if(NOT licensecc_PACKAGE_PROFILE STREQUAL \"${expected_profile}\")
	message(FATAL_ERROR \"licensecc_PACKAGE_PROFILE mismatch: \${licensecc_PACKAGE_PROFILE}\")
endif()
if(NOT licensecc_LICENSE_FORMAT_MIN STREQUAL \"200\")
	message(FATAL_ERROR \"licensecc_LICENSE_FORMAT_MIN mismatch: \${licensecc_LICENSE_FORMAT_MIN}\")
endif()
if(NOT licensecc_LICENSE_FORMAT_MAX STREQUAL \"201\")
	message(FATAL_ERROR \"licensecc_LICENSE_FORMAT_MAX mismatch: \${licensecc_LICENSE_FORMAT_MAX}\")
endif()
if(NOT licensecc_PUBLIC_KEY_SHA256 STREQUAL \"${expected_public_key_sha}\")
	message(FATAL_ERROR \"licensecc_PUBLIC_KEY_SHA256 mismatch: \${licensecc_PUBLIC_KEY_SHA256}\")
endif()
if(NOT licensecc_PUBLIC_KEY_DER_SHA256 STREQUAL \"${expected_public_key_der_sha}\")
	message(FATAL_ERROR \"licensecc_PUBLIC_KEY_DER_SHA256 mismatch: \${licensecc_PUBLIC_KEY_DER_SHA256}\")
endif()
if(NOT licensecc_PUBLIC_KEY_ID STREQUAL \"${expected_public_key_id}\")
	message(FATAL_ERROR \"licensecc_PUBLIC_KEY_ID mismatch: \${licensecc_PUBLIC_KEY_ID}\")
endif()
if(NOT licensecc_ABI_TAG STREQUAL \"${expected_abi}\")
	message(FATAL_ERROR \"licensecc_ABI_TAG mismatch: \${licensecc_ABI_TAG}\")
endif()
if(NOT licensecc_BUILD_CONFIG STREQUAL \"${expected_build_config}\")
	message(FATAL_ERROR \"licensecc_BUILD_CONFIG mismatch: \${licensecc_BUILD_CONFIG}\")
endif()

set(_expected_identity
	LICENSECC_PROJECT_NAME \"${expected_project}\"
	LICENSECC_PROJECT_MAGIC_NUM \"${expected_magic}\"
	LICENSECC_PACKAGE_PROFILE \"${expected_profile}\"
	LICENSECC_LICENSE_FORMAT_MIN \"200\"
	LICENSECC_LICENSE_FORMAT_MAX \"201\"
	LICENSECC_PUBLIC_KEY_SHA256 \"${expected_public_key_sha}\"
	LICENSECC_PUBLIC_KEY_DER_SHA256 \"${expected_public_key_der_sha}\"
	LICENSECC_PUBLIC_KEY_ID \"${expected_public_key_id}\"
	LICENSECC_ABI_TAG \"${expected_abi}\"
	LICENSECC_BUILD_CONFIG \"${expected_build_config}\")
while(_expected_identity)
	list(POP_FRONT _expected_identity _prop _expected)
	get_target_property(_actual licensecc::licensecc_static \${_prop})
	if(NOT DEFINED _actual OR \"\${_actual}\" STREQUAL \"_actual-NOTFOUND\")
		message(FATAL_ERROR \"Missing target identity property \${_prop}\")
	endif()
	if(NOT \"\${_actual}\" STREQUAL \"\${_expected}\")
		message(FATAL_ERROR \"Target identity property \${_prop} mismatch: \${_actual}\")
	endif()
endwhile()

add_executable(minimal main.cpp)
target_link_libraries(minimal PRIVATE licensecc::licensecc_static)
")
endfunction()

function(_write_header_hygiene_consumer source_dir project_name expected_magic)
	_remove_safe("${source_dir}" "${_smoke_root}" "header hygiene consumer source")
	file(MAKE_DIRECTORY "${source_dir}/fake")
	file(WRITE "${source_dir}/fake/licensecc_properties.h"
"#error \"consumer include path shadowed the project-scoped licensecc properties header\"
")
	file(WRITE "${source_dir}/main.cpp"
"#include <licensecc/licensecc.h>

#ifdef min
#error \"licensecc public headers must not define min\"
#endif
#ifdef max
#error \"licensecc public headers must not define max\"
#endif

static_assert(sizeof(AuditEvent{}.license_reference) == LCC_API_PATH_SIZE, \"path size macro mismatch\");
static_assert(LCC_PROJECT_MAGIC_NUM == ${expected_magic}, \"wrong generated project properties header\");

int main() {
	CallerInformations caller{};
	caller.magic = LCC_PROJECT_MAGIC_NUM;
	return caller.magic == ${expected_magic} ? 0 : 1;
}
")
	file(WRITE "${source_dir}/CMakeLists.txt"
"cmake_minimum_required(VERSION 3.16)
project(licensecc_header_hygiene_consumer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(licensecc REQUIRED COMPONENTS ${project_name})

add_executable(header_hygiene main.cpp)
target_include_directories(header_hygiene BEFORE PRIVATE \"\${CMAKE_CURRENT_SOURCE_DIR}/fake\")
target_link_libraries(header_hygiene PRIVATE licensecc::licensecc_static)
")
endfunction()

function(_write_cxx11_consumer source_dir project_name expected_magic)
	_remove_safe("${source_dir}" "${_smoke_root}" "C++11 consumer source")
	file(MAKE_DIRECTORY "${source_dir}")
	file(WRITE "${source_dir}/main.cpp"
"#include <cstddef>
#include <licensecc/licensecc.h>

#if defined(_WIN32)
static_assert(LCC_API_PATH_SIZE == 260, \"Windows path ABI size changed\");
static_assert(sizeof(AuditEvent) == 524, \"Windows AuditEvent ABI size changed\");
static_assert(sizeof(LicenseInfo) == 2668, \"Windows LicenseInfo ABI size changed\");
#else
static_assert(LCC_API_PATH_SIZE == 1024, \"Unix path ABI size changed\");
static_assert(sizeof(AuditEvent) == 1288, \"Unix AuditEvent ABI size changed\");
static_assert(sizeof(LicenseInfo) == 6488, \"Unix LicenseInfo ABI size changed\");
#endif

static_assert(LCC_API_MAX_LICENSE_DATA_LENGTH == 4096, \"license-data ABI limit changed\");
static_assert(LCC_API_PC_IDENTIFIER_SIZE == 19, \"PC identifier ABI limit changed\");
static_assert(LCC_API_PROPRIETARY_DATA_SIZE == 16, \"proprietary-data ABI limit changed\");
static_assert(LCC_API_AUDIT_EVENT_NUM == 5, \"audit-event count changed\");
static_assert(LCC_API_AUDIT_EVENT_PARAM2 == 255, \"audit-event param2 size changed\");
static_assert(LCC_API_VERSION_LENGTH == 15, \"version ABI limit changed\");
static_assert(LCC_API_FEATURE_NAME_SIZE == 15, \"feature-name ABI limit changed\");
static_assert(LCC_API_EXPIRY_DATE_SIZE == 10, \"expiry-date ABI limit changed\");
static_assert(LCC_API_ERROR_BUFFER_SIZE == 256, \"error-buffer ABI limit changed\");
static_assert(offsetof(AuditEvent, severity) == 0, \"AuditEvent severity offset changed\");
static_assert(offsetof(AuditEvent, event_type) == 4, \"AuditEvent event_type offset changed\");
static_assert(offsetof(AuditEvent, license_reference) == 8, \"AuditEvent license_reference offset changed\");
static_assert(offsetof(AuditEvent, param2) == 8 + LCC_API_PATH_SIZE, \"AuditEvent param2 offset changed\");
static_assert(sizeof(LicenseLocation) == 4100, \"LicenseLocation ABI size changed\");
static_assert(offsetof(LicenseLocation, licenseData) == 4, \"LicenseLocation data offset changed\");
static_assert(sizeof(CallerInformations) == 36, \"CallerInformations ABI size changed\");
static_assert(offsetof(CallerInformations, feature_name) == 16, \"CallerInformations feature offset changed\");
static_assert(offsetof(CallerInformations, magic) == 32, \"CallerInformations magic offset changed\");
static_assert(static_cast<int>(LICENSE_OK) == 0, \"LICENSE_OK value changed\");
static_assert(static_cast<int>(LICENSE_MALFORMED) == 5, \"LICENSE_MALFORMED value changed\");
static_assert(static_cast<int>(LICENSE_CORRUPTED) == 8, \"LICENSE_CORRUPTED value changed\");
static_assert(static_cast<int>(STRATEGY_DEFAULT) == -1, \"STRATEGY_DEFAULT value changed\");
static_assert(static_cast<int>(STRATEGY_ETHERNET) == 0, \"STRATEGY_ETHERNET value changed\");

int main() {
	CallerInformations caller = {};
	caller.magic = LCC_PROJECT_MAGIC_NUM;
	LicenseInfo info = {};
	LCC_EVENT_TYPE (*acquire_ptr)(const CallerInformations*, const LicenseLocation*, LicenseInfo*) = &acquire_license;
	const char* (*strerror_ptr)(LCC_EVENT_TYPE) = &lcc_strerror;
	return (caller.magic == ${expected_magic} &&
			sizeof(info.status[0].license_reference) == LCC_API_PATH_SIZE &&
			acquire_ptr != 0 &&
			strerror_ptr != 0) ? 0 : 1;
}
")
	file(WRITE "${source_dir}/CMakeLists.txt"
"cmake_minimum_required(VERSION 3.16)
project(licensecc_cxx11_consumer CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(licensecc REQUIRED COMPONENTS ${project_name})

add_executable(cxx11_consumer main.cpp)
target_link_libraries(cxx11_consumer PRIVATE licensecc::licensecc_static)
")
endfunction()

function(_write_decision_consumer source_dir project_name)
	_remove_safe("${source_dir}" "${_smoke_root}" "decision consumer source")
	file(MAKE_DIRECTORY "${source_dir}")
	file(WRITE "${source_dir}/main.cpp"
"#include <cstdio>
#include <cstring>
#include <licensecc/licensecc.h>

static int online_calls = 0;
static int floor_load_calls = 0;
static int floor_store_calls = 0;

static LCC_ONLINE_CALLBACK_STATUS online_callback(void*, const LccOnlineRequest*, char*, size_t*) {
	++online_calls;
	return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
}

static bool host_integrity_callback(void*, char* detail_out, size_t detail_out_size) {
	if (detail_out != nullptr && detail_out_size > 0) {
		std::snprintf(detail_out, detail_out_size, \"installed consumer forced host failure\");
	}
	return false;
}

static bool floor_load_callback(void*, const LccRevocationFloorRecord*, uint64_t* revocation_seq_out) {
	++floor_load_calls;
	if (revocation_seq_out != nullptr) {
		*revocation_seq_out = 0;
	}
	return true;
}

static bool floor_store_callback(void*, const LccRevocationFloorRecord*) {
	++floor_store_calls;
	return true;
}

int main(int argc, char** argv) {
	if (argc != 2) {
		return 2;
	}
	CallerInformations caller;
	lcc_init_caller_informations(&caller);
	LicenseLocation location;
	lcc_init_license_location(&location, LICENSE_PATH);
	if (!lcc_set_license_path(&location, argv[1])) {
		return 2;
	}
	LicenseInfo info;
	LccLicenseDecision decision;
	LccLicenseDecisionOptions options;
	lcc_init_license_decision_options(&options);
	options.online_check = online_callback;
	options.host_integrity_check = host_integrity_callback;
	options.revocation_floor_load = floor_load_callback;
	options.revocation_floor_store = floor_store_callback;
	const LCC_EVENT_TYPE result = lcc_acquire_license_decision(&caller, &location, &info, &decision, &options);
	if (result != LICENSE_TAMPER_DETECTED || decision.decision != LCC_LICENSE_DECISION_DENY ||
		!decision.tamper_enforced || online_calls != 0 || floor_load_calls != 0 || floor_store_calls != 0) {
		return 1;
	}
	return 0;
}
")
	file(WRITE "${source_dir}/CMakeLists.txt"
"cmake_minimum_required(VERSION 3.16)
project(licensecc_decision_consumer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(licensecc REQUIRED COMPONENTS ${project_name})

add_executable(decision_consumer main.cpp)
target_link_libraries(decision_consumer PRIVATE licensecc::licensecc_static)
")
endfunction()

function(_configure_and_build_consumer description source_dir build_dir prefix)
	_remove_safe("${build_dir}" "${_smoke_root}" "${description} build dir")
	set(_configure_command
		"${CMAKE_COMMAND}"
		-S "${source_dir}"
		-B "${build_dir}"
		"-DCMAKE_PREFIX_PATH=${prefix}"
	)
	list(APPEND _configure_command ${ARGN})
	_append_generator_args(_configure_command)
	_run_checked("${description} configure" ${_configure_command})

	file(STRINGS "${build_dir}/CMakeCache.txt" _licensecc_dir_line REGEX "^licensecc_DIR:PATH=")
	if(NOT _licensecc_dir_line)
		message(FATAL_ERROR "${description} cache does not contain licensecc_DIR")
	endif()
	string(REPLACE "licensecc_DIR:PATH=" "" _licensecc_dir "${_licensecc_dir_line}")
	_assert_under("${_licensecc_dir}" "${prefix}" "${description} resolved licensecc_DIR")

	set(_build_command "${CMAKE_COMMAND}" --build "${build_dir}")
	if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
		list(APPEND _build_command --config "${LICENSECC_CONFIG}")
	endif()
	_run_checked("${description} build" ${_build_command})
endfunction()

function(_find_built_executable out_var build_dir target_name)
	set(_candidates
		"${build_dir}/${LICENSECC_CONFIG}/${target_name}.exe"
		"${build_dir}/${target_name}.exe"
		"${build_dir}/${LICENSECC_CONFIG}/${target_name}"
		"${build_dir}/${target_name}"
	)
	foreach(_candidate IN LISTS _candidates)
		if(EXISTS "${_candidate}")
			set(${out_var} "${_candidate}" PARENT_SCOPE)
			return()
		endif()
	endforeach()
	message(FATAL_ERROR "Could not find built ${target_name} executable under ${build_dir}")
endfunction()

function(_find_lccgen out_var)
	set(_lccgen_candidates
		"${LICENSECC_BUILD_DIR}/extern/license-generator/src/license_generator/${LICENSECC_CONFIG}/lccgen.exe"
		"${LICENSECC_BUILD_DIR}/extern/license-generator/src/license_generator/lccgen.exe"
		"${LICENSECC_BUILD_DIR}/extern/license-generator/src/license_generator/${LICENSECC_CONFIG}/lccgen"
		"${LICENSECC_BUILD_DIR}/extern/license-generator/src/license_generator/lccgen"
	)
	foreach(_candidate IN LISTS _lccgen_candidates)
		if(EXISTS "${_candidate}")
			set(${out_var} "${_candidate}" PARENT_SCOPE)
			return()
		endif()
	endforeach()
	message(FATAL_ERROR "Could not find built lccgen under ${LICENSECC_BUILD_DIR}")
endfunction()

function(_issue_license name out_var)
	set(_license_path "${_licenses_dir}/${name}.lic")
	set(_project_dir "${LICENSECC_PROJECTS_BASE_DIR}/${LICENSECC_PROJECT_NAME}")
	set(_private_key "${_project_dir}/private_key.rsa")
	if(NOT EXISTS "${_private_key}")
		message(FATAL_ERROR "Cannot issue ${name}: missing private key ${_private_key}")
	endif()
	_run_checked(
		"issue ${name} license"
		"${_lccgen_exe}"
		license issue
		--primary-key "${_private_key}"
		--output-file-name "${_license_path}"
		--project-folder "${_project_dir}"
		${ARGN}
	)
	if(NOT EXISTS "${_license_path}")
		message(FATAL_ERROR "Issue command did not create ${_license_path}")
	endif()
	set(${out_var} "${_license_path}" PARENT_SCOPE)
endfunction()

_require_defined(LICENSECC_SOURCE_DIR)
_require_defined(LICENSECC_BUILD_DIR)
_require_defined(LICENSECC_INSTALL_PREFIX)
_require_defined(LICENSECC_CONSUMER_BUILD_DIR)
_require_defined(LICENSECC_PROJECT_NAME)
_require_defined(LICENSECC_PROJECTS_BASE_DIR)
_require_defined(LICENSECC_PROJECT_MAGIC_NUM)
_require_defined(LICENSECC_PACKAGE_ABI_TAG)

if(NOT DEFINED LICENSECC_CONFIG)
	set(LICENSECC_CONFIG "")
endif()

_to_abs(LICENSECC_SOURCE_DIR "${LICENSECC_SOURCE_DIR}")
_to_abs(LICENSECC_BUILD_DIR "${LICENSECC_BUILD_DIR}")
_to_abs(LICENSECC_INSTALL_PREFIX "${LICENSECC_INSTALL_PREFIX}")
_to_abs(LICENSECC_CONSUMER_BUILD_DIR "${LICENSECC_CONSUMER_BUILD_DIR}")
_to_abs(LICENSECC_PROJECTS_BASE_DIR "${LICENSECC_PROJECTS_BASE_DIR}")
set(_smoke_root "${LICENSECC_BUILD_DIR}/Testing/install-consumer")
set(_licenses_dir "${_smoke_root}/${LICENSECC_CONFIG}/licenses")
include("${LICENSECC_SOURCE_DIR}/test/release_manifest_assertions.cmake")

_remove_safe("${LICENSECC_INSTALL_PREFIX}" "${_smoke_root}" "install prefix")
_remove_safe("${LICENSECC_CONSUMER_BUILD_DIR}" "${_smoke_root}" "consumer build dir")
_remove_safe("${_licenses_dir}" "${_smoke_root}" "install smoke licenses dir")
file(MAKE_DIRECTORY "${_licenses_dir}")
_find_lccgen(_lccgen_exe)

set(_install_command
	"${CMAKE_COMMAND}"
	--install "${LICENSECC_BUILD_DIR}"
	--prefix "${LICENSECC_INSTALL_PREFIX}"
)
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _install_command --config "${LICENSECC_CONFIG}")
endif()
_run_checked("licensecc install" ${_install_command})

set(_config_file "${LICENSECC_INSTALL_PREFIX}/lib/cmake/licensecc/licensecc-config.cmake")
set(_export_file "${LICENSECC_INSTALL_PREFIX}/lib/licensecc/${LICENSECC_PROJECT_NAME}/cmake/licensecc.cmake")
set(_properties_file "${LICENSECC_INSTALL_PREFIX}/include/licensecc/${LICENSECC_PROJECT_NAME}/licensecc_properties.h")
set(_public_key_file "${LICENSECC_INSTALL_PREFIX}/include/licensecc/${LICENSECC_PROJECT_NAME}/public_key.h")
set(_manifest_file "${LICENSECC_INSTALL_PREFIX}/share/licensecc/${LICENSECC_PROJECT_NAME}/release-manifest.cmake")
foreach(_required_file IN LISTS _config_file _export_file _properties_file _public_key_file _manifest_file)
	if(NOT EXISTS "${_required_file}")
		message(FATAL_ERROR "Expected installed file is missing: ${_required_file}")
	endif()
endforeach()
lcc_assert_release_manifest(
	"${LICENSECC_INSTALL_PREFIX}"
	"${LICENSECC_PROJECT_NAME}"
	"${LICENSECC_PROJECT_MAGIC_NUM}"
	"${LICENSECC_CONFIG}"
	"installed runtime"
)
lcc_read_release_manifest("${_manifest_file}")
if(NOT LCC_RELEASE_ABI_TAG STREQUAL "${LICENSECC_PACKAGE_ABI_TAG}")
	message(FATAL_ERROR
		"Installed release manifest has wrong ABI tag.\n"
		"Expected: ${LICENSECC_PACKAGE_ABI_TAG}\n"
		"Actual: ${LCC_RELEASE_ABI_TAG}")
endif()
_run_checked(
	"installed release manifest summary"
	"${CMAKE_COMMAND}"
	"-DLCC_RELEASE_MANIFEST_PREFIX=${LICENSECC_INSTALL_PREFIX}"
	"-DLCC_RELEASE_MANIFEST_PROJECT_NAME=${LICENSECC_PROJECT_NAME}"
	-P "${LICENSECC_SOURCE_DIR}/cmake/PrintReleaseManifestSummary.cmake"
)
file(STRINGS "${_properties_file}" _magic_define REGEX "^#define LCC_PROJECT_MAGIC_NUM ")
if(NOT _magic_define STREQUAL "#define LCC_PROJECT_MAGIC_NUM ${LICENSECC_PROJECT_MAGIC_NUM}")
	message(FATAL_ERROR
		"Installed generated properties expose the wrong LCC_PROJECT_MAGIC_NUM.\n"
		"Expected: #define LCC_PROJECT_MAGIC_NUM ${LICENSECC_PROJECT_MAGIC_NUM}\n"
		"Actual: ${_magic_define}")
endif()

file(GLOB_RECURSE _private_keys "${LICENSECC_INSTALL_PREFIX}/*private_key.rsa")
if(_private_keys)
	message(FATAL_ERROR "Install contains private key material: ${_private_keys}")
endif()
_run_checked(
	"runtime artifact scan"
	"${CMAKE_COMMAND}"
	"-DLCC_ARTIFACT_SCAN_ROOT=${LICENSECC_INSTALL_PREFIX}"
	"-DLCC_ARTIFACT_ALLOW_TOOLS=OFF"
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=${LICENSECC_PROJECT_NAME}"
	-P "${LICENSECC_SOURCE_DIR}/cmake/ScanReleaseArtifact.cmake"
)

set(_configure_command
	"${CMAKE_COMMAND}"
	-S "${LICENSECC_SOURCE_DIR}/examples/minimal"
	-B "${LICENSECC_CONSUMER_BUILD_DIR}"
	"-DCMAKE_PREFIX_PATH=${LICENSECC_INSTALL_PREFIX}"
	"-DLCC_PROJECT_NAME=${LICENSECC_PROJECT_NAME}"
)
_append_generator_args(_configure_command)
_run_checked("external consumer configure" ${_configure_command})

file(STRINGS "${LICENSECC_CONSUMER_BUILD_DIR}/CMakeCache.txt" _licensecc_dir_line REGEX "^licensecc_DIR:PATH=")
if(NOT _licensecc_dir_line)
	message(FATAL_ERROR "Consumer cache does not contain licensecc_DIR")
endif()
string(REPLACE "licensecc_DIR:PATH=" "" _licensecc_dir "${_licensecc_dir_line}")
_assert_under("${_licensecc_dir}" "${LICENSECC_INSTALL_PREFIX}" "resolved licensecc_DIR")

set(_build_command "${CMAKE_COMMAND}" --build "${LICENSECC_CONSUMER_BUILD_DIR}")
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _build_command --config "${LICENSECC_CONFIG}")
endif()
_run_checked("external consumer build" ${_build_command})

set(_minimal_candidates
	"${LICENSECC_CONSUMER_BUILD_DIR}/${LICENSECC_CONFIG}/minimal.exe"
	"${LICENSECC_CONSUMER_BUILD_DIR}/minimal.exe"
	"${LICENSECC_CONSUMER_BUILD_DIR}/${LICENSECC_CONFIG}/minimal"
	"${LICENSECC_CONSUMER_BUILD_DIR}/minimal"
)
set(_minimal_exe "")
foreach(_candidate IN LISTS _minimal_candidates)
	if(EXISTS "${_candidate}")
		set(_minimal_exe "${_candidate}")
		break()
	endif()
endforeach()
if("${_minimal_exe}" STREQUAL "")
	message(FATAL_ERROR "Could not find built minimal executable under ${LICENSECC_CONSUMER_BUILD_DIR}")
endif()

set(_missing_license "${LICENSECC_INSTALL_PREFIX}/definitely-missing.lic")
execute_process(
	COMMAND "${_minimal_exe}" "${_missing_license}"
	RESULT_VARIABLE _run_result
	OUTPUT_VARIABLE _run_stdout
	ERROR_VARIABLE _run_stderr
)
string(CONCAT _run_output "${_run_stdout}\n${_run_stderr}")
if(NOT _run_result EQUAL 1)
	message(FATAL_ERROR
		"minimal returned ${_run_result}; expected 1 for missing license.\n"
		"output:\n${_run_output}")
endif()
if(NOT _run_output MATCHES "license check failed")
	message(FATAL_ERROR "minimal output did not contain the fail-closed summary:\n${_run_output}")
endif()
if(NOT _run_output MATCHES "license file not found")
	message(FATAL_ERROR "minimal output did not contain the missing-file diagnostic:\n${_run_output}")
endif()

set(_host_source_dir "${LICENSECC_SOURCE_DIR}/examples/fail_closed_host")
set(_host_build_dir "${_smoke_root}/fail-closed-host-build")
_configure_and_build_consumer(
	"fail-closed host"
	"${_host_source_dir}"
	"${_host_build_dir}"
	"${LICENSECC_INSTALL_PREFIX}"
	"-DLCC_PROJECT_NAME=${LICENSECC_PROJECT_NAME}"
)
_find_built_executable(_host_exe "${_host_build_dir}" "fail_closed_host")
execute_process(
	COMMAND "${_host_exe}" "${_missing_license}" "1.0.0"
	RESULT_VARIABLE _host_result
	OUTPUT_VARIABLE _host_stdout
	ERROR_VARIABLE _host_stderr
)
string(CONCAT _host_output "${_host_stdout}\n${_host_stderr}")
if(NOT _host_result EQUAL 1)
	message(FATAL_ERROR
		"fail-closed host returned ${_host_result}; expected 1 for missing license.\n"
		"output:\n${_host_output}")
endif()
foreach(_expected "application unavailable" "REPORTS unavailable" "EXPORT unavailable" "license file not found")
	if(NOT _host_output MATCHES "${_expected}")
		message(FATAL_ERROR "fail-closed host output did not contain ${_expected}:\n${_host_output}")
	endif()
endforeach()
foreach(_forbidden "application enabled" "REPORTS enabled" "EXPORT enabled")
	if(_host_output MATCHES "${_forbidden}")
		message(FATAL_ERROR "fail-closed host output unexpectedly contained ${_forbidden}:\n${_host_output}")
	endif()
endforeach()

_issue_license("host_source_fatal_valid" _host_source_fatal_valid --extra-data source-fatal-ok)
get_filename_component(_host_exe_dir "${_host_exe}" DIRECTORY)
get_filename_component(_host_exe_name_we "${_host_exe}" NAME_WE)
set(_host_near_license "${_host_exe_dir}/${_host_exe_name_we}.lic")
file(WRITE "${_host_near_license}" "[${LICENSECC_PROJECT_NAME}]\nlic_ver = 200\n")
execute_process(
	COMMAND "${_host_exe}" "${_host_source_fatal_valid}" "1.0.0"
	RESULT_VARIABLE _host_source_fatal_result
	OUTPUT_VARIABLE _host_source_fatal_stdout
	ERROR_VARIABLE _host_source_fatal_stderr
)
file(REMOVE "${_host_near_license}")
string(CONCAT _host_source_fatal_output "${_host_source_fatal_stdout}\n${_host_source_fatal_stderr}")
if(NOT _host_source_fatal_result EQUAL 1)
	message(FATAL_ERROR
		"fail-closed host source-fatal case returned ${_host_source_fatal_result}; expected 1.\n"
		"output:\n${_host_source_fatal_output}")
endif()
foreach(_expected "application unavailable" "REPORTS unavailable" "EXPORT unavailable" "mandatory fields are missing")
	if(NOT _host_source_fatal_output MATCHES "${_expected}")
		message(FATAL_ERROR "fail-closed host source-fatal output did not contain ${_expected}:\n${_host_source_fatal_output}")
	endif()
endforeach()
foreach(_forbidden "application enabled" "REPORTS enabled" "EXPORT enabled" "signed data: source-fatal-ok")
	if(_host_source_fatal_output MATCHES "${_forbidden}")
		message(FATAL_ERROR "fail-closed host source-fatal output unexpectedly contained ${_forbidden}:\n${_host_source_fatal_output}")
	endif()
endforeach()

set(_decision_source "${_smoke_root}/decision-consumer-src")
set(_decision_build "${_smoke_root}/decision-consumer-build")
_write_decision_consumer("${_decision_source}" "${LICENSECC_PROJECT_NAME}")
_configure_and_build_consumer(
	"decision wrapper consumer"
	"${_decision_source}"
	"${_decision_build}"
	"${LICENSECC_INSTALL_PREFIX}"
)
_find_built_executable(_decision_exe "${_decision_build}" "decision_consumer")
_run_checked("decision wrapper consumer forced tamper denial" "${_decision_exe}" "${_host_source_fatal_valid}")

_expect_configure_failure(
	"wrong-project"
	"licensecc project NOT_INSTALLED is missing release metadata"
	"-DLCC_PROJECT_NAME=NOT_INSTALLED"
)
_expect_configure_failure(
	"missing-project"
	"licensecc project not selected"
)

set(_component_source "${_smoke_root}/component-consumer-src")
_write_identity_consumer(
	"${_component_source}"
	"find_package(licensecc REQUIRED COMPONENTS ${LICENSECC_PROJECT_NAME})
find_package(licensecc REQUIRED COMPONENTS ${LICENSECC_PROJECT_NAME})"
	"${LICENSECC_PROJECT_NAME}"
	"${LICENSECC_PROJECT_MAGIC_NUM}"
	"${LCC_RELEASE_PACKAGE_PROFILE}"
	"${LCC_RELEASE_PUBLIC_KEY_SHA256}"
	"${LCC_RELEASE_PUBLIC_KEY_DER_SHA256}"
	"${LCC_RELEASE_PUBLIC_KEY_ID}"
	"${LCC_RELEASE_ABI_TAG}"
	"${LCC_RELEASE_BUILD_CONFIG}"
)
_configure_and_build_consumer(
	"component metadata and idempotency consumer"
	"${_component_source}"
	"${_smoke_root}/component-consumer-build"
	"${LICENSECC_INSTALL_PREFIX}"
)

set(_relocated_prefix "${_smoke_root}/relocated install prefix")
_remove_safe("${_relocated_prefix}" "${_smoke_root}" "relocated install prefix")
_run_checked(
	"relocate install prefix"
	"${CMAKE_COMMAND}" -E copy_directory "${LICENSECC_INSTALL_PREFIX}" "${_relocated_prefix}"
)
_configure_and_build_consumer(
	"relocated component consumer"
	"${_component_source}"
	"${_smoke_root}/relocated-component-consumer-build"
	"${_relocated_prefix}"
)

set(_header_hygiene_source "${_smoke_root}/header-hygiene-src")
_write_header_hygiene_consumer(
	"${_header_hygiene_source}"
	"${LICENSECC_PROJECT_NAME}"
	"${LICENSECC_PROJECT_MAGIC_NUM}"
)
_configure_and_build_consumer(
	"header hygiene consumer"
	"${_header_hygiene_source}"
	"${_smoke_root}/header-hygiene-build"
	"${LICENSECC_INSTALL_PREFIX}"
)

set(_cxx11_source "${_smoke_root}/cxx11-consumer-src")
_write_cxx11_consumer(
	"${_cxx11_source}"
	"${LICENSECC_PROJECT_NAME}"
	"${LICENSECC_PROJECT_MAGIC_NUM}"
)
_configure_and_build_consumer(
	"C++11 public API consumer"
	"${_cxx11_source}"
	"${_smoke_root}/cxx11-consumer-build"
	"${LICENSECC_INSTALL_PREFIX}"
)

if(NOT "${LCC_RELEASE_BUILD_CONFIG}" STREQUAL "")
	set(_mismatched_consumer_config "Release")
	if("${LCC_RELEASE_BUILD_CONFIG}" STREQUAL "Release")
		set(_mismatched_consumer_config "Debug")
	endif()
	_expect_configure_failure_from_source(
		"wrong-build-config"
		"packaged for build config"
		"${_component_source}"
		"${LICENSECC_INSTALL_PREFIX}"
		"-DCMAKE_BUILD_TYPE=${_mismatched_consumer_config}"
	)
endif()

set(_other_project "${LICENSECC_PROJECT_NAME}_OTHER")
set(_other_export_dir "${LICENSECC_INSTALL_PREFIX}/lib/licensecc/${_other_project}")
set(_other_manifest_dir "${LICENSECC_INSTALL_PREFIX}/share/licensecc/${_other_project}")
set(_other_include_dir "${LICENSECC_INSTALL_PREFIX}/include/licensecc/${_other_project}")
file(MAKE_DIRECTORY "${_other_export_dir}" "${_other_manifest_dir}" "${_other_include_dir}")
file(COPY "${LICENSECC_INSTALL_PREFIX}/lib/licensecc/${LICENSECC_PROJECT_NAME}/cmake" DESTINATION "${_other_export_dir}")
file(COPY "${LICENSECC_INSTALL_PREFIX}/include/licensecc/${LICENSECC_PROJECT_NAME}/public_key.h" DESTINATION "${_other_include_dir}")
file(COPY "${LICENSECC_INSTALL_PREFIX}/include/licensecc/${LICENSECC_PROJECT_NAME}/licensecc_properties.h" DESTINATION "${_other_include_dir}")
file(READ "${_manifest_file}" _other_manifest)
string(REPLACE "set(LCC_RELEASE_PROJECT_NAME \"${LICENSECC_PROJECT_NAME}\")" "set(LCC_RELEASE_PROJECT_NAME \"${_other_project}\")" _other_manifest "${_other_manifest}")
string(REPLACE "set(LCC_RELEASE_PROJECT_MAGIC_NUM \"${LICENSECC_PROJECT_MAGIC_NUM}\")" "set(LCC_RELEASE_PROJECT_MAGIC_NUM \"987654\")" _other_manifest "${_other_manifest}")
string(REPLACE "include/licensecc/${LICENSECC_PROJECT_NAME}/" "include/licensecc/${_other_project}/" _other_manifest "${_other_manifest}")
file(WRITE "${_other_manifest_dir}/release-manifest.cmake" "${_other_manifest}")

set(_two_project_source "${_smoke_root}/two-project-src")
_write_generated_consumer(
	"${_two_project_source}"
	"find_package(licensecc REQUIRED COMPONENTS ${LICENSECC_PROJECT_NAME})
find_package(licensecc REQUIRED COMPONENTS ${_other_project})"
)
_expect_configure_failure_from_source(
	"two-project-target-reuse"
	"LICENSECC_PROJECT_NAME"
	"${_two_project_source}"
	"${LICENSECC_INSTALL_PREFIX}"
)

set(_missing_metadata_source "${_smoke_root}/missing-target-metadata-src")
_write_generated_consumer(
	"${_missing_metadata_source}"
	"add_library(licensecc::licensecc_static STATIC IMPORTED)
find_package(licensecc REQUIRED COMPONENTS ${LICENSECC_PROJECT_NAME})"
)
_expect_configure_failure_from_source(
	"missing-target-metadata"
	"LICENSECC_PROJECT_NAME"
	"${_missing_metadata_source}"
	"${LICENSECC_INSTALL_PREFIX}"
)

set(_wrong_metadata_source "${_smoke_root}/wrong-target-metadata-src")
_write_generated_consumer(
	"${_wrong_metadata_source}"
	"add_library(licensecc::licensecc_static STATIC IMPORTED)
set_target_properties(licensecc::licensecc_static PROPERTIES
	LICENSECC_PROJECT_NAME WRONG_PROJECT
	LICENSECC_PROJECT_MAGIC_NUM ${LICENSECC_PROJECT_MAGIC_NUM}
	LICENSECC_PACKAGE_PROFILE ${LCC_RELEASE_PACKAGE_PROFILE}
	LICENSECC_PUBLIC_KEY_SHA256 ${LCC_RELEASE_PUBLIC_KEY_SHA256}
	LICENSECC_ABI_TAG ${LCC_RELEASE_ABI_TAG}
	LICENSECC_BUILD_CONFIG ${LCC_RELEASE_BUILD_CONFIG})
find_package(licensecc REQUIRED COMPONENTS ${LICENSECC_PROJECT_NAME})"
)
_expect_configure_failure_from_source(
	"wrong-target-metadata"
	"LICENSECC_PROJECT_NAME"
	"${_wrong_metadata_source}"
	"${LICENSECC_INSTALL_PREFIX}"
)

set(_wrong_component_source "${_smoke_root}/wrong-component-src")
_write_generated_consumer(
	"${_wrong_component_source}"
	"find_package(licensecc REQUIRED COMPONENTS NOT_INSTALLED)"
)
_expect_configure_failure_from_source(
	"wrong-component"
	"licensecc project NOT_INSTALLED is missing release metadata"
	"${_wrong_component_source}"
	"${LICENSECC_INSTALL_PREFIX}"
)

set(_unsafe_component_source "${_smoke_root}/unsafe-component-src")
_write_generated_consumer(
	"${_unsafe_component_source}"
	"find_package(licensecc REQUIRED COMPONENTS ../NOT_INSTALLED)"
)
_expect_configure_failure_from_source(
	"unsafe-component"
	"contains unsafe[ \r\n]+characters"
	"${_unsafe_component_source}"
	"${LICENSECC_INSTALL_PREFIX}"
)
_expect_configure_failure(
	"unsafe-lcc-project-name"
	"contains unsafe[ \r\n]+characters"
	"-DLCC_PROJECT_NAME=../NOT_INSTALLED"
)

set(_multiple_component_source "${_smoke_root}/multiple-component-src")
_write_generated_consumer(
	"${_multiple_component_source}"
	"find_package(licensecc REQUIRED COMPONENTS ${LICENSECC_PROJECT_NAME} NOT_INSTALLED)"
)
_expect_configure_failure_from_source(
	"multiple-components"
	"licensecc supports selecting one installed project per consumer target"
	"${_multiple_component_source}"
	"${LICENSECC_INSTALL_PREFIX}"
)
