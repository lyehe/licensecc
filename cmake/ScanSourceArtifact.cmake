if(NOT DEFINED LCC_SOURCE_ARTIFACT_SCAN_ROOT OR "${LCC_SOURCE_ARTIFACT_SCAN_ROOT}" STREQUAL "")
	message(FATAL_ERROR "LCC_SOURCE_ARTIFACT_SCAN_ROOT is required")
endif()

get_filename_component(LCC_SOURCE_ARTIFACT_SCAN_ROOT "${LCC_SOURCE_ARTIFACT_SCAN_ROOT}" ABSOLUTE)
if(NOT EXISTS "${LCC_SOURCE_ARTIFACT_SCAN_ROOT}")
	message(FATAL_ERROR "Source artifact scan root does not exist: ${LCC_SOURCE_ARTIFACT_SCAN_ROOT}")
endif()

file(GLOB_RECURSE _lcc_source_artifact_paths
	LIST_DIRECTORIES true
	"${LCC_SOURCE_ARTIFACT_SCAN_ROOT}/*")
set(_lcc_source_artifact_violations)

set(_lcc_private_key_suffix "PRIVATE KEY")
set(_lcc_private_key_marker_regex "BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?${_lcc_private_key_suffix}|BEGIN ${_lcc_private_key_suffix}")
file(TO_CMAKE_PATH "${LCC_SOURCE_ARTIFACT_SCAN_ROOT}" _lcc_source_root_cmake)

function(_lcc_source_path_is_key_like out_var name_lower rel_path_lower)
	set(_is_key_like OFF)
	if(name_lower STREQUAL "private_key.rsa" OR
	   name_lower STREQUAL "id_rsa" OR
	   name_lower STREQUAL "id_dsa" OR
	   name_lower STREQUAL "id_ecdsa" OR
	   name_lower STREQUAL "id_ed25519" OR
	   name_lower MATCHES ".*\\.(pem|key|p12|pfx|der|p8|pk8|pkcs8|jwk|secret)$" OR
	   rel_path_lower MATCHES "(^|/)[^/]*signing[^/]*$")
		set(_is_key_like ON)
	endif()
	set(${out_var} "${_is_key_like}" PARENT_SCOPE)
endfunction()

foreach(_path IN LISTS _lcc_source_artifact_paths)
	get_filename_component(_path_abs "${_path}" ABSOLUTE)
	file(TO_CMAKE_PATH "${_path_abs}" _path_abs_cmake)
	string(FIND "${_path_abs_cmake}/" "${_lcc_source_root_cmake}/" _under_root)
	if(NOT _under_root EQUAL 0)
		list(APPEND _lcc_source_artifact_violations "path escapes source artifact root: ${_path}")
	endif()

	file(RELATIVE_PATH _rel_path "${LCC_SOURCE_ARTIFACT_SCAN_ROOT}" "${_path}")
	file(TO_CMAKE_PATH "${_rel_path}" _rel_path_cmake)
	string(TOLOWER "${_rel_path_cmake}" _rel_path_lower)
	get_filename_component(_name "${_path}" NAME)
	string(TOLOWER "${_name}" _name_lower)

	if(IS_SYMLINK "${_path}")
		list(APPEND _lcc_source_artifact_violations "symlink or reparse-point-like path present: ${_rel_path_cmake}")
	endif()

	if(_rel_path_lower MATCHES "(^|/)\\.git($|/)" OR
	   _rel_path_lower MATCHES "(^|/)\\.svn($|/)" OR
	   _rel_path_lower MATCHES "(^|/)\\.hg($|/)" OR
	   _rel_path_lower MATCHES "(^|/)\\.bzr($|/)" OR
	   _rel_path_lower MATCHES "(^|/)cvs($|/)")
		list(APPEND _lcc_source_artifact_violations "VCS metadata present: ${_rel_path_cmake}")
	endif()

	if(_rel_path_lower MATCHES "^build[^/]*($|/)" OR
	   _rel_path_lower MATCHES "(^|/)(install|dist|node_modules|\\.wrangler|projects|testing|_cpack_packages|cmakefiles)($|/)" OR
	   _name_lower STREQUAL "cmakecache.txt" OR
	   _name_lower STREQUAL "cpackconfig.cmake" OR
	   _name_lower STREQUAL "cpacksourceconfig.cmake")
		list(APPEND _lcc_source_artifact_violations "local build or staging output present: ${_rel_path_cmake}")
	endif()

	if(NOT IS_DIRECTORY "${_path}" AND NOT IS_SYMLINK "${_path}")
		_lcc_source_path_is_key_like(_lcc_key_like "${_name_lower}" "${_rel_path_lower}")
		if(_lcc_key_like)
			list(APPEND _lcc_source_artifact_violations "forbidden key-like file: ${_rel_path_cmake}")
		endif()

		file(STRINGS "${_path}" _private_key_markers
			REGEX "${_lcc_private_key_marker_regex}"
			LIMIT_COUNT 1)
		if(_private_key_markers)
			list(APPEND _lcc_source_artifact_violations "private-key marker present in file content: ${_rel_path_cmake}")
		endif()
	endif()
endforeach()

if(_lcc_source_artifact_violations)
	string(REPLACE ";" "\n  " _lcc_source_artifact_report "${_lcc_source_artifact_violations}")
	message(FATAL_ERROR "Source artifact scan failed under ${LCC_SOURCE_ARTIFACT_SCAN_ROOT}:\n  ${_lcc_source_artifact_report}")
endif()
