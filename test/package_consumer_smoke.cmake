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

function(_write_identity_consumer source_dir expected_project expected_magic expected_profile expected_public_key_sha expected_public_key_der_sha expected_public_key_id expected_abi expected_build_config)
	_remove_safe("${source_dir}" "${LICENSECC_PACKAGE_ROOT}" "identity consumer source")
	file(MAKE_DIRECTORY "${source_dir}")
	file(COPY "${LICENSECC_SOURCE_DIR}/examples/minimal/main.cpp" DESTINATION "${source_dir}")
	file(WRITE "${source_dir}/CMakeLists.txt"
"cmake_minimum_required(VERSION 3.16)
project(licensecc_packaged_identity_consumer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(licensecc REQUIRED COMPONENTS ${expected_project})

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

function(_write_decision_consumer source_dir project_name)
	_remove_safe("${source_dir}" "${LICENSECC_PACKAGE_ROOT}" "decision consumer source")
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
		std::snprintf(detail_out, detail_out_size, \"packaged consumer forced host failure\");
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
project(licensecc_packaged_decision_consumer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(licensecc REQUIRED COMPONENTS ${project_name})

add_executable(decision_consumer main.cpp)
target_link_libraries(decision_consumer PRIVATE licensecc::licensecc_static)
")
endfunction()

_require_defined(LICENSECC_SOURCE_DIR)
_require_defined(LICENSECC_BUILD_DIR)
_require_defined(LICENSECC_PACKAGE_ROOT)
_require_defined(LICENSECC_PROJECT_NAME)
_require_defined(LICENSECC_PROJECTS_BASE_DIR)
_require_defined(LICENSECC_PROJECT_MAGIC_NUM)
_require_defined(LICENSECC_PACKAGE_ABI_TAG)
_require_defined(LICENSECC_CPACK_COMMAND)

if(NOT DEFINED LICENSECC_CONFIG)
	set(LICENSECC_CONFIG "")
endif()

_to_abs(LICENSECC_SOURCE_DIR "${LICENSECC_SOURCE_DIR}")
_to_abs(LICENSECC_BUILD_DIR "${LICENSECC_BUILD_DIR}")
_to_abs(LICENSECC_PACKAGE_ROOT "${LICENSECC_PACKAGE_ROOT}")
_to_abs(LICENSECC_PROJECTS_BASE_DIR "${LICENSECC_PROJECTS_BASE_DIR}")
include("${LICENSECC_SOURCE_DIR}/test/release_manifest_assertions.cmake")

set(_package_dir "${LICENSECC_PACKAGE_ROOT}/packages")
set(_extract_dir "${LICENSECC_PACKAGE_ROOT}/extract")
set(_consumer_dir "${LICENSECC_PACKAGE_ROOT}/consumer")
set(_licenses_dir "${LICENSECC_PACKAGE_ROOT}/licenses")

_remove_safe("${LICENSECC_PACKAGE_ROOT}" "${LICENSECC_BUILD_DIR}/Testing/package-consumer" "package smoke root")
file(MAKE_DIRECTORY "${_package_dir}" "${_extract_dir}")

set(_cpack_command
	"${LICENSECC_CPACK_COMMAND}"
	--config "${LICENSECC_BUILD_DIR}/CPackConfig.cmake"
	-B "${_package_dir}"
	-D LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE=ON
	-D LCC_ALLOW_RELEASE_PROJECT_KEYGEN=ON
)
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _cpack_command -C "${LICENSECC_CONFIG}")
endif()
_run_checked("licensecc package" ${_cpack_command})

file(GLOB_RECURSE _packages
	"${_package_dir}/*.zip"
	"${_package_dir}/*.tar.gz"
	"${_package_dir}/*.tgz"
)
list(LENGTH _packages _package_count)
if(NOT _package_count EQUAL 1)
	message(FATAL_ERROR "Expected exactly one runtime package in ${_package_dir}, found ${_package_count}: ${_packages}")
endif()
list(GET _packages 0 _package)
get_filename_component(_package_name "${_package}" NAME)
string(FIND "${_package_name}" "runtime" _runtime_name_pos)
string(FIND "${_package_name}" "${LICENSECC_PROJECT_NAME}" _project_name_pos)
string(FIND "${_package_name}" "${LICENSECC_PACKAGE_ABI_TAG}" _abi_tag_pos)
set(_config_name_pos 0)
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	string(FIND "${_package_name}" "${LICENSECC_CONFIG}" _config_name_pos)
endif()
if(_runtime_name_pos EQUAL -1 OR _project_name_pos EQUAL -1 OR _abi_tag_pos EQUAL -1 OR _config_name_pos EQUAL -1)
	message(FATAL_ERROR
		"Runtime package filename does not identify profile, project, build config, and ABI.\n"
		"Package: ${_package_name}")
endif()

_run_checked("package extraction" "${CMAKE_COMMAND}" -E chdir "${_extract_dir}" "${CMAKE_COMMAND}" -E tar xf "${_package}")

file(GLOB_RECURSE _package_configs LIST_DIRECTORIES false "${_extract_dir}/*licensecc-config.cmake")
list(LENGTH _package_configs _config_count)
if(NOT _config_count EQUAL 1)
	message(FATAL_ERROR "Expected exactly one extracted licensecc-config.cmake, found ${_config_count}: ${_package_configs}")
endif()
list(GET _package_configs 0 _package_config)
get_filename_component(_config_dir "${_package_config}" DIRECTORY)
get_filename_component(_prefix "${_config_dir}/../../.." ABSOLUTE)

_run_checked(
	"extracted runtime artifact scan"
	"${CMAKE_COMMAND}"
	"-DLCC_ARTIFACT_SCAN_ROOT=${_extract_dir}"
	"-DLCC_ARTIFACT_ALLOW_TOOLS=OFF"
	-P "${LICENSECC_SOURCE_DIR}/cmake/ScanReleaseArtifact.cmake"
)
_run_checked(
	"runtime artifact path allowlist scan"
	"${CMAKE_COMMAND}"
	"-DLCC_ARTIFACT_SCAN_ROOT=${_prefix}"
	"-DLCC_ARTIFACT_ALLOW_TOOLS=OFF"
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=${LICENSECC_PROJECT_NAME}"
	-P "${LICENSECC_SOURCE_DIR}/cmake/ScanReleaseArtifact.cmake"
)

set(_properties_file "${_prefix}/include/licensecc/${LICENSECC_PROJECT_NAME}/licensecc_properties.h")
lcc_assert_release_manifest(
	"${_prefix}"
	"${LICENSECC_PROJECT_NAME}"
	"${LICENSECC_PROJECT_MAGIC_NUM}"
	"${LICENSECC_CONFIG}"
	"packaged runtime"
)
lcc_read_release_manifest("${_prefix}/share/licensecc/${LICENSECC_PROJECT_NAME}/release-manifest.cmake")
if(NOT LCC_RELEASE_ABI_TAG STREQUAL "${LICENSECC_PACKAGE_ABI_TAG}")
	message(FATAL_ERROR
		"Packaged release manifest has wrong ABI tag.\n"
		"Expected: ${LICENSECC_PACKAGE_ABI_TAG}\n"
		"Actual: ${LCC_RELEASE_ABI_TAG}")
endif()
_run_checked(
	"packaged release manifest summary"
	"${CMAKE_COMMAND}"
	"-DLCC_RELEASE_MANIFEST_PREFIX=${_prefix}"
	"-DLCC_RELEASE_MANIFEST_PROJECT_NAME=${LICENSECC_PROJECT_NAME}"
	-P "${LICENSECC_SOURCE_DIR}/cmake/PrintReleaseManifestSummary.cmake"
)
file(STRINGS "${_properties_file}" _magic_define REGEX "^#define LCC_PROJECT_MAGIC_NUM ")
if(NOT _magic_define STREQUAL "#define LCC_PROJECT_MAGIC_NUM ${LICENSECC_PROJECT_MAGIC_NUM}")
	message(FATAL_ERROR
		"Packaged generated properties expose the wrong LCC_PROJECT_MAGIC_NUM.\n"
		"Expected: #define LCC_PROJECT_MAGIC_NUM ${LICENSECC_PROJECT_MAGIC_NUM}\n"
		"Actual: ${_magic_define}")
endif()

set(_configure_command
	"${CMAKE_COMMAND}"
	-S "${LICENSECC_SOURCE_DIR}/examples/minimal"
	-B "${_consumer_dir}"
	"-DCMAKE_PREFIX_PATH=${_prefix}"
	"-DLCC_PROJECT_NAME=${LICENSECC_PROJECT_NAME}"
)
_append_generator_args(_configure_command)
_run_checked("packaged consumer configure" ${_configure_command})

set(_build_command "${CMAKE_COMMAND}" --build "${_consumer_dir}")
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _build_command --config "${LICENSECC_CONFIG}")
endif()
_run_checked("packaged consumer build" ${_build_command})

set(_metadata_source_dir "${LICENSECC_PACKAGE_ROOT}/metadata-consumer-src")
set(_metadata_build_dir "${LICENSECC_PACKAGE_ROOT}/metadata-consumer")
_write_identity_consumer(
	"${_metadata_source_dir}"
	"${LICENSECC_PROJECT_NAME}"
	"${LICENSECC_PROJECT_MAGIC_NUM}"
	"${LCC_RELEASE_PACKAGE_PROFILE}"
	"${LCC_RELEASE_PUBLIC_KEY_SHA256}"
	"${LCC_RELEASE_PUBLIC_KEY_DER_SHA256}"
	"${LCC_RELEASE_PUBLIC_KEY_ID}"
	"${LCC_RELEASE_ABI_TAG}"
	"${LCC_RELEASE_BUILD_CONFIG}"
)
set(_metadata_configure_command
	"${CMAKE_COMMAND}"
	-S "${_metadata_source_dir}"
	-B "${_metadata_build_dir}"
	"-DCMAKE_PREFIX_PATH=${_prefix}"
)
_append_generator_args(_metadata_configure_command)
_run_checked("packaged metadata consumer configure" ${_metadata_configure_command})
set(_metadata_build_command "${CMAKE_COMMAND}" --build "${_metadata_build_dir}")
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _metadata_build_command --config "${LICENSECC_CONFIG}")
endif()
_run_checked("packaged metadata consumer build" ${_metadata_build_command})

set(_relocated_prefix "${LICENSECC_PACKAGE_ROOT}/relocated package prefix")
set(_relocated_consumer_dir "${LICENSECC_PACKAGE_ROOT}/relocated-consumer")
_remove_safe("${_relocated_prefix}" "${LICENSECC_BUILD_DIR}/Testing/package-consumer" "relocated package prefix")
_remove_safe("${_relocated_consumer_dir}" "${LICENSECC_BUILD_DIR}/Testing/package-consumer" "relocated consumer dir")
_run_checked(
	"relocate package prefix"
	"${CMAKE_COMMAND}" -E copy_directory "${_prefix}" "${_relocated_prefix}"
)

set(_relocated_configure_command
	"${CMAKE_COMMAND}"
	-S "${LICENSECC_SOURCE_DIR}/examples/minimal"
	-B "${_relocated_consumer_dir}"
	"-DCMAKE_PREFIX_PATH=${_relocated_prefix}"
	"-DLCC_PROJECT_NAME=${LICENSECC_PROJECT_NAME}"
)
_append_generator_args(_relocated_configure_command)
_run_checked("relocated packaged consumer configure" ${_relocated_configure_command})

file(STRINGS "${_relocated_consumer_dir}/CMakeCache.txt" _relocated_licensecc_dir_line REGEX "^licensecc_DIR:PATH=")
if(NOT _relocated_licensecc_dir_line)
	message(FATAL_ERROR "Relocated packaged consumer cache does not contain licensecc_DIR")
endif()
string(REPLACE "licensecc_DIR:PATH=" "" _relocated_licensecc_dir "${_relocated_licensecc_dir_line}")
_assert_under("${_relocated_licensecc_dir}" "${_relocated_prefix}" "relocated packaged consumer licensecc_DIR")

set(_relocated_build_command "${CMAKE_COMMAND}" --build "${_relocated_consumer_dir}")
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _relocated_build_command --config "${LICENSECC_CONFIG}")
endif()
_run_checked("relocated packaged consumer build" ${_relocated_build_command})

