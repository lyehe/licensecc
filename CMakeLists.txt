cmake_minimum_required(VERSION 3.16 FATAL_ERROR)

SET(LICENSECC_SHORT_LICENSE "GNU Affero General Public License v3.0 or later")

SET(CMAKE_DISABLE_SOURCE_CHANGES OFF)
SET(CMAKE_DISABLE_IN_SOURCE_BUILD ON)

option(STATIC_RUNTIME "Link statically to the compiler runtime where supported." OFF)

IF(NOT DEFINED LCC_PROJECT_NAME OR "${LCC_PROJECT_NAME}" STREQUAL "")
	message(STATUS "You should define a variable LCC_PROJECT_NAME containing the name of the software you want to add a license to."
		"A mock project named DEFAULT has been added for you.")
	set(LCC_PROJECT_NAME "DEFAULT" CACHE STRING "Project name (name of the software for which you want to issue a license)") 
ENDIF()

# Base folder where generated project files are stored.
IF(NOT DEFINED LCC_PROJECTS_BASE_DIR OR "${LCC_PROJECTS_BASE_DIR}" STREQUAL "")
	set(LCC_PROJECTS_BASE_DIR "${CMAKE_BINARY_DIR}/projects" CACHE PATH "Base folder where licensecc projects are stored")
ENDIF()
file(TO_CMAKE_PATH "${LCC_PROJECTS_BASE_DIR}" LCC_PROJECTS_BASE_DIR)
set(LCC_PROJECTS_BASE_DIR "${LCC_PROJECTS_BASE_DIR}" CACHE PATH "Base folder where licensecc projects are stored" FORCE)

option(LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE
	"Allow release install/package artifacts to use reserved local test or example project names." OFF)
option(LCC_ALLOW_RELEASE_PROJECT_KEYGEN
	"Allow release install/package artifacts to generate missing project keys." OFF)
set(LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN 390 CACHE STRING
	"Minimum generated public-key DER length accepted for release install/package artifacts.")
set(LCC_MIN_RELEASE_PUBLIC_KEY_BITS 3072 CACHE STRING
	"Minimum generated public-key RSA modulus bits accepted for release install/package artifacts.")
set(LCC_SUPPORTED_LICENSE_FORMAT_MIN 200 CACHE STRING
	"Minimum license file format version supported by this runtime package.")
set(LCC_SUPPORTED_LICENSE_FORMAT_MAX 201 CACHE STRING
	"Maximum license file format version supported by this runtime package.")
set(LCC_FORBIDDEN_RELEASE_PROJECT_NAMES
	"DEFAULT;test;demo;example;sample;magic_smoke;tools_smoke"
	CACHE STRING "Project names rejected for release install/package artifacts unless explicitly allowed.")
set(LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS "" CACHE STRING
	"C++ expression list of license::os::SignaturePublicKey records trusted for online assertions.")
set(LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS "" CACHE STRING
	"C string literal list of retired online assertion key ids, for example \"sha256:old\".")
set(LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS "" CACHE STRING
	"C++ expression list of license::os::SignaturePublicKey records trusted for config attestation tokens.")
set(LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS "" CACHE STRING
	"C string literal list of retired config attestation key ids, for example \"sha256:old\".")
set(LCC_ADDITIONAL_PUBLIC_KEY_RECORDS "" CACHE STRING
	"C++ expression list of additional license::os::SignaturePublicKey records added to the project verification ring (e.g. hot lease keys alongside the embedded cold-root key).")
set(LCC_RETIRED_PUBLIC_KEY_IDS "" CACHE STRING
	"C string literal list of retired project verification ring key ids, for example \"sha256:old\".")

# Lease platform: populate the project verification ring from a checked-in ring
# manifest so the hot/cold key split is a regeneration-durable generated artifact
# (not a hand-edited, rebuild-clobbered public_key.h). See cmake/LeaseRing.cmake.
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/LeaseRing.cmake")
set(LCC_LEASE_RING_MANIFEST "" CACHE FILEPATH
	"Path to a lease ring manifest (ring.json) used to populate the project verification ring.")
