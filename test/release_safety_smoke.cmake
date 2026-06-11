function(_require_defined name)
	if(NOT DEFINED ${name} OR "${${name}}" STREQUAL "")
		message(FATAL_ERROR "${name} is required")
	endif()
endfunction()

function(_to_abs out path)
	get_filename_component(_abs "${path}" ABSOLUTE)
	set(${out} "${_abs}" PARENT_SCOPE)
endfunction()

function(_to_cmake_abs out path)
	_to_abs(_abs "${path}")
	file(TO_CMAKE_PATH "${_abs}" _cmake)
	set(${out} "${_cmake}" PARENT_SCOPE)
endfunction()

function(_assert_under path root description)
	_to_cmake_abs(_path_cmake "${path}")
	_to_cmake_abs(_root_cmake "${root}")
	string(FIND "${_path_cmake}/" "${_root_cmake}/" _pos)
	if(NOT _pos EQUAL 0)
		message(FATAL_ERROR "${description} must be under ${_root_cmake}: ${_path_cmake}")
	endif()
endfunction()

function(_remove_safe path root description)
	_assert_under("${path}" "${root}" "${description}")
	file(REMOVE_RECURSE "${path}")
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

function(_append_common_configure_args out_var)
	list(APPEND ${out_var}
		-DBUILD_TESTING=OFF
		-DLCC_BUILD_INSPECTOR=OFF
		-DBUILD_BENCHMARKS=OFF
		-DCMAKE_DISABLE_FIND_PACKAGE_Doxygen=TRUE
		-DCMAKE_DISABLE_FIND_PACKAGE_Sphinx=TRUE
	)
	if(DEFINED LICENSECC_BOOST_ROOT AND NOT "${LICENSECC_BOOST_ROOT}" STREQUAL "")
		list(APPEND ${out_var} "-DBOOST_ROOT=${LICENSECC_BOOST_ROOT}")
	endif()
	_append_generator_args(${out_var})
	set(${out_var} "${${out_var}}" PARENT_SCOPE)
endfunction()

