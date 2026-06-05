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

function(_write_file path content)
	get_filename_component(_parent "${path}" DIRECTORY)
	file(MAKE_DIRECTORY "${_parent}")
	file(WRITE "${path}" "${content}")
endfunction()

function(_public_key_header out_var der_len bits algorithm signature_algorithm)
	set(_der_sha256 "1111111111111111111111111111111111111111111111111111111111111111")
	string(CONCAT _header
		"#define PUBLIC_KEY {0}\n"
		"#define PUBLIC_KEY_LEN ${der_len}\n"
		"#define LCC_PUBLIC_KEY_ALGORITHM \"${algorithm}\"\n"
		"#define LCC_PUBLIC_KEY_BITS ${bits}\n"
		"#define LCC_PUBLIC_KEY_SHA256 \"${_der_sha256}\"\n"
		"#define LCC_PUBLIC_KEY_ID \"sha256:${_der_sha256}\"\n"
		"#define LCC_SIGNATURE_ALGORITHM \"${signature_algorithm}\"\n")
	set(${out_var} "${_header}" PARENT_SCOPE)
endfunction()

function(_run_scan name root allow_tools out_result out_stdout out_stderr)
	set(_scan_command
		"${CMAKE_COMMAND}"
		"-DLCC_ARTIFACT_SCAN_ROOT=${root}"
		"-DLCC_ARTIFACT_ALLOW_TOOLS=${allow_tools}"
	)
	list(APPEND _scan_command ${ARGN})
	list(APPEND _scan_command -P "${LICENSECC_SOURCE_DIR}/cmake/ScanReleaseArtifact.cmake")
	execute_process(
		COMMAND ${_scan_command}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	set(${out_result} "${_result}" PARENT_SCOPE)
	set(${out_stdout} "${_stdout}" PARENT_SCOPE)
	set(${out_stderr} "${_stderr}" PARENT_SCOPE)
endfunction()

function(_expect_scan_success name root)
	_run_scan("${name}" "${root}" OFF _result _stdout _stderr ${ARGN})
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR
			"${name} scan failed unexpectedly\n"
			"stdout:\n${_stdout}\n"
			"stderr:\n${_stderr}")
	endif()
endfunction()

function(_expect_scan_failure name expected_message)
	set(_case_root "${_scan_root}/${name}")
	_remove_safe("${_case_root}" "${_scan_root}" "${name} case root")
	file(MAKE_DIRECTORY "${_case_root}")
	set(_stage_function "${ARGV2}")
	cmake_language(CALL "${_stage_function}" "${_case_root}")
	set(_scan_args)
	if(ARGC GREATER 3)
		foreach(_index RANGE 3 ${ARGC})
			if(_index LESS ARGC)
				list(GET ARGV ${_index} _arg)
				list(APPEND _scan_args "${_arg}")
			endif()
		endforeach()
	endif()
	_run_scan("${name}" "${_case_root}" OFF _result _stdout _stderr ${_scan_args})
	string(CONCAT _combined "${_stdout}\n${_stderr}")
	if(_result EQUAL 0)
		message(FATAL_ERROR "${name} scan unexpectedly passed")
	endif()
	if(NOT _combined MATCHES "${expected_message}")
		message(FATAL_ERROR
			"${name} scan failed, but did not report the expected diagnostic.\n"
			"Expected regex: ${expected_message}\n"
			"stdout:\n${_stdout}\n"
			"stderr:\n${_stderr}")
	endif()
endfunction()

function(_stage_private_key_name root)
	_write_file("${root}/include/licensecc/MY_PRODUCT/private_key.rsa" "not a real key\n")
endfunction()

function(_stage_key_extension root)
	_write_file("${root}/share/licensecc/signing.key" "not a real key\n")
endfunction()

function(_stage_private_key_marker root)
	string(CONCAT _marker_payload
		"-----BEGIN " "PRIVATE KEY-----\n"
		"redacted\n"
		"-----END " "PRIVATE KEY-----\n")
	_write_file("${root}/share/licensecc/readme.txt" "${_marker_payload}")
endfunction()

function(_stage_projects_folder root)
	_write_file("${root}/projects/MY_PRODUCT/public_key.h" "public metadata in the wrong folder\n")
endfunction()

function(_stage_lccgen root)
	if(WIN32)
		_write_file("${root}/bin/lccgen.exe" "tool placeholder\n")
	else()
		_write_file("${root}/bin/lccgen" "tool placeholder\n")
	endif()
endfunction()

