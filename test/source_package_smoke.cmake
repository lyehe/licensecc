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

function(_write_file path content)
	get_filename_component(_dir "${path}" DIRECTORY)
	file(MAKE_DIRECTORY "${_dir}")
	file(WRITE "${path}" "${content}")
endfunction()

function(_stage_valid_source root)
	_write_file("${root}/CMakeLists.txt" "cmake_minimum_required(VERSION 3.10)\nproject(source_scan_fixture)\n")
	_write_file("${root}/src/library.cpp" "int source_scan_fixture() { return 0; }\n")
	_write_file("${root}/README.md" "source scan fixture\n")
endfunction()

function(_run_source_scan root result_var output_var)
	execute_process(
		COMMAND "${CMAKE_COMMAND}"
			"-DLCC_SOURCE_ARTIFACT_SCAN_ROOT=${root}"
			-P "${LICENSECC_SOURCE_DIR}/cmake/ScanSourceArtifact.cmake"
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	string(CONCAT _output "${_stdout}\n${_stderr}")
	set(${result_var} "${_result}" PARENT_SCOPE)
	set(${output_var} "${_output}" PARENT_SCOPE)
endfunction()

function(_assert_source_scan_passes root)
	_run_source_scan("${root}" _result _output)
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR "Source scan unexpectedly failed for ${root}:\n${_output}")
	endif()
endfunction()

function(_assert_source_scan_fails name root expected_message)
	_run_source_scan("${root}" _result _output)
	if(_result EQUAL 0)
		message(FATAL_ERROR "${name} source scan unexpectedly passed")
	endif()
	if(NOT _output MATCHES "${expected_message}")
		message(FATAL_ERROR
			"${name} source scan failed without expected diagnostic.\n"
			"Expected regex: ${expected_message}\n"
			"Output:\n${_output}")
	endif()
endfunction()

function(_find_one out_var description)
	file(GLOB_RECURSE _matches LIST_DIRECTORIES false ${ARGN})
	list(LENGTH _matches _match_count)
	if(NOT _match_count EQUAL 1)
		message(FATAL_ERROR "Expected one ${description}, found ${_match_count}: ${_matches}")
	endif()
	list(GET _matches 0 _match)
	set(${out_var} "${_match}" PARENT_SCOPE)
endfunction()

_require_defined(LICENSECC_SOURCE_DIR)
_require_defined(LICENSECC_BUILD_DIR)
_require_defined(LICENSECC_CPACK_COMMAND)

_to_abs(LICENSECC_SOURCE_DIR "${LICENSECC_SOURCE_DIR}")
_to_abs(LICENSECC_BUILD_DIR "${LICENSECC_BUILD_DIR}")

set(_smoke_root "${LICENSECC_BUILD_DIR}/Testing/source-package")
set(_fixture_root "${_smoke_root}/fixtures")
set(_package_dir "${_smoke_root}/packages")
set(_extract_dir "${_smoke_root}/extract")

_remove_safe("${_smoke_root}" "${LICENSECC_BUILD_DIR}/Testing" "source package smoke root")
file(MAKE_DIRECTORY "${_fixture_root}" "${_package_dir}" "${_extract_dir}")

set(_valid_fixture "${_fixture_root}/valid")
_stage_valid_source("${_valid_fixture}")
_assert_source_scan_passes("${_valid_fixture}")

set(_private_key_name_fixture "${_fixture_root}/private-key-name")
_stage_valid_source("${_private_key_name_fixture}")
_write_file("${_private_key_name_fixture}/projects/MY_PRODUCT/private_key.rsa" "not a real key\n")
_assert_source_scan_fails("private key name" "${_private_key_name_fixture}" "forbidden key-like file")

set(_key_extension_fixture "${_fixture_root}/key-extension")
_stage_valid_source("${_key_extension_fixture}")
_write_file("${_key_extension_fixture}/config/signing.key" "not a real key\n")
_assert_source_scan_fails("key extension" "${_key_extension_fixture}" "forbidden key-like file")

