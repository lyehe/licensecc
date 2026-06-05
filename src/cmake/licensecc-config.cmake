# licensecc-config.cmake - package configuration file
@PACKAGE_INIT@

include(CMakeFindDependencyMacro)
include("${CMAKE_CURRENT_LIST_DIR}/ReadReleaseManifest.cmake")

set_and_check(LCC_PRJ_BASE "${PACKAGE_PREFIX_DIR}/lib/licensecc")
set_and_check(_licensecc_manifest_base "${PACKAGE_PREFIX_DIR}/share/licensecc")

set(licensecc_FOUND false)
set(LCC_FOUND false)

macro(_licensecc_fail message)
	set(licensecc_FOUND false)
	set(LCC_FOUND false)
	set(licensecc_NOT_FOUND_MESSAGE "${message}")
	if(licensecc_FIND_REQUIRED)
		message(FATAL_ERROR "${message}")
	elseif(NOT licensecc_FIND_QUIETLY)
		message(WARNING "${message}")
	endif()
endmacro()

function(_licensecc_validate_project_name out_var project_name)
	set(${out_var} false PARENT_SCOPE)
	if("${project_name}" STREQUAL "")
		_licensecc_fail("licensecc project name is empty.")
		return()
	endif()
	if(NOT "${project_name}" MATCHES "^[A-Za-z_][A-Za-z0-9_]*$")
		_licensecc_fail("invalid licensecc project name '${project_name}' contains unsafe characters. Use only ASCII letters, digits, and '_', and start with an ASCII letter or '_'.")
		return()
	endif()
	set(${out_var} true PARENT_SCOPE)
endfunction()

function(_licensecc_load_project_metadata out_var project_name)
	set(${out_var} false PARENT_SCOPE)
	set(_manifest "${_licensecc_manifest_base}/${project_name}/release-manifest.cmake")
	if(NOT EXISTS "${_manifest}")
		_licensecc_fail("licensecc project ${project_name} is missing release metadata: ${_manifest}.")
		return()
	endif()

	unset(LCC_RELEASE_PACKAGE_PROFILE)
	unset(LCC_RELEASE_LICENSE_FORMAT_MIN)
	unset(LCC_RELEASE_LICENSE_FORMAT_MAX)
	unset(LCC_RELEASE_PROJECT_NAME)
	unset(LCC_RELEASE_PROJECT_MAGIC_NUM)
	unset(LCC_RELEASE_BUILD_CONFIG)
	unset(LCC_RELEASE_PUBLIC_KEY_SHA256)
	unset(LCC_RELEASE_PUBLIC_KEY_DER_SHA256)
	unset(LCC_RELEASE_PUBLIC_KEY_ID)
	unset(LCC_RELEASE_ABI_TAG)
	lcc_read_release_manifest("${_manifest}")

	foreach(_required_var IN ITEMS
		LCC_RELEASE_PACKAGE_PROFILE
		LCC_RELEASE_LICENSE_FORMAT_MIN
		LCC_RELEASE_LICENSE_FORMAT_MAX
		LCC_RELEASE_PROJECT_NAME
		LCC_RELEASE_PROJECT_MAGIC_NUM
		LCC_RELEASE_BUILD_CONFIG
		LCC_RELEASE_PUBLIC_KEY_SHA256
		LCC_RELEASE_PUBLIC_KEY_DER_SHA256
		LCC_RELEASE_PUBLIC_KEY_ID
		LCC_RELEASE_ABI_TAG)
		if(NOT DEFINED ${_required_var} OR "${${_required_var}}" STREQUAL "")
			_licensecc_fail("licensecc project ${project_name} release metadata is missing ${_required_var}: ${_manifest}.")
			return()
		endif()
	endforeach()

	if(NOT "${LCC_RELEASE_PROJECT_NAME}" STREQUAL "${project_name}")
		_licensecc_fail("licensecc project ${project_name} release metadata identifies project ${LCC_RELEASE_PROJECT_NAME}.")
		return()
	endif()

	set(licensecc_PROJECT_NAME "${LCC_RELEASE_PROJECT_NAME}" PARENT_SCOPE)
	set(licensecc_PROJECT_MAGIC_NUM "${LCC_RELEASE_PROJECT_MAGIC_NUM}" PARENT_SCOPE)
	set(licensecc_PACKAGE_PROFILE "${LCC_RELEASE_PACKAGE_PROFILE}" PARENT_SCOPE)
	set(licensecc_LICENSE_FORMAT_MIN "${LCC_RELEASE_LICENSE_FORMAT_MIN}" PARENT_SCOPE)
	set(licensecc_LICENSE_FORMAT_MAX "${LCC_RELEASE_LICENSE_FORMAT_MAX}" PARENT_SCOPE)
	set(licensecc_PUBLIC_KEY_SHA256 "${LCC_RELEASE_PUBLIC_KEY_SHA256}" PARENT_SCOPE)
	set(licensecc_PUBLIC_KEY_DER_SHA256 "${LCC_RELEASE_PUBLIC_KEY_DER_SHA256}" PARENT_SCOPE)
	set(licensecc_PUBLIC_KEY_ID "${LCC_RELEASE_PUBLIC_KEY_ID}" PARENT_SCOPE)
	set(licensecc_ABI_TAG "${LCC_RELEASE_ABI_TAG}" PARENT_SCOPE)
	set(licensecc_BUILD_CONFIG "${LCC_RELEASE_BUILD_CONFIG}" PARENT_SCOPE)
	set(licensecc_MANIFEST_PATH "${_manifest}" PARENT_SCOPE)
	set(${out_var} true PARENT_SCOPE)
