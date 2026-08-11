set(_lcc_device_identity_tests
    device_identity_abi_test
    device_identity_vectors_test
    device_identity_policy_test
    device_identity_concurrency_test)

foreach(_lcc_device_identity_test IN LISTS _lcc_device_identity_tests)
    add_executable(${_lcc_device_identity_test} ${_lcc_device_identity_test}.cpp)
    target_include_directories(${_lcc_device_identity_test}
        PRIVATE
            ${CMAKE_SOURCE_DIR}/src/library/device_identity)
    target_link_libraries(${_lcc_device_identity_test}
        PRIVATE
            licensecc_static
            Boost::unit_test_framework
            Boost::system)
    add_test(NAME ${_lcc_device_identity_test} COMMAND ${_lcc_device_identity_test})
    set_tests_properties(${_lcc_device_identity_test}
        PROPERTIES LABELS "security;public_api;device_identity")
endforeach()

target_compile_definitions(device_identity_vectors_test
    PRIVATE LCC_DEVICE_IDENTITY_VECTOR_ROOT="${CMAKE_SOURCE_DIR}/test/vectors")

unset(_lcc_device_identity_test)
unset(_lcc_device_identity_tests)
