#if we're here boost has been found
add_definitions(-DBOOST_ALL_NO_LIB) #Disable Boost Microsoft magic, all dependencies are handled by cmake

configure_file (
	"${CMAKE_CURRENT_SOURCE_DIR}/../src/templates/licensecc_properties_test.h.in" 
	"${CMAKE_BINARY_DIR}/licensecc_properties_test.h.tmp"
)
file(GENERATE OUTPUT "${CMAKE_BINARY_DIR}/include/$<CONFIG>/licensecc_properties_test.h" 
		INPUT "${CMAKE_BINARY_DIR}/licensecc_properties_test.h.tmp")
include_directories ( ${CMAKE_BINARY_DIR}/include/$<CONFIG> )

add_subdirectory(library)
add_subdirectory(functional)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
	# The installed package config must stop a consumer offering libcurl < 7.85 and name the remediation.
	add_test(NAME package_config_rejects_old_curl
		COMMAND "${CMAKE_COMMAND}" -S "${CMAKE_CURRENT_SOURCE_DIR}/consumer/old_curl"
			-B "${CMAKE_CURRENT_BINARY_DIR}/old_curl"
			"-DLCC_CONFIG_TEMPLATE=${CMAKE_CURRENT_SOURCE_DIR}/../src/cmake/licensecc-config.cmake")
	set_tests_properties(package_config_rejects_old_curl PROPERTIES
		PASS_REGULAR_EXPRESSION "found:[ \n]+'7\\.81\\.0'.*LCC_ENABLE_LINUX_DESKTOP=OFF")
endif()