function(_expect_build_failure name build_dir target_name config_name expected_message)
	set(_build_command
		"${CMAKE_COMMAND}"
		--build "${build_dir}"
		--target "${target_name}"
	)
	if(NOT "${config_name}" STREQUAL "")
		list(APPEND _build_command --config "${config_name}")
	endif()
	execute_process(
		COMMAND ${_build_command}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	string(CONCAT _combined "${_stdout}\n${_stderr}")
	if(_result EQUAL 0)
		message(FATAL_ERROR "${name} unexpectedly built successfully")
	endif()
	if(NOT _combined MATCHES "${expected_message}")
		message(FATAL_ERROR
			"${name} failed, but did not report the expected error.\n"
			"Expected regex: ${expected_message}\n"
			"stdout:\n${_stdout}\n"
			"stderr:\n${_stderr}")
	endif()
endfunction()

function(_expect_build_success name build_dir target_name config_name)
	set(_build_command
		"${CMAKE_COMMAND}"
		--build "${build_dir}"
		--target "${target_name}"
	)
	if(NOT "${config_name}" STREQUAL "")
		list(APPEND _build_command --config "${config_name}")
	endif()
	execute_process(
		COMMAND ${_build_command}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR
			"${name} failed with exit code ${_result}\n"
			"stdout:\n${_stdout}\n"
			"stderr:\n${_stderr}")
	endif()
endfunction()

function(_run_cpack name build_dir out_result out_stdout out_stderr)
	_require_defined(LICENSECC_CPACK_COMMAND)
	set(_package_dir "${_smoke_root}/${name}/packages")
	_remove_safe("${_package_dir}" "${_smoke_root}" "${name} package dir")
	file(MAKE_DIRECTORY "${_package_dir}")
	set(_cpack_config "${LICENSECC_CONFIG}")
	if(_is_multi_config AND "${name}" MATCHES "^debug-package-")
		set(_cpack_config "Debug")
	endif()
	set(_cpack_command
		"${LICENSECC_CPACK_COMMAND}"
		--config "${build_dir}/CPackConfig.cmake"
		-B "${_package_dir}"
	)
	if(NOT "${_cpack_config}" STREQUAL "")
		list(APPEND _cpack_command -C "${_cpack_config}")
	endif()
	list(APPEND _cpack_command ${ARGN})
	execute_process(
		COMMAND ${_cpack_command}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	set(${out_result} "${_result}" PARENT_SCOPE)
	set(${out_stdout} "${_stdout}" PARENT_SCOPE)
	set(${out_stderr} "${_stderr}" PARENT_SCOPE)
endfunction()

function(_expect_cpack_failure name build_dir expected_message)
	_run_cpack("${name}" "${build_dir}" _result _stdout _stderr ${ARGN})
	string(CONCAT _combined "${_stdout}\n${_stderr}")
	if(_result EQUAL 0)
		message(FATAL_ERROR "${name} unexpectedly packaged successfully")
	endif()
	if(NOT _combined MATCHES "${expected_message}")
		message(FATAL_ERROR
			"${name} failed, but did not report the expected packaging error.\n"
			"Expected regex: ${expected_message}\n"
			"stdout:\n${_stdout}\n"
			"stderr:\n${_stderr}")
	endif()
endfunction()

function(_expect_cpack_success name build_dir)
	_run_cpack("${name}" "${build_dir}" _result _stdout _stderr ${ARGN})
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR
			"${name} package failed with exit code ${_result}\n"
			"stdout:\n${_stdout}\n"
			"stderr:\n${_stderr}")
	endif()
endfunction()

function(_snapshot_tree out_var root)
	if(NOT EXISTS "${root}")
		set(${out_var} "<missing>" PARENT_SCOPE)
		return()
	endif()
	file(GLOB_RECURSE _entries LIST_DIRECTORIES true "${root}/*")
	set(_snapshot)
	foreach(_entry IN LISTS _entries)
		file(RELATIVE_PATH _rel "${root}" "${_entry}")
		file(TO_CMAKE_PATH "${_rel}" _rel)
		if(IS_DIRECTORY "${_entry}")
			list(APPEND _snapshot "D:${_rel}")
		else()
			file(SHA256 "${_entry}" _sha)
			list(APPEND _snapshot "F:${_rel}:${_sha}")
		endif()
	endforeach()
	list(SORT _snapshot)
	string(REPLACE ";" "\n" _snapshot_text "${_snapshot}")
	set(${out_var} "${_snapshot_text}" PARENT_SCOPE)
endfunction()

function(_run_configure name source_dir build_dir out_result out_stdout out_stderr)
	_remove_safe("${build_dir}" "${_smoke_root}" "${name} build dir")
	set(_configure_command
		"${CMAKE_COMMAND}"
		-S "${source_dir}"
		-B "${build_dir}"
	)
	list(APPEND _configure_command ${ARGN})
	_append_common_configure_args(_configure_command)
	execute_process(
		COMMAND ${_configure_command}
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _stdout
		ERROR_VARIABLE _stderr
	)
	set(${out_result} "${_result}" PARENT_SCOPE)
	set(${out_stdout} "${_stdout}" PARENT_SCOPE)
	set(${out_stderr} "${_stderr}" PARENT_SCOPE)
endfunction()

function(_expect_configure_failure name expected_message)
	set(_build_dir "${_smoke_root}/${name}")
	_run_configure("${name}" "${LICENSECC_SOURCE_DIR}" "${_build_dir}" _result _stdout _stderr ${ARGN})
	string(CONCAT _combined "${_stdout}\n${_stderr}")
	if(_result EQUAL 0)
		message(FATAL_ERROR "${name} unexpectedly configured successfully")
	endif()
	if(NOT _combined MATCHES "${expected_message}")
		message(FATAL_ERROR
			"${name} failed, but did not report the expected error.\n"
			"Expected regex: ${expected_message}\n"
			"stdout:\n${_stdout}\n"
			"stderr:\n${_stderr}")
	endif()
endfunction()

function(_expect_configure_success name)
	set(_build_dir "${_smoke_root}/${name}")
	_run_configure("${name}" "${LICENSECC_SOURCE_DIR}" "${_build_dir}" _result _stdout _stderr ${ARGN})
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR
			"${name} configure failed with exit code ${_result}\n"
			"stdout:\n${_stdout}\n"
			"stderr:\n${_stderr}")
	endif()
	set(${name}_BUILD_DIR "${_build_dir}" PARENT_SCOPE)
endfunction()

function(_write_weak_project_key_fixture projects_base project_name)
	set(_project_dir "${projects_base}/${project_name}")
	set(_include_dir "${_project_dir}/include/licensecc/${project_name}")
	file(MAKE_DIRECTORY "${_include_dir}")
	file(WRITE "${_project_dir}/private_key.rsa" "placeholder legacy private key\n")
	file(WRITE "${_include_dir}/public_key.h"
		"#ifndef PUBLIC_KEY_H_\n"
		"#define PUBLIC_KEY_H_\n"
		"#define PRODUCT_NAME ${project_name}\n"
		"#define PUBLIC_KEY {0}\n"
		"#define PUBLIC_KEY_LEN 390\n"
		"#define LCC_PUBLIC_KEY_ALGORITHM \"rsa\"\n"
		"#define LCC_PUBLIC_KEY_BITS 1024\n"
		"#define LCC_SIGNATURE_ALGORITHM \"rsa-pkcs1-sha256\"\n"
		"#endif\n")