set(_minimal_candidates
	"${_consumer_dir}/${LICENSECC_CONFIG}/minimal.exe"
	"${_consumer_dir}/minimal.exe"
	"${_consumer_dir}/${LICENSECC_CONFIG}/minimal"
	"${_consumer_dir}/minimal"
)
set(_minimal_exe "")
foreach(_candidate IN LISTS _minimal_candidates)
	if(EXISTS "${_candidate}")
		set(_minimal_exe "${_candidate}")
		break()
	endif()
endforeach()
if("${_minimal_exe}" STREQUAL "")
	message(FATAL_ERROR "Could not find packaged minimal executable under ${_consumer_dir}")
endif()

set(_host_consumer_dir "${LICENSECC_PACKAGE_ROOT}/fail-closed-host-consumer")
_remove_safe("${_host_consumer_dir}" "${LICENSECC_BUILD_DIR}/Testing/package-consumer" "fail-closed host consumer dir")
set(_host_configure_command
	"${CMAKE_COMMAND}"
	-S "${LICENSECC_SOURCE_DIR}/examples/fail_closed_host"
	-B "${_host_consumer_dir}"
	"-DCMAKE_PREFIX_PATH=${_prefix}"
	"-DLCC_PROJECT_NAME=${LICENSECC_PROJECT_NAME}"
)
_append_generator_args(_host_configure_command)
_run_checked("packaged fail-closed host configure" ${_host_configure_command})

