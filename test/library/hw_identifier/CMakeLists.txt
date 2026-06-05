add_executable( test_hw_identifier
 hw_identifier_test.cpp
)

target_link_libraries( test_hw_identifier
 licensecc_static
 Boost::unit_test_framework 
 Boost::filesystem
 Boost::system
)

if(CODE_COVERAGE AND UNIX)
	  target_compile_options(test_hw_identifier PUBLIC -O0 -g --coverage)
endif(CODE_COVERAGE AND UNIX)

add_executable( test_hw_identifier_facade
 hw_identifier_facade_test.cpp
)

target_link_libraries( test_hw_identifier_facade
 licensecc_static
 Boost::unit_test_framework
 Boost::filesystem
 Boost::system
)

ADD_TEST(NAME test_hw_identifier COMMAND test_hw_identifier)
ADD_TEST(NAME test_hw_identifier_facade COMMAND test_hw_identifier_facade)

set_tests_properties(test_hw_identifier PROPERTIES LABELS "security;hardware")
set_tests_properties(test_hw_identifier_facade PROPERTIES LABELS "security;hardware;public_api")
