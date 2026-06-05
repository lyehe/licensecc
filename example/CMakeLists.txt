cmake_minimum_required(VERSION 3.16)
project(licensecc_workflow_example CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT LCC_PROJECT_NAME)
	message(FATAL_ERROR "Configure with -DLCC_PROJECT_NAME=<installed licensecc project>")
endif()

find_package(licensecc REQUIRED COMPONENTS ${LCC_PROJECT_NAME})

add_executable(licensecc_workflow main.cpp)
target_link_libraries(licensecc_workflow PRIVATE licensecc::licensecc_static)
