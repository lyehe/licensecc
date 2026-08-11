add_executable(test_license license_test.cpp)
target_link_libraries(test_license license_generator_lib ${Boost_LIBRARIES})
ADD_TEST(NAME test_license COMMAND test_license WORKING_DIRECTORY ${CMAKE_BINARY_DIR})

add_executable(test_command-line command-line_test.cpp)
target_link_libraries(test_command-line license_generator_lib ${Boost_LIBRARIES})
ADD_TEST(NAME test_command-line COMMAND test_command-line WORKING_DIRECTORY ${CMAKE_BINARY_DIR})

add_executable(test_project project_test.cpp)
target_link_libraries(test_project license_generator_lib ${Boost_LIBRARIES})
ADD_TEST(NAME test_project COMMAND test_project WORKING_DIRECTORY ${CMAKE_BINARY_DIR})

add_executable(test_file_publish file_publish_test.cpp)
target_link_libraries(test_file_publish license_generator_lib ${Boost_LIBRARIES})
ADD_TEST(NAME test_file_publish COMMAND test_file_publish WORKING_DIRECTORY ${CMAKE_BINARY_DIR})

add_executable(test_rsa_interop rsa_interop_test.cpp)
target_link_libraries(test_rsa_interop license_generator_lib ${Boost_LIBRARIES})
ADD_TEST(NAME test_rsa_interop COMMAND test_rsa_interop WORKING_DIRECTORY ${CMAKE_BINARY_DIR})

add_executable(test_cryptohelper cryptohelper_test.cpp)
target_link_libraries(test_cryptohelper license_generator_lib ${Boost_LIBRARIES})
ADD_TEST(NAME test_cryptohelper COMMAND test_cryptohelper WORKING_DIRECTORY ${CMAKE_BINARY_DIR})

add_executable(test_generator_v201_canonical_payload v201_canonical_payload_test.cpp)
target_link_libraries(test_generator_v201_canonical_payload license_generator_lib ${Boost_LIBRARIES})
ADD_TEST(NAME test_generator_v201_canonical_payload COMMAND test_generator_v201_canonical_payload WORKING_DIRECTORY ${CMAKE_BINARY_DIR})

string(SHA256 LCCGEN_EMBEDDED_FIXTURE_BINARY_HASH "${CMAKE_CURRENT_BINARY_DIR}")
string(SUBSTRING "${LCCGEN_EMBEDDED_FIXTURE_BINARY_HASH}" 0 12 LCCGEN_EMBEDDED_FIXTURE_BINARY_ID)
# Keep this configure probe near the top-level binary tree.  When lccgen is
# embedded below a deeply nested superproject path, putting its CMakeScratch
# tree below test/ can exceed MSBuild's legacy tlog path limit on Windows.
# The per-directory hash avoids collisions between independently embedded
# lccgen instances while remaining short.
set(LCCGEN_EMBEDDED_FIXTURE_BINARY_DIR
	"${CMAKE_BINARY_DIR}/lccgen-e-${LCCGEN_EMBEDDED_FIXTURE_BINARY_ID}")

add_test(NAME test_generator_embedded_configure
	COMMAND ${CMAKE_COMMAND}
		-DLCCGEN_SOURCE_DIR=${PROJECT_SOURCE_DIR}
		-DLCCGEN_EMBEDDED_FIXTURE_DIR=${CMAKE_CURRENT_SOURCE_DIR}/fixtures/embedded
		-DLCCGEN_EMBEDDED_BINARY_DIR=${LCCGEN_EMBEDDED_FIXTURE_BINARY_DIR}
		-DLCCGEN_EMBEDDED_BINARY_ROOT=${CMAKE_BINARY_DIR}
		-P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/configure_embedded_fixture.cmake)

set(LCCGEN_V201_CROSS_CONTRACT_DIR "" CACHE PATH
	"Optional external runtime v201 vector directory checked against generator-owned fixtures")
if(LCCGEN_V201_CROSS_CONTRACT_DIR)
	add_test(NAME test_generator_v201_cross_contract
		COMMAND ${CMAKE_COMMAND}
			-DLCCGEN_LOCAL_VECTOR_DIR=${CMAKE_CURRENT_SOURCE_DIR}/data/v201
			-DLCCGEN_CROSS_CONTRACT_DIR=${LCCGEN_V201_CROSS_CONTRACT_DIR}
			-P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/compare_v201_contract.cmake)
	set_tests_properties(test_generator_v201_cross_contract PROPERTIES LABELS "security;generator;validation;v201;cross-contract")
endif()

set_tests_properties(test_license PROPERTIES LABELS "security;generator;signature")
set_tests_properties(test_command-line PROPERTIES LABELS "security;generator")
set_tests_properties(test_project PROPERTIES LABELS "security;generator")
set_tests_properties(test_file_publish PROPERTIES LABELS "security;generator;file-publication")
set_tests_properties(test_rsa_interop PROPERTIES LABELS "security;generator;signature;interop")
set_tests_properties(test_cryptohelper PROPERTIES LABELS "security;generator;signature;base64")
set_tests_properties(test_generator_v201_canonical_payload PROPERTIES LABELS "security;generator;validation;v201")
set_tests_properties(test_generator_embedded_configure PROPERTIES LABELS "generator;cmake;embedded")
