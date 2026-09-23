cmake_minimum_required(VERSION 3.21 FATAL_ERROR)
project(licensecc_java_device_bound LANGUAGES CXX)
set(LCC_PROJECT_NAME "test" CACHE STRING "Installed Licensecc project component")
find_package(licensecc CONFIG REQUIRED)
# LCC_ENABLE_LINUX_DESKTOP defaults ON only when the installed package was built
# with LCC_ENABLE_TPM2_OPENSSL=ON, and needs libcurl >= 7.85.
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8 OR NOT LCC_ENABLE_DEVICE_IDENTITY OR
   (WIN32 AND (NOT MSVC OR NOT LCC_ENABLE_WINDOWS_TPM)) OR
   (CMAKE_SYSTEM_NAME STREQUAL "Linux" AND (NOT LCC_ENABLE_TPM2_OPENSSL OR NOT LCC_ENABLE_LINUX_DESKTOP)) OR
   (NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "Linux"))
    message(FATAL_ERROR "The bridge requires an installed 64-bit Windows/MSVC or Linux TPM package")
endif()
# Only headers are needed: this is loaded by the JVM and must not link a JVM DLL.
find_path(LCC_JNI_INCLUDE jni.h PATHS "$ENV{JAVA_HOME}/include" NO_DEFAULT_PATH REQUIRED)
if(WIN32)
    set(jni_platform win32)
else()
    set(jni_platform linux)
endif()
find_path(LCC_JNI_PLATFORM_INCLUDE jni_md.h PATHS "$ENV{JAVA_HOME}/include/${jni_platform}" NO_DEFAULT_PATH REQUIRED)
add_library(licensecc_device_bound_jni SHARED bridge.cpp)
target_compile_features(licensecc_device_bound_jni PRIVATE cxx_std_17)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/jni.map" "{ global: Java_io_licensecc_client_*; local: *; };\n")
    target_link_options(licensecc_device_bound_jni PRIVATE "LINKER:--version-script=${CMAKE_CURRENT_BINARY_DIR}/jni.map")
endif()
target_include_directories(licensecc_device_bound_jni PRIVATE "${LCC_JNI_INCLUDE}" "${LCC_JNI_PLATFORM_INCLUDE}")
target_link_libraries(licensecc_device_bound_jni PRIVATE licensecc::licensecc_static)
set_target_properties(licensecc_device_bound_jni PROPERTIES WINDOWS_EXPORT_ALL_SYMBOLS OFF)
install(TARGETS licensecc_device_bound_jni RUNTIME DESTINATION bin LIBRARY DESTINATION lib)
option(LCC_JNI_BUILD_TESTS "Build test-only incompatible JNI library" OFF)
if(LCC_JNI_BUILD_TESTS)
    add_library(licensecc_device_bound_jni_bad SHARED test/bad_version.cpp)
    target_include_directories(licensecc_device_bound_jni_bad PRIVATE "${LCC_JNI_INCLUDE}" "${LCC_JNI_PLATFORM_INCLUDE}")
    add_library(licensecc_device_bound_jni_fixture SHARED bridge.cpp test/fake_runtime.cpp)
    target_compile_features(licensecc_device_bound_jni_fixture PRIVATE cxx_std_17)
    target_compile_definitions(licensecc_device_bound_jni_fixture PRIVATE LCC_JNI_TEST_FIXTURE
        "$<TARGET_PROPERTY:licensecc::licensecc_static,INTERFACE_COMPILE_DEFINITIONS>")
    target_include_directories(licensecc_device_bound_jni_fixture PRIVATE "${LCC_JNI_INCLUDE}" "${LCC_JNI_PLATFORM_INCLUDE}"
        "$<TARGET_PROPERTY:licensecc::licensecc_static,INTERFACE_INCLUDE_DIRECTORIES>")
endif()
