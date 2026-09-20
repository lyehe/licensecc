#include <licensecc/device_bound.h>
#include "options.hpp"
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
bool persistence(LccDeviceBoundClient* client, LccDeviceBoundOutcome& detail) {
	const auto save = [&] {
		LccDeviceBoundOutcome saved;
		lcc_init_device_bound_outcome(&saved);
		lcc_device_bound_save_checkpoint(client, &saved);
		if (saved.checkpoint_result != LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED)
			detail.checkpoint_result = saved.checkpoint_result;
	};
	const auto complete = [&] {
		return detail.checkpoint_result == LCC_BOUND_CHECKPOINT_SAVED ||
			   detail.checkpoint_result == LCC_BOUND_CHECKPOINT_UNCHANGED ||
			   detail.checkpoint_result == LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED;
	};
	for (unsigned attempt = 0; !complete() && attempt < 3; ++attempt) {
		save();	 // Storage only; preserve the primary provider outcome.
		if (!complete()) std::this_thread::sleep_for(std::chrono::milliseconds(250));
	}
	while (!complete()) {
		std::cerr << "Checkpoint recovery required (status " << detail.checkpoint_result
				  << "). Press Enter to retry storage without another request, or type quit to exit with unresolved "
					 "recovery: "
				  << std::flush;
		std::string answer;
		if (!std::getline(std::cin, answer) || answer == "quit") return false;
		save();
	}
	return true;
}
LCC_BOUND_RESULT update(LccDeviceBoundClient* client, bool activation) {
	LccDeviceBoundOutcome detail;
	lcc_init_device_bound_outcome(&detail);
	LCC_BOUND_RESULT result = LCC_BOUND_INTERNAL_ERROR;
	for (unsigned attempt = 0;; ++attempt) {
		result = activation ? lcc_device_bound_activate(client, &detail) : lcc_device_bound_renew(client, &detail);
		if (!persistence(client, detail)) return LCC_BOUND_STORAGE_ERROR;
		if (result != LCC_BOUND_RETRY && result != LCC_BOUND_BUSY && result != LCC_BOUND_CONFLICT) break;
		if (attempt >= 2 || result == LCC_BOUND_CONFLICT) {
			std::cerr
				<< "Issuance is unresolved (result " << result << "). Press Enter to retry, quit to stop"
				<< (!activation && result == LCC_BOUND_CONFLICT
						? ", or restart to abandon this request and start a new renewal (the server binding remains)"
						: "")
				<< (!activation && result == LCC_BOUND_RETRY ? ", or offline to recheck the existing lease" : "")
				<< ": " << std::flush;
			std::string answer;
			if (!std::getline(std::cin, answer) || answer == "quit") return LCC_BOUND_CANCELLED;
			if (!activation && result == LCC_BOUND_RETRY && answer == "offline") return LCC_BOUND_RETRY;
			if (!activation && result == LCC_BOUND_CONFLICT && answer == "restart") {
				const auto abandoned = lcc_device_bound_abandon_pending(client, &detail);
				if (!persistence(client, detail)) return LCC_BOUND_STORAGE_ERROR;
				if (abandoned != LCC_BOUND_ONLINE_REQUIRED) return abandoned;
				attempt = 0;
			}
		}
		std::this_thread::sleep_for(std::chrono::seconds(1));
	}
	if (result != LCC_BOUND_OK && result != LCC_BOUND_ONLINE_REQUIRED && result != LCC_BOUND_RETRY)
		std::cerr << "Operation stopped (result " << result << ", provider " << detail.provider_result << ").\n";
	return result;
}
bool enroll(LccDeviceBoundClient* client) {
	LccDeviceBoundView view;
	lcc_init_device_bound_view(&view);
	LCC_BOUND_RESULT prepared = LCC_BOUND_RETRY;
	for (unsigned attempt = 0; prepared == LCC_BOUND_RETRY && attempt < 3; ++attempt) {
		prepared = lcc_device_bound_prepare(client, &view);
		if (prepared == LCC_BOUND_RETRY) std::this_thread::sleep_for(std::chrono::seconds(1));
	}
	if (prepared != LCC_BOUND_OK) {
		std::cerr << "Enrollment preparation failed: " << prepared << '\n';
		return false;
	}
	std::cout << "Compare this code with the browser before approving: " << view.comparison_code << std::endl;
	if (lcc_device_bound_launch(client) != LCC_BOUND_OK) {
		std::cerr << "Browser could not open. Retry enrollment in the application.\n";
		return false;
	}
	LCC_BOUND_RESULT callback;
	do {
		callback = lcc_device_bound_poll(client, 100);
	} while (callback == LCC_BOUND_WAITING || callback == LCC_BOUND_CALLBACK_REJECTED);
	if (callback != LCC_BOUND_CALLBACK_RECEIVED) {
		std::cerr << "Consent did not complete: " << callback << '\n';
		return false;
	}
	const auto result = update(client, true);
	return result == LCC_BOUND_OK || (result == LCC_BOUND_ONLINE_REQUIRED && update(client, false) == LCC_BOUND_OK);
}
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
