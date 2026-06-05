if(POLICY CMP0057)
	cmake_policy(SET CMP0057 NEW)
endif()

include("${CMAKE_CURRENT_LIST_DIR}/ValidateLicenseccIdentity.cmake")

if(NOT DEFINED LCC_CONFIG_NAME)
	set(LCC_CONFIG_NAME "")
endif()
if(NOT DEFINED LCC_PROJECT_NAME)
	set(LCC_PROJECT_NAME "")
endif()
if(NOT DEFINED LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE)
	set(LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE OFF)
endif()
if(NOT DEFINED LCC_ALLOW_RELEASE_PROJECT_KEYGEN)
	set(LCC_ALLOW_RELEASE_PROJECT_KEYGEN OFF)
endif()
if(NOT DEFINED LCC_ENFORCE_RELEASE_ARTIFACT_POLICY)
	set(LCC_ENFORCE_RELEASE_ARTIFACT_POLICY OFF)
endif()
if(NOT DEFINED LCCGEN_EXECUTABLE)
	set(LCCGEN_EXECUTABLE "")
endif()
if(NOT DEFINED LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN OR "${LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN}" STREQUAL "")
	set(LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN 390)
endif()
if(NOT "${LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN}" MATCHES "^[0-9]+$")
	message(FATAL_ERROR "LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN must be numeric: ${LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN}")
endif()
if(NOT DEFINED LCC_MIN_RELEASE_PUBLIC_KEY_BITS OR "${LCC_MIN_RELEASE_PUBLIC_KEY_BITS}" STREQUAL "")
	set(LCC_MIN_RELEASE_PUBLIC_KEY_BITS 3072)
endif()
if(NOT "${LCC_MIN_RELEASE_PUBLIC_KEY_BITS}" MATCHES "^[0-9]+$")
	message(FATAL_ERROR "LCC_MIN_RELEASE_PUBLIC_KEY_BITS must be numeric: ${LCC_MIN_RELEASE_PUBLIC_KEY_BITS}")
endif()
if(NOT DEFINED LCC_FORBIDDEN_RELEASE_PROJECT_NAMES OR "${LCC_FORBIDDEN_RELEASE_PROJECT_NAMES}" STREQUAL "")
	set(LCC_FORBIDDEN_RELEASE_PROJECT_NAMES
		DEFAULT
		test
		demo
		example
		sample
		magic_smoke
		tools_smoke)
endif()

lcc_validate_project_name("${LCC_PROJECT_NAME}")

function(_lcc_read_public_key_numeric_define out_var public_key_header define_name)
	set(${out_var} "" PARENT_SCOPE)
	if(NOT EXISTS "${public_key_header}")
		return()
	endif()
	file(STRINGS "${public_key_header}" _lcc_public_key_numeric_lines
		REGEX "^[ \t]*#define[ \t]+${define_name}[ \t]+[^ \t]+[ \t]*$"
		LIMIT_COUNT 1)
	if(NOT _lcc_public_key_numeric_lines)
		return()
	endif()
	list(GET _lcc_public_key_numeric_lines 0 _lcc_public_key_numeric_line)
	string(REGEX REPLACE "^[ \t]*#define[ \t]+${define_name}[ \t]+([^ \t]+)[ \t]*$" "\\1"
		_lcc_public_key_numeric_value "${_lcc_public_key_numeric_line}")
	set(${out_var} "${_lcc_public_key_numeric_value}" PARENT_SCOPE)
endfunction()

function(_lcc_read_public_key_string_define out_var public_key_header define_name)
	set(${out_var} "" PARENT_SCOPE)
	if(NOT EXISTS "${public_key_header}")
		return()
	endif()
	file(STRINGS "${public_key_header}" _lcc_public_key_string_lines
		REGEX "^[ \t]*#define[ \t]+${define_name}[ \t]+\"[^\"]*\"[ \t]*$"
		LIMIT_COUNT 1)
	if(NOT _lcc_public_key_string_lines)
		return()
	endif()
	list(GET _lcc_public_key_string_lines 0 _lcc_public_key_string_line)
	string(REGEX REPLACE "^[ \t]*#define[ \t]+${define_name}[ \t]+\"([^\"]*)\"[ \t]*$" "\\1"
		_lcc_public_key_string_value "${_lcc_public_key_string_line}")
	set(${out_var} "${_lcc_public_key_string_value}" PARENT_SCOPE)
endfunction()

