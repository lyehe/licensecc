if(LCC_ENABLE_DEVICE_IDENTITY)
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
endif()

if(LCC_BUILD_TPM2_OPENSSL_CAPABILITY_TEST)
    add_executable(device_identity_tpm2_openssl_test tpm2_openssl_test.cpp)
    target_compile_features(device_identity_tpm2_openssl_test PRIVATE cxx_std_17)
    target_link_libraries(device_identity_tpm2_openssl_test PRIVATE OpenSSL::Crypto)
    add_test(NAME device_identity_tpm2_openssl COMMAND device_identity_tpm2_openssl_test)
    set_tests_properties(device_identity_tpm2_openssl
        PROPERTIES LABELS "security;device_identity;ubuntu_tpm2" SKIP_RETURN_CODE 77)
endif()

if(LCC_ENABLE_TPM2_OPENSSL)
    add_executable(device_identity_tpm2_openssl_shim_test tpm2_openssl_test.cpp)
    target_compile_definitions(device_identity_tpm2_openssl_shim_test
        PRIVATE LCC_TPM2_OPENSSL_PRODUCTION_TEST=1)
    target_include_directories(device_identity_tpm2_openssl_shim_test
        PRIVATE ${CMAKE_SOURCE_DIR}/src/library/device_identity)
    target_link_libraries(device_identity_tpm2_openssl_shim_test
        PRIVATE licensecc_static Boost::unit_test_framework Boost::system)
    add_test(NAME device_identity_tpm2_openssl_shim
        COMMAND device_identity_tpm2_openssl_shim_test --shim)
    set_tests_properties(device_identity_tpm2_openssl_shim
        PROPERTIES LABELS "security;device_identity;ubuntu_tpm2")

    set(_lcc_tpm2_real_storage_directory
        "${CMAKE_CURRENT_BINARY_DIR}/tpm2-real-keyrefs")
    file(MAKE_DIRECTORY "${_lcc_tpm2_real_storage_directory}")
    if(UNIX)
        execute_process(COMMAND chmod 700 "${_lcc_tpm2_real_storage_directory}"
            RESULT_VARIABLE _lcc_tpm2_chmod_result)
        if(NOT _lcc_tpm2_chmod_result EQUAL 0)
            message(FATAL_ERROR "Unable to set the real TPM2 test directory mode to 0700")
        endif()
        unset(_lcc_tpm2_chmod_result)
    endif()
    add_test(NAME device_identity_tpm2_openssl_real
        COMMAND device_identity_tpm2_openssl_shim_test --real
                "${_lcc_tpm2_real_storage_directory}")
    set_tests_properties(device_identity_tpm2_openssl_real
        PROPERTIES
            LABELS "security;device_identity;ubuntu_tpm2;real_hardware"
            SKIP_RETURN_CODE 77)
    unset(_lcc_tpm2_real_storage_directory)
endif()