option(LCC_BUILD_LEASE_RING_TEST
	"Configure a real 2-key lease ring from the checked-in test manifest and build the lease-ring golden test." OFF)
if(NOT "${LCC_LEASE_RING_MANIFEST}" STREQUAL "")
	lcc_apply_lease_ring_manifest("${LCC_LEASE_RING_MANIFEST}")
elseif(LCC_BUILD_LEASE_RING_TEST)
	# Generate an ephemeral hot key into the build tree (never committed) and wire it
	# into the ring; exposes LCC_LEASE_TEST_HOT_KEY_PATH / _ID for test_lease_ring.
	lcc_generate_test_lease_ring()
endif()
if(NOT "${LCC_SUPPORTED_LICENSE_FORMAT_MIN}" MATCHES "^[0-9]+$")
	message(FATAL_ERROR "LCC_SUPPORTED_LICENSE_FORMAT_MIN must be numeric: ${LCC_SUPPORTED_LICENSE_FORMAT_MIN}")
endif()
if(NOT "${LCC_SUPPORTED_LICENSE_FORMAT_MAX}" MATCHES "^[0-9]+$")
	message(FATAL_ERROR "LCC_SUPPORTED_LICENSE_FORMAT_MAX must be numeric: ${LCC_SUPPORTED_LICENSE_FORMAT_MAX}")
endif()
if(LCC_SUPPORTED_LICENSE_FORMAT_MIN GREATER LCC_SUPPORTED_LICENSE_FORMAT_MAX)
	message(FATAL_ERROR "LCC_SUPPORTED_LICENSE_FORMAT_MIN must not exceed LCC_SUPPORTED_LICENSE_FORMAT_MAX")
endif()

if(NOT DEFINED LCC_PROJECT_MAGIC_NUM OR "${LCC_PROJECT_MAGIC_NUM}" STREQUAL "")
	set(LCC_PROJECT_MAGIC_NUM 0 CACHE STRING "Project magic number embedded in generated project metadata")
endif()

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/ValidateLicenseccIdentity.cmake")
lcc_validate_project_name("${LCC_PROJECT_NAME}")
lcc_validate_project_magic_num("${LCC_PROJECT_MAGIC_NUM}")

# Audit R6.6: magic 0 makes LCC_VERIFY_MAGIC (lic_info.m_magic == LCC_PROJECT_MAGIC_NUM) inert -- a
# null CallerInformations also has m_magic 0, so the anti-tamper magic binding does nothing. Warn so
# an integrator who expects the magic check to bind sets a non-zero LCC_PROJECT_MAGIC_NUM on purpose.
if("${LCC_PROJECT_MAGIC_NUM}" STREQUAL "0")
	message(WARNING
		"LCC_PROJECT_MAGIC_NUM is 0: the anti-tamper magic check is INERT (a null or zero-magic caller "
		"passes). Set -DLCC_PROJECT_MAGIC_NUM=<non-zero> and pass the same value via "
		"CallerInformations.magic to make the magic binding effective.")
endif()

set(LCC_PROJECT_PUBLIC_KEY "${LCC_PROJECTS_BASE_DIR}/${LCC_PROJECT_NAME}/include/licensecc/${LCC_PROJECT_NAME}/public_key.h")
set(LCC_PROJECT_PRIVATE_KEY "${LCC_PROJECTS_BASE_DIR}/${LCC_PROJECT_NAME}/private_key.rsa")
set(LCC_CONFIG_NAME "${CMAKE_BUILD_TYPE}")
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckReleaseProject.cmake")
unset(LCC_CONFIG_NAME)

cmake_policy(SET CMP0048 NEW)
if(POLICY CMP0091)
	cmake_policy(SET CMP0091 NEW)
endif()
if(STATIC_RUNTIME)
	set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
project (licensecc 
			VERSION 2.1.0
			LANGUAGES CXX)
set(PROJECT_DESCRIPTION "Copy protection and licensing library")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(BUILD_BENCHMARKS "Build performance benchmarks (no extra dependencies)" OFF)
option(BUILD_FUZZERS "Build libFuzzer-based parser and decoder fuzz targets." OFF)
option(LCC_BUILD_EXAMPLES "Build optional licensecc examples." OFF)