endfunction()

function(_licensecc_check_existing_target_metadata out_var target_name)
	set(${out_var} false PARENT_SCOPE)
	if(NOT TARGET "${target_name}")
		set(${out_var} true PARENT_SCOPE)
		return()
	endif()

	set(_identity_props
		LICENSECC_PROJECT_NAME "${licensecc_PROJECT_NAME}"
		LICENSECC_PROJECT_MAGIC_NUM "${licensecc_PROJECT_MAGIC_NUM}"
		LICENSECC_PACKAGE_PROFILE "${licensecc_PACKAGE_PROFILE}"
		LICENSECC_LICENSE_FORMAT_MIN "${licensecc_LICENSE_FORMAT_MIN}"
		LICENSECC_LICENSE_FORMAT_MAX "${licensecc_LICENSE_FORMAT_MAX}"
		LICENSECC_PUBLIC_KEY_SHA256 "${licensecc_PUBLIC_KEY_SHA256}"
		LICENSECC_PUBLIC_KEY_DER_SHA256 "${licensecc_PUBLIC_KEY_DER_SHA256}"
		LICENSECC_PUBLIC_KEY_ID "${licensecc_PUBLIC_KEY_ID}"
		LICENSECC_ABI_TAG "${licensecc_ABI_TAG}"
		LICENSECC_BUILD_CONFIG "${licensecc_BUILD_CONFIG}")
	while(_identity_props)
		list(POP_FRONT _identity_props _prop _expected)
		get_target_property(_actual "${target_name}" "${_prop}")
		if(NOT DEFINED _actual OR "${_actual}" STREQUAL "_actual-NOTFOUND")
			_licensecc_fail("Target ${target_name} already exists without licensecc package identity metadata (${_prop}); refusing to reuse it for project ${licensecc_PROJECT_NAME}.")
			return()
		endif()
		if(NOT "${_actual}" STREQUAL "${_expected}")
			_licensecc_fail("Target ${target_name} already exists with incompatible licensecc package identity for ${_prop}. Existing: '${_actual}'. Requested: '${_expected}'.")
			return()
		endif()
	endwhile()

	set(${out_var} true PARENT_SCOPE)
endfunction()

