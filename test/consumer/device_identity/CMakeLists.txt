cmake_minimum_required(VERSION 3.21 FATAL_ERROR)
project(licensecc_device_identity_consumer LANGUAGES CXX)

include(CheckLanguage)
option(LCC_DEVICE_IDENTITY_REQUIRE_C99
    "Fail configuration when the installed C99 header smoke cannot be built"
    OFF)
option(LCC_DEVICE_IDENTITY_EXPECT_WINDOWS_TPM
    "Require the installed package to contain the Windows Platform KSP provider"
    OFF)
option(LCC_DEVICE_IDENTITY_EXPECT_TPM2_OPENSSL
    "Require the installed package to contain the Linux OpenSSL TPM2 provider"
    OFF)
option(LCC_DEVICE_IDENTITY_PRE_FIND_OPENSSL
    "Find OpenSSL 3 before loading the installed Licensecc package"
    OFF)
option(LCC_DEVICE_IDENTITY_TPM2_ALLOW_SKIP
    "Allow the TPM2 consumer test to skip when hardware/provider access is unavailable"
    OFF)
set(LCC_DEVICE_IDENTITY_TPM2_STORAGE_DIRECTORY "" CACHE PATH
    "Absolute 0700 directory used by the installed TPM2 consumer")
set(LCC_PROJECT_NAME "test" CACHE STRING "Installed Licensecc project component")
if(LCC_DEVICE_IDENTITY_PRE_FIND_OPENSSL)
    find_package(OpenSSL 3.0 REQUIRED COMPONENTS Crypto)
endif()
find_package(licensecc CONFIG REQUIRED)

if(NOT TARGET licensecc::licensecc_static)
    message(FATAL_ERROR "The installed package did not export licensecc::licensecc_static")
endif()
if(NOT LCC_ENABLE_DEVICE_IDENTITY)
    message(FATAL_ERROR "The installed package does not contain the device-identity core")
endif()
if(LCC_DEVICE_IDENTITY_EXPECT_WINDOWS_TPM AND NOT LCC_ENABLE_WINDOWS_TPM)
    message(FATAL_ERROR "The installed package does not contain the Windows Platform KSP provider")
endif()
if(LCC_DEVICE_IDENTITY_EXPECT_TPM2_OPENSSL AND NOT LCC_ENABLE_TPM2_OPENSSL)
    message(FATAL_ERROR "The installed package does not contain the OpenSSL TPM2 provider")
endif()
if(LCC_DEVICE_IDENTITY_EXPECT_WINDOWS_TPM AND LCC_DEVICE_IDENTITY_EXPECT_TPM2_OPENSSL)
    message(FATAL_ERROR "Select only one installed hardware provider expectation")
endif()
if(LCC_DEVICE_IDENTITY_EXPECT_TPM2_OPENSSL AND
   "${LCC_DEVICE_IDENTITY_TPM2_STORAGE_DIRECTORY}" STREQUAL "")
    message(FATAL_ERROR "TPM2 installed consumer requires LCC_DEVICE_IDENTITY_TPM2_STORAGE_DIRECTORY")
endif()
if(LCC_DEVICE_IDENTITY_EXPECT_TPM2_OPENSSL AND
   NOT IS_ABSOLUTE "${LCC_DEVICE_IDENTITY_TPM2_STORAGE_DIRECTORY}")
    message(FATAL_ERROR "TPM2 installed consumer requires an absolute storage directory")
endif()

check_language(C)
if(CMAKE_C_COMPILER)
    enable_language(C)
    add_library(device_identity_c_header_smoke OBJECT c_header_smoke.c)
    set_target_properties(device_identity_c_header_smoke PROPERTIES C_STANDARD 99 C_STANDARD_REQUIRED YES)
    target_link_libraries(device_identity_c_header_smoke PRIVATE licensecc::licensecc_static)
    message(STATUS "Device identity installed C99 header smoke: ENABLED")
elseif(LCC_DEVICE_IDENTITY_REQUIRE_C99)
    message(FATAL_ERROR "Device identity installed consumer requires a C compiler for its C99 header smoke")
else()
    message(STATUS "Device identity installed C99 header smoke: SKIP (no C compiler)")
endif()

add_executable(device_identity_cpp_link_smoke cpp_link_smoke.cpp)
set_target_properties(device_identity_cpp_link_smoke PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED YES)
target_link_libraries(device_identity_cpp_link_smoke PRIVATE licensecc::licensecc_static)
if(LCC_DEVICE_IDENTITY_EXPECT_WINDOWS_TPM)
    target_compile_definitions(device_identity_cpp_link_smoke
        PRIVATE LCC_DEVICE_IDENTITY_EXPECT_WINDOWS_TPM=1)
endif()
if(LCC_DEVICE_IDENTITY_EXPECT_TPM2_OPENSSL)
    target_compile_definitions(device_identity_cpp_link_smoke
        PRIVATE
            LCC_DEVICE_IDENTITY_EXPECT_TPM2_OPENSSL=1
            "LCC_DEVICE_IDENTITY_TPM2_STORAGE_DIRECTORY=\"${LCC_DEVICE_IDENTITY_TPM2_STORAGE_DIRECTORY}\"")
    if(LCC_DEVICE_IDENTITY_TPM2_ALLOW_SKIP)
        target_compile_definitions(device_identity_cpp_link_smoke
            PRIVATE LCC_DEVICE_IDENTITY_TPM2_ALLOW_SKIP=1)
    endif()
endif()
if(TARGET device_identity_c_header_smoke)
    target_sources(device_identity_cpp_link_smoke
        PRIVATE $<TARGET_OBJECTS:device_identity_c_header_smoke>)
    target_compile_definitions(device_identity_cpp_link_smoke
        PRIVATE LCC_DEVICE_IDENTITY_C_SMOKE_LINKED=1)
endif()

enable_testing()
add_test(NAME device_identity_installed_cpp_link COMMAND device_identity_cpp_link_smoke)
if(LCC_DEVICE_IDENTITY_EXPECT_TPM2_OPENSSL AND LCC_DEVICE_IDENTITY_TPM2_ALLOW_SKIP)
    set_tests_properties(device_identity_installed_cpp_link PROPERTIES SKIP_RETURN_CODE 77)
endif()
