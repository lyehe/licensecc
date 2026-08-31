function(lcc_add_parser_fuzzer target source)
	add_executable(${target} ${source})
	target_compile_features(${target} PRIVATE cxx_std_17)
	target_include_directories(${target} PRIVATE "${PROJECT_SOURCE_DIR}/src/library")
	target_link_libraries(${target} PRIVATE licensecc_static)
	target_link_options(${target} PRIVATE -fsanitize=fuzzer)
	set_target_properties(${target} PROPERTIES
		RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/fuzz")
endfunction()

lcc_add_parser_fuzzer(fuzz_activation_request activation_request_fuzzer.cpp)
lcc_add_parser_fuzzer(fuzz_online_assertion online_assertion_fuzzer.cpp)
