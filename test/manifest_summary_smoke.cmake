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

function(_append_manifest_value manifest name value)
	string(REPLACE "\\" "\\\\" _escaped "${value}")
	string(REPLACE "\"" "\\\"" _escaped "${_escaped}")
	file(APPEND "${manifest}" "set(${name} \"${_escaped}\")\n")
endfunction()

function(_write_manifest prefix project public_key_path generator)
	set(_manifest_dir "${prefix}/share/licensecc/${project}")
	set(_manifest "${_manifest_dir}/release-manifest.cmake")
	file(MAKE_DIRECTORY "${_manifest_dir}")
	file(WRITE "${_manifest}" "")
	_append_manifest_value("${_manifest}" LCC_RELEASE_MANIFEST_VERSION "1")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PACKAGE_NAME "licensecc")
		_append_manifest_value("${_manifest}" LCC_RELEASE_PACKAGE_VERSION "2.1.0")
		_append_manifest_value("${_manifest}" LCC_RELEASE_PACKAGE_PROFILE "runtime")
		_append_manifest_value("${_manifest}" LCC_RELEASE_LICENSE_FORMAT_MIN "200")
		_append_manifest_value("${_manifest}" LCC_RELEASE_LICENSE_FORMAT_MAX "201")
		_append_manifest_value("${_manifest}" LCC_RELEASE_PROJECT_NAME "${project}")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PROJECT_MAGIC_NUM "123456")
	_append_manifest_value("${_manifest}" LCC_RELEASE_BUILD_CONFIG "Debug")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PLATFORM "Windows")
	_append_manifest_value("${_manifest}" LCC_RELEASE_SYSTEM_PROCESSOR "x86_64")
	_append_manifest_value("${_manifest}" LCC_RELEASE_GENERATOR "${generator}")
	_append_manifest_value("${_manifest}" LCC_RELEASE_COMPILER_ID "MSVC")
	_append_manifest_value("${_manifest}" LCC_RELEASE_COMPILER_VERSION "19.44")
	_append_manifest_value("${_manifest}" LCC_RELEASE_COMPILER_ARCHITECTURE "x64")
	_append_manifest_value("${_manifest}" LCC_RELEASE_RUNTIME_LINKAGE "msvc-dynamic")
	_append_manifest_value("${_manifest}" LCC_RELEASE_ABI_TAG "MSVC-19.44-x64-msvc-dynamic")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PUBLIC_KEY_PATH "${public_key_path}")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PUBLIC_KEY_SHA256 "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PUBLIC_KEY_DER_SHA256 "1111111111111111111111111111111111111111111111111111111111111111")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PUBLIC_KEY_ID "sha256:1111111111111111111111111111111111111111111111111111111111111111")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PUBLIC_KEY_DER_LEN "398")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PUBLIC_KEY_ALGORITHM "rsa")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PUBLIC_KEY_BITS "3072")
	_append_manifest_value("${_manifest}" LCC_RELEASE_SIGNATURE_ALGORITHM "rsa-pkcs1-sha256")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PROPERTIES_PATH "include/licensecc/${project}/licensecc_properties.h")
	_append_manifest_value("${_manifest}" LCC_RELEASE_PROPERTIES_SHA256 "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789")
	set(LCC_MANIFEST_SUMMARY_SMOKE_LAST_MANIFEST "${_manifest}" PARENT_SCOPE)
endfunction()

function(_run_summary result_var output_var)
	execute_process(
		COMMAND ${ARGN}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	string(CONCAT _output "${_stdout}\n${_stderr}")
	set(${result_var} "${_result}" PARENT_SCOPE)
	set(${output_var} "${_output}" PARENT_SCOPE)
endfunction()

function(_assert_summary_passes description)
	_run_summary(_result _output ${ARGN})
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR "${description} summary unexpectedly failed:\n${_output}")
	endif()
	foreach(_expected IN ITEMS
		"licensecc release manifest summary"
		"package: licensecc 2.1.0"
		"profile: runtime"
		"project: MY_PRODUCT"
		"project_magic: 123456"
		"compiler: MSVC 19.44"
		"runtime_linkage: msvc-dynamic"
		"abi_tag: MSVC-19.44-x64-msvc-dynamic"
		"public_key_sha256:"
		"public_key_der_sha256:"
		"public_key_id: sha256:"
		"public_key_der_len: 398"
		"public_key_algorithm: rsa"
		"public_key_bits: 3072"
		"signature_algorithm: rsa-pkcs1-sha256"
		"properties_sha256:")
		if(NOT _output MATCHES "${_expected}")
			message(FATAL_ERROR "${description} summary is missing '${_expected}':\n${_output}")
		endif()
	endforeach()
	set(_private_key_suffix "PRIVATE KEY")
	set(_private_key_marker_regex "BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?${_private_key_suffix}|BEGIN ${_private_key_suffix}")
	if(_output MATCHES "private[_-]?key" OR
	   _output MATCHES "${_private_key_marker_regex}")
		message(FATAL_ERROR "${description} summary exposed private-key-like material:\n${_output}")
	endif()
endfunction()

function(_assert_summary_fails description expected_message)
	_run_summary(_result _output ${ARGN})
	if(_result EQUAL 0)
		message(FATAL_ERROR "${description} summary unexpectedly passed:\n${_output}")
	endif()
	if(NOT _output MATCHES "${expected_message}")
		message(FATAL_ERROR
			"${description} summary failed without expected diagnostic.\n"
			"Expected regex: ${expected_message}\n"
			"Output:\n${_output}")
	endif()
