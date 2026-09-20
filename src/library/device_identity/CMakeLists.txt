set(_lcc_device_identity_sources
    device_identity.cpp
    bound_public.cpp
    bound_public_config.cpp
    bound_public_results.cpp
    feature_session.cpp
    proof_payload.cpp
    bound_protocol.cpp
    bound_encoding.cpp
    bound_signing.cpp
    bound_lease.cpp
    bound_checkpoint.cpp
    bound_checkpoint_store.cpp
    bound_anchor.cpp
    bound_anchor_platform.cpp
    bound_possession.cpp
    bound_session.cpp
    bound_json.cpp
    bound_wire.cpp
    bound_http.cpp
    bound_client.cpp
    bound_enrollment.cpp
    bound_callback.cpp
    spki.cpp)

if(WIN32)
    list(APPEND _lcc_device_identity_sources p256_crypto_windows.cpp bound_http_windows.cpp bound_loopback_windows.cpp bound_browser_windows.cpp bound_desktop.cpp
        bound_checkpoint_directory.cpp bound_checkpoint_windows.cpp)
else()
    list(APPEND _lcc_device_identity_sources p256_crypto_openssl.cpp)
endif()

if(LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER)
    list(APPEND _lcc_device_identity_sources providers/software_test.cpp)
endif()

if(LCC_ENABLE_WINDOWS_TPM)
    list(APPEND _lcc_device_identity_sources providers/windows_tpm.cpp)
endif()

if(LCC_ENABLE_TPM2_OPENSSL)
    list(APPEND _lcc_device_identity_sources providers/tpm2_openssl.cpp)
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
    target_link_libraries(device_identity PRIVATE bcrypt winhttp ws2_32 shell32 ole32 advapi32)
    if(LCC_ENABLE_WINDOWS_TPM)
        target_link_libraries(device_identity PRIVATE ncrypt)
    endif()
else()
    target_link_libraries(device_identity PRIVATE OpenSSL::Crypto)
endif()

unset(_lcc_device_identity_sources)
