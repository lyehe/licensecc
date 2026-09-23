#include <licensecc/device_bound.h>
#include "options.hpp"
#include "enrollment_work.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <memory>
#include <string>
#include <thread>

namespace {
using example_configuration::options;
using example_enrollment::enroll;
using example_enrollment::persistence;
using example_enrollment::update;
bool analyze(LccDeviceBoundClient* client, const char* path) {
	std::ifstream input(path);
	if (!input) {
		std::cerr << "Cannot open points file.\n";
		return false;
	}
	struct Point {
		double x, y, z;
	};
	std::array<Point, 4096> batch;
	std::array<double, 3> low{INFINITY, INFINITY, INFINITY}, high{-INFINITY, -INFINITY, -INFINITY};
	std::size_t total = 0;
	for (;;) {
		std::size_t count = 0;
		while (count < batch.size()) {
			if (!(input >> batch[count].x)) break;
			if (!(input >> batch[count].y >> batch[count].z)) {
				std::cerr << "Incomplete XYZ triple.\n";
				return false;
			}
			const auto& p = batch[count];
			if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z)) return false;
			++count;
		}
		if (!input.eof() && input.fail()) {
			std::cerr << "Expected whitespace-separated XYZ triples.\n";
			return false;
		}
		if (!count) break;
		LccDeviceBoundOutcome detail;
		lcc_init_device_bound_outcome(&detail);
		auto allowed = lcc_device_bound_authorize(client, &detail);
		if (allowed == LCC_BOUND_ONLINE_REQUIRED || (allowed == LCC_BOUND_OK && detail.renewal_due)) {
			const auto renewed = update(client, false);
			if (renewed != LCC_BOUND_OK && renewed != LCC_BOUND_RETRY) return false;
			allowed = lcc_device_bound_authorize(client, &detail);	// Recheck after all network/storage work.
		}
		if (allowed != LCC_BOUND_OK) {
			std::cerr << "Protected operation denied: " << allowed << '\n';
			return false;
		}
		// Protected computation starts immediately after the native authorization.
		for (std::size_t i = 0; i < count; ++i) {
			const double coordinates[]{batch[i].x, batch[i].y, batch[i].z};
			for (unsigned axis = 0; axis < 3; ++axis) {
				low[axis] = (std::min)(low[axis], coordinates[axis]);
				high[axis] = (std::max)(high[axis], coordinates[axis]);
			}
		}
		total += count;
	}
	if (!total) {
		std::cerr << "The points file is empty.\n";
		return false;
	}
	std::cout << "Analyzed " << total << " points. Bounds: " << low[0] << ',' << low[1] << ',' << low[2] << " to "
			  << high[0] << ',' << high[1] << ',' << high[2] << '\n';
	return true;
}
}  // namespace
int main(int argc, char** argv) {
	if (argc == 2 && std::strcmp(argv[1], "--check-api") == 0) {
		LccDeviceBoundOptions invalid;
		lcc_init_device_bound_options(&invalid);
		LccDeviceBoundOutcome detail;
		lcc_init_device_bound_outcome(&detail);
		LccDeviceBoundClient* handle = nullptr;
		if (lcc_device_bound_open_enrollment(&invalid, &handle, &detail) != LCC_BOUND_INVALID_ARGUMENT || handle)
			return 1;
		std::cout << "Installed public API linked; invalid configuration rejected without provisioning.\n";
		return 0;
	}
	if (argc != 3 || (std::strcmp(argv[1], "enroll") && std::strcmp(argv[1], "resume") &&
					  std::strcmp(argv[1], "enroll-batch") && std::strcmp(argv[1], "enroll-export"))) {
		std::cout << "Usage: licensecc_device_bound enroll|resume|enroll-batch|enroll-export points.xyz\n"
				  << "enroll explicitly provisions a user-scoped TPM key; resume never creates one.\n";
		return 2;
	}
	const bool feature_enrollment =
		std::strcmp(argv[1], "enroll-batch") == 0 || std::strcmp(argv[1], "enroll-export") == 0;
	const bool enrollment = std::strcmp(argv[1], "enroll") == 0 || feature_enrollment;
	auto config = options();
	if (feature_enrollment)
		std::strcpy(config.feature, std::strcmp(argv[1], "enroll-batch") == 0 ? "BATCH_RUN" : "EXPORT");
	if (enrollment)
		std::cout << "Select feature " << config.feature
				  << " in the browser. Other features are not authorized by this enrollment.\n";
	LccDeviceBoundOutcome detail;
	lcc_init_device_bound_outcome(&detail);
	LccDeviceBoundClient* raw = nullptr;
	const auto opened = enrollment ? lcc_device_bound_open_enrollment(&config, &raw, &detail)
								   : lcc_device_bound_open_resume(&config, &raw, &detail);
	std::unique_ptr<LccDeviceBoundClient, decltype(&lcc_device_bound_close)> client(raw, lcc_device_bound_close);
	if (opened != LCC_BOUND_OK) {
		std::cerr << "Open failed: " << opened << ", provider " << detail.provider_result << ", checkpoint "
				  << detail.checkpoint_result << '\n';
		if (opened == LCC_BOUND_RESUME_REQUIRED) std::cerr << "Use resume; existing checkpoint state is preserved.\n";
		return 1;
	}
	if (!(enrollment ? enroll(client.get()) : update(client.get(), false) == LCC_BOUND_OK)) return 1;
	if (feature_enrollment) {
		std::cout << "Feature enrolled. Start work with licensecc_feature_sessions.\n";
		return 0;
	}
	return analyze(client.get(), argv[2]) ? 0 : 1;
}
