ADD_LIBRARY(config_attestation OBJECT
    ConfigAttestation.cpp
)

target_include_directories(config_attestation PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../..
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../include
    ${LCC_INCLUDE_DIR}
    ${LCC_PROJECT_INCLUDE_ROOT}
)

target_compile_definitions(config_attestation
    PRIVATE
        "LCC_PROJECT_CONFIG_HEADER=\"${LCC_PROJECT_CONFIG_HEADER}\""
        "LCC_PROJECT_PUBLIC_KEY_HEADER=\"${LCC_PROJECT_PUBLIC_KEY_HEADER}\""
)
