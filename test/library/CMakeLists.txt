add_executable( test_license_reader
 LicenseReader_test.cpp
)

target_link_libraries( test_license_reader
 licensecc_static
 Boost::unit_test_framework 
 Boost::filesystem
 Boost::system
)

IF(WIN32)
#test windows
ELSE(WIN32)
    add_executable(
 		test_os_linux
 		os_linux_test.cpp
	)

	target_link_libraries(
 		test_os_linux
 		licensecc_static
 		Boost::unit_test_framework 
        Boost::filesystem
        Boost::system
	)

	ADD_TEST(NAME test_os_linux COMMAND test_os_linux)
	set_tests_properties(test_os_linux PROPERTIES LABELS "security;platform;hardware")
ENDIF(WIN32)

### LicenseLocator tests
add_executable(
	test_license_locator
 	LicenseLocator_test.cpp
)

target_link_libraries(
 test_license_locator
 licensecc_static
 Boost::unit_test_framework 
 Boost::filesystem
 Boost::system
)

### Base64 decoder tests
add_executable(
 test_base64
 base64_test.cpp
)

target_link_libraries(
 test_base64
 licensecc_static
 Boost::unit_test_framework
 Boost::system
)

### v201 canonical payload tests
add_executable(
 test_v201_canonical_payload
 v201_canonical_payload_test.cpp
)

target_link_libraries(
 test_v201_canonical_payload
 licensecc_static
 Boost::unit_test_framework
 Boost::system
)

### LicenseLocator tests
add_executable(
 test_event_registry
 EventRegistry_test.cpp
 $<TARGET_OBJECTS:base>
)

target_link_libraries(
 test_event_registry
 Boost::unit_test_framework
 Boost::system
)

if(CODE_COVERAGE AND UNIX)
  target_link_libraries(test_event_registry gcov)
endif(CODE_COVERAGE AND UNIX)

### LicenseVerifier tests
add_executable(
 test_license_verifier
 license_verifier_test.cpp
)

target_link_libraries(
 test_license_verifier
 licensecc_static
 Boost::unit_test_framework
 Boost::system
)

### Public API tests (lcc_strerror / print_error)
add_executable(
 test_public_api
 public_api_test.cpp
)

target_link_libraries(
 test_public_api
 licensecc_static
 Boost::unit_test_framework
 Boost::system
)

# Inject the CMake project version (unquoted) so the public header LCC_VERSION_*
# macros cannot silently drift from project(... VERSION ...). The version test in
# public_api_test.cpp stringifies and compares it, failing the build on drift.
target_compile_definitions(
 test_public_api
 PRIVATE LCC_EXPECTED_PROJECT_VERSION=${PROJECT_VERSION}
)

### Anti-tamper API and integration tests
add_executable(
 test_anti_tamper
 anti_tamper_test.cpp
)

target_link_libraries(
 test_anti_tamper
 licensecc_static
 Boost::unit_test_framework
 Boost::system
)

### Online verification API, assertion, and integration tests
add_executable(
 test_online_verification
 online_verification_test.cpp
)

target_link_libraries(
 test_online_verification
 licensecc_static
 license_generator_lib
 Boost::unit_test_framework
 Boost::system
)

### Online callback transport failover helper tests
add_executable(
 test_online_callback_failover
 online_callback_failover_test.cpp
)

target_include_directories(
 test_online_callback_failover
 PRIVATE
 ${CMAKE_SOURCE_DIR}/examples/online_callback
)

target_link_libraries(
 test_online_callback_failover
 licensecc_static
 Boost::unit_test_framework
 Boost::system
)

### Config attestation verification tests
add_executable(
 test_config_attestation
 config_attestation_test.cpp
)

target_link_libraries(
 test_config_attestation
 licensecc_static
 license_generator_lib
 Boost::unit_test_framework
 Boost::system
)

ADD_TEST(NAME test_license_reader COMMAND test_license_reader)
ADD_TEST(NAME test_license_locator COMMAND test_license_locator)
ADD_TEST(NAME test_base64 COMMAND test_base64)
ADD_TEST(NAME test_v201_canonical_payload COMMAND test_v201_canonical_payload)
ADD_TEST(NAME test_event_registry COMMAND test_event_registry)
ADD_TEST(NAME test_license_verifier COMMAND test_license_verifier)
ADD_TEST(NAME test_public_api COMMAND test_public_api)
ADD_TEST(NAME test_anti_tamper COMMAND test_anti_tamper)
ADD_TEST(NAME test_online_verification COMMAND test_online_verification)
ADD_TEST(NAME test_online_callback_failover COMMAND test_online_callback_failover)
ADD_TEST(NAME test_config_attestation COMMAND test_config_attestation)

set_tests_properties(
 test_license_reader
 PROPERTIES LABELS "security;parser"
)

set_tests_properties(
 test_license_locator
 PROPERTIES LABELS "security;parser;base64;public_api"
)

set_tests_properties(
 test_base64
 PROPERTIES LABELS "security;base64"
)

set_tests_properties(
 test_v201_canonical_payload
 PROPERTIES LABELS "security;validation;v201"
)

set_tests_properties(
 test_event_registry
 PROPERTIES LABELS "security;validation"
)

set_tests_properties(
 test_license_verifier
 PROPERTIES LABELS "security;verifier"
)

set_tests_properties(
 test_public_api
 PROPERTIES LABELS "security;public_api"
)

set_tests_properties(
 test_anti_tamper
 PROPERTIES LABELS "security;public_api;anti_tamper"
)

set_tests_properties(
 test_online_verification
 PROPERTIES LABELS "security;public_api;online"
)

set_tests_properties(
 test_online_callback_failover
 PROPERTIES LABELS "security;public_api;online"
)

set_tests_properties(
 test_config_attestation
 PROPERTIES LABELS "security;config_attestation"
)

### Config public API tests
add_executable(
 test_config_public_api
 config_public_api_test.cpp
)

target_link_libraries(
 test_config_public_api
 licensecc_static
 license_generator_lib
 Boost::unit_test_framework
 Boost::system
)

ADD_TEST(NAME test_config_public_api COMMAND test_config_public_api)

set_tests_properties(
 test_config_public_api
 PROPERTIES LABELS "security;public_api;config_attestation"
)

ADD_SUBDIRECTORY(os)
ADD_SUBDIRECTORY(hw_identifier)
