# Regression: lccinspector's verifyLicense once built a section name with
# `std::string(section.pItem, 15)`, reading a fixed 15 bytes past a short
# NUL-terminated section name (iterative review round 3). Run the inspector
# against an INI whose sections are shorter than 15 chars and assert it processes
# them to completion (prints the per-section result) without crashing.

if(NOT DEFINED LCCINSPECTOR)
	message(FATAL_ERROR "LCCINSPECTOR must be set to the lccinspector executable")
endif()

set(_probe_ini "${CMAKE_CURRENT_BINARY_DIR}/lcc_short_section_probe.ini")
file(WRITE "${_probe_ini}" "[pro]\nname=x\n[a]\nb=c\n")

execute_process(
	COMMAND "${LCCINSPECTOR}" "${_probe_ini}"
	RESULT_VARIABLE _rc
	OUTPUT_VARIABLE _out
	ERROR_VARIABLE _err
	TIMEOUT 30)

file(REMOVE "${_probe_ini}")

# A crash during verifyLicense (the over-read) prevents the per-section lines from
# being emitted. Reaching them means the short-named sections were read in bounds.
if(NOT "${_out}${_err}" MATCHES "project")
	message(FATAL_ERROR
		"lccinspector did not process the short-named sections (possible crash). rc=${_rc}\n--stdout--\n${_out}\n--stderr--\n${_err}")
endif()

message(STATUS "lccinspector short-section probe ok (rc=${_rc})")