endfunction()

function(_assert_paths_equal actual expected description)
	_to_cmake_abs(_actual "${actual}")
	_to_cmake_abs(_expected "${expected}")
	if(NOT _actual STREQUAL _expected)
		message(FATAL_ERROR
			"${description} mismatch\n"
			"Expected: ${_expected}\n"
			"Actual:   ${_actual}")
	endif()
endfunction()

_require_defined(LICENSECC_SOURCE_DIR)
_require_defined(LICENSECC_BUILD_DIR)

if(NOT DEFINED LICENSECC_CONFIG OR "${LICENSECC_CONFIG}" STREQUAL "")
	set(_config_name "single-config")
else()
	set(_config_name "${LICENSECC_CONFIG}")
endif()
set(_is_multi_config FALSE)
if(DEFINED LICENSECC_GENERATOR AND
   ("${LICENSECC_GENERATOR}" MATCHES "Visual Studio" OR
	"${LICENSECC_GENERATOR}" MATCHES "Multi-Config" OR
	"${LICENSECC_GENERATOR}" MATCHES "Xcode"))
	set(_is_multi_config TRUE)
endif()
set(_project_initialize_config "${LICENSECC_CONFIG}")
if(_is_multi_config)
	set(_project_initialize_config "Debug")
endif()

_to_abs(LICENSECC_SOURCE_DIR "${LICENSECC_SOURCE_DIR}")
_to_abs(LICENSECC_BUILD_DIR "${LICENSECC_BUILD_DIR}")
set(_smoke_root "${LICENSECC_BUILD_DIR}/Testing/release-safety/${_config_name}")
_remove_safe("${_smoke_root}" "${LICENSECC_BUILD_DIR}/Testing/release-safety" "release safety smoke root")
file(MAKE_DIRECTORY "${_smoke_root}")

set(_source_projects_root "${LICENSECC_SOURCE_DIR}/projects")
_snapshot_tree(_source_projects_before "${_source_projects_root}")

_expect_configure_failure(
	"invalid-project-name-path"
	"invalid licensecc project name"
	-DCMAKE_BUILD_TYPE=Debug
	"-DLCC_PROJECT_NAME=../BAD"
)
_expect_configure_failure(
	"invalid-project-name-hyphen"
	"invalid licensecc project name"
	-DCMAKE_BUILD_TYPE=Debug
	-DLCC_PROJECT_NAME=BAD-NAME
)
_expect_configure_failure(
	"invalid-project-name-leading-digit"
	"invalid licensecc project name"
	-DCMAKE_BUILD_TYPE=Debug
	-DLCC_PROJECT_NAME=1BAD
)
_expect_configure_failure(
	"invalid-project-magic"
	"invalid LCC_PROJECT_MAGIC_NUM"
	-DCMAKE_BUILD_TYPE=Debug
	-DLCC_PROJECT_NAME=PRODUCT_SMOKE
	-DLCC_PROJECT_MAGIC_NUM=abc
)

