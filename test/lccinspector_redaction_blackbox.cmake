if(NOT DEFINED LCCINSPECTOR)
	message(FATAL_ERROR "LCCINSPECTOR must point to the lccinspector executable")
endif()

execute_process(
	COMMAND "${LCCINSPECTOR}"
	RESULT_VARIABLE _default_result
	OUTPUT_VARIABLE _default_output
	ERROR_VARIABLE _default_error
)
if(NOT _default_result EQUAL 0)
	message(FATAL_ERROR "lccinspector default run failed: ${_default_error}")
endif()

execute_process(
	COMMAND "${LCCINSPECTOR}" --raw-hardware-identifiers
	RESULT_VARIABLE _raw_result
	OUTPUT_VARIABLE _raw_output
	ERROR_VARIABLE _raw_error
)
if(NOT _raw_result EQUAL 0)
	message(FATAL_ERROR "lccinspector raw diagnostic run failed: ${_raw_error}")
endif()

function(_assert_default_output_omits pattern description)
	if("${_default_output}" MATCHES "${pattern}")
		message(FATAL_ERROR "lccinspector default output leaked ${description}:\n${_default_output}")
	endif()
endfunction()

_assert_default_output_omits("(DEFAULT|MAC|IP|Disk):[A-Za-z0-9+/]{4}-[A-Za-z0-9+/]{4}-[A-Za-z0-9+/=]{4}"
	"raw generated hardware identifier")
_assert_default_output_omits("ip address \\[[0-9]{1,3}-[0-9]{1,3}-[0-9]{1,3}-[0-9]{1,3}\\]"
	"raw IPv4 address")
_assert_default_output_omits("mac address \\[[0-9A-Fa-f]{1,2}(:[0-9A-Fa-f]{1,2}){5}\\]"
	"raw MAC address")
_assert_default_output_omits("Network adapter \\[[^]]*\\]: [^<\r\n]"
	"raw network adapter description")

foreach(_field
	"Cpu Vendor"
	"Cpu Brand"
	"Cpu hypervisor"
	"Cpu model"
	"Bios vendor"
	"Bios description"
	"System vendor"
	"Cpu Vendor \\(dmi\\)"
	"Cpu Cores  \\(dmi\\)"
)
	_assert_default_output_omits("${_field}[ ]*:[^<\r\n]" "raw ${_field} field")
endforeach()

if(NOT "${_default_output}" MATCHES "<redacted>")
	message(FATAL_ERROR "lccinspector default output did not contain redaction markers:\n${_default_output}")
endif()

if("${_raw_output}" STREQUAL "${_default_output}")
	message(FATAL_ERROR "lccinspector raw diagnostic mode did not change output")
endif()

if("${_raw_output}" MATCHES "<redacted>")
	message(FATAL_ERROR "lccinspector raw diagnostic output still contains redaction markers:\n${_raw_output}")
endif()