# Internal file logging (writes a temp-dir open-license.log on error paths) is a debug
# diagnostic, not a production feature: a linked library should not silently own a log
# sink by default. Disable it for non-Debug configs; hosts opt back in everywhere with
# -DLCC_ENABLE_LOGGING=ON. Applies to all targets defined below (library + tools + tests).
option(LCC_ENABLE_LOGGING "Force-enable licensecc internal file logging in all build configs." OFF)
if(NOT LCC_ENABLE_LOGGING)
	add_compile_definitions($<$<NOT:$<CONFIG:Debug>>:LOG_DISABLED=1>)
endif()

SET(CMAKE_MODULE_PATH ${CMAKE_MODULE_PATH} "${CMAKE_CURRENT_SOURCE_DIR}/cmake/")

option(LCC_INSTALL_TOOLS
	"Install issuer/support tools such as lccgen and lccinspector." OFF)
option(LCC_BUILD_INSPECTOR "Build the lccinspector support tool when Boost is available." ON)
set(LCCGEN_INSTALL ${LCC_INSTALL_TOOLS} CACHE BOOL "Install the vendored lccgen tool." FORCE)

#find lccgen executable or build it.
find_package(lccgen REQUIRED) 

option(LCC_ALLOW_SOURCE_TREE_KEYGEN
	"Allow project_initialize to create a new private signing key under the source tree." OFF)

#In case the build system doesn't support binfmt misc
IF( ( CMAKE_HOST_SYSTEM_NAME STREQUAL "Linux" ) AND CMAKE_CROSSCOMPILING AND NOT DEFINED CMAKE_CROSSCOMPILING_EMULATOR )
	SET(CMAKE_CROSSCOMPILING_EMULATOR "wine")	
ENDIF()

SET (OPENSSL_USE_STATIC_LIBS TRUE)
IF(${STATIC_RUNTIME})
	SET(OPENSSL_MSVC_STATIC_RT TRUE)
ENDIF(${STATIC_RUNTIME})
find_package(OpenSSL COMPONENTS Crypto QUIET)
IF(OPENSSL_FOUND)
	MESSAGE(STATUS "Found openssl version ${OPENSSL_VERSION} -licensecc")
ENDIF(OPENSSL_FOUND)

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
	set(main_lib_dest "lib/${PROJECT_NAME}")
	#https://cmake.org/cmake/help/latest/command/find_package.html
	set(pkg_config_dest "lib/cmake/${PROJECT_NAME}")
endif(UNIX)

#initialize project
#load the current project from files or find it from environment variables or create a default one
set(LCC_PROJECT_INCLUDE_ROOT "${LCC_PROJECTS_BASE_DIR}/${LCC_PROJECT_NAME}/include")
set(LCC_PROJECT_CONFIG_HEADER "${PROJECT_NAME}/${LCC_PROJECT_NAME}/licensecc_properties.h")
set(LCC_PROJECT_PUBLIC_KEY_HEADER "${PROJECT_NAME}/${LCC_PROJECT_NAME}/public_key.h")
set(LCC_INCLUDE_DIR "${LCC_PROJECT_INCLUDE_ROOT}/${PROJECT_NAME}/${LCC_PROJECT_NAME}" )
set(LCC_PROJECT_PUBLIC_KEY "${LCC_INCLUDE_DIR}/public_key.h" )
set(LCC_PROJECT_PRIVATE_KEY "${LCC_PROJECTS_BASE_DIR}/${LCC_PROJECT_NAME}/private_key.rsa" )
add_compile_definitions(
	"LCC_PROJECT_CONFIG_HEADER=\"${LCC_PROJECT_CONFIG_HEADER}\""
	"LCC_PROJECT_PUBLIC_KEY_HEADER=\"${LCC_PROJECT_PUBLIC_KEY_HEADER}\"")