function(_stage_lccinspector root)
	if(WIN32)
		_write_file("${root}/bin/lccinspector.exe" "tool placeholder\n")
	else()
		_write_file("${root}/bin/lccinspector" "tool placeholder\n")
	endif()
endfunction()

function(_stage_lccgen_config root)
	_write_file("${root}/lib/cmake/lccgen/lccgen-config.cmake" "set(lccgen_FOUND TRUE)\n")
endfunction()

function(_stage_unexpected_runtime_path root)
	_stage_valid_runtime("${root}")
	_write_file("${root}/share/licensecc/MY_PRODUCT/notes.txt" "unexpected file\n")
endfunction()

function(_stage_wrong_runtime_project root)
	_stage_valid_runtime("${root}")
	_write_file("${root}/include/licensecc/DEFAULT/public_key.h" "wrong project metadata\n")
endfunction()

function(_stage_missing_manifest root)
	_stage_valid_runtime("${root}")
	file(REMOVE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake")
endfunction()

function(_stage_duplicate_manifest root)
	_stage_valid_runtime("${root}")
	_write_file("${root}/share/licensecc/OTHER_PRODUCT/release-manifest.cmake" "set(LCC_RELEASE_MANIFEST_VERSION \"1\")\n")
endfunction()

function(_stage_manifest_wrong_project root)
	_stage_valid_runtime("${root}")
	file(READ "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" _manifest)
	string(REPLACE "set(LCC_RELEASE_PROJECT_NAME \"MY_PRODUCT\")" "set(LCC_RELEASE_PROJECT_NAME \"OTHER_PRODUCT\")" _manifest "${_manifest}")
	file(WRITE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

function(_stage_manifest_wrong_profile root)
	_stage_valid_runtime("${root}")
	file(READ "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" _manifest)
	string(REPLACE "set(LCC_RELEASE_PACKAGE_PROFILE \"runtime\")" "set(LCC_RELEASE_PACKAGE_PROFILE \"tools\")" _manifest "${_manifest}")
	file(WRITE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

function(_stage_manifest_public_hash_mismatch root)
	_stage_valid_runtime("${root}")
	file(APPEND "${root}/include/licensecc/MY_PRODUCT/public_key.h" "tampered\n")
endfunction()

function(_stage_manifest_properties_hash_mismatch root)
	_stage_valid_runtime("${root}")
	file(APPEND "${root}/include/licensecc/MY_PRODUCT/licensecc_properties.h" "tampered\n")
endfunction()

function(_stage_manifest_public_len_mismatch root)
	_stage_valid_runtime("${root}")
	file(READ "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" _manifest)
	string(REPLACE
		"set(LCC_RELEASE_PUBLIC_KEY_DER_LEN \"390\")"
		"set(LCC_RELEASE_PUBLIC_KEY_DER_LEN \"391\")"
		_manifest
		"${_manifest}")
	file(WRITE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

function(_stage_manifest_public_bits_mismatch root)
	_stage_valid_runtime("${root}")
	file(READ "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" _manifest)
	string(REPLACE
		"set(LCC_RELEASE_PUBLIC_KEY_BITS \"3072\")"
		"set(LCC_RELEASE_PUBLIC_KEY_BITS \"3073\")"
		_manifest
		"${_manifest}")
	file(WRITE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

function(_stage_manifest_public_der_sha_mismatch root)
	_stage_valid_runtime("${root}")
	file(READ "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" _manifest)
	string(REPLACE
		"set(LCC_RELEASE_PUBLIC_KEY_DER_SHA256 \"1111111111111111111111111111111111111111111111111111111111111111\")"
		"set(LCC_RELEASE_PUBLIC_KEY_DER_SHA256 \"2222222222222222222222222222222222222222222222222222222222222222\")"
		_manifest
		"${_manifest}")
	file(WRITE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

function(_stage_manifest_public_key_id_mismatch root)
	_stage_valid_runtime("${root}")
	file(READ "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" _manifest)
	string(REPLACE
		"set(LCC_RELEASE_PUBLIC_KEY_ID \"sha256:1111111111111111111111111111111111111111111111111111111111111111\")"
		"set(LCC_RELEASE_PUBLIC_KEY_ID \"sha256:2222222222222222222222222222222222222222222222222222222222222222\")"
		_manifest
		"${_manifest}")
	file(WRITE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

function(_stage_manifest_public_algorithm_mismatch root)
	_stage_valid_runtime("${root}")
	file(READ "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" _manifest)
	string(REPLACE
		"set(LCC_RELEASE_PUBLIC_KEY_ALGORITHM \"rsa\")"
		"set(LCC_RELEASE_PUBLIC_KEY_ALGORITHM \"dsa\")"
		_manifest
		"${_manifest}")
	file(WRITE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

function(_stage_manifest_signature_algorithm_mismatch root)
	_stage_valid_runtime("${root}")
	file(READ "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" _manifest)
	string(REPLACE
		"set(LCC_RELEASE_SIGNATURE_ALGORITHM \"rsa-pkcs1-sha256\")"
		"set(LCC_RELEASE_SIGNATURE_ALGORITHM \"rsa-pss-sha256\")"
		_manifest
		"${_manifest}")
	file(WRITE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

function(_stage_manifest_weak_public_key root)
	_stage_valid_runtime("${root}")
	_public_key_header(_weak_header 390 1024 rsa rsa-pkcs1-sha256)
	_write_file("${root}/include/licensecc/MY_PRODUCT/public_key.h" "${_weak_header}")
	file(SHA256 "${root}/include/licensecc/MY_PRODUCT/public_key.h" _public_key_sha256)
	file(READ "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" _manifest)
	string(REGEX REPLACE
		"set\\(LCC_RELEASE_PUBLIC_KEY_SHA256 \"[0-9a-f]+\"\\)"
		"set(LCC_RELEASE_PUBLIC_KEY_SHA256 \"${_public_key_sha256}\")"
		_manifest
		"${_manifest}")
	string(REPLACE
		"set(LCC_RELEASE_PUBLIC_KEY_BITS \"3072\")"
		"set(LCC_RELEASE_PUBLIC_KEY_BITS \"1024\")"
		_manifest
		"${_manifest}")
	file(WRITE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

function(_stage_manifest_unsafe_path root)
	_stage_valid_runtime("${root}")
	file(READ "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" _manifest)
	string(REPLACE
		"set(LCC_RELEASE_PUBLIC_KEY_PATH \"include/licensecc/MY_PRODUCT/public_key.h\")"
		"set(LCC_RELEASE_PUBLIC_KEY_PATH \"../public_key.h\")"
		_manifest
		"${_manifest}")
	file(WRITE "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

function(_stage_manifest_unsupported_syntax root)
	_stage_valid_runtime("${root}")
	file(APPEND "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake"
		"message(FATAL_ERROR \"manifest content executed\")\n")
endfunction()

function(_stage_manifest_unexpected_key root)
	_stage_valid_runtime("${root}")
	file(APPEND "${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake"
		"set(LCC_RELEASE_PRIVATE_KEY_PATH \"private_key.rsa\")\n")
endfunction()

function(_stage_valid_runtime root)
	_write_file("${root}/include/licensecc/datatypes.h" "public header placeholder\n")
	_write_file("${root}/include/licensecc/licensecc.h" "public header placeholder\n")
	_write_file("${root}/include/licensecc/MY_PRODUCT/licensecc_properties.h"
		"#define LCC_PROJECT_MAGIC_NUM 0\n#define LCC_SUPPORTED_LICENSE_FORMAT_MIN 200\n#define LCC_SUPPORTED_LICENSE_FORMAT_MAX 201\n")
	_public_key_header(_valid_public_key_header 390 3072 rsa rsa-pkcs1-sha256)
	_write_file("${root}/include/licensecc/MY_PRODUCT/public_key.h" "${_valid_public_key_header}")
	_write_file("${root}/lib/licensecc/MY_PRODUCT/cmake/licensecc.cmake" "add_library(licensecc::licensecc_static STATIC IMPORTED)\n")
	_write_file("${root}/lib/licensecc/MY_PRODUCT/cmake/licensecc-debug.cmake" "set(_IMPORT_CHECK_TARGETS licensecc::licensecc_static)\n")
	_write_file("${root}/lib/cmake/licensecc/licensecc-config.cmake" "set(licensecc_FOUND TRUE)\n")
	_write_file("${root}/lib/cmake/licensecc/licensecc-config-version.cmake" "set(PACKAGE_VERSION 2.1.0)\n")
	_write_file("${root}/lib/licensecc/MY_PRODUCT/licensecc_static.lib" "library placeholder\n")
	file(SHA256 "${root}/include/licensecc/MY_PRODUCT/public_key.h" _public_key_sha256)
	file(SHA256 "${root}/include/licensecc/MY_PRODUCT/licensecc_properties.h" _properties_sha256)
	string(CONCAT _manifest
		"set(LCC_RELEASE_MANIFEST_VERSION \"1\")\n"
		"set(LCC_RELEASE_PACKAGE_NAME \"licensecc\")\n"
		"set(LCC_RELEASE_PACKAGE_VERSION \"2.1.0\")\n"
		"set(LCC_RELEASE_PACKAGE_PROFILE \"runtime\")\n"
		"set(LCC_RELEASE_LICENSE_FORMAT_MIN \"200\")\n"
		"set(LCC_RELEASE_LICENSE_FORMAT_MAX \"201\")\n"
		"set(LCC_RELEASE_PROJECT_NAME \"MY_PRODUCT\")\n"
		"set(LCC_RELEASE_PROJECT_MAGIC_NUM \"0\")\n"
		"set(LCC_RELEASE_BUILD_CONFIG \"Debug\")\n"
		"set(LCC_RELEASE_PLATFORM \"test-platform\")\n"
		"set(LCC_RELEASE_SYSTEM_PROCESSOR \"test-processor\")\n"
		"set(LCC_RELEASE_GENERATOR \"test-generator\")\n"
		"set(LCC_RELEASE_COMPILER_ID \"test-compiler\")\n"
		"set(LCC_RELEASE_COMPILER_VERSION \"1.0\")\n"
		"set(LCC_RELEASE_COMPILER_ARCHITECTURE \"test-arch\")\n"
		"set(LCC_RELEASE_RUNTIME_LINKAGE \"test-runtime\")\n"
		"set(LCC_RELEASE_ABI_TAG \"test-abi\")\n"
		"set(LCC_RELEASE_PUBLIC_KEY_PATH \"include/licensecc/MY_PRODUCT/public_key.h\")\n"
		"set(LCC_RELEASE_PUBLIC_KEY_SHA256 \"${_public_key_sha256}\")\n"
		"set(LCC_RELEASE_PUBLIC_KEY_DER_SHA256 \"1111111111111111111111111111111111111111111111111111111111111111\")\n"
		"set(LCC_RELEASE_PUBLIC_KEY_ID \"sha256:1111111111111111111111111111111111111111111111111111111111111111\")\n"
		"set(LCC_RELEASE_PUBLIC_KEY_DER_LEN \"390\")\n"
		"set(LCC_RELEASE_PUBLIC_KEY_ALGORITHM \"rsa\")\n"
		"set(LCC_RELEASE_PUBLIC_KEY_BITS \"3072\")\n"
		"set(LCC_RELEASE_SIGNATURE_ALGORITHM \"rsa-pkcs1-sha256\")\n"
		"set(LCC_RELEASE_PROPERTIES_PATH \"include/licensecc/MY_PRODUCT/licensecc_properties.h\")\n"
		"set(LCC_RELEASE_PROPERTIES_SHA256 \"${_properties_sha256}\")\n")
	_write_file("${root}/share/licensecc/MY_PRODUCT/release-manifest.cmake" "${_manifest}")
endfunction()

_require_defined(LICENSECC_SOURCE_DIR)
_require_defined(LICENSECC_BUILD_DIR)

if(NOT DEFINED LICENSECC_CONFIG OR "${LICENSECC_CONFIG}" STREQUAL "")
	set(_config_name "single-config")
else()
	set(_config_name "${LICENSECC_CONFIG}")
endif()

_to_abs(LICENSECC_SOURCE_DIR "${LICENSECC_SOURCE_DIR}")
_to_abs(LICENSECC_BUILD_DIR "${LICENSECC_BUILD_DIR}")
set(_scan_root "${LICENSECC_BUILD_DIR}/Testing/artifact-scan/${_config_name}")
_remove_safe("${_scan_root}" "${LICENSECC_BUILD_DIR}/Testing/artifact-scan" "artifact scan smoke root")
file(MAKE_DIRECTORY "${_scan_root}")

set(_valid_root "${_scan_root}/valid-runtime")
file(MAKE_DIRECTORY "${_valid_root}")
_stage_valid_runtime("${_valid_root}")
_expect_scan_success("valid runtime skeleton" "${_valid_root}")
_expect_scan_success(
	"valid runtime allowlist"
	"${_valid_root}"
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_run_scan(
	"invalid expected profile"
	"${_valid_root}"
	OFF
	_invalid_profile_result
	_invalid_profile_stdout
	_invalid_profile_stderr
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=developer"
)
string(CONCAT _invalid_profile_output "${_invalid_profile_stdout}\n${_invalid_profile_stderr}")
if(_invalid_profile_result EQUAL 0 OR NOT _invalid_profile_output MATCHES "invalid licensecc package profile")
	message(FATAL_ERROR
		"invalid expected profile did not fail with the expected diagnostic\n"
		"stdout:\n${_invalid_profile_stdout}\n"
		"stderr:\n${_invalid_profile_stderr}")
endif()
_run_scan(
	"invalid expected project"
	"${_valid_root}"
	OFF
	_invalid_project_result
	_invalid_project_stdout
	_invalid_project_stderr
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=../MY_PRODUCT"
)
string(CONCAT _invalid_project_output "${_invalid_project_stdout}\n${_invalid_project_stderr}")
if(_invalid_project_result EQUAL 0 OR NOT _invalid_project_output MATCHES "invalid licensecc project name")
	message(FATAL_ERROR
		"invalid expected project did not fail with the expected diagnostic\n"
		"stdout:\n${_invalid_project_stdout}\n"
		"stderr:\n${_invalid_project_stderr}")
endif()

_expect_scan_failure("private-key-filename" "forbidden key-like file" _stage_private_key_name)
_expect_scan_failure("key-extension" "forbidden key-like file" _stage_key_extension)
_expect_scan_failure("private-key-marker" "private-key marker present" _stage_private_key_marker)
_expect_scan_failure("projects-folder" "generated project folder present" _stage_projects_folder)
_expect_scan_failure("lccgen-tool" "tooling executable present" _stage_lccgen)
_expect_scan_failure("lccinspector-tool" "tooling executable present" _stage_lccinspector)
_expect_scan_failure("lccgen-config" "lccgen package config present" _stage_lccgen_config)
_expect_scan_failure(
	"unexpected-runtime-path"
	"unexpected runtime artifact path"
	_stage_unexpected_runtime_path
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"wrong-runtime-project"
	"unexpected runtime artifact path"
	_stage_wrong_runtime_project
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"missing-release-manifest"
	"exactly one release manifest"
	_stage_missing_manifest
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"duplicate-release-manifest"
	"exactly one release manifest"
	_stage_duplicate_manifest
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-wrong-project"
	"release manifest has wrong project"
	_stage_manifest_wrong_project
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-wrong-profile"
	"release manifest has wrong package profile"
	_stage_manifest_wrong_profile
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-public-hash-mismatch"
	"public key SHA256 does not match"
	_stage_manifest_public_hash_mismatch
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-public-len-mismatch"
	"public key DER length does not match"
	_stage_manifest_public_len_mismatch
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-public-bits-mismatch"
	"public key bit length does not match"
	_stage_manifest_public_bits_mismatch
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-public-der-sha-mismatch"
	"public key DER SHA256 does not match"
	_stage_manifest_public_der_sha_mismatch
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-public-key-id-mismatch"
	"public key ID does not match"
	_stage_manifest_public_key_id_mismatch
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-public-algorithm-mismatch"
	"public key algorithm is unsupported"
	_stage_manifest_public_algorithm_mismatch
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-signature-algorithm-mismatch"
	"signature algorithm is unsupported"
	_stage_manifest_signature_algorithm_mismatch
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-weak-public-key"
	"public key bit length is below minimum"
	_stage_manifest_weak_public_key
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-properties-hash-mismatch"
	"properties SHA256 does not match"
	_stage_manifest_properties_hash_mismatch
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-unsafe-path"
	"public key path is unsafe"
	_stage_manifest_unsafe_path
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-unsupported-syntax"
	"unsupported syntax"
	_stage_manifest_unsupported_syntax
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)
_expect_scan_failure(
	"manifest-unexpected-key"
	"unexpected key"
	_stage_manifest_unexpected_key
	"-DLCC_ARTIFACT_EXPECTED_PROFILE=runtime"
	"-DLCC_ARTIFACT_EXPECTED_PROJECT_NAME=MY_PRODUCT"
)

set(_tools_root "${_scan_root}/tools-allowed")
file(MAKE_DIRECTORY "${_tools_root}")
_stage_lccgen("${_tools_root}")
_stage_lccinspector("${_tools_root}")
_run_scan("tools allowed" "${_tools_root}" ON _tools_result _tools_stdout _tools_stderr)
if(NOT _tools_result EQUAL 0)
	message(FATAL_ERROR
		"tools-allowed scan failed unexpectedly\n"
		"stdout:\n${_tools_stdout}\n"
		"stderr:\n${_tools_stderr}")
endif()

message(STATUS "Artifact scan smoke passed")
