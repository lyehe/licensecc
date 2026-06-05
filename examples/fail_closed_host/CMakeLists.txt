cmake_minimum_required(VERSION 3.16)
project(licensecc_fail_closed_host_example CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(licensecc REQUIRED COMPONENTS ${LCC_PROJECT_NAME})

add_executable(fail_closed_host main.cpp)
target_link_libraries(fail_closed_host PRIVATE licensecc::licensecc_static)
