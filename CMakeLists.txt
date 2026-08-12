cmake_minimum_required(VERSION 3.16 FATAL_ERROR)

SET(LICENSECC_SHORT_LICENSE "GNU Affero General Public License v3.0 or later")

SET(CMAKE_DISABLE_SOURCE_CHANGES ON)
SET(CMAKE_DISABLE_IN_SOURCE_BUILD ON)

# Task 0 source-baseline guard: public declarations must never survive a merge
# that drops the real online/v201 implementation objects. Keep this list in
# source control, not under the build tree, so configure fails before it can
# create a misleading partial library.
set(LCC_REQUIRED_ONLINE_V201_SOURCES
	"include/licensecc/licensecc.h"
	"src/library/online_verification/OnlineVerification.cpp"
	"src/library/signed_token/SignedToken.cpp"
	"src/library/base/v201_canonical_payload.cpp"
	"src/library/activation/ActivationRequest.cpp")
foreach(_lcc_required_online_v201_source IN LISTS LCC_REQUIRED_ONLINE_V201_SOURCES)
	if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/${_lcc_required_online_v201_source}")
		message(FATAL_ERROR
			"licensecc online/v201 source baseline is incomplete: missing ${_lcc_required_online_v201_source}")
	endif()
endforeach()
unset(_lcc_required_online_v201_source)

IF(NOT LCC_PROJECT_NAME)
	message(STATUS "You should define a variable LCC_PROJECT_NAME containing the name of the software you want to add a license to."
		"A mock project named DEFAULT has been added for you.")
	set(LCC_PROJECT_NAME "DEFAULT" CACHE STRING "Project name (name of the software for which you want to issue a license)") 
ENDIF(NOT LCC_PROJECT_NAME)

# Base folder where generated license projects are stored.
IF(NOT LCC_PROJECTS_BASE_DIR)
	set(LCC_PROJECTS_BASE_DIR "${CMAKE_BINARY_DIR}/projects")
ENDIF(NOT LCC_PROJECTS_BASE_DIR)

set(LCC_SUPPORTED_LICENSE_FORMAT_MIN 200 CACHE STRING
	"Minimum license file format version supported by this runtime package.")
set(LCC_SUPPORTED_LICENSE_FORMAT_MAX 201 CACHE STRING
	"Maximum license file format version supported by this runtime package.")
if(NOT DEFINED LCC_PROJECT_MAGIC_NUM OR "${LCC_PROJECT_MAGIC_NUM}" STREQUAL "")
	set(LCC_PROJECT_MAGIC_NUM 0 CACHE STRING "Project magic number embedded in generated project metadata")
endif()
set(LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS "" CACHE STRING
	"Optional C++ expressions for trusted online assertion public keys.")
set(LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS "" CACHE STRING
	"Optional C string literals for retired online assertion key ids.")
set(LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS "" CACHE STRING
	"Optional C++ expressions for trusted config-attestation public keys.")
set(LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS "" CACHE STRING
	"Optional C string literals for retired config-attestation key ids.")
set(LCC_ADDITIONAL_PUBLIC_KEY_RECORDS "" CACHE STRING
	"Optional C++ expressions for additional project verification-ring public keys.")
set(LCC_RETIRED_PUBLIC_KEY_IDS "" CACHE STRING
	"Optional C string literals for retired project verification-ring key ids.")
option(LCC_BUILD_LEASE_RING_TEST
	"Configure the optional lease-ring golden test; requires its external generator helper." OFF)
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/LeaseRing.cmake")

cmake_policy(SET CMP0048 NEW)
if(POLICY CMP0091)
	cmake_policy(SET CMP0091 NEW)
endif()
option(STATIC_RUNTIME "Link statically to the compiler runtime where supported." OFF)
if(STATIC_RUNTIME)
	set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
project (licensecc 
			VERSION 2.1.0
			LANGUAGES CXX)
set(PROJECT_DESCRIPTION "Copy protection and licensing library")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(LCC_EXPECT_TARGET_ARCH "" CACHE STRING
	"Optional configure-time target architecture assertion (currently: arm64).")