function(_lcc_read_public_key_der_len out_var public_key_header)
	_lcc_read_public_key_numeric_define(_lcc_public_key_len "${public_key_header}" PUBLIC_KEY_LEN)
	set(${out_var} "${_lcc_public_key_len}" PARENT_SCOPE)
endfunction()

string(TOLOWER "${LCC_CONFIG_NAME}" _lcc_config_lower)
set(_lcc_release_configs release relwithdebinfo minsizerel)
set(_lcc_release_policy_active OFF)
if(_lcc_config_lower IN_LIST _lcc_release_configs OR LCC_ENFORCE_RELEASE_ARTIFACT_POLICY)
	set(_lcc_release_policy_active ON)
endif()
string(TOLOWER "${LCC_PROJECT_NAME}" _lcc_project_lower)
set(_lcc_forbidden_project_name "")
foreach(_lcc_forbidden_project IN LISTS LCC_FORBIDDEN_RELEASE_PROJECT_NAMES)
	string(TOLOWER "${_lcc_forbidden_project}" _lcc_forbidden_project_lower)
	if(_lcc_project_lower STREQUAL _lcc_forbidden_project_lower)
		set(_lcc_forbidden_project_name "${_lcc_forbidden_project}")
		break()
	endif()
endforeach()

if(_lcc_release_policy_active AND
   NOT "${_lcc_forbidden_project_name}" STREQUAL "" AND
   NOT LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE)
	message(FATAL_ERROR
		"Release builds/install/package artifacts must use a product-specific LCC_PROJECT_NAME. "
		"'${LCC_PROJECT_NAME}' is reserved for local tests or examples; set -DLCC_PROJECT_NAME=<product>.")
endif()

if(_lcc_release_policy_active AND NOT LCC_ALLOW_RELEASE_PROJECT_KEYGEN)
	set(_lcc_missing_release_key_paths)
	foreach(_lcc_required_key_var IN ITEMS LCC_PROJECT_PUBLIC_KEY LCC_PROJECT_PRIVATE_KEY)
		if(NOT DEFINED ${_lcc_required_key_var} OR "${${_lcc_required_key_var}}" STREQUAL "")
			list(APPEND _lcc_missing_release_key_paths "${_lcc_required_key_var}=<unset>")
		elseif(NOT EXISTS "${${_lcc_required_key_var}}")
			list(APPEND _lcc_missing_release_key_paths "${${_lcc_required_key_var}}")
		endif()
	endforeach()
	if(_lcc_missing_release_key_paths)
		string(REPLACE ";" ", " _lcc_missing_release_key_paths_text "${_lcc_missing_release_key_paths}")
		message(FATAL_ERROR
			"Release project keys are missing. Initialize the issuer-controlled "
			"LCC_PROJECTS_BASE_DIR before building release artifacts or set "
			"LCC_ALLOW_RELEASE_PROJECT_KEYGEN=ON for an explicit local-development opt-out. "
			"Missing: ${_lcc_missing_release_key_paths_text}")
	endif()
endif()

