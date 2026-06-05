include(CheckCXXCompilerFlag)

if(MSVC OR NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
	message(FATAL_ERROR "BUILD_FUZZERS requires a Clang/libFuzzer toolchain.")
endif()

check_cxx_compiler_flag("-fsanitize=fuzzer-no-link" LCC_HAS_FUZZER_NO_LINK)
if(NOT LCC_HAS_FUZZER_NO_LINK)
	message(FATAL_ERROR "BUILD_FUZZERS requires -fsanitize=fuzzer-no-link support.")
endif()

set(LCC_FUZZ_COMPILE_OPTIONS
	-fsanitize=fuzzer-no-link,address,undefined
	-fno-omit-frame-pointer
)
set(LCC_FUZZ_LINK_OPTIONS
	-fsanitize=fuzzer,address,undefined
)

set(LCC_FUZZ_GENERATED_LICENSE_CORPUS "${CMAKE_CURRENT_BINARY_DIR}/corpus/license_reader_generated")
add_custom_target(generate_fuzz_license_reader_corpus
	COMMAND ${CMAKE_COMMAND}
		"-DLCC_FUZZ_LCCGEN=$<TARGET_FILE:license_generator::lccgen>"
		"-DLCC_FUZZ_PROJECT_DIR=${LCC_PROJECTS_BASE_DIR}/${LCC_PROJECT_NAME}"
		"-DLCC_FUZZ_PROJECT_NAME=${LCC_PROJECT_NAME}"
		"-DLCC_FUZZ_OUTPUT_DIR=${LCC_FUZZ_GENERATED_LICENSE_CORPUS}"
		-P "${CMAKE_CURRENT_SOURCE_DIR}/GenerateLicenseReaderCorpus.cmake"
	DEPENDS project_initialize
	COMMENT "Generating license-reader fuzz corpus with current project keys"
)

function(lcc_add_fuzzer target source corpus labels)
	add_executable(${target} ${source})
	target_compile_options(${target} PRIVATE ${LCC_FUZZ_COMPILE_OPTIONS})
	target_link_options(${target} PRIVATE ${LCC_FUZZ_LINK_OPTIONS})
	target_compile_definitions(${target}
		PRIVATE
			"LCC_FUZZ_PROJECT_NAME=\"${LCC_PROJECT_NAME}\""
			"LCC_FUZZ_PROJECT_DIR=\"${LCC_PROJECTS_BASE_DIR}/${LCC_PROJECT_NAME}\""
	)
	add_test(
		NAME ${target}_seed
		COMMAND ${target} -runs=0 "${CMAKE_CURRENT_SOURCE_DIR}/corpus/${corpus}"
	)
	set_tests_properties(${target}_seed PROPERTIES LABELS "${labels}" TIMEOUT 120)
endfunction()

lcc_add_fuzzer(fuzz_license_reader fuzz_license_reader.cpp license_reader "security;fuzz;parser")
target_link_libraries(fuzz_license_reader PRIVATE licensecc_static)
add_dependencies(fuzz_license_reader generate_fuzz_license_reader_corpus)
add_test(
	NAME fuzz_license_reader_generated_seed
	COMMAND fuzz_license_reader -runs=0 "${LCC_FUZZ_GENERATED_LICENSE_CORPUS}"
)
set_tests_properties(fuzz_license_reader_generated_seed PROPERTIES LABELS "security;fuzz;parser" TIMEOUT 120)

lcc_add_fuzzer(fuzz_base64 fuzz_base64.cpp base64 "security;fuzz;base64")
target_link_libraries(fuzz_base64 PRIVATE licensecc_static)

lcc_add_fuzzer(fuzz_hw_identifier fuzz_hw_identifier.cpp hw_identifier "security;fuzz;hardware;generator")
target_link_libraries(fuzz_hw_identifier PRIVATE licensecc_static license_generator_lib)

lcc_add_fuzzer(fuzz_v201_canonical_payload fuzz_v201_canonical_payload.cpp v201_canonical_payload
	"security;fuzz;validation;v201")
target_link_libraries(fuzz_v201_canonical_payload PRIVATE licensecc_static)
