add_executable( test_network
 network_test.cpp
 "network_test.cpp")

target_link_libraries( test_network
 licensecc_static
 Boost::unit_test_framework 
 Boost::filesystem
 Boost::system
)

ADD_TEST(NAME test_network COMMAND test_network)

IF(WIN32)
	add_executable( test_windows_disk_info
	 windows_disk_info_test.cpp
	)

	target_link_libraries( test_windows_disk_info
	 licensecc_static
	 Boost::unit_test_framework
	 Boost::filesystem
	 Boost::system
	)

	ADD_TEST(NAME test_windows_disk_info COMMAND test_windows_disk_info)
ENDIF(WIN32)

IF(NOT DEFINED MINGW)
	add_executable( test_dmi_info dmi_info_test.cpp "dmi_info_test.cpp")
	target_link_libraries( test_dmi_info
 		licensecc_static
 		Boost::unit_test_framework 
 		Boost::filesystem
 		Boost::system
	)
	ADD_TEST(NAME test_dmi_info COMMAND test_dmi_info)
ENDIF(NOT DEFINED MINGW)

add_executable( test_execution_environment
 	execution_environment_test.cpp
)

target_link_libraries( test_execution_environment
 licensecc_static
 Boost::unit_test_framework 
 Boost::filesystem
 Boost::system
)

ADD_TEST(NAME test_execution_environment COMMAND test_execution_environment)

if(CODE_COVERAGE AND UNIX)
	IF(NOT DEFINED MINGW)
		target_compile_options(test_dmi_info PUBLIC -O0 -g --coverage)
	ENDIF(NOT DEFINED MINGW)
	
	target_compile_options(test_execution_environment PUBLIC -O0 -g --coverage)
	target_compile_options(test_network PUBLIC -O0 -g --coverage)
endif(CODE_COVERAGE AND UNIX)

set_tests_properties(
 test_network
 PROPERTIES LABELS "security;platform;hardware"
)

IF(WIN32)
	set_tests_properties(
	 test_windows_disk_info
	 PROPERTIES LABELS "security;platform;hardware"
	)
ENDIF(WIN32)

IF(NOT DEFINED MINGW)
	set_tests_properties(
	 test_dmi_info
	 PROPERTIES LABELS "security;platform;hardware"
	)
ENDIF(NOT DEFINED MINGW)

set_tests_properties(
 test_execution_environment
 PROPERTIES LABELS "security;platform"
)



