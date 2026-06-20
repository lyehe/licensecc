if(POLICY CMP0057)
	cmake_policy(SET CMP0057 NEW)
endif()

if(NOT DEFINED LICENSECC_CTEST_COMMAND OR LICENSECC_CTEST_COMMAND STREQUAL "")
	message(FATAL_ERROR "LICENSECC_CTEST_COMMAND is required")
endif()
if(NOT DEFINED LICENSECC_BUILD_DIR OR LICENSECC_BUILD_DIR STREQUAL "")
	message(FATAL_ERROR "LICENSECC_BUILD_DIR is required")
endif()

set(_lcc_ctest_config_args)
if(DEFINED LICENSECC_CONFIG AND NOT LICENSECC_CONFIG STREQUAL "")
	list(APPEND _lcc_ctest_config_args -C "${LICENSECC_CONFIG}")
endif()

function(lcc_capture_label label out_var)
	execute_process(
		COMMAND "${LICENSECC_CTEST_COMMAND}" ${_lcc_ctest_config_args} -N -L "${label}"
		WORKING_DIRECTORY "${LICENSECC_BUILD_DIR}"
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _output
		ERROR_VARIABLE _error
	)
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR "ctest label query failed for '${label}': ${_error}")
	endif()
	string(REPLACE "\r\n" "\n" _output "${_output}")
	string(REPLACE "\r" "\n" _output "${_output}")
	set(${out_var} "${_output}" PARENT_SCOPE)
endfunction()

function(lcc_capture_all_tests out_var)
	execute_process(
		COMMAND "${LICENSECC_CTEST_COMMAND}" ${_lcc_ctest_config_args} -N
		WORKING_DIRECTORY "${LICENSECC_BUILD_DIR}"
		RESULT_VARIABLE _result
		OUTPUT_VARIABLE _output
		ERROR_VARIABLE _error
	)
	if(NOT _result EQUAL 0)
		message(FATAL_ERROR "ctest test discovery failed: ${_error}")
	endif()
	string(REPLACE "\r\n" "\n" _output "${_output}")
	string(REPLACE "\r" "\n" _output "${_output}")
	set(${out_var} "${_output}" PARENT_SCOPE)
endfunction()

function(lcc_assert_label_has_test label test_name)
	string(MAKE_C_IDENTIFIER "${label}" _label_id)
	set(_output "${LABEL_OUTPUT_${_label_id}}")
	string(FIND "${_output}" ": ${test_name}\n" _found)
	if(_found EQUAL -1)
		message(FATAL_ERROR "CTest label '${label}' does not include expected test '${test_name}'")
	endif()
endfunction()

set(_required_labels
	security
	parser
	base64
	signature
	public_api
	anti_tamper
	online
	generator
	package
	install
	platform
	hardware
	validation
	verifier
	v201
	config_attestation
)

if(LICENSECC_BUILD_FUZZERS)
	list(APPEND _required_labels fuzz)
endif()

foreach(_label IN LISTS _required_labels)
	string(MAKE_C_IDENTIFIER "${_label}" _label_id)
	lcc_capture_label("${_label}" "LABEL_OUTPUT_${_label_id}")
	string(FIND "${LABEL_OUTPUT_${_label_id}}" "Total Tests: 0" _no_tests)
	if(NOT _no_tests EQUAL -1)
		message(FATAL_ERROR "CTest label '${_label}' has no tests")
	endif()
endforeach()

