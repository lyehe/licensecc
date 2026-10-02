# Configured by the package_config_*_component tests: stages licensecc-config.cmake as an
# installed package with the single project component "installed_project", then asks
# find_package for LCC_REQUIRED_COMPONENT.
cmake_minimum_required(VERSION 3.16)
project(component_consumer NONE)
include(CMakePackageConfigHelpers)
set(package "${CMAKE_BINARY_DIR}/package")
file(REMOVE_RECURSE "${package}")
configure_package_config_file("${LCC_CONFIG_TEMPLATE}" "${package}/lib/cmake/licensecc/licensecc-config.cmake"
	INSTALL_DESTINATION lib/cmake/licensecc
	INSTALL_PREFIX "${package}")
file(WRITE "${package}/lib/licensecc/installed_project/cmake/licensecc.cmake"
	"add_library(licensecc::licensecc_static INTERFACE IMPORTED)\n")
set(licensecc_DIR "${package}/lib/cmake/licensecc")
find_package(licensecc CONFIG REQUIRED COMPONENTS ${LCC_REQUIRED_COMPONENT})
if(NOT TARGET licensecc::licensecc_static OR NOT licensecc_${LCC_REQUIRED_COMPONENT}_FOUND)
	message(FATAL_ERROR "licensecc reported ${LCC_REQUIRED_COMPONENT} found without loading it")
endif()
message(STATUS "licensecc component ${LCC_REQUIRED_COMPONENT} found")
