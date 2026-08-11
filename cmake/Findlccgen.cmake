#[=======================================================================[.rst:
Findlccgen
----------

Resolve the lccgen executable without changing the source checkout. The
bundled generator is vendored source, so this module never fetches, initializes,
or updates it.

Input variables
^^^^^^^^^^^^^^^

``LCC_LOCATION``
  An explicit lccgen executable, installation prefix, or directory containing
  its CMake package configuration.  When supplied, no other location is used.

Imported targets
^^^^^^^^^^^^^^^^

``license_generator::lccgen``
  The generator command used by the project's public-header build rule.

``license_generator::test_support`` (optional)
  A generator development-package target that exposes the private signing
  support required by the C++ generator-coupled tests.  The bundled checkout's
  legacy ``license_generator_lib`` target is recognized as the same capability.

Result variables
^^^^^^^^^^^^^^^^

``LCCGEN_TEST_SUPPORT_TARGET``
  The target to link generator-coupled tests against, or empty when the
  selected generator provides only its executable.

``LCCGEN_TEST_SUPPORT_AVAILABLE``
  True when ``LCCGEN_TEST_SUPPORT_TARGET`` is available.
#]=======================================================================]

set(_lccgen_failure_message
	"Unable to locate lccgen. Restore the vendored extern/license-generator source, or configure with -DLCC_LOCATION=<lccgen executable or installation prefix>.")
set(LCCGEN_TEST_SUPPORT_TARGET "")
set(LCCGEN_TEST_SUPPORT_AVAILABLE FALSE)

function(_lccgen_add_imported_target executable_path)
	if(NOT TARGET license_generator::lccgen)
		add_executable(license_generator::lccgen IMPORTED GLOBAL)
		set_property(TARGET license_generator::lccgen PROPERTY IMPORTED_LOCATION "${executable_path}")
	endif()
endfunction()

function(_lccgen_require_target)
	if(NOT TARGET license_generator::lccgen)
		message(FATAL_ERROR "${_lccgen_failure_message}")
	endif()
	set(lccgen_FOUND TRUE PARENT_SCOPE)
	set(LCC_FOUND TRUE PARENT_SCOPE)
endfunction()

if(LCC_LOCATION)
	get_filename_component(_lccgen_explicit_location "${LCC_LOCATION}" ABSOLUTE)
	if(IS_DIRECTORY "${_lccgen_explicit_location}")
		# CONFIG mode prevents this module from recursively finding itself.
		find_package(lccgen CONFIG QUIET NO_DEFAULT_PATH
			PATHS "${_lccgen_explicit_location}"
			PATH_SUFFIXES "cmake" "lib/cmake/lccgen")
		if(NOT TARGET license_generator::lccgen)
			unset(_lccgen_explicit_program CACHE)
			find_program(_lccgen_explicit_program
				NAMES lccgen lccgen.exe
				NO_DEFAULT_PATH
				HINTS "${_lccgen_explicit_location}"
				PATH_SUFFIXES "bin")
			if(_lccgen_explicit_program)
				_lccgen_add_imported_target("${_lccgen_explicit_program}")
			endif()
		endif()
	elseif(EXISTS "${_lccgen_explicit_location}")
		_lccgen_add_imported_target("${_lccgen_explicit_location}")
	endif()
	_lccgen_require_target()
else()
	if(EXISTS "${CMAKE_SOURCE_DIR}/extern/license-generator/CMakeLists.txt")
		# The repository owns this source tree; configure it in the build tree.
		add_subdirectory(
			"${CMAKE_SOURCE_DIR}/extern/license-generator"
			"${CMAKE_BINARY_DIR}/extern/license-generator")
	else()
		# A configured installation is a valid alternative when no pinned source
		# checkout is present.  CONFIG mode prevents recursive module lookup.
		find_package(lccgen CONFIG QUIET)
		if(NOT TARGET license_generator::lccgen)
			unset(_lccgen_installed_program CACHE)
			find_program(_lccgen_installed_program NAMES lccgen lccgen.exe)
			if(_lccgen_installed_program)
				_lccgen_add_imported_target("${_lccgen_installed_program}")
			endif()
		endif()
	endif()
	_lccgen_require_target()
endif()

# A raw executable is sufficient for production public-header generation, but
# the C++ signing tests use CryptoHelper from the generator's private library.
# Keep that capability explicit so CMake never turns a missing target into a
# late, toolchain-specific bare library link such as license_generator_lib.lib.
if(TARGET license_generator::test_support)
	set(LCCGEN_TEST_SUPPORT_TARGET "license_generator::test_support")
elseif(TARGET license_generator_lib)
	set(LCCGEN_TEST_SUPPORT_TARGET "license_generator_lib")
endif()
if(LCCGEN_TEST_SUPPORT_TARGET)
	set(LCCGEN_TEST_SUPPORT_AVAILABLE TRUE)
endif()

unset(_lccgen_explicit_location)
unset(_lccgen_explicit_program)
unset(_lccgen_installed_program)