get_filename_component(LCC_PROJECTS_BASE_ABS "${LCC_PROJECTS_BASE_DIR}" ABSOLUTE)
get_filename_component(LCC_SOURCE_DIR_ABS "${CMAKE_SOURCE_DIR}" ABSOLUTE)
get_filename_component(LCC_BINARY_DIR_ABS "${CMAKE_BINARY_DIR}" ABSOLUTE)
file(TO_CMAKE_PATH "${LCC_PROJECTS_BASE_ABS}" LCC_PROJECTS_BASE_ABS_CMAKE)
file(TO_CMAKE_PATH "${LCC_SOURCE_DIR_ABS}" LCC_SOURCE_DIR_ABS_CMAKE)
file(TO_CMAKE_PATH "${LCC_BINARY_DIR_ABS}" LCC_BINARY_DIR_ABS_CMAKE)
string(FIND "${LCC_PROJECTS_BASE_ABS_CMAKE}/" "${LCC_SOURCE_DIR_ABS_CMAKE}/" LCC_PROJECTS_UNDER_SOURCE_POS)
string(FIND "${LCC_PROJECTS_BASE_ABS_CMAKE}/" "${LCC_BINARY_DIR_ABS_CMAKE}/" LCC_PROJECTS_UNDER_BINARY_POS)
if(LCC_PROJECTS_UNDER_SOURCE_POS EQUAL 0 AND
   (NOT LCC_PROJECTS_UNDER_BINARY_POS EQUAL 0) AND
   (NOT EXISTS "${LCC_PROJECT_PRIVATE_KEY}" OR NOT EXISTS "${LCC_PROJECT_PUBLIC_KEY}") AND
   NOT LCC_ALLOW_SOURCE_TREE_KEYGEN)
	message(FATAL_ERROR
		"Refusing to generate project files under the source tree. "
		"Set -DLCC_ALLOW_SOURCE_TREE_KEYGEN=ON for local development or set "
		"LCC_PROJECTS_BASE_DIR to an issuer-controlled directory outside the source tree.")
endif()

add_custom_target(project_initialize
  COMMAND license_generator::lccgen project initialize -t "${PROJECT_SOURCE_DIR}/src/templates" -n "${LCC_PROJECT_NAME}" -p "${LCC_PROJECTS_BASE_DIR}"
  COMMENT "preparing project ${LCC_PROJECT_NAME}; embedding public key ${LCC_PROJECT_PUBLIC_KEY}"
  VERBATIM
  USES_TERMINAL
)
add_custom_target(release_project_guard
  COMMAND ${CMAKE_COMMAND}
    "-DLCC_CONFIG_NAME=$<CONFIG>"
    "-DLCC_PROJECT_NAME=${LCC_PROJECT_NAME}"
    "-DLCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE=${LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE}"
    "-DLCC_ALLOW_RELEASE_PROJECT_KEYGEN=${LCC_ALLOW_RELEASE_PROJECT_KEYGEN}"
    "-DLCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN=${LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN}"
    "-DLCC_MIN_RELEASE_PUBLIC_KEY_BITS=${LCC_MIN_RELEASE_PUBLIC_KEY_BITS}"
    "-DLCC_FORBIDDEN_RELEASE_PROJECT_NAMES=${LCC_FORBIDDEN_RELEASE_PROJECT_NAMES}"
    "-DLCC_PROJECT_PUBLIC_KEY=${LCC_PROJECT_PUBLIC_KEY}"
    "-DLCC_PROJECT_PRIVATE_KEY=${LCC_PROJECT_PRIVATE_KEY}"
    "-DLCCGEN_EXECUTABLE=$<TARGET_FILE:license_generator::lccgen>"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckReleaseProject.cmake"
  VERBATIM
)
if(TARGET lccgen)
  add_dependencies(release_project_guard lccgen)
endif()
add_dependencies(project_initialize release_project_guard)

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
message( STATUS "Project public key  : " ${LCC_PROJECT_PUBLIC_KEY} )

add_subdirectory(src)

IF(BUILD_BENCHMARKS)
	add_subdirectory(benchmark)
ENDIF(BUILD_BENCHMARKS)

if(LCC_BUILD_EXAMPLES)
	add_subdirectory(examples/online_callback)
	add_subdirectory(examples/anti_tamper_host)
	add_subdirectory(examples/production_decision_host)
endif()

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

if(LCC_INSTALL_TOOLS)
	set(LCC_PACKAGE_PROFILE "tools")
