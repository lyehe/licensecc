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

if(NOT DEFINED LICENSECC_CONFIG)
	set(LICENSECC_CONFIG "")
endif()

if(DEFINED LICENSECC_CONFIG AND NOT "${LICENSECC_CONFIG}" STREQUAL "" AND NOT "${LICENSECC_CONFIG}" STREQUAL "Debug")
	message(STATUS "Tools profile smoke is exercised only for Debug configs; current config is ${LICENSECC_CONFIG}")
	return()
endif()

_to_abs(LICENSECC_SOURCE_DIR "${LICENSECC_SOURCE_DIR}")
_to_abs(LICENSECC_BUILD_DIR "${LICENSECC_BUILD_DIR}")
set(_smoke_root "${LICENSECC_BUILD_DIR}/Testing/tools-profile")
set(_build_dir "${_smoke_root}/build")
set(_install_prefix "${_smoke_root}/prefix")
set(_package_dir "${_smoke_root}/packages")
set(_extract_dir "${_smoke_root}/extract")
set(_project_name "tools_smoke")
set(_project_magic "654321")
set(_projects_base "${_build_dir}/projects")

_remove_safe("${_smoke_root}" "${LICENSECC_BUILD_DIR}/Testing" "tools profile smoke root")
file(MAKE_DIRECTORY "${_smoke_root}" "${_package_dir}" "${_extract_dir}")

set(_configure_command
	"${CMAKE_COMMAND}"
	-S "${LICENSECC_SOURCE_DIR}"
	-B "${_build_dir}"
	-DBUILD_TESTING=OFF
	-DLCC_INSTALL_TOOLS=ON
	-DLCC_BUILD_INSPECTOR=ON
	"-DLCC_PROJECT_NAME=${_project_name}"
	"-DLCC_PROJECTS_BASE_DIR=${_projects_base}"
	"-DLCC_PROJECT_MAGIC_NUM=${_project_magic}"
	"-DCMAKE_INSTALL_PREFIX=${_install_prefix}"
)
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _configure_command "-DCMAKE_BUILD_TYPE=${LICENSECC_CONFIG}")
endif()
if(DEFINED LICENSECC_BOOST_ROOT AND NOT "${LICENSECC_BOOST_ROOT}" STREQUAL "")
	list(APPEND _configure_command "-DBOOST_ROOT=${LICENSECC_BOOST_ROOT}")
endif()
_append_generator_args(_configure_command)
_run_checked("tools profile configure" ${_configure_command})

set(_install_command "${CMAKE_COMMAND}" --build "${_build_dir}" --target install)
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _install_command --config "${LICENSECC_CONFIG}")
endif()
_run_checked("tools profile install" ${_install_command})

include("${LICENSECC_SOURCE_DIR}/test/release_manifest_assertions.cmake")
lcc_assert_release_manifest(
	"${_install_prefix}"
	"${_project_name}"
	"${_project_magic}"
	"${LICENSECC_CONFIG}"
	"installed tools profile"
	"tools"
)

_find_one(_installed_lccgen "installed lccgen" "${_install_prefix}/bin/lccgen.exe" "${_install_prefix}/bin/lccgen")
_find_one(_installed_lccinspector "installed lccinspector"
	"${_install_prefix}/bin/${_project_name}/lccinspector.exe"
	"${_install_prefix}/bin/${_project_name}/lccinspector")

set(_cpack_command
	"${LICENSECC_CPACK_COMMAND}"
	--config "${_build_dir}/CPackConfig.cmake"
	-B "${_package_dir}"
	-D LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE=ON
	-D LCC_ALLOW_RELEASE_PROJECT_KEYGEN=ON
)
if(NOT "${LICENSECC_CONFIG}" STREQUAL "")
	list(APPEND _cpack_command -C "${LICENSECC_CONFIG}")
endif()
_run_checked("tools profile package" ${_cpack_command})

