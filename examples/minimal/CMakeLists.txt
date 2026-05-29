cmake_minimum_required(VERSION 3.16)
project(licensecc_minimal_example CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Locate a built/installed licensecc. Provide, on the command line:
#   -DCMAKE_PREFIX_PATH=<licensecc install dir>   (or -DLICENSECC_LOCATION=...)
#   -DLCC_PROJECT_NAME=<the project you built licensecc with>
find_package(licensecc REQUIRED)

add_executable(minimal main.cpp)
target_link_libraries(minimal licensecc::licensecc_static)