set(_expected_label_entries
	"test_license|security,generator,signature"
	"test_command-line|security,generator"
	"test_project|security,generator"
	"test_cryptohelper|security,generator,signature,base64"
	"test_generator_v201_canonical_payload|security,generator,validation,v201"
	"test_install_consumer_smoke|security,install,public_api,validation"
	"test_package_consumer_smoke|security,install,package,public_api,validation"
	"test_release_safety_smoke|security,validation,generator"
	"test_artifact_scan_smoke|security,validation,package"
	"test_tools_profile_smoke|security,validation,package"
	"test_source_package_smoke|security,validation,package"
	"test_manifest_summary_smoke|security,validation,package"
	"test_ctest_label_audit|security,validation"
	"test_license_reader|security,parser"
	"test_license_locator|security,parser,base64,public_api"
	"test_base64|security,base64"
	"test_v201_canonical_payload|security,validation,v201"
	"test_event_registry|security,validation"
	"test_license_verifier|security,verifier"
	"test_public_api|security,public_api"
	"test_anti_tamper|security,public_api,anti_tamper"
	"test_online_verification|security,public_api,online"
	"test_online_callback_failover|security,public_api,online"
	"test_config_attestation|security,config_attestation"
	"test_config_public_api|security,public_api,config_attestation"
	"test_network|security,platform,hardware"
	"test_execution_environment|security,platform"
	"test_hw_identifier|security,hardware"
	"test_hw_identifier_facade|security,hardware,public_api"
	"test_crack|security,parser,signature,public_api"
	"test_date|security,parser,verifier"
	"test_it_hw_identifier|security,hardware,generator"
	"test_standard_license|security,signature,generator"
	"test_signature_verifier|security,signature"
)

if(LICENSECC_BUILD_FUZZERS)
	list(APPEND _expected_label_entries
		"fuzz_license_reader_seed|security,fuzz,parser"
		"fuzz_license_reader_generated_seed|security,fuzz,parser"
		"fuzz_base64_seed|security,fuzz,base64"
		"fuzz_hw_identifier_seed|security,fuzz,hardware,generator"
		"fuzz_v201_canonical_payload_seed|security,fuzz,validation,v201"
	)
endif()

if(LICENSECC_BUILD_INSPECTOR)
	list(APPEND _expected_label_entries
		"test_lccinspector_redaction|security,hardware,platform"
		"test_lccinspector_blackbox_redaction|security,hardware,platform"
		"test_lccinspector_short_section|security,hardware,platform"
	)
endif()

if(LICENSECC_IS_WINDOWS)
	list(APPEND _expected_label_entries
		"test_windows_disk_info|security,platform,hardware"
		"test_smbios|security,platform,hardware"
	)
else()
	list(APPEND _expected_label_entries
		"test_os_linux|security,platform,hardware"
	)
endif()

if(LICENSECC_HAS_DMI_TEST)
	list(APPEND _expected_label_entries
		"test_dmi_info|security,platform,hardware"
	)
endif()

foreach(_entry IN LISTS _expected_label_entries)
	string(REPLACE "|" ";" _parts "${_entry}")
	list(GET _parts 0 _test_name)
	list(GET _parts 1 _label_csv)
	string(REPLACE "," ";" _labels "${_label_csv}")
	foreach(_label IN LISTS _labels)
		lcc_assert_label_has_test("${_label}" "${_test_name}")
	endforeach()
endforeach()

lcc_capture_all_tests(_all_test_output)
string(REGEX MATCHALL "\n[ \t]*Test[ \t]+#[0-9]+:[ \t]+[^\n]+" _all_test_lines "${_all_test_output}")

set(_discovered_tests)
foreach(_line IN LISTS _all_test_lines)
	string(REGEX REPLACE "^.*:[ \t]*([^ \t\n]+).*$" "\\1" _test_name "${_line}")
	list(APPEND _discovered_tests "${_test_name}")
endforeach()
list(SORT _discovered_tests)

set(_expected_tests)
foreach(_entry IN LISTS _expected_label_entries)
	string(REPLACE "|" ";" _parts "${_entry}")
	list(GET _parts 0 _test_name)
	list(APPEND _expected_tests "${_test_name}")
endforeach()
list(SORT _expected_tests)

foreach(_test_name IN LISTS _discovered_tests)
	if(NOT _test_name IN_LIST _expected_tests)
		message(FATAL_ERROR "CTest test '${_test_name}' is missing from the label audit")
	endif()
endforeach()

foreach(_test_name IN LISTS _expected_tests)
	if(NOT _test_name IN_LIST _discovered_tests)
		message(FATAL_ERROR "Label audit expects missing CTest test '${_test_name}'")
	endif()
endforeach()

message(STATUS "CTest label audit passed")