file(GLOB_RECURSE _packages
	"${_package_dir}/*.zip"
	"${_package_dir}/*.tar.gz"
	"${_package_dir}/*.tgz"
)
list(LENGTH _packages _package_count)
if(NOT _package_count EQUAL 1)
	message(FATAL_ERROR "Expected exactly one tools package, found ${_package_count}: ${_packages}")
endif()
list(GET _packages 0 _package)
get_filename_component(_package_name "${_package}" NAME)
string(FIND "${_package_name}" "tools" _tools_pos)
string(FIND "${_package_name}" "${_project_name}" _project_pos)
if(_tools_pos EQUAL -1 OR _project_pos EQUAL -1)
	message(FATAL_ERROR "Tools package filename does not identify tools profile and project: ${_package_name}")
endif()

_run_checked("tools package extraction" "${CMAKE_COMMAND}" -E chdir "${_extract_dir}" "${CMAKE_COMMAND}" -E tar xf "${_package}")

_find_one(_extracted_manifest "extracted tools release manifest" "${_extract_dir}/*/share/licensecc/${_project_name}/release-manifest.cmake")
get_filename_component(_manifest_dir "${_extracted_manifest}" DIRECTORY)
get_filename_component(_prefix "${_manifest_dir}/../../.." ABSOLUTE)
lcc_assert_release_manifest(
	"${_prefix}"
	"${_project_name}"
	"${_project_magic}"
	"${LICENSECC_CONFIG}"
	"extracted tools profile"
	"tools"
)
lcc_read_release_manifest("${_extracted_manifest}")
string(FIND "${_package_name}" "${LICENSECC_CONFIG}" _tools_config_pos)
string(FIND "${_package_name}" "${LCC_RELEASE_ABI_TAG}" _tools_abi_pos)
if((NOT "${LICENSECC_CONFIG}" STREQUAL "" AND _tools_config_pos EQUAL -1) OR _tools_abi_pos EQUAL -1)
	message(FATAL_ERROR
		"Tools package filename does not identify build config and ABI.\n"
		"Package: ${_package_name}\n"
		"Expected config: ${LICENSECC_CONFIG}\n"
		"Expected ABI: ${LCC_RELEASE_ABI_TAG}")
endif()

_find_one(_extracted_lccgen "extracted lccgen" "${_prefix}/bin/lccgen.exe" "${_prefix}/bin/lccgen")
_find_one(_extracted_lccinspector "extracted lccinspector"
	"${_prefix}/bin/${_project_name}/lccinspector.exe"
	"${_prefix}/bin/${_project_name}/lccinspector")

execute_process(
	COMMAND "${CMAKE_COMMAND}"
		"-DLCC_ARTIFACT_SCAN_ROOT=${_prefix}"
		-DLCC_ARTIFACT_ALLOW_TOOLS=OFF
		-P "${LICENSECC_SOURCE_DIR}/cmake/ScanReleaseArtifact.cmake"
	RESULT_VARIABLE _runtime_scan_result
	OUTPUT_VARIABLE _runtime_scan_stdout
	ERROR_VARIABLE _runtime_scan_stderr
)
string(CONCAT _runtime_scan_output "${_runtime_scan_stdout}\n${_runtime_scan_stderr}")
if(_runtime_scan_result EQUAL 0)
	message(FATAL_ERROR "Tools package unexpectedly passed runtime tool-free scan")
endif()
if(NOT _runtime_scan_output MATCHES "tooling executable present")
	message(FATAL_ERROR
		"Tools package runtime scan failed without the expected tooling diagnostic.\n"
		"stdout:\n${_runtime_scan_stdout}\n"
		"stderr:\n${_runtime_scan_stderr}")
endif()

_run_checked(
	"tools package scan with tools allowed"
	"${CMAKE_COMMAND}"
	"-DLCC_ARTIFACT_SCAN_ROOT=${_prefix}"
	-DLCC_ARTIFACT_ALLOW_TOOLS=ON
	-P "${LICENSECC_SOURCE_DIR}/cmake/ScanReleaseArtifact.cmake"
)

message(STATUS "Tools profile smoke passed")