if(_lcc_release_policy_active AND
   DEFINED LCC_PROJECT_PUBLIC_KEY AND
   NOT "${LCC_PROJECT_PUBLIC_KEY}" STREQUAL "" AND
   EXISTS "${LCC_PROJECT_PUBLIC_KEY}")
	_lcc_read_public_key_der_len(_lcc_public_key_der_len "${LCC_PROJECT_PUBLIC_KEY}")
	if("${_lcc_public_key_der_len}" STREQUAL "")
		message(FATAL_ERROR
			"Release public key length is missing from ${LCC_PROJECT_PUBLIC_KEY}. "
			"Regenerate the project with the current lccgen templates before producing release artifacts.")
	endif()
	if(NOT "${_lcc_public_key_der_len}" MATCHES "^[0-9]+$")
		message(FATAL_ERROR
			"Release public key length is not numeric in ${LCC_PROJECT_PUBLIC_KEY}: ${_lcc_public_key_der_len}")
	endif()
	if(_lcc_public_key_der_len LESS LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN)
		message(FATAL_ERROR
			"Release public key is too small (${_lcc_public_key_der_len} DER bytes; "
			"minimum ${LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN}). Regenerate project keys "
			"with the current RSA-3072 default instead of a legacy RSA-1024 key.")
	endif()
	_lcc_read_public_key_string_define(_lcc_public_key_algorithm "${LCC_PROJECT_PUBLIC_KEY}" LCC_PUBLIC_KEY_ALGORITHM)
	if("${_lcc_public_key_algorithm}" STREQUAL "")
		message(FATAL_ERROR
			"Release public key algorithm is missing from ${LCC_PROJECT_PUBLIC_KEY}. "
			"Regenerate the project with the current lccgen templates before producing release artifacts.")
	endif()
	if(NOT "${_lcc_public_key_algorithm}" STREQUAL "rsa")
		message(FATAL_ERROR
			"Release public key algorithm is unsupported in ${LCC_PROJECT_PUBLIC_KEY}: "
			"${_lcc_public_key_algorithm}; expected rsa.")
	endif()
	_lcc_read_public_key_numeric_define(_lcc_public_key_bits "${LCC_PROJECT_PUBLIC_KEY}" LCC_PUBLIC_KEY_BITS)
	if("${_lcc_public_key_bits}" STREQUAL "")
		message(FATAL_ERROR
			"Release public key bit length is missing from ${LCC_PROJECT_PUBLIC_KEY}. "
			"Regenerate the project with the current lccgen templates before producing release artifacts.")
	endif()
	if(NOT "${_lcc_public_key_bits}" MATCHES "^[0-9]+$")
		message(FATAL_ERROR
			"Release public key bit length is not numeric in ${LCC_PROJECT_PUBLIC_KEY}: ${_lcc_public_key_bits}")
	endif()
	if(_lcc_public_key_bits LESS LCC_MIN_RELEASE_PUBLIC_KEY_BITS)
		message(FATAL_ERROR
			"Release public key is too small (${_lcc_public_key_bits} bits; "
			"minimum ${LCC_MIN_RELEASE_PUBLIC_KEY_BITS}; ${_lcc_public_key_der_len} DER bytes). "
			"Regenerate project keys with the current RSA-3072 default instead of a legacy RSA-1024 key.")
	endif()
	_lcc_read_public_key_string_define(_lcc_signature_algorithm "${LCC_PROJECT_PUBLIC_KEY}" LCC_SIGNATURE_ALGORITHM)
	if("${_lcc_signature_algorithm}" STREQUAL "")
		message(FATAL_ERROR
			"Release signature algorithm is missing from ${LCC_PROJECT_PUBLIC_KEY}. "
			"Regenerate the project with the current lccgen templates before producing release artifacts.")
	endif()
	if(NOT "${_lcc_signature_algorithm}" STREQUAL "rsa-pkcs1-sha256")
		message(FATAL_ERROR
			"Release signature algorithm is unsupported in ${LCC_PROJECT_PUBLIC_KEY}: "
			"${_lcc_signature_algorithm}; expected rsa-pkcs1-sha256.")
	endif()
endif()

if(_lcc_release_policy_active AND
   NOT "${LCCGEN_EXECUTABLE}" STREQUAL "" AND
   DEFINED LCC_PROJECT_PUBLIC_KEY AND
   DEFINED LCC_PROJECT_PRIVATE_KEY AND
   EXISTS "${LCC_PROJECT_PUBLIC_KEY}" AND
   EXISTS "${LCC_PROJECT_PRIVATE_KEY}")
	if(NOT EXISTS "${LCCGEN_EXECUTABLE}")
		message(FATAL_ERROR
			"LCCGEN_EXECUTABLE was set for release key-pair validation but does not exist: ${LCCGEN_EXECUTABLE}")
	endif()
	execute_process(
		COMMAND "${LCCGEN_EXECUTABLE}" project validate-keypair
			--private-key "${LCC_PROJECT_PRIVATE_KEY}"
			--public-key "${LCC_PROJECT_PUBLIC_KEY}"
		RESULT_VARIABLE _lcc_keypair_result
		OUTPUT_VARIABLE _lcc_keypair_stdout
		ERROR_VARIABLE _lcc_keypair_stderr)
	if(NOT _lcc_keypair_result EQUAL 0)
		string(STRIP "${_lcc_keypair_stdout}" _lcc_keypair_stdout)
		string(STRIP "${_lcc_keypair_stderr}" _lcc_keypair_stderr)
		string(CONCAT _lcc_keypair_output "${_lcc_keypair_stdout}\n${_lcc_keypair_stderr}")
		string(STRIP "${_lcc_keypair_output}" _lcc_keypair_output)
		message(FATAL_ERROR
			"Release project key-pair consistency check failed. "
			"${_lcc_keypair_output}")
	endif()
endif()
