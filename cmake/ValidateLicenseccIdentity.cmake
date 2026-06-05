if(DEFINED _LCC_VALIDATE_LICENSECC_IDENTITY_INCLUDED)
	return()
endif()
set(_LCC_VALIDATE_LICENSECC_IDENTITY_INCLUDED TRUE)

function(lcc_validate_project_name project_name)
	if("${project_name}" STREQUAL "")
		message(FATAL_ERROR "invalid licensecc project name: must not be empty")
	endif()
	if(NOT "${project_name}" MATCHES "^[A-Za-z_][A-Za-z0-9_]*$")
		message(FATAL_ERROR
			"invalid licensecc project name '${project_name}': use only ASCII letters, digits, "
			"and '_', and start with an ASCII letter or '_'")
	endif()
endfunction()

function(lcc_validate_project_magic_num project_magic_num)
	if("${project_magic_num}" STREQUAL "")
		message(FATAL_ERROR "invalid LCC_PROJECT_MAGIC_NUM: must not be empty")
	endif()
	if(NOT "${project_magic_num}" MATCHES "^[0-9]+$")
		message(FATAL_ERROR "invalid LCC_PROJECT_MAGIC_NUM '${project_magic_num}': use a non-negative decimal integer")
	endif()
endfunction()

function(lcc_validate_package_profile package_profile)
	if("${package_profile}" STREQUAL "")
		message(FATAL_ERROR "invalid licensecc package profile: must not be empty")
	endif()
	if(NOT "${package_profile}" MATCHES "^(runtime|tools|source)$")
		message(FATAL_ERROR
			"invalid licensecc package profile '${package_profile}': expected runtime, tools, or source")
	endif()
endfunction()
