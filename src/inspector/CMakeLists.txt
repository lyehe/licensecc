
ADD_EXECUTABLE(lccinspector inspector.cpp )

target_link_libraries(lccinspector 
     licensecc_static
     Boost::unit_test_framework 
     Boost::filesystem
     Boost::system)

if(LCC_INSTALL_TOOLS)
	install(TARGETS lccinspector RUNTIME DESTINATION bin/${LCC_PROJECT_NAME}
		COMPONENT licensecc_tools)
endif()

if(BUILD_TESTING)
	add_test(NAME test_lccinspector_redaction COMMAND lccinspector --self-test-redaction)
	set_tests_properties(test_lccinspector_redaction PROPERTIES LABELS "security;hardware;platform")
	add_test(NAME test_lccinspector_blackbox_redaction
		COMMAND ${CMAKE_COMMAND}
			"-DLCCINSPECTOR=$<TARGET_FILE:lccinspector>"
			-P "${CMAKE_SOURCE_DIR}/test/lccinspector_redaction_blackbox.cmake")
	set_tests_properties(test_lccinspector_blackbox_redaction PROPERTIES LABELS "security;hardware;platform")
	add_test(NAME test_lccinspector_short_section
		COMMAND ${CMAKE_COMMAND}
			"-DLCCINSPECTOR=$<TARGET_FILE:lccinspector>"
			-P "${CMAKE_SOURCE_DIR}/test/lccinspector_short_section.cmake")
	set_tests_properties(test_lccinspector_short_section PROPERTIES LABELS "security;hardware;platform")
endif()
