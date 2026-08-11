set(_lcc_device_identity_sources
    device_identity.cpp
    proof_payload.cpp
    spki.cpp)

if(WIN32)
    list(APPEND _lcc_device_identity_sources p256_crypto_windows.cpp)
else()
    list(APPEND _lcc_device_identity_sources p256_crypto_openssl.cpp)
endif()

if(LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER)
    list(APPEND _lcc_device_identity_sources providers/software_test.cpp)
endif()

add_library(device_identity OBJECT ${_lcc_device_identity_sources})
add_dependencies(device_identity project_public_header)
target_include_directories(device_identity
    PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${LCC_PROJECT_INCLUDE_ROOT}
        ${LCC_INCLUDE_DIR})
target_compile_definitions(device_identity
    PRIVATE
        LCC_ENABLE_WINDOWS_TPM=$<BOOL:${LCC_ENABLE_WINDOWS_TPM}>
        LCC_ENABLE_TPM2_OPENSSL=$<BOOL:${LCC_ENABLE_TPM2_OPENSSL}>
        LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER=$<BOOL:${LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER}>)

if(WIN32)
    target_link_libraries(device_identity PRIVATE bcrypt)
else()
    target_link_libraries(device_identity PRIVATE OpenSSL::Crypto)
endif()

unset(_lcc_device_identity_sources)
