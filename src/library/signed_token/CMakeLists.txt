ADD_LIBRARY(signed_token OBJECT
    SignedToken.cpp
)

target_include_directories(signed_token PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../..
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../include
    ${LCC_INCLUDE_DIR}
    ${LCC_PROJECT_INCLUDE_ROOT}
)

target_compile_definitions(signed_token
    PRIVATE
        "LCC_PROJECT_CONFIG_HEADER=\"${LCC_PROJECT_CONFIG_HEADER}\""
        "LCC_PROJECT_PUBLIC_KEY_HEADER=\"${LCC_PROJECT_PUBLIC_KEY_HEADER}\""
)
