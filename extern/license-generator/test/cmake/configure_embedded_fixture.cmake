if(NOT DEFINED LCCGEN_SOURCE_DIR OR NOT DEFINED LCCGEN_EMBEDDED_FIXTURE_DIR OR
   NOT DEFINED LCCGEN_EMBEDDED_BINARY_DIR OR NOT DEFINED LCCGEN_EMBEDDED_BINARY_ROOT)
  message(FATAL_ERROR "LCCGEN_SOURCE_DIR, LCCGEN_EMBEDDED_FIXTURE_DIR, LCCGEN_EMBEDDED_BINARY_DIR, and LCCGEN_EMBEDDED_BINARY_ROOT are required")
endif()

get_filename_component(_embedded_binary_root "${LCCGEN_EMBEDDED_BINARY_ROOT}" ABSOLUTE)
get_filename_component(_embedded_binary_dir "${LCCGEN_EMBEDDED_BINARY_DIR}" ABSOLUTE)
file(RELATIVE_PATH _embedded_binary_relative "${_embedded_binary_root}" "${_embedded_binary_dir}")
if(_embedded_binary_relative STREQUAL "" OR _embedded_binary_relative MATCHES "^\\.\\." OR
   IS_ABSOLUTE "${_embedded_binary_relative}")
  message(FATAL_ERROR "Embedded fixture binary directory must be a child of its declared binary root: ${_embedded_binary_dir}")
endif()

# A clean, hash-isolated binary tree prevents a stale CMake cache from making
# this embedded-configure probe pass accidentally. The guard above confines
# cleanup to the top-level binary tree selected by the enclosing build.
file(REMOVE_RECURSE "${_embedded_binary_dir}")
execute_process(
	COMMAND "${CMAKE_COMMAND}" -S "${LCCGEN_EMBEDDED_FIXTURE_DIR}" -B "${_embedded_binary_dir}"
			"-DLCCGEN_SOURCE_DIR=${LCCGEN_SOURCE_DIR}" -DBUILD_TESTING=OFF
	RESULT_VARIABLE configure_result
	OUTPUT_VARIABLE configure_stdout
	ERROR_VARIABLE configure_stderr)
file(REMOVE_RECURSE "${_embedded_binary_dir}")
if(NOT configure_result EQUAL 0)
	message(FATAL_ERROR "Embedded lccgen configure failed:\n${configure_stdout}\n${configure_stderr}")
endif()