function(_licensecc_apply_target_metadata target_name)
	if(NOT TARGET "${target_name}")
		_licensecc_fail("licensecc project ${licensecc_PROJECT_NAME} did not define ${target_name}.")
		return()
	endif()
	set_target_properties("${target_name}" PROPERTIES
		LICENSECC_PROJECT_NAME "${licensecc_PROJECT_NAME}"
		LICENSECC_PROJECT_MAGIC_NUM "${licensecc_PROJECT_MAGIC_NUM}"
		LICENSECC_PACKAGE_PROFILE "${licensecc_PACKAGE_PROFILE}"
		LICENSECC_LICENSE_FORMAT_MIN "${licensecc_LICENSE_FORMAT_MIN}"
		LICENSECC_LICENSE_FORMAT_MAX "${licensecc_LICENSE_FORMAT_MAX}"
		LICENSECC_PUBLIC_KEY_SHA256 "${licensecc_PUBLIC_KEY_SHA256}"
		LICENSECC_PUBLIC_KEY_DER_SHA256 "${licensecc_PUBLIC_KEY_DER_SHA256}"
		LICENSECC_PUBLIC_KEY_ID "${licensecc_PUBLIC_KEY_ID}"
		LICENSECC_ABI_TAG "${licensecc_ABI_TAG}"
		LICENSECC_BUILD_CONFIG "${licensecc_BUILD_CONFIG}"
		LICENSECC_MANIFEST_PATH "${licensecc_MANIFEST_PATH}")
endfunction()

function(_licensecc_check_consumer_config)
	if(CMAKE_BUILD_TYPE AND
	   NOT "${licensecc_BUILD_CONFIG}" STREQUAL "" AND
	   NOT "${licensecc_BUILD_CONFIG}" STREQUAL "multi" AND
	   NOT "${CMAKE_BUILD_TYPE}" STREQUAL "${licensecc_BUILD_CONFIG}")
		_licensecc_fail("licensecc project ${licensecc_PROJECT_NAME} was packaged for build config '${licensecc_BUILD_CONFIG}', but the consumer configured CMAKE_BUILD_TYPE='${CMAKE_BUILD_TYPE}'. Use a matching package/configuration.")
	endif()
endfunction()

macro(_licensecc_expose_metadata_to_parent)
	foreach(_metadata_var IN ITEMS
		licensecc_PROJECT_NAME
		licensecc_PROJECT_MAGIC_NUM
		licensecc_PACKAGE_PROFILE
		licensecc_LICENSE_FORMAT_MIN
		licensecc_LICENSE_FORMAT_MAX
		licensecc_PUBLIC_KEY_SHA256
		licensecc_PUBLIC_KEY_DER_SHA256
		licensecc_PUBLIC_KEY_ID
		licensecc_ABI_TAG
		licensecc_BUILD_CONFIG
		licensecc_MANIFEST_PATH)
		set(${_metadata_var} "${${_metadata_var}}" PARENT_SCOPE)
	endforeach()
	set(LICENSECC_PROJECT_NAME "${licensecc_PROJECT_NAME}" PARENT_SCOPE)
	set(LICENSECC_PROJECT_MAGIC_NUM "${licensecc_PROJECT_MAGIC_NUM}" PARENT_SCOPE)
	set(LICENSECC_PACKAGE_PROFILE "${licensecc_PACKAGE_PROFILE}" PARENT_SCOPE)
	set(LICENSECC_LICENSE_FORMAT_MIN "${licensecc_LICENSE_FORMAT_MIN}" PARENT_SCOPE)
	set(LICENSECC_LICENSE_FORMAT_MAX "${licensecc_LICENSE_FORMAT_MAX}" PARENT_SCOPE)
	set(LICENSECC_PUBLIC_KEY_SHA256 "${licensecc_PUBLIC_KEY_SHA256}" PARENT_SCOPE)
	set(LICENSECC_PUBLIC_KEY_DER_SHA256 "${licensecc_PUBLIC_KEY_DER_SHA256}" PARENT_SCOPE)
	set(LICENSECC_PUBLIC_KEY_ID "${licensecc_PUBLIC_KEY_ID}" PARENT_SCOPE)
	set(LICENSECC_ABI_TAG "${licensecc_ABI_TAG}" PARENT_SCOPE)
	set(LICENSECC_BUILD_CONFIG "${licensecc_BUILD_CONFIG}" PARENT_SCOPE)
	set(LICENSECC_MANIFEST_PATH "${licensecc_MANIFEST_PATH}" PARENT_SCOPE)