if(LCC_EXPECT_TARGET_ARCH)
	if(NOT LCC_EXPECT_TARGET_ARCH STREQUAL "arm64")
		message(FATAL_ERROR "Unsupported LCC_EXPECT_TARGET_ARCH value: ${LCC_EXPECT_TARGET_ARCH}")
	endif()
	include(CheckCXXSourceCompiles)
	check_cxx_source_compiles(
		"#if !defined(__aarch64__) && !defined(_M_ARM64)\n#error target is not ARM64\n#endif\nint main() { return 0; }"
		LCC_TARGET_IS_ARM64)
	if(NOT LCC_TARGET_IS_ARM64)
		message(FATAL_ERROR "LCC_EXPECT_TARGET_ARCH=arm64 but the configured compiler does not target ARM64")
	endif()
endif()

# Generated project material is build output. An explicit external base is
# supported for stable keys. A normal build tree is also allowed when it is
# nested below the source checkout, but it may not equal or contain that
# checkout; only source-contained project paths outside the active binary tree
# are forbidden.
get_filename_component(_lcc_source_dir_real "${CMAKE_SOURCE_DIR}" REALPATH)
get_filename_component(_lcc_binary_dir_real "${CMAKE_BINARY_DIR}" REALPATH)
get_filename_component(_lcc_projects_dir_real "${LCC_PROJECTS_BASE_DIR}" REALPATH)
file(TO_CMAKE_PATH "${_lcc_source_dir_real}" _lcc_source_dir_real)
file(TO_CMAKE_PATH "${_lcc_binary_dir_real}" _lcc_binary_dir_real)
file(TO_CMAKE_PATH "${_lcc_projects_dir_real}" _lcc_projects_dir_real)
function(_lcc_path_is_within candidate_path parent_path result_variable)
	set(_lcc_candidate_for_compare "${candidate_path}")
	set(_lcc_parent_for_compare "${parent_path}")
	if(WIN32)
		string(TOLOWER "${_lcc_candidate_for_compare}" _lcc_candidate_for_compare)
		string(TOLOWER "${_lcc_parent_for_compare}" _lcc_parent_for_compare)
	endif()
	string(LENGTH "${_lcc_parent_for_compare}" _lcc_parent_length)
	string(LENGTH "${_lcc_candidate_for_compare}" _lcc_candidate_length)
	set(_lcc_within FALSE)
	if(_lcc_candidate_length GREATER_EQUAL _lcc_parent_length)
		string(SUBSTRING "${_lcc_candidate_for_compare}" 0 ${_lcc_parent_length} _lcc_candidate_prefix)
		if(_lcc_candidate_prefix STREQUAL "${_lcc_parent_for_compare}")
			if(_lcc_candidate_length EQUAL _lcc_parent_length)
				set(_lcc_within TRUE)
			else()
				string(SUBSTRING "${_lcc_candidate_for_compare}" ${_lcc_parent_length} 1 _lcc_boundary_character)
				if(_lcc_boundary_character STREQUAL "/")
					set(_lcc_within TRUE)
				endif()
			endif()
		endif()
	endif()
	set(${result_variable} ${_lcc_within} PARENT_SCOPE)
endfunction()
_lcc_path_is_within("${_lcc_source_dir_real}" "${_lcc_binary_dir_real}" _lcc_source_inside_binary)
if(_lcc_source_inside_binary)
	message(FATAL_ERROR "CMAKE_BINARY_DIR must resolve outside and must not contain the source tree: ${CMAKE_BINARY_DIR}")
endif()
_lcc_path_is_within("${_lcc_projects_dir_real}" "${_lcc_source_dir_real}" _lcc_projects_inside_source)
_lcc_path_is_within("${_lcc_projects_dir_real}" "${_lcc_binary_dir_real}" _lcc_projects_inside_binary)
if(_lcc_projects_inside_source AND NOT _lcc_projects_inside_binary)
	message(FATAL_ERROR "LCC_PROJECTS_BASE_DIR must resolve outside the source tree or within the active binary tree: ${LCC_PROJECTS_BASE_DIR}")
endif()
unset(_lcc_source_dir_real)
unset(_lcc_binary_dir_real)
unset(_lcc_projects_dir_real)
unset(_lcc_source_inside_binary)
unset(_lcc_projects_inside_source)
unset(_lcc_projects_inside_binary)

# The reconciled online/v201 modules use project-scoped generated headers.
# Keep the generated metadata under the build tree while preserving the legacy
# include shape consumed by existing C and C++ callers.
set(LCC_PROJECT_INCLUDE_ROOT "${LCC_PROJECTS_BASE_DIR}/${LCC_PROJECT_NAME}/include")
set(LCC_PROJECT_CONFIG_HEADER "${PROJECT_NAME}/${LCC_PROJECT_NAME}/licensecc_properties.h")
set(LCC_PROJECT_PUBLIC_KEY_HEADER "${PROJECT_NAME}/${LCC_PROJECT_NAME}/public_key.h")

