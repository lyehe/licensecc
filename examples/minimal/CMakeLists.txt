cmake_minimum_required(VERSION 3.16)
project(licensecc_minimal_example CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Locate a built/installed licensecc. Provide, on the command line:
#   -DCMAKE_PREFIX_PATH=<licensecc install dir>
#   -DLCC_PROJECT_NAME=<the project you built licensecc with>
find_package(licensecc REQUIRED COMPONENTS ${LCC_PROJECT_NAME})

add_executable(minimal main.cpp)
target_link_libraries(minimal licensecc::licensecc_static)