set(_id_rsa_fixture "${_fixture_root}/id-rsa-name")
_stage_valid_source("${_id_rsa_fixture}")
_write_file("${_id_rsa_fixture}/secrets/id_rsa" "not a real key\n")
_assert_source_scan_fails("id_rsa name" "${_id_rsa_fixture}" "forbidden key-like file")

set(_der_fixture "${_fixture_root}/der-extension")
_stage_valid_source("${_der_fixture}")
_write_file("${_der_fixture}/keys/public.der" "not a real key\n")
_assert_source_scan_fails("DER extension" "${_der_fixture}" "forbidden key-like file")

set(_jwk_fixture "${_fixture_root}/jwk-extension")
_stage_valid_source("${_jwk_fixture}")
_write_file("${_jwk_fixture}/keys/license.jwk" "{\"kty\":\"RSA\"}\n")
_assert_source_scan_fails("JWK extension" "${_jwk_fixture}" "forbidden key-like file")

set(_signing_name_fixture "${_fixture_root}/signing-name")
_stage_valid_source("${_signing_name_fixture}")
_write_file("${_signing_name_fixture}/config/product-signing-material.txt" "not a real key\n")
_assert_source_scan_fails("signing name" "${_signing_name_fixture}" "forbidden key-like file")

set(_private_key_marker_fixture "${_fixture_root}/private-key-marker")
_stage_valid_source("${_private_key_marker_fixture}")
string(CONCAT _private_key_marker
	"-----BEGIN " "PRIVATE KEY-----\n"
	"redacted\n"
	"-----END " "PRIVATE KEY-----\n")
_write_file("${_private_key_marker_fixture}/notes.txt" "${_private_key_marker}")
_assert_source_scan_fails("private key marker" "${_private_key_marker_fixture}" "private-key marker present")

set(_encrypted_private_key_marker_fixture "${_fixture_root}/encrypted-private-key-marker")
_stage_valid_source("${_encrypted_private_key_marker_fixture}")
string(CONCAT _encrypted_private_key_marker
	"-----BEGIN " "ENCRYPTED PRIVATE KEY-----\n"
	"redacted\n"
	"-----END " "ENCRYPTED PRIVATE KEY-----\n")
_write_file("${_encrypted_private_key_marker_fixture}/notes.txt" "${_encrypted_private_key_marker}")
_assert_source_scan_fails("encrypted private key marker" "${_encrypted_private_key_marker_fixture}" "private-key marker present")

set(_symlink_fixture "${_fixture_root}/symlink")
_stage_valid_source("${_symlink_fixture}")
_write_file("${_symlink_fixture}/target.txt" "not a key\n")
execute_process(
	COMMAND "${CMAKE_COMMAND}" -E create_symlink "target.txt" "${_symlink_fixture}/linked.txt"
	RESULT_VARIABLE _symlink_result
	OUTPUT_VARIABLE _symlink_stdout
	ERROR_VARIABLE _symlink_stderr
)
if(_symlink_result EQUAL 0)
	_assert_source_scan_fails("symlink" "${_symlink_fixture}" "symlink or reparse-point-like path present")
else()
	message(STATUS "Skipping source symlink fixture because this platform refused symlink creation: ${_symlink_stderr}")
endif()

set(_projects_fixture "${_fixture_root}/projects-folder")
_stage_valid_source("${_projects_fixture}")
_write_file("${_projects_fixture}/projects/MY_PRODUCT/public_key.h" "public metadata in a local project folder\n")
_assert_source_scan_fails("projects folder" "${_projects_fixture}" "local build or staging output present")

set(_testing_fixture "${_fixture_root}/testing-folder")
_stage_valid_source("${_testing_fixture}")
_write_file("${_testing_fixture}/Testing/Temporary/LastTest.log" "local test output\n")
_assert_source_scan_fails("Testing folder" "${_testing_fixture}" "local build or staging output present")