option(BUILD_BENCHMARKS "Build performance benchmarks (no extra dependencies)" OFF)
# CTest declares this option later, after Boost discovery.  Define its normal
# ON default before generator discovery so a raw executable cannot accidentally
# configure a test tree that will later contain undeclared generator-library
# links.
option(BUILD_TESTING "Build the testing tree." ON)
option(LCC_ENABLE_DEVICE_IDENTITY "Build the portable device-identity ABI and proof core." OFF)
option(LCC_ENABLE_WINDOWS_TPM "Build the Windows Platform KSP device-key provider." OFF)
option(LCC_ENABLE_TPM2_OPENSSL "Build the OpenSSL TPM2 device-key provider." OFF)
option(LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER "Build the process-local software device-key test provider." OFF)
option(LCC_BUILD_TPM2_OPENSSL_CAPABILITY_TEST
	"Build the standalone OpenSSL tpm2-provider exact-digest capability test." OFF)

if(LCC_ENABLE_WINDOWS_TPM AND NOT WIN32)
	message(FATAL_ERROR "LCC_ENABLE_WINDOWS_TPM is valid only on WIN32")
endif()
if(LCC_BUILD_TPM2_OPENSSL_CAPABILITY_TEST AND NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
	message(FATAL_ERROR "LCC_BUILD_TPM2_OPENSSL_CAPABILITY_TEST is valid only on Linux")
endif()
if(LCC_ENABLE_TPM2_OPENSSL AND NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
	message(FATAL_ERROR "LCC_ENABLE_TPM2_OPENSSL is valid only on Linux")
endif()
if(LCC_BUILD_TPM2_OPENSSL_CAPABILITY_TEST AND NOT BUILD_TESTING)
	message(FATAL_ERROR
		"LCC_BUILD_TPM2_OPENSSL_CAPABILITY_TEST=ON requires BUILD_TESTING=ON")
endif()
if(LCC_ENABLE_WINDOWS_TPM OR LCC_ENABLE_TPM2_OPENSSL OR LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER)
	set(LCC_ENABLE_DEVICE_IDENTITY ON CACHE BOOL
		"Build the portable device-identity ABI and proof core." FORCE)
endif()
if(LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER AND NOT BUILD_TESTING)
	message(FATAL_ERROR
		"LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER=ON requires BUILD_TESTING=ON; the software provider is test-only")
endif()
SET(CMAKE_MODULE_PATH ${CMAKE_MODULE_PATH} "${CMAKE_CURRENT_SOURCE_DIR}/cmake/")

#find lccgen executable or build it.
find_package(lccgen REQUIRED) 

if(BUILD_TESTING AND NOT LCCGEN_TEST_SUPPORT_AVAILABLE)
	message(FATAL_ERROR
		"BUILD_TESTING=ON requires generator test support. The selected lccgen provides only the generator executable. Configure with -DBUILD_TESTING=OFF for a production build, use the embedded generator checkout, or install a compatible generator development package that exports license_generator::test_support.")
endif()

#In case the build system doesn't support binfmt misc
IF( ( CMAKE_HOST_SYSTEM_NAME STREQUAL "Linux" ) AND CMAKE_CROSSCOMPILING AND NOT DEFINED CMAKE_CROSSCOMPILING_EMULATOR )
	SET(CMAKE_CROSSCOMPILING_EMULATOR "wine")	
ENDIF()

SET (OPENSSL_USE_STATIC_LIBS TRUE)
IF(${STATIC_RUNTIME})
	SET(OPENSSL_MSVC_STATIC_RT TRUE)
ENDIF(${STATIC_RUNTIME})
if(LCC_ENABLE_TPM2_OPENSSL OR LCC_BUILD_TPM2_OPENSSL_CAPABILITY_TEST)
	find_package(OpenSSL 3.0 REQUIRED COMPONENTS Crypto)
else()
	find_package(OpenSSL COMPONENTS Crypto QUIET)
endif()
IF(OPENSSL_FOUND)
	MESSAGE(STATUS "Found openssl version ${OPENSSL_VERSION} -licensecc")
ENDIF(OPENSSL_FOUND)
if(LCC_ENABLE_TPM2_OPENSSL)
	if(NOT OPENSSL_FOUND OR OPENSSL_VERSION VERSION_LESS 3.0)
		message(FATAL_ERROR "LCC_ENABLE_TPM2_OPENSSL requires OpenSSL >= 3")
	endif()
endif()

if(UNIX) #this is true for all the linux systems but not for cross compiling "linux->windows"
	IF(${STATIC_RUNTIME})
		set(CMAKE_EXE_LINKER_FLAGS "-static-libgcc -static-libstdc++ -static")
	ENDIF(${STATIC_RUNTIME})
	IF(NOT OPENSSL_FOUND)
		MESSAGE(SEND_ERROR "Openssl required in Linux, please install it or specify -DOPENSSL_ROOT")
	ENDIF(NOT OPENSSL_FOUND)
	
    find_package(Threads)
	if(THREADS_HAVE_PTHREAD_ARG)
  		list(APPEND EXTERNAL_LIBS "-pthread")
	else(THREADS_HAVE_PTHREAD_ARG)
		if(CMAKE_THREAD_LIBS_INIT)
  			 list(APPEND EXTERNAL_LIBS "${CMAKE_THREAD_LIBS_INIT}")
		endif()
	endif(THREADS_HAVE_PTHREAD_ARG)

	#Zlib required with old openssl version < 1.0.1f in centos 7
	IF(OPENSSL_VERSION VERSION_LESS_EQUAL 1.0.2)
		SET ( ZLIB_USE_STATIC_LIBS ON ) 
		find_package(ZLIB REQUIRED)
		list(APPEND EXTERNAL_LIBS "${ZLIB_LIBRARIES}")
		MESSAGE(STATUS "Found zlib version ${ZLIB_VERSION_STRING} - licensecc")
	ELSE(OPENSSL_VERSION VERSION_LESS_EQUAL 1.0.2)
	    MESSAGE(STATUS "openssl ${OPENSSL_VERSION} zlib not required - licensecc")
	ENDIF(OPENSSL_VERSION VERSION_LESS_EQUAL 1.0.2)
	
	find_program( MEMORYCHECK_COMMAND valgrind )
	set( MEMORYCHECK_COMMAND_OPTIONS "--trace-children=yes --leak-check=full" )
	set(main_lib_dest "lib/${PROJECT_NAME}")
	#https://cmake.org/cmake/help/latest/command/find_package.html
	set(pkg_config_dest "lib/cmake/${PROJECT_NAME}")
else(UNIX)
	IF(NOT OPENSSL_FOUND)
		MESSAGE(STATUS "Openssl not found, configuring the library without it (running in wine not supported).")
	ENDIF(NOT OPENSSL_FOUND)
	if(MSVC)
		include(target_arch)
		target_architecture( TARGET_ARCHITECTURE )
		message(STATUS "architecture detected: ${TARGET_ARCHITECTURE}")
		#cmake > 3.15 handle the /MD flag more nicely than this
		if(STATIC_RUNTIME)
		    message(STATUS "Static runtime ${STATIC_RUNTIME}")
			string(REPLACE "/MD" "/MT" CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE}")
			string(REPLACE "/MDd" "/MTd" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
			#list(APPEND CMAKE_CXX_FLAGS_DEBUG "/MTd")
			SET(Boost_USE_STATIC_RUNTIME ON)
		endif(STATIC_RUNTIME)
		add_definitions("/D _CRT_SECURE_NO_WARNINGS")
	    list(APPEND EXTERNAL_LIBS "bcrypt" "crypt32" "ws2_32" "iphlpapi")
	else(MSVC)
	    if(MINGW)        
            list(APPEND EXTERNAL_LIBS "-lbcrypt" "-lcrypt32" "-lws2_32" "-liphlpapi")
	        SET(CMAKE_EXE_LINKER_FLAGS "-static -static-libstdc++")
	    endif(MINGW)
	endif(MSVC)
	set(main_lib_dest "${PROJECT_NAME}")  
	#https://cmake.org/cmake/help/latest/command/find_package.html
	set(pkg_config_dest "cmake/${PROJECT_NAME}")
endif(UNIX)

#initialize project
#load the current project from files or find it from environment variables or create a default one
set(LCC_INCLUDE_DIR "${LCC_PROJECT_INCLUDE_ROOT}/${PROJECT_NAME}/${LCC_PROJECT_NAME}" )
set(LCC_PROJECT_PUBLIC_KEY "${LCC_INCLUDE_DIR}/public_key.h" )
# Test helpers consume this location to sign fixture licenses. It is deliberately
# not a custom-command output, byproduct, or install input.
set(LCC_PROJECT_PRIVATE_KEY "${LCC_PROJECTS_BASE_DIR}/${LCC_PROJECT_NAME}/private_key.rsa")
file(MAKE_DIRECTORY "${LCC_INCLUDE_DIR}")

# The authoritative main template deliberately remains byte-compatible with
# older generated projects.  The reconciled v201 issuer additionally needs
# key identity metadata, so create a build-tree overlay for lccgen rather than
# editing that source template or any existing generated project header.
set(LCC_PROJECT_TEMPLATE_DIR "${CMAKE_BINARY_DIR}/generated-project-templates")
file(MAKE_DIRECTORY "${LCC_PROJECT_TEMPLATE_DIR}")
configure_file("${PROJECT_SOURCE_DIR}/src/templates/public_key.inja"
	"${LCC_PROJECT_TEMPLATE_DIR}/public_key.inja" COPYONLY)
file(APPEND "${LCC_PROJECT_TEMPLATE_DIR}/public_key.inja"
	"\n#ifndef LCC_PUBLIC_KEY_ALGORITHM\n"
	"#define LCC_PUBLIC_KEY_ALGORITHM \"{{ public_key_algorithm }}\"\n"
	"#endif\n"
	"#ifndef LCC_PUBLIC_KEY_BITS\n"
	"#define LCC_PUBLIC_KEY_BITS {{ public_key_bits }}\n"
	"#endif\n"
	"#ifndef LCC_PUBLIC_KEY_SHA256\n"
	"#define LCC_PUBLIC_KEY_SHA256 \"{{ public_key_sha256 }}\"\n"
	"#endif\n"
	"#ifndef LCC_PUBLIC_KEY_ID\n"
	"#define LCC_PUBLIC_KEY_ID \"sha256:{{ public_key_sha256 }}\"\n"
	"#endif\n"
	"#ifndef LCC_SIGNATURE_ALGORITHM\n"
	"#define LCC_SIGNATURE_ALGORITHM \"{{ signature_algorithm }}\"\n"
	"#endif\n")

add_compile_definitions(
	"LCC_PROJECT_CONFIG_HEADER=\"${LCC_PROJECT_CONFIG_HEADER}\""
	"LCC_PROJECT_PUBLIC_KEY_HEADER=\"${LCC_PROJECT_PUBLIC_KEY_HEADER}\"")

add_custom_command(
	OUTPUT "${LCC_PROJECT_PUBLIC_KEY}"
	COMMAND "${CMAKE_COMMAND}" -E make_directory "${LCC_INCLUDE_DIR}"
	COMMAND license_generator::lccgen project initialize -t "${LCC_PROJECT_TEMPLATE_DIR}" -n "${LCC_PROJECT_NAME}" -p "${LCC_PROJECTS_BASE_DIR}"
	DEPENDS license_generator::lccgen "${LCC_PROJECT_TEMPLATE_DIR}/public_key.inja"
	COMMENT "Generating ${LCC_PROJECT_PUBLIC_KEY}"
	VERBATIM)
add_custom_target(project_public_header DEPENDS "${LCC_PROJECT_PUBLIC_KEY}")

include_directories( ${LCC_PROJECT_INCLUDE_ROOT} ${LCC_INCLUDE_DIR} "${CMAKE_CURRENT_SOURCE_DIR}/include" )

message( STATUS "CXX compiler        : " ${CMAKE_CXX_COMPILER})
message( STATUS "CXX compiler flags  : " ${CMAKE_CXX_FLAGS})
message( STATUS "CXX compiler flags debug : " ${CMAKE_CXX_FLAGS_DEBUG})
message( STATUS "CXX compiler flags release: " ${CMAKE_CXX_FLAGS_RELEASE})
if(CMAKE_BUILD_TYPE)
  message( STATUS "Build type          : " ${CMAKE_BUILD_TYPE})
endif(CMAKE_BUILD_TYPE)
message( STATUS "Install prefix      : " ${CMAKE_INSTALL_PREFIX})
message( STATUS "Project name        : " ${LCC_PROJECT_NAME} )
message( STATUS "Project base dir    : " ${LCC_PROJECTS_BASE_DIR}/${LCC_PROJECT_NAME} )

add_subdirectory(src)

IF(BUILD_BENCHMARKS)
	add_subdirectory(benchmark)
ENDIF(BUILD_BENCHMARKS)

#boost is required only for tests
#bug in cmake win32 - can't find boost compiled with mingw 
if(WIN32 AND "x${CMAKE_CXX_COMPILER_ARCHITECTURE_ID}" STREQUAL "x")
    message(WARNING "WIN32 compiler does not specify CMAKE_CXX_COMPILER_ARCHITECTURE_ID -- filling in manually")
    if(CMAKE_SIZEOF_VOID_P EQUAL 8)
        set(CMAKE_CXX_COMPILER_ARCHITECTURE_ID "x64")
    else()
        set(CMAKE_CXX_COMPILER_ARCHITECTURE_ID "x86")
    endif()
	    message(STATUS "Compiler architecture: ${CMAKE_CXX_COMPILER_ARCHITECTURE_ID}")
endif()
SET( Boost_USE_STATIC_LIBS ON )
find_package(Boost COMPONENTS unit_test_framework system filesystem)
#if boost is found enable tests
IF(Boost_FOUND)
	INCLUDE(CTest)
	IF(BUILD_TESTING)
		SET(BUILDNAME "${BUILDNAME}" CACHE STRING "Name of build on the dashboard")
		MARK_AS_ADVANCED(BUILDNAME)
		add_subdirectory(test)
	ENDIF(BUILD_TESTING)
	add_subdirectory("src/inspector")
ELSE(Boost_FOUND)
	message(WARNING "Boost not found, disabling tests")
ENDIF(Boost_FOUND)

#################################
# Documentation
#################################
find_package(Doxygen COMPONENTS dot)
find_package(Sphinx)
 
IF(Doxygen_FOUND AND Sphinx_FOUND)
    message(STATUS "Doxygen found, generating docs.")
    SET(DOXYGEN_EXCLUDE_PATTERNS "*/library/ini/*;*/doc/resources/*")
    SET(DOXYGEN_DISABLE_INDEX YES)
    #SET(DOXYGEN_GENERATE_TREEVIEW YES)
    SET(DOXYGEN_GENERATE_XML YES)
    SET(DOXYGEN_LAYOUT_FILE "${CMAKE_CURRENT_SOURCE_DIR}/doc/DoxygenLayout.xml")
	doxygen_add_docs(docs doc src include/licensecc ${LCC_INCLUDE_DIR} COMMENT "doxygen docs")
	#file(COPY "${CMAKE_CURRENT_SOURCE_DIR}/doc/resources/" DESTINATION "${CMAKE_CURRENT_BINARY_DIR}/html")
	
	#file(COPY "${CMAKE_CURRENT_SOURCE_DIR}/doc/sphinx/" DESTINATION "${CMAKE_CURRENT_BINARY_DIR}")
	set(SPHINX_SOURCE ${CMAKE_CURRENT_SOURCE_DIR}/doc)
	set(SPHINX_BUILD ${CMAKE_CURRENT_BINARY_DIR}/docs/sphinx)
 
	add_custom_target(documentation
                  COMMAND
                  ${SPHINX_EXECUTABLE} -b html
                  ${SPHINX_SOURCE} ${SPHINX_BUILD}
                  -Dbreathe_projects.licensecc=${CMAKE_CURRENT_BINARY_DIR}/xml
                  WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
                  COMMENT "Generating documentation with Sphinx")
    add_dependencies(documentation docs)
    
ELSE(Doxygen_FOUND AND Sphinx_FOUND)
	message(STATUS "Doxygen or Sphynx not found, not generating docs.")
ENDIF(Doxygen_FOUND AND Sphinx_FOUND)
file(TO_CMAKE_PATH "${LCC_INCLUDE_DIR}" _lcc_include_dir_for_install)
install(DIRECTORY "${_lcc_include_dir_for_install}" DESTINATION include/${PROJECT_NAME})
unset(_lcc_include_dir_for_install)
install(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/include/ DESTINATION include)
configure_file(src/cmake/licensecc-config.cmake
	${CMAKE_BINARY_DIR}/licensecc-config.cmake @ONLY)
install(FILES ${CMAKE_BINARY_DIR}/licensecc-config.cmake DESTINATION ${pkg_config_dest})

include(CMakePackageConfigHelpers)
write_basic_package_version_file(${CMAKE_BINARY_DIR}/licensecc-config-version.cmake COMPATIBILITY SameMajorVersion)
install(FILES ${CMAKE_BINARY_DIR}/licensecc-config-version.cmake DESTINATION ${pkg_config_dest})