endmacro()

function(_licensecc_load_project project_name)
	_licensecc_validate_project_name(_licensecc_project_name_valid "${project_name}")
	if(NOT _licensecc_project_name_valid)
		return()
	endif()

	_licensecc_load_project_metadata(_licensecc_metadata_loaded "${project_name}")
	if(NOT _licensecc_metadata_loaded)
		return()
	endif()

	_licensecc_check_consumer_config()
	_licensecc_check_existing_target_metadata(_licensecc_target_metadata_ok licensecc::licensecc_static)
	if(NOT _licensecc_target_metadata_ok)
		return()
	endif()

	set(cmakefile "${LCC_PRJ_BASE}/${project_name}/cmake/licensecc.cmake")
	if(EXISTS "${cmakefile}")
		include("${cmakefile}")
		if(TARGET licensecc::licensecc_static)
			_licensecc_apply_target_metadata(licensecc::licensecc_static)
			_licensecc_expose_metadata_to_parent()
			set(${project_name}_FOUND true)
			set(licensecc_${project_name}_FOUND true)
			set(licensecc_FOUND true)
			set(LCC_FOUND true)
			set(${project_name}_FOUND true PARENT_SCOPE)
			set(licensecc_${project_name}_FOUND true PARENT_SCOPE)
			set(licensecc_FOUND true PARENT_SCOPE)
			set(LCC_FOUND true PARENT_SCOPE)
		else()
			_licensecc_fail("licensecc project ${project_name} export was loaded from ${cmakefile}, but it did not define licensecc::licensecc_static.")
		endif()
	else()
		set(${project_name}_FOUND false)
		set(licensecc_${project_name}_FOUND false)
		set(${project_name}_FOUND false PARENT_SCOPE)
		set(licensecc_${project_name}_FOUND false PARENT_SCOPE)
		_licensecc_fail("licensecc project ${project_name} not found under ${LCC_PRJ_BASE}. Set -DLCC_PROJECT_NAME=<installed project> or use find_package(licensecc REQUIRED COMPONENTS <project>).")
	endif()
endfunction()

if(licensecc_FIND_COMPONENTS)
	list(LENGTH licensecc_FIND_COMPONENTS _licensecc_component_count)
	if(_licensecc_component_count GREATER 1)
		_licensecc_fail("licensecc supports selecting one installed project per consumer target; requested components: ${licensecc_FIND_COMPONENTS}.")
	else()
		list(GET licensecc_FIND_COMPONENTS 0 _licensecc_component)
		_licensecc_load_project("${_licensecc_component}")
	endif()
else()
	if(DEFINED LCC_PROJECT_NAME AND NOT "${LCC_PROJECT_NAME}" STREQUAL "")
		_licensecc_load_project("${LCC_PROJECT_NAME}")
	elseif(PROJECT_NAME AND EXISTS "${LCC_PRJ_BASE}/${PROJECT_NAME}/cmake/licensecc.cmake")
		_licensecc_load_project("${PROJECT_NAME}")
	else()
		_licensecc_fail("licensecc project not selected. Set -DLCC_PROJECT_NAME=<installed project> or use find_package(licensecc REQUIRED COMPONENTS <project>).")
	endif()
endif()

if(licensecc_FOUND AND TARGET licensecc::licensecc_static)
	get_property(COMPILE_DEF TARGET licensecc::licensecc_static PROPERTY INTERFACE_COMPILE_DEFINITIONS)
	if("HAS_OPENSSL" IN_LIST COMPILE_DEF AND NOT TARGET OpenSSL::Crypto)
		find_dependency(OpenSSL COMPONENTS Crypto)
	endif()
endif()
