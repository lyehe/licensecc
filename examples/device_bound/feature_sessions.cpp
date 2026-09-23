#include <licensecc/feature_session.h>
#include "options.hpp"
#include "feature_work.hpp"
#include <array>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <memory>
#include <thread>

namespace {
using example_work::cancel_work;
using example_work::cancelled;
using example_work::Session;
struct Report {
	uint64_t bytes = 0, checksum = 0;
};
bool run_batch(const char* path, Report& report) {
	Session session;
	if (!session.start("BATCH_RUN")) return false;
	std::ifstream input(path, std::ios::binary);
	if (!input) return false;
	std::array<char, 4096> bytes{};
	Report computed;
	while (input.read(bytes.data(), bytes.size()) || input.gcount()) {
		if (!session.authorize("BATCH_RUN")) {
			std::cerr << "Batch authorization unavailable; work stopped.\n";
			return false;
		}
		// A bounded protected unit, including the very first unit.
		for (std::streamsize i = 0; i < input.gcount(); ++i)
			computed.checksum += static_cast<unsigned char>(bytes[static_cast<std::size_t>(i)]);
		computed.bytes += static_cast<uint64_t>(input.gcount());
	}
	if (!input.eof() || !session.authorize("BATCH_RUN")) return false;
	report = computed;
	return session.stop();	// Ends local work, never retires a device binding.
}
bool export_report(const Report& report) {
	Session session;
	if (!session.start("EXPORT") || !session.authorize("EXPORT")) return false;
	std::cout << "bytes,checksum\n" << report.bytes << ',' << report.checksum << '\n';
	return session.stop();
}
}  // namespace
int main(int argc, char** argv) {
	if (argc == 2 && std::strcmp(argv[1], "--check-api") == 0) {
		LccDeviceBoundOptions config;
		lcc_init_device_bound_options(&config);
		LccFeatureSessionOutcome detail;
		lcc_init_feature_session_outcome(&detail);
		LccFeatureSession* owner = nullptr;
		return lcc_feature_session_open(&config, &owner, &detail) == LCC_BOUND_INVALID_ARGUMENT && !owner ? 0 : 1;
	}
	if (argc != 2) {
		std::cerr << "Usage: licensecc_feature_sessions input-file (Ctrl+C cancels)\n";
		return 2;
	}
	std::signal(SIGINT, cancel_work);
	Report first, second;
	// Two jobs in one process MUST obtain separate fresh server decisions.
	return run_batch(argv[1], first) && run_batch(argv[1], second) && export_report(second) ? 0 : 1;
}