else()
	set(LCC_PACKAGE_PROFILE "runtime")
endif()
lcc_validate_package_profile("${LCC_PACKAGE_PROFILE}")

if(CMAKE_CONFIGURATION_TYPES)
	set(LCC_PACKAGE_BUILD_CONFIG "multi")
elseif(NOT "${CMAKE_BUILD_TYPE}" STREQUAL "")
	set(LCC_PACKAGE_BUILD_CONFIG "${CMAKE_BUILD_TYPE}")
else()
	set(LCC_PACKAGE_BUILD_CONFIG "configless")
endif()

if(MSVC)
	if(STATIC_RUNTIME)
		set(LCC_RUNTIME_LINKAGE "msvc-static")
	else()
		set(LCC_RUNTIME_LINKAGE "msvc-dynamic")
	endif()
elseif(STATIC_RUNTIME)
	set(LCC_RUNTIME_LINKAGE "static-runtime")
else()
	set(LCC_RUNTIME_LINKAGE "default-runtime")
endif()

set(LCC_PACKAGE_ABI_TAG
	"${CMAKE_CXX_COMPILER_ID}-${CMAKE_CXX_COMPILER_VERSION}-${CMAKE_CXX_COMPILER_ARCHITECTURE_ID}-${LCC_RUNTIME_LINKAGE}")
string(REGEX REPLACE "[^A-Za-z0-9_.+-]+" "_" LCC_PACKAGE_ABI_TAG "${LCC_PACKAGE_ABI_TAG}")

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
	IF(LCC_BUILD_INSPECTOR)
		add_subdirectory("src/inspector")
	ENDIF(LCC_BUILD_INSPECTOR)
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
                  ${SPHINX_EXECUTABLE} -b html -W --keep-going -n
                  -Dbreathe_projects.licensecc=${CMAKE_CURRENT_BINARY_DIR}/xml
                  ${SPHINX_SOURCE} ${SPHINX_BUILD}
                  WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
                  COMMENT "Generating documentation with Sphinx")
    add_dependencies(documentation docs)
    
ELSE(Doxygen_FOUND AND Sphinx_FOUND)
	message(STATUS "Doxygen or Sphinx not found, not generating docs.")
ENDIF(Doxygen_FOUND AND Sphinx_FOUND)
install(DIRECTORY ${LCC_INCLUDE_DIR} DESTINATION include/${PROJECT_NAME} COMPONENT licensecc_runtime)
install(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/include/ DESTINATION include COMPONENT licensecc_runtime)
include(CMakePackageConfigHelpers)
configure_package_config_file(
	"${CMAKE_CURRENT_SOURCE_DIR}/src/cmake/licensecc-config.cmake"
	"${CMAKE_BINARY_DIR}/licensecc-config.cmake"
	INSTALL_DESTINATION "${pkg_config_dest}"
)
install(FILES ${CMAKE_BINARY_DIR}/licensecc-config.cmake DESTINATION ${pkg_config_dest} COMPONENT licensecc_runtime)
install(FILES ${CMAKE_CURRENT_SOURCE_DIR}/cmake/ReadReleaseManifest.cmake DESTINATION ${pkg_config_dest} COMPONENT licensecc_runtime)

