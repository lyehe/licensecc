cmake_minimum_required(VERSION 3.21 FATAL_ERROR)
project(licensecc_windows_tpm_example LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(LCC_PROJECT_NAME "test" CACHE STRING "Installed Licensecc project component")
find_package(licensecc CONFIG REQUIRED)

if(NOT TARGET licensecc::licensecc_static)
    message(FATAL_ERROR "The installed package did not export licensecc::licensecc_static")
endif()
if(NOT LCC_ENABLE_DEVICE_IDENTITY OR NOT LCC_ENABLE_WINDOWS_TPM)
    message(FATAL_ERROR "This example requires an installed package built with LCC_ENABLE_WINDOWS_TPM=ON")
endif()

add_executable(licensecc_windows_tpm windows_tpm.cpp)
target_link_libraries(licensecc_windows_tpm PRIVATE licensecc::licensecc_static)