set(_vcs_fixture "${_fixture_root}/vcs-metadata")
_stage_valid_source("${_vcs_fixture}")
_write_file("${_vcs_fixture}/extern/license-generator/.git" "gitdir: ../../.git/modules/extern/license-generator\n")
_assert_source_scan_fails("VCS metadata" "${_vcs_fixture}" "VCS metadata present")

set(_source_config_in "${LICENSECC_BUILD_DIR}/CPackSourceConfig.cmake")
if(NOT EXISTS "${_source_config_in}")
	message(FATAL_ERROR "CPack source config is missing: ${_source_config_in}")
endif()

set(_source_config "${_smoke_root}/CPackSourceConfig.cmake")
file(READ "${_source_config_in}" _source_config_content)
file(TO_CMAKE_PATH "${_package_dir}" _package_dir_cmake)
file(WRITE "${_source_config}" "${_source_config_content}\n")
file(APPEND "${_source_config}" "set(CPACK_GENERATOR \"ZIP\")\n")
file(APPEND "${_source_config}" "set(CPACK_SOURCE_GENERATOR \"ZIP\")\n")
file(APPEND "${_source_config}" "set(CPACK_SOURCE_7Z \"OFF\")\n")
file(APPEND "${_source_config}" "set(CPACK_SOURCE_ZIP \"ON\")\n")
file(APPEND "${_source_config}" "set(CPACK_OUTPUT_FILE_PREFIX \"${_package_dir_cmake}\")\n")

_run_checked("source package" "${LICENSECC_CPACK_COMMAND}" --config "${_source_config}")

file(GLOB_RECURSE _packages LIST_DIRECTORIES false "${_package_dir}/*.zip")
list(LENGTH _packages _package_count)
if(NOT _package_count EQUAL 1)
	message(FATAL_ERROR "Expected exactly one source package, found ${_package_count}: ${_packages}")
endif()
list(GET _packages 0 _package)
get_filename_component(_package_name "${_package}" NAME)
string(TOLOWER "${_package_name}" _package_name_lower)
string(FIND "${_package_name_lower}" "source" _source_name_pos)
string(FIND "${_package_name_lower}" "runtime" _runtime_name_pos)
string(FIND "${_package_name_lower}" "tools" _tools_name_pos)
if(_source_name_pos EQUAL -1 OR NOT _runtime_name_pos EQUAL -1 OR NOT _tools_name_pos EQUAL -1)
	message(FATAL_ERROR
		"Source package filename does not identify only the source profile.\n"
		"Package: ${_package_name}")
endif()

_run_checked("source package extraction" "${CMAKE_COMMAND}" -E chdir "${_extract_dir}" "${CMAKE_COMMAND}" -E tar xf "${_package}")

file(GLOB _extracted_roots LIST_DIRECTORIES true "${_extract_dir}/*")
set(_source_roots)
foreach(_candidate IN LISTS _extracted_roots)
	if(IS_DIRECTORY "${_candidate}")
		list(APPEND _source_roots "${_candidate}")
	endif()
endforeach()
list(LENGTH _source_roots _source_root_count)
if(NOT _source_root_count EQUAL 1)
	message(FATAL_ERROR "Expected exactly one extracted source root, found ${_source_root_count}: ${_source_roots}")
endif()
list(GET _source_roots 0 _source_root)

if(NOT EXISTS "${_source_root}/CMakeLists.txt")
	message(FATAL_ERROR "Extracted source package is missing CMakeLists.txt")
endif()
if(EXISTS "${_source_root}/Testing")
	message(FATAL_ERROR "Extracted source package contains top-level Testing output")
endif()
if(EXISTS "${_source_root}/extern/license-generator/.git")
	message(FATAL_ERROR "Extracted source package contains submodule .git metadata")
endif()
if(EXISTS "${_source_root}/extern/license-generator/test/data/private_key.rsa")
	message(FATAL_ERROR "Extracted source package contains private-key test fixture")
endif()

_assert_source_scan_passes("${_source_root}")

message(STATUS "Source package smoke passed")