_expect_configure_failure(
	"release-default-project"
	"product-specific[ \r\n]+LCC_PROJECT_NAME"
	-DCMAKE_BUILD_TYPE=Release
)
_expect_configure_failure(
	"relwithdebinfo-default-project"
	"product-specific[ \r\n]+LCC_PROJECT_NAME"
	-DCMAKE_BUILD_TYPE=RelWithDebInfo
)
_expect_configure_failure(
	"release-test-project"
	"test.*reserved for local tests or examples"
	-DCMAKE_BUILD_TYPE=Release
	-DLCC_PROJECT_NAME=test
)
_expect_configure_failure(
	"release-demo-project"
	"demo.*reserved for local tests or examples"
	-DCMAKE_BUILD_TYPE=Release
	-DLCC_PROJECT_NAME=demo
)
_expect_configure_failure(
	"release-missing-project-keys"
	"Release project keys are missing"
	-DCMAKE_BUILD_TYPE=Release
	-DLCC_PROJECT_NAME=PRODUCT_SMOKE
	"-DLCC_PROJECTS_BASE_DIR=${_smoke_root}/missing-release-projects"
)
set(_weak_projects_base "${_smoke_root}/weak-release-projects")
_write_weak_project_key_fixture("${_weak_projects_base}" "PRODUCT_WEAK_SMOKE")
_expect_configure_failure(
	"release-weak-project-key"
	"Release public key is too small"
	-DCMAKE_BUILD_TYPE=Release
	-DLCC_PROJECT_NAME=PRODUCT_WEAK_SMOKE
	"-DLCC_PROJECTS_BASE_DIR=${_weak_projects_base}"
)
set(_prepared_projects_base "${_smoke_root}/release-keygen/projects")
_expect_configure_success(
	"release-keygen"
	-DCMAKE_BUILD_TYPE=Debug
	-DLCC_PROJECT_NAME=PRODUCT_SMOKE
	"-DLCC_PROJECTS_BASE_DIR=${_prepared_projects_base}"
)
set(_release_keygen_build_dir "${release-keygen_BUILD_DIR}")
_expect_build_success(
	"release key preparation"
	"${_release_keygen_build_dir}"
	"project_initialize"
	"${_project_initialize_config}"
)
if(NOT EXISTS "${_prepared_projects_base}/PRODUCT_SMOKE/private_key.rsa" OR
   NOT EXISTS "${_prepared_projects_base}/PRODUCT_SMOKE/include/licensecc/PRODUCT_SMOKE/public_key.h")
	message(FATAL_ERROR "release key preparation did not create the expected project keys")
endif()
_expect_configure_success(
	"release-existing-project-keys"
	-DCMAKE_BUILD_TYPE=Release
	-DLCC_PROJECT_NAME=PRODUCT_SMOKE
	"-DLCC_PROJECTS_BASE_DIR=${_prepared_projects_base}"
)
set(_alternate_projects_base "${_smoke_root}/release-keygen-other/projects")
_expect_configure_success(
	"release-keygen-other"
	-DCMAKE_BUILD_TYPE=Debug
	-DLCC_PROJECT_NAME=PRODUCT_OTHER_SMOKE
	"-DLCC_PROJECTS_BASE_DIR=${_alternate_projects_base}"
)
set(_release_keygen_other_build_dir "${release-keygen-other_BUILD_DIR}")
_expect_build_success(
	"release alternate key preparation"
	"${_release_keygen_other_build_dir}"
	"project_initialize"
	"${_project_initialize_config}"
)
set(_mismatched_projects_base "${_smoke_root}/mismatched-release-projects")
file(MAKE_DIRECTORY "${_mismatched_projects_base}")
file(COPY "${_prepared_projects_base}/PRODUCT_SMOKE" DESTINATION "${_mismatched_projects_base}")
file(REMOVE "${_mismatched_projects_base}/PRODUCT_SMOKE/private_key.rsa")
file(COPY "${_alternate_projects_base}/PRODUCT_OTHER_SMOKE/private_key.rsa"
	DESTINATION "${_mismatched_projects_base}/PRODUCT_SMOKE")
_expect_configure_success(
	"release-mismatched-project-keys"
	-DCMAKE_BUILD_TYPE=Release
	-DLCC_PROJECT_NAME=PRODUCT_SMOKE
	"-DLCC_PROJECTS_BASE_DIR=${_mismatched_projects_base}"
)
_expect_build_failure(
	"release project key-pair mismatch"
	"${release-mismatched-project-keys_BUILD_DIR}"
	"release_project_guard"
	"Release"
	"Release project key-pair consistency check failed.*private key does not match generated public key bytes"
)

_expect_configure_success("clean-default-project-dir")
set(_default_build_dir "${clean-default-project-dir_BUILD_DIR}")
if(EXISTS "${_default_build_dir}/projects/DEFAULT/private_key.rsa" OR
   EXISTS "${_default_build_dir}/projects/DEFAULT/include/licensecc/DEFAULT/public_key.h")
	message(FATAL_ERROR "clean default configure generated signing keys before a build requested project_initialize")
