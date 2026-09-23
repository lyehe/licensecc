# Configured by the package_config_rejects_old_curl test: stages licensecc-config.cmake as a
# Linux-desktop package would install it and offers only libcurl 7.81, which must be fatal.
cmake_minimum_required(VERSION 3.16)
project(old_curl_consumer NONE)
set(LCC_ENABLE_DEVICE_IDENTITY ON)
set(LCC_ENABLE_LINUX_DESKTOP ON)
set(package "${CMAKE_BINARY_DIR}/package")
configure_file("${LCC_CONFIG_TEMPLATE}" "${package}/lib/cmake/licensecc-config.cmake" @ONLY)
file(WRITE "${package}/licensecc/${PROJECT_NAME}/cmake/licensecc.cmake"
	"add_library(licensecc::licensecc_static INTERFACE IMPORTED)\n")
file(WRITE "${CMAKE_BINARY_DIR}/modules/FindCURL.cmake"
	"set(CURL_VERSION_STRING 7.81.0)\ninclude(FindPackageHandleStandardArgs)\n"
	"find_package_handle_standard_args(CURL REQUIRED_VARS CURL_VERSION_STRING VERSION_VAR CURL_VERSION_STRING)\n")
list(APPEND CMAKE_MODULE_PATH "${CMAKE_BINARY_DIR}/modules")
include("${package}/lib/cmake/licensecc-config.cmake")
message(FATAL_ERROR "libcurl 7.81 was accepted")
