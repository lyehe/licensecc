# Performance benchmarks. Dependency-free (std::chrono only) so enabling
# BUILD_BENCHMARKS does not pull in any extra third-party library.
add_executable(benchmark_identify_pc benchmark_identify_pc.cpp)
target_link_libraries(benchmark_identify_pc licensecc::licensecc_static)