install(CODE "
	set(LCC_CONFIG_NAME \"\${CMAKE_INSTALL_CONFIG_NAME}\")
	set(LCC_PROJECT_NAME \"${LCC_PROJECT_NAME}\")
	if(DEFINED ENV{LCC_CPACK_ALLOW_DEFAULT_PROJECT_FOR_RELEASE} AND NOT \"\$ENV{LCC_CPACK_ALLOW_DEFAULT_PROJECT_FOR_RELEASE}\" STREQUAL \"\")
		set(LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE \"\$ENV{LCC_CPACK_ALLOW_DEFAULT_PROJECT_FOR_RELEASE}\")
	else()
		set(LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE \"${LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE}\")
	endif()
	if(DEFINED ENV{LCC_CPACK_ALLOW_RELEASE_PROJECT_KEYGEN} AND NOT \"\$ENV{LCC_CPACK_ALLOW_RELEASE_PROJECT_KEYGEN}\" STREQUAL \"\")
		set(LCC_ALLOW_RELEASE_PROJECT_KEYGEN \"\$ENV{LCC_CPACK_ALLOW_RELEASE_PROJECT_KEYGEN}\")
	else()
		set(LCC_ALLOW_RELEASE_PROJECT_KEYGEN \"${LCC_ALLOW_RELEASE_PROJECT_KEYGEN}\")
	endif()
	set(LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN \"${LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN}\")
	set(LCC_MIN_RELEASE_PUBLIC_KEY_BITS \"${LCC_MIN_RELEASE_PUBLIC_KEY_BITS}\")
	set(LCC_FORBIDDEN_RELEASE_PROJECT_NAMES \"${LCC_FORBIDDEN_RELEASE_PROJECT_NAMES}\")
	set(LCC_PROJECT_PUBLIC_KEY \"${LCC_PROJECT_PUBLIC_KEY}\")
	set(LCC_PROJECT_PRIVATE_KEY \"${LCC_PROJECT_PRIVATE_KEY}\")
	set(LCCGEN_EXECUTABLE \"$<TARGET_FILE:license_generator::lccgen>\")
	include(\"${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckReleaseProject.cmake\")
	set(LCC_ARTIFACT_SCAN_ROOT \"\$ENV{DESTDIR}\${CMAKE_INSTALL_PREFIX}\")
	set(LCC_ARTIFACT_ROOT \"\${LCC_ARTIFACT_SCAN_ROOT}\")
	set(LCC_ARTIFACT_PROJECT_NAME \"${LCC_PROJECT_NAME}\")
	set(LCC_ARTIFACT_PROJECT_MAGIC_NUM \"${LCC_PROJECT_MAGIC_NUM}\")
	set(LCC_ARTIFACT_PACKAGE_NAME \"${PROJECT_NAME}\")
	set(LCC_ARTIFACT_PACKAGE_VERSION \"${PROJECT_VERSION}\")
	set(LCC_ARTIFACT_PACKAGE_PROFILE \"${LCC_PACKAGE_PROFILE}\")
	set(LCC_ARTIFACT_LICENSE_FORMAT_MIN \"${LCC_SUPPORTED_LICENSE_FORMAT_MIN}\")
	set(LCC_ARTIFACT_LICENSE_FORMAT_MAX \"${LCC_SUPPORTED_LICENSE_FORMAT_MAX}\")
	set(LCC_ARTIFACT_BUILD_CONFIG \"\${CMAKE_INSTALL_CONFIG_NAME}\")
	set(LCC_ARTIFACT_PLATFORM \"${CMAKE_SYSTEM_NAME}\")
	set(LCC_ARTIFACT_SYSTEM_PROCESSOR \"${CMAKE_SYSTEM_PROCESSOR}\")
	set(LCC_ARTIFACT_GENERATOR \"${CMAKE_GENERATOR}\")
	set(LCC_ARTIFACT_COMPILER_ID \"${CMAKE_CXX_COMPILER_ID}\")
	set(LCC_ARTIFACT_COMPILER_VERSION \"${CMAKE_CXX_COMPILER_VERSION}\")
	set(LCC_ARTIFACT_COMPILER_ARCHITECTURE \"${CMAKE_CXX_COMPILER_ARCHITECTURE_ID}\")
	set(LCC_ARTIFACT_RUNTIME_LINKAGE \"${LCC_RUNTIME_LINKAGE}\")
	set(LCC_ARTIFACT_ABI_TAG \"${LCC_PACKAGE_ABI_TAG}\")
	include(\"${CMAKE_CURRENT_SOURCE_DIR}/cmake/WriteReleaseManifest.cmake\")
	set(LCC_ARTIFACT_ALLOW_TOOLS \"${LCC_INSTALL_TOOLS}\")
	set(LCC_ARTIFACT_EXPECTED_PROFILE \"${LCC_PACKAGE_PROFILE}\")
	set(LCC_ARTIFACT_EXPECTED_PROJECT_NAME \"${LCC_PROJECT_NAME}\")
	include(\"${CMAKE_CURRENT_SOURCE_DIR}/cmake/ScanReleaseArtifact.cmake\")
" COMPONENT licensecc_runtime)

write_basic_package_version_file(${CMAKE_BINARY_DIR}/licensecc-config-version.cmake COMPATIBILITY SameMajorVersion)
install(FILES ${CMAKE_BINARY_DIR}/licensecc-config-version.cmake DESTINATION ${pkg_config_dest} COMPONENT licensecc_runtime)

set(CPACK_PACKAGE_NAME "${PROJECT_NAME}")
set(CPACK_PACKAGE_VENDOR "open license manager Team")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_RESOURCE_FILE_LICENSE "${PROJECT_SOURCE_DIR}/LICENSE")
set(CPACK_OUTPUT_FILE_PREFIX dist)
set(CPACK_PACKAGE_FILE_NAME
	"${PROJECT_NAME}-${PROJECT_VERSION}-${LCC_PACKAGE_PROFILE}-${LCC_PROJECT_NAME}-${LCC_PACKAGE_BUILD_CONFIG}-${LCC_PACKAGE_ABI_TAG}-${CMAKE_SYSTEM_NAME}")
configure_file(
	"${CMAKE_CURRENT_SOURCE_DIR}/cmake/LicenseccCPackOptions.cmake.in"
	"${CMAKE_BINARY_DIR}/LicenseccCPackOptions.cmake"
	@ONLY)
if(CMAKE_CONFIGURATION_TYPES)
	file(GENERATE
		OUTPUT "${CMAKE_BINARY_DIR}/LicenseccLccgenPath-$<CONFIG>.cmake"
		CONTENT "set(LCCGEN_EXECUTABLE \"$<TARGET_FILE:license_generator::lccgen>\")\n")
else()
	file(GENERATE
		OUTPUT "${CMAKE_BINARY_DIR}/LicenseccLccgenPath-${LCC_PACKAGE_BUILD_CONFIG}.cmake"
		CONTENT "set(LCCGEN_EXECUTABLE \"$<TARGET_FILE:license_generator::lccgen>\")\n")
	file(GENERATE
		OUTPUT "${CMAKE_BINARY_DIR}/LicenseccLccgenPath.cmake"
		CONTENT "set(LCCGEN_EXECUTABLE \"$<TARGET_FILE:license_generator::lccgen>\")\n")
endif()
set(CPACK_PROJECT_CONFIG_FILE "${CMAKE_BINARY_DIR}/LicenseccCPackOptions.cmake")
if(WIN32)
	set(CPACK_GENERATOR "ZIP")
else()
	set(CPACK_GENERATOR "TGZ")
endif()
set(CPACK_SOURCE_IGNORE_FILES
	"/CVS/"
	"/build[^/]*/"
	"/\\\\.svn/"
	"/\\\\.bzr/"
	"/\\\\.hg/"
	"/\\\\.git/"
	"/\\\\.git$"
	"/build/"
	"/install/"
	"/dist/"
	"/node_modules/"
	"/\\\\.venv/"
	"/__pycache__/"
	"/services/"
	"/sdks/"
	"/docs/"
	"/\\\\.wrangler/"
	"/\\\\.online-key/"
	"/projects/"
	"/Testing/"
	"/_CPack_Packages/"
	"/CMakeFiles/"
	"/CMakeCache\\\\.txt$"
	"/CPackConfig\\\\.cmake$"
	"/CPackSourceConfig\\\\.cmake$"
	"/IMPLEMENTATION_CHECKLIST\\\\.md$"
	"/CLAUDE\\\\.md$"
	"/pyvenv\\\\.cfg$"
	"private_key\\\\.rsa$"
	"/id_rsa$"
	"/id_dsa$"
	"/id_ecdsa$"
	"/id_ed25519$"
	"\\\\.pem$"
	"\\\\.key$"
	"\\\\.p12$"
	"\\\\.pfx$"
	"\\\\.der$"
	"\\\\.p8$"
	"\\\\.pk8$"
	"\\\\.pkcs8$"
	"\\\\.jwk$"
	"\\\\.secret$"
	"signing"
)
include(CPack)