set(_host_build_command "${CMAKE_COMMAND}" --build "${_host_consumer_dir}")
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _host_build_command --config "${LICENSECC_CONFIG}")
endif()
_run_checked("packaged fail-closed host build" ${_host_build_command})

set(_host_candidates
	"${_host_consumer_dir}/${LICENSECC_CONFIG}/fail_closed_host.exe"
	"${_host_consumer_dir}/fail_closed_host.exe"
	"${_host_consumer_dir}/${LICENSECC_CONFIG}/fail_closed_host"
	"${_host_consumer_dir}/fail_closed_host"
)
set(_host_exe "")
foreach(_candidate IN LISTS _host_candidates)
	if(EXISTS "${_candidate}")
		set(_host_exe "${_candidate}")
		break()
	endif()
endforeach()
if("${_host_exe}" STREQUAL "")
	message(FATAL_ERROR "Could not find packaged fail_closed_host executable under ${_host_consumer_dir}")
endif()

set(_decision_consumer_dir "${LICENSECC_PACKAGE_ROOT}/decision-consumer")
set(_decision_source_dir "${LICENSECC_PACKAGE_ROOT}/decision-consumer-src")
_write_decision_consumer("${_decision_source_dir}" "${LICENSECC_PROJECT_NAME}")
set(_decision_configure_command
	"${CMAKE_COMMAND}"
	-S "${_decision_source_dir}"
	-B "${_decision_consumer_dir}"
	"-DCMAKE_PREFIX_PATH=${_prefix}"
)
_append_generator_args(_decision_configure_command)
_run_checked("packaged decision consumer configure" ${_decision_configure_command})