endfunction()

_require_defined(LICENSECC_SOURCE_DIR)
_require_defined(LICENSECC_BUILD_DIR)

_to_abs(LICENSECC_SOURCE_DIR "${LICENSECC_SOURCE_DIR}")
_to_abs(LICENSECC_BUILD_DIR "${LICENSECC_BUILD_DIR}")

set(_smoke_root "${LICENSECC_BUILD_DIR}/Testing/manifest-summary")
set(_safe_prefix "${_smoke_root}/safe-prefix")
set(_unsafe_prefix "${_smoke_root}/unsafe-prefix")

_remove_safe("${_smoke_root}" "${LICENSECC_BUILD_DIR}/Testing" "manifest summary smoke root")
file(MAKE_DIRECTORY "${_smoke_root}")

_write_manifest("${_safe_prefix}" "MY_PRODUCT" "include/licensecc/MY_PRODUCT/public_key.h" "Visual Studio 17 2022")
_assert_summary_passes(
	"prefix manifest"
	"${CMAKE_COMMAND}"
	"-DLCC_RELEASE_MANIFEST_PREFIX=${_safe_prefix}"
	-DLCC_RELEASE_MANIFEST_PROJECT_NAME=MY_PRODUCT
	-P "${LICENSECC_SOURCE_DIR}/cmake/PrintReleaseManifestSummary.cmake"
)
_assert_summary_passes(
	"explicit manifest path"
	"${CMAKE_COMMAND}"
	"-DLCC_RELEASE_MANIFEST_PATH=${LCC_MANIFEST_SUMMARY_SMOKE_LAST_MANIFEST}"
	-P "${LICENSECC_SOURCE_DIR}/cmake/PrintReleaseManifestSummary.cmake"
)

_write_manifest("${_unsafe_prefix}" "MY_PRODUCT" "projects/MY_PRODUCT/private_key.rsa" "Visual Studio 17 2022")
_assert_summary_fails(
	"unsafe manifest path"
	"Refusing to print unsafe release manifest value"
	"${CMAKE_COMMAND}"
	"-DLCC_RELEASE_MANIFEST_PREFIX=${_unsafe_prefix}"
	-DLCC_RELEASE_MANIFEST_PROJECT_NAME=MY_PRODUCT
	-P "${LICENSECC_SOURCE_DIR}/cmake/PrintReleaseManifestSummary.cmake"
)

set(_malicious_prefix "${_smoke_root}/malicious-prefix")
_write_manifest("${_malicious_prefix}" "MY_PRODUCT" "include/licensecc/MY_PRODUCT/public_key.h" "Visual Studio 17 2022")
set(_malicious_marker "${_smoke_root}/manifest-executed.txt")
file(APPEND "${LCC_MANIFEST_SUMMARY_SMOKE_LAST_MANIFEST}"
	"file(WRITE \"${_malicious_marker}\" \"manifest executed\")\n")
_assert_summary_fails(
	"malicious manifest syntax"
	"unsupported syntax"
	"${CMAKE_COMMAND}"
	"-DLCC_RELEASE_MANIFEST_PREFIX=${_malicious_prefix}"
	-DLCC_RELEASE_MANIFEST_PROJECT_NAME=MY_PRODUCT
	-P "${LICENSECC_SOURCE_DIR}/cmake/PrintReleaseManifestSummary.cmake"
)
if(EXISTS "${_malicious_marker}")
	message(FATAL_ERROR "Manifest summary executed unsupported manifest content: ${_malicious_marker}")
endif()

set(_unexpected_key_prefix "${_smoke_root}/unexpected-key-prefix")
_write_manifest("${_unexpected_key_prefix}" "MY_PRODUCT" "include/licensecc/MY_PRODUCT/public_key.h" "Visual Studio 17 2022")
file(APPEND "${LCC_MANIFEST_SUMMARY_SMOKE_LAST_MANIFEST}" "set(LCC_RELEASE_PRIVATE_KEY_PATH \"private_key.rsa\")\n")
_assert_summary_fails(
	"unexpected manifest key"
	"unexpected key"
	"${CMAKE_COMMAND}"
	"-DLCC_RELEASE_MANIFEST_PREFIX=${_unexpected_key_prefix}"
	-DLCC_RELEASE_MANIFEST_PROJECT_NAME=MY_PRODUCT
	-P "${LICENSECC_SOURCE_DIR}/cmake/PrintReleaseManifestSummary.cmake"
)

set(_duplicate_key_prefix "${_smoke_root}/duplicate-key-prefix")
_write_manifest("${_duplicate_key_prefix}" "MY_PRODUCT" "include/licensecc/MY_PRODUCT/public_key.h" "Visual Studio 17 2022")
file(APPEND "${LCC_MANIFEST_SUMMARY_SMOKE_LAST_MANIFEST}" "set(LCC_RELEASE_PACKAGE_NAME \"licensecc\")\n")
_assert_summary_fails(
	"duplicate manifest key"
	"duplicate key"
	"${CMAKE_COMMAND}"
	"-DLCC_RELEASE_MANIFEST_PREFIX=${_duplicate_key_prefix}"
	-DLCC_RELEASE_MANIFEST_PROJECT_NAME=MY_PRODUCT
	-P "${LICENSECC_SOURCE_DIR}/cmake/PrintReleaseManifestSummary.cmake"
)

message(STATUS "Release manifest summary smoke passed")
