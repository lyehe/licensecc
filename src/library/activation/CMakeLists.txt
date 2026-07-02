ADD_LIBRARY(activation OBJECT
    ActivationRequest.cpp
)

target_include_directories(activation PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../..
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../include
    ${LCC_INCLUDE_DIR}
    ${LCC_PROJECT_INCLUDE_ROOT}
)

target_compile_definitions(activation
    PRIVATE
        "LCC_PROJECT_CONFIG_HEADER=\"${LCC_PROJECT_CONFIG_HEADER}\""
        "LCC_PROJECT_PUBLIC_KEY_HEADER=\"${LCC_PROJECT_PUBLIC_KEY_HEADER}\""
)
