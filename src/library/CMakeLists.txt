add_subdirectory("signed_token")
add_subdirectory("base")
add_subdirectory("anti_tamper")
add_subdirectory("online_verification")
add_subdirectory("config_attestation")
add_subdirectory("os")
add_subdirectory("locate")
add_subdirectory("hw_identifier")

foreach(_lcc_generated_metadata_target IN ITEMS signed_token base anti_tamper online_verification config_attestation os locate hw_identifier)
    if(TARGET ${_lcc_generated_metadata_target})
        add_dependencies(${_lcc_generated_metadata_target} project_initialize)
    endif()
endforeach()

ADD_LIBRARY(licensecc_static STATIC
    licensecc.cpp
    LicenseReader.cpp
    limits/license_verifier.cpp
    ini/ConvertUTF.cpp
    $<TARGET_OBJECTS:hw_identifier>
    $<TARGET_OBJECTS:locate>
    $<TARGET_OBJECTS:os>
    $<TARGET_OBJECTS:base>
    $<TARGET_OBJECTS:anti_tamper>
    $<TARGET_OBJECTS:signed_token>
    $<TARGET_OBJECTS:online_verification>
    $<TARGET_OBJECTS:config_attestation>
)

if(CODE_COVERAGE AND UNIX)
	  if(CMAKE_VERSION VERSION_GREATER_EQUAL 3.13)
	    target_link_options(licensecc_static PUBLIC --coverage)
	  endif()
	  list(APPEND EXTERNAL_LIBS gcov)
endif(CODE_COVERAGE AND UNIX)

define_property(TARGET PROPERTY WITH_OPENSSL BRIEF_DOCS "need openssl to compile" FULL_DOCS "ff")
IF(UNIX OR OPENSSL_FOUND)
	target_compile_definitions(licensecc_static PUBLIC HAS_OPENSSL)
	set_target_properties(licensecc_static PROPERTIES WITH_OPENSSL 1)
	target_link_libraries(licensecc_static PUBLIC OpenSSL::Crypto ${EXTERNAL_LIBS} ${CMAKE_DL_LIBS})
ELSE(UNIX OR OPENSSL_FOUND)
	set_target_properties(licensecc_static PROPERTIES WITH_OPENSSL 0)
	target_link_libraries(licensecc_static PUBLIC ${EXTERNAL_LIBS})
ENDIF(UNIX OR OPENSSL_FOUND)

if(WIN32)
	target_link_libraries(licensecc_static PUBLIC bcrypt)
endif()

#set_property(TARGET licensecc_static PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

target_include_directories(licensecc_static
    PUBLIC 
        $<INSTALL_INTERFACE:include>
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/../../include>
        $<BUILD_INTERFACE:${LCC_PROJECT_INCLUDE_ROOT}>
    PRIVATE
        $<BUILD_INTERFACE:${LCC_INCLUDE_DIR}>
)

target_compile_definitions(licensecc_static
    PUBLIC
        "LCC_PROJECT_CONFIG_HEADER=\"${LCC_PROJECT_CONFIG_HEADER}\""
        "LCC_PROJECT_PUBLIC_KEY_HEADER=\"${LCC_PROJECT_PUBLIC_KEY_HEADER}\""
)

if(NOT "${LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS}" STREQUAL "")
    if(TARGET online_verification)
        target_compile_definitions(online_verification
            PRIVATE
                "LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS=${LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS}"
        )
    endif()
    target_compile_definitions(licensecc_static
        PUBLIC
            "LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS=${LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS}"
    )
endif()

if(NOT "${LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS}" STREQUAL "")
    if(TARGET online_verification)
        target_compile_definitions(online_verification
            PRIVATE
                "LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS=${LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS}"
        )
    endif()
    target_compile_definitions(licensecc_static
        PUBLIC
            "LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS=${LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS}"
    )
endif()

if(NOT "${LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS}" STREQUAL "")
    if(TARGET config_attestation)
        target_compile_definitions(config_attestation
            PRIVATE
                "LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS=${LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS}"
        )
    endif()
    target_compile_definitions(licensecc_static
        PUBLIC
            "LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS=${LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS}"
    )
endif()

if(NOT "${LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS}" STREQUAL "")
    if(TARGET config_attestation)
        target_compile_definitions(config_attestation
            PRIVATE
                "LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS=${LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS}"
        )
    endif()
    target_compile_definitions(licensecc_static
        PUBLIC
            "LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS=${LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS}"
    )
endif()

add_library(licensecc::licensecc_static ALIAS licensecc_static)
install(TARGETS licensecc_static EXPORT licensecc
	ARCHIVE DESTINATION ${main_lib_dest}/${LCC_PROJECT_NAME}
	COMPONENT licensecc_runtime)
	
install(EXPORT licensecc NAMESPACE licensecc:: DESTINATION  ${main_lib_dest}/${LCC_PROJECT_NAME}/cmake
	COMPONENT licensecc_runtime)
export(EXPORT licensecc NAMESPACE licensecc:: FILE ${CMAKE_BINARY_DIR}/${PROJECT_NAME}.cmake)
