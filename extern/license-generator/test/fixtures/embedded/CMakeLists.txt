cmake_minimum_required(VERSION 3.6)
project(lccgen_embedded_fixture LANGUAGES CXX)

if(NOT DEFINED LCCGEN_SOURCE_DIR)
  message(FATAL_ERROR "LCCGEN_SOURCE_DIR must name the generator source directory")
endif()

# Do not set LCCGEN_INSTALL here: this fixture verifies the embedded default.
add_subdirectory("${LCCGEN_SOURCE_DIR}" lccgen)

if(LCCGEN_INSTALL)
  message(FATAL_ERROR "Embedded lccgen must default LCCGEN_INSTALL to OFF")
endif()
