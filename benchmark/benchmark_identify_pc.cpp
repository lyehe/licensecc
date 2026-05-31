// Dependency-free latency benchmark for the hardware-identification hot path.
//
// identify_pc() enumerates disks / NICs / execution environment on every call;
// the performance plan flags this as one of the biggest avoidable costs and a
// prime caching target. This benchmark establishes a baseline so any future
// caching work can be measured rather than guessed.
//
// Build with -DBUILD_BENCHMARKS=ON, then run ./benchmark/benchmark_identify_pc.
#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdio>
#include <vector>

#include <licensecc/licensecc.h>

namespace {

struct Stats {
	double median_us;
	double min_us;
	double max_us;
};

Stats measure(LCC_API_HW_IDENTIFICATION_STRATEGY strategy, int iterations) {
	char buffer[256];
	size_t buf_size = sizeof(buffer);
	// warm up (first call may pay one-off OS costs)
	identify_pc(strategy, buffer, &buf_size, nullptr);

	std::vector<double> samples;
	samples.reserve(iterations);
	for (int i = 0; i < iterations; ++i) {
		buf_size = sizeof(buffer);
		const auto t0 = std::chrono::steady_clock::now();
		identify_pc(strategy, buffer, &buf_size, nullptr);
		const auto t1 = std::chrono::steady_clock::now();
		samples.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count());
	}
	std::sort(samples.begin(), samples.end());
	return Stats{samples[samples.size() / 2], samples.front(), samples.back()};
}

}  // namespace

int main() {
	const struct {
		LCC_API_HW_IDENTIFICATION_STRATEGY strategy;
		const char *name;
	} cases[] = {
		{STRATEGY_DEFAULT, "DEFAULT"},
		{STRATEGY_ETHERNET, "ETHERNET"},
		{STRATEGY_IP_ADDRESS, "IP_ADDRESS"},
		{STRATEGY_DISK, "DISK"},
	};

	const int iterations = 200;
	std::printf("identify_pc() latency over %d iterations (microseconds):\n", iterations);
	std::printf("  %-12s %10s %10s %10s\n", "strategy", "median", "min", "max");
	for (const auto &c : cases) {
		const Stats s = measure(c.strategy, iterations);
		std::printf("  %-12s %10.1f %10.1f %10.1f\n", c.name, s.median_us, s.min_us, s.max_us);
	}
	return 0;
}
