cmake_minimum_required(VERSION 3.16)
project(licensecc_anti_tamper_host_example CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT TARGET licensecc::licensecc_static)
  find_package(licensecc REQUIRED COMPONENTS ${LCC_PROJECT_NAME})
endif()

add_executable(anti_tamper_host main.cpp)
target_link_libraries(anti_tamper_host PRIVATE licensecc::licensecc_static)
