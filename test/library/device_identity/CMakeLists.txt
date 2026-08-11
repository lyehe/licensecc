set(_lcc_device_identity_tests
    device_identity_abi_test
    device_identity_vectors_test)

if(LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER)
    list(APPEND _lcc_device_identity_tests
        device_identity_policy_test
        device_identity_concurrency_test)
endif()

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

if(LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER)
    target_compile_definitions(device_identity_abi_test PRIVATE LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER=1)
    target_compile_definitions(device_identity_vectors_test PRIVATE LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER=1)
else()
    target_compile_definitions(device_identity_abi_test PRIVATE LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER=0)
    target_compile_definitions(device_identity_vectors_test PRIVATE LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER=0)
endif()

if(WIN32 AND LCC_ENABLE_WINDOWS_TPM)
    add_executable(device_identity_windows_test windows_tpm_test.cpp)
    target_include_directories(device_identity_windows_test
        PRIVATE ${CMAKE_SOURCE_DIR}/src/library/device_identity)
    target_link_libraries(device_identity_windows_test PRIVATE licensecc_static bcrypt ncrypt)
    add_test(NAME device_identity_windows_shim COMMAND device_identity_windows_test --shim)
    add_test(NAME device_identity_windows_real COMMAND device_identity_windows_test --real)
    set_tests_properties(device_identity_windows_shim device_identity_windows_real
        PROPERTIES LABELS "security;public_api;device_identity;windows_tpm")
    set_tests_properties(device_identity_windows_real PROPERTIES SKIP_RETURN_CODE 77)
endif()

unset(_lcc_device_identity_test)
unset(_lcc_device_identity_tests)
