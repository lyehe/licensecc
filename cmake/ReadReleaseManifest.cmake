if(DEFINED _LCC_READ_RELEASE_MANIFEST_INCLUDED)
	return()
endif()
set(_LCC_READ_RELEASE_MANIFEST_INCLUDED TRUE)

set(LCC_RELEASE_MANIFEST_KEYS
	LCC_RELEASE_MANIFEST_VERSION
	LCC_RELEASE_PACKAGE_NAME
	LCC_RELEASE_PACKAGE_VERSION
	LCC_RELEASE_PACKAGE_PROFILE
	LCC_RELEASE_LICENSE_FORMAT_MIN
	LCC_RELEASE_LICENSE_FORMAT_MAX
	LCC_RELEASE_PROJECT_NAME
	LCC_RELEASE_PROJECT_MAGIC_NUM
	LCC_RELEASE_BUILD_CONFIG
	LCC_RELEASE_PLATFORM
	LCC_RELEASE_SYSTEM_PROCESSOR
	LCC_RELEASE_GENERATOR
	LCC_RELEASE_COMPILER_ID
	LCC_RELEASE_COMPILER_VERSION
	LCC_RELEASE_COMPILER_ARCHITECTURE
	LCC_RELEASE_RUNTIME_LINKAGE
	LCC_RELEASE_ABI_TAG
	LCC_RELEASE_PUBLIC_KEY_PATH
	LCC_RELEASE_PUBLIC_KEY_SHA256
	LCC_RELEASE_PUBLIC_KEY_DER_SHA256
	LCC_RELEASE_PUBLIC_KEY_ID
	LCC_RELEASE_PUBLIC_KEY_DER_LEN
	LCC_RELEASE_PUBLIC_KEY_ALGORITHM
	LCC_RELEASE_PUBLIC_KEY_BITS
	LCC_RELEASE_SIGNATURE_ALGORITHM
	LCC_RELEASE_PROPERTIES_PATH
	LCC_RELEASE_PROPERTIES_SHA256)

function(lcc_read_release_manifest manifest_path)
	if(NOT EXISTS "${manifest_path}")
		message(FATAL_ERROR "Release manifest is missing: ${manifest_path}")
	endif()

	foreach(_lcc_manifest_key IN LISTS LCC_RELEASE_MANIFEST_KEYS)
		unset(${_lcc_manifest_key} PARENT_SCOPE)
	endforeach()

	file(STRINGS "${manifest_path}" _lcc_manifest_lines)
	set(_lcc_manifest_seen_keys)
	set(_lcc_manifest_line_number 0)
	foreach(_lcc_manifest_line IN LISTS _lcc_manifest_lines)
		math(EXPR _lcc_manifest_line_number "${_lcc_manifest_line_number} + 1")
		if("${_lcc_manifest_line}" STREQUAL "")
			continue()
		endif()
		if(NOT "${_lcc_manifest_line}" MATCHES "^set\\(([A-Za-z0-9_]+) \"(.*)\"\\)$")
			message(FATAL_ERROR
				"Release manifest contains unsupported syntax at ${manifest_path}:${_lcc_manifest_line_number}")
		endif()
		set(_lcc_manifest_key "${CMAKE_MATCH_1}")
		set(_lcc_manifest_value "${CMAKE_MATCH_2}")

		list(FIND LCC_RELEASE_MANIFEST_KEYS "${_lcc_manifest_key}" _lcc_manifest_allowed_index)
		if(_lcc_manifest_allowed_index EQUAL -1)
			message(FATAL_ERROR
				"Release manifest contains unexpected key ${_lcc_manifest_key}: ${manifest_path}")
		endif()
		list(FIND _lcc_manifest_seen_keys "${_lcc_manifest_key}" _lcc_manifest_seen_index)
		if(NOT _lcc_manifest_seen_index EQUAL -1)
			message(FATAL_ERROR
				"Release manifest contains duplicate key ${_lcc_manifest_key}: ${manifest_path}")
		endif()
		if("${_lcc_manifest_value}" MATCHES ";")
			message(FATAL_ERROR
				"Release manifest value for ${_lcc_manifest_key} contains an unsupported list separator: ${manifest_path}")
		endif()

		string(REPLACE "\\\"" "\"" _lcc_manifest_value "${_lcc_manifest_value}")
		string(REPLACE "\\\\" "\\" _lcc_manifest_value "${_lcc_manifest_value}")
		list(APPEND _lcc_manifest_seen_keys "${_lcc_manifest_key}")
		set(${_lcc_manifest_key} "${_lcc_manifest_value}" PARENT_SCOPE)
	endforeach()
endfunction()