endif()
_expect_build_success(
	"debug default runtime build"
	"${_default_build_dir}"
	"licensecc_static"
	"${_project_initialize_config}"
)
_expect_cpack_failure(
	"debug-package-default-project"
	"${_default_build_dir}"
	"product-specific[ \r\n]+LCC_PROJECT_NAME"
)
_expect_cpack_success(
	"debug-package-default-project-explicit-opt-out"
	"${_default_build_dir}"
	-D LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE=ON
	-D LCC_ALLOW_RELEASE_PROJECT_KEYGEN=ON
)
set(_weak_package_projects_base "${_smoke_root}/weak-package-projects")
_write_weak_project_key_fixture("${_weak_package_projects_base}" "PRODUCT_WEAK_PACKAGE")
_expect_configure_success(
	"debug-weak-package-project"
	-DLCC_PROJECT_NAME=PRODUCT_WEAK_PACKAGE
	"-DLCC_PROJECTS_BASE_DIR=${_weak_package_projects_base}"
)
_expect_cpack_failure(
	"debug-package-weak-project-key"
	"${debug-weak-package-project_BUILD_DIR}"
	"Release public key is too small"
)
_expect_configure_success(
	"debug-mismatched-package-project"
	-DLCC_PROJECT_NAME=PRODUCT_SMOKE
	"-DLCC_PROJECTS_BASE_DIR=${_mismatched_projects_base}"
)
_expect_build_success(
	"debug mismatched package runtime build"
	"${debug-mismatched-package-project_BUILD_DIR}"
	"licensecc_static"
	"${_project_initialize_config}"
)
_expect_cpack_failure(
	"debug-package-mismatched-project-keypair"
	"${debug-mismatched-package-project_BUILD_DIR}"
	"Release project key-pair consistency check failed.*private key does not match generated public key bytes"
)
file(STRINGS "${_default_build_dir}/CMakeCache.txt" _base_dir_line REGEX "^LCC_PROJECTS_BASE_DIR:PATH=")
if(NOT _base_dir_line)
	message(FATAL_ERROR "clean-default-project-dir cache does not contain LCC_PROJECTS_BASE_DIR")
endif()
string(REPLACE "LCC_PROJECTS_BASE_DIR:PATH=" "" _actual_base_dir "${_base_dir_line}")
_assert_paths_equal(
	"${_actual_base_dir}"
	"${_default_build_dir}/projects"
	"Clean default LCC_PROJECTS_BASE_DIR"
)

if(_is_multi_config)
	_expect_build_failure(
		"multi-config-release-default-project"
		"${_default_build_dir}"
		"release_project_guard"
		"Release"
		"Release builds/install/package artifacts must use"
	)
	_expect_build_failure(
		"multi-config-relwithdebinfo-default-project"
		"${_default_build_dir}"
		"release_project_guard"
		"RelWithDebInfo"
		"Release builds/install/package artifacts must use"
	)
	_expect_configure_success(
		"clean-test-project-dir"
		-DLCC_PROJECT_NAME=test
	)
	set(_test_build_dir "${clean-test-project-dir_BUILD_DIR}")
	_expect_build_failure(
		"multi-config-release-test-project"
		"${_test_build_dir}"
		"release_project_guard"
		"Release"
		"test.*reserved for local tests or examples"
	)
	_expect_configure_success(
		"clean-product-project-dir"
		-DLCC_PROJECT_NAME=PRODUCT_SMOKE
		"-DLCC_PROJECTS_BASE_DIR=${_smoke_root}/clean-product-project-dir/projects"
	)
	set(_product_build_dir "${clean-product-project-dir_BUILD_DIR}")
	_expect_cpack_failure(
		"debug-package-product-missing-project-keys"
		"${_product_build_dir}"
		"Release project keys are missing"
	)
	_expect_build_failure(
		"multi-config-release-missing-project-keys"
		"${_product_build_dir}"
		"release_project_guard"
		"Release"
		"Release project keys are missing"
	)
endif()

set(_source_tree_project_name "LCC_SOURCE_TREE_REFUSAL_SMOKE")
set(_source_tree_project_dir "${_source_projects_root}/${_source_tree_project_name}")
if(EXISTS "${_source_tree_project_dir}")
	message(FATAL_ERROR "source-tree refusal smoke project already exists: ${_source_tree_project_dir}")
endif()
_expect_configure_failure(
	"source-tree-keygen-refusal"
	"Refusing to generate project files under the source tree"
	"-DLCC_PROJECT_NAME=${_source_tree_project_name}"
	"-DLCC_PROJECTS_BASE_DIR=${_source_projects_root}"
)
if(EXISTS "${_source_tree_project_dir}")
	message(FATAL_ERROR "source-tree keygen refusal left generated project files in ${_source_tree_project_dir}")
endif()

_snapshot_tree(_source_projects_after "${_source_projects_root}")
if(NOT _source_projects_before STREQUAL _source_projects_after)
	message(FATAL_ERROR "release safety smoke changed source-tree projects content")
endif()

message(STATUS "Release safety smoke passed")