set(_decision_build_command "${CMAKE_COMMAND}" --build "${_decision_consumer_dir}")
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _decision_build_command --config "${LICENSECC_CONFIG}")
endif()
_run_checked("packaged decision consumer build" ${_decision_build_command})

set(_decision_candidates
	"${_decision_consumer_dir}/${LICENSECC_CONFIG}/decision_consumer.exe"
	"${_decision_consumer_dir}/decision_consumer.exe"
	"${_decision_consumer_dir}/${LICENSECC_CONFIG}/decision_consumer"
	"${_decision_consumer_dir}/decision_consumer"
)
set(_decision_exe "")
foreach(_candidate IN LISTS _decision_candidates)
	if(EXISTS "${_candidate}")
		set(_decision_exe "${_candidate}")
		break()
	endif()
endforeach()
if("${_decision_exe}" STREQUAL "")
	message(FATAL_ERROR "Could not find packaged decision_consumer executable under ${_decision_consumer_dir}")
endif()

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

function(_run_minimal_case name expected_exit expected_pattern license_path feature version magic)
	set(_command "${_minimal_exe}" "${license_path}")
	if(NOT "${feature}" STREQUAL "-")
		list(APPEND _command "${feature}")
	endif()
	if(NOT "${version}" STREQUAL "-")
		list(APPEND _command "${version}")
	endif()
	if(NOT "${magic}" STREQUAL "-")
		list(APPEND _command "${magic}")
	endif()
	execute_process(
		COMMAND ${_command}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	string(CONCAT _output "${_stdout}\n${_stderr}")
	if(NOT _result EQUAL ${expected_exit})
		message(FATAL_ERROR
			"${name} returned ${_result}; expected ${expected_exit}.\n"
			"Command: ${_command}\n"
			"output:\n${_output}")
	endif()
	if(NOT _output MATCHES "${expected_pattern}")
		message(FATAL_ERROR
			"${name} output did not match ${expected_pattern}.\n"
			"Command: ${_command}\n"
			"output:\n${_output}")
	endif()
endfunction()

function(_run_host_case name expected_exit license_path version)
	set(_command "${_host_exe}" "${license_path}" "${version}")
	execute_process(
		COMMAND ${_command}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	string(CONCAT _output "${_stdout}\n${_stderr}")
	if(NOT _result EQUAL ${expected_exit})
		message(FATAL_ERROR
			"${name} returned ${_result}; expected ${expected_exit}.\n"
			"Command: ${_command}\n"
			"output:\n${_output}")
	endif()
	foreach(_pattern IN LISTS ARGN)
		if(_pattern MATCHES "^NOT:(.*)")
			set(_forbidden "${CMAKE_MATCH_1}")
			if(_output MATCHES "${_forbidden}")
				message(FATAL_ERROR
					"${name} output unexpectedly matched ${_forbidden}.\n"
					"Command: ${_command}\n"
					"output:\n${_output}")
			endif()
		elseif(NOT _output MATCHES "${_pattern}")
			message(FATAL_ERROR
				"${name} output did not match ${_pattern}.\n"
				"Command: ${_command}\n"
				"output:\n${_output}")
		endif()
	endforeach()
endfunction()

file(MAKE_DIRECTORY "${_licenses_dir}")
_find_lccgen(_lccgen_exe)

_issue_license("valid" _valid_license)
_run_checked("packaged decision wrapper consumer forced tamper denial" "${_decision_exe}" "${_valid_license}")
_run_minimal_case("valid license" 0 "license OK" "${_valid_license}" "-" "-" "-")
_run_minimal_case("valid license with matching magic" 0 "license OK" "${_valid_license}" "${LICENSECC_PROJECT_NAME}" "0" "${LICENSECC_PROJECT_MAGIC_NUM}")
if(NOT "${LICENSECC_PROJECT_MAGIC_NUM}" STREQUAL "0")
	_run_minimal_case("valid license with zero magic denied" 1 "license signature didn't match" "${_valid_license}" "${LICENSECC_PROJECT_NAME}" "0" "0")
endif()

execute_process(
	COMMAND "${_minimal_exe}" "${_prefix}/definitely-missing.lic"
	RESULT_VARIABLE _run_result
	OUTPUT_VARIABLE _run_stdout
	ERROR_VARIABLE _run_stderr
)
string(CONCAT _run_output "${_run_stdout}\n${_run_stderr}")
if(NOT _run_result EQUAL 1)
	message(FATAL_ERROR
		"packaged minimal returned ${_run_result}; expected 1 for missing license.\n"
		"output:\n${_run_output}")
endif()
if(NOT _run_output MATCHES "license check failed")
	message(FATAL_ERROR "packaged minimal output did not contain the fail-closed summary:\n${_run_output}")
endif()
if(NOT _run_output MATCHES "license file not found")
	message(FATAL_ERROR "packaged minimal output did not contain the missing-file diagnostic:\n${_run_output}")
endif()

file(WRITE "${_licenses_dir}/malformed.lic" "[${LICENSECC_PROJECT_NAME}]\nlic_ver = 200\n")
_run_minimal_case("malformed license" 1 "mandatory fields are missing" "${_licenses_dir}/malformed.lic" "-" "-" "-")
_run_host_case(
	"fail-closed host malformed license"
	1
	"${_licenses_dir}/malformed.lic"
	"1.2.0"
	"application unavailable"
	"REPORTS unavailable"
	"EXPORT unavailable"
	"NOT:application enabled"
	"NOT:REPORTS enabled"
	"NOT:EXPORT enabled"
)

_issue_license("corrupted_base" _corrupted_base --extra-data good)
file(READ "${_corrupted_base}" _corrupted_content)
string(REPLACE "extra-data = good" "extra-data = bad" _corrupted_content_changed "${_corrupted_content}")
if("${_corrupted_content_changed}" STREQUAL "${_corrupted_content}")
	message(FATAL_ERROR "Could not mutate extra-data in ${_corrupted_base}")
endif()
set(_corrupted_license "${_licenses_dir}/corrupted.lic")
file(WRITE "${_corrupted_license}" "${_corrupted_content_changed}")
_run_minimal_case("corrupted license" 1 "license signature didn't match" "${_corrupted_license}" "-" "-" "-")

_issue_license("expired" _expired_license --valid-to 2000-01-01)
_run_minimal_case("expired license" 1 "license expired" "${_expired_license}" "-" "-" "-")

_issue_license("wrong_feature" _wrong_feature_license --feature-names OTHER)
_run_minimal_case("wrong feature license" 1 "this product was not licensed" "${_wrong_feature_license}" "${LICENSECC_PROJECT_NAME}" "-" "-")

_issue_license("wrong_version" _wrong_version_license --start-version 2.0.0 --end-version 3.0.0)
_run_minimal_case("wrong version license" 1 "this product was not licensed" "${_wrong_version_license}" "${LICENSECC_PROJECT_NAME}" "1.0.0" "-")

_issue_license("host_base" _host_base_license --extra-data base-ok)
get_filename_component(_host_exe_dir "${_host_exe}" DIRECTORY)
get_filename_component(_host_exe_name_we "${_host_exe}" NAME_WE)
set(_host_near_license "${_host_exe_dir}/${_host_exe_name_we}.lic")
file(WRITE "${_host_near_license}" "[${LICENSECC_PROJECT_NAME}]\nlic_ver = 200\n")
_run_host_case(
	"fail-closed host source-fatal colocated malformed license"
	1
	"${_host_base_license}"
	"1.2.0"
	"application unavailable"
	"REPORTS unavailable"
	"EXPORT unavailable"
	"mandatory fields are missing"
	"NOT:application enabled"
	"NOT:REPORTS enabled"
	"NOT:EXPORT enabled"
	"NOT:signed data: base-ok"
)
file(REMOVE "${_host_near_license}")
_run_host_case(
	"fail-closed host base only"
	0
	"${_host_base_license}"
	"1.2.0"
	"application enabled"
	"signed data: base-ok"
	"REPORTS unavailable"
	"EXPORT unavailable"
	"NOT:REPORTS enabled"
	"NOT:EXPORT enabled"
)

_issue_license(
	"host_all_features"
	_host_all_features_license
	--feature-names "${LICENSECC_PROJECT_NAME},REPORTS,EXPORT"
	--start-version 1.0.0
	--end-version 2.0.0
	--extra-data host-ok
)
_run_host_case(
	"fail-closed host all features"
	0
	"${_host_all_features_license}"
	"1.2.0"
	"application enabled"
	"signed data: host-ok"
	"REPORTS enabled"
	"EXPORT enabled"
)
_run_host_case(
	"fail-closed host wrong version"
	1
	"${_host_all_features_license}"
	"3.0.0"
	"application unavailable"
	"REPORTS unavailable"
	"EXPORT unavailable"
	"NOT:application enabled"
	"NOT:REPORTS enabled"
	"NOT:EXPORT enabled"
)

_issue_license("wrong_magic" _wrong_magic_license)
set(_wrong_magic 42)
if("${LICENSECC_PROJECT_MAGIC_NUM}" STREQUAL "42")
	set(_wrong_magic 43)
elseif(NOT "${LICENSECC_PROJECT_MAGIC_NUM}" STREQUAL "0")
	set(_wrong_magic 0)
endif()
_run_minimal_case("wrong magic license" 1 "license signature didn't match" "${_wrong_magic_license}" "${LICENSECC_PROJECT_NAME}" "0" "${_wrong_magic}")

_issue_license("hardware_mismatch" _hardware_mismatch_license --client-signature AEBC-Q0RF-Rkc=)
_run_minimal_case("hardware mismatch license" 1 "calculated hardware identifier" "${_hardware_mismatch_license}" "-" "-" "-")
