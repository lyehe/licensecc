#include <licensecc/feature_session.h>
#include "options.hpp"
#include <array>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <memory>
#include <thread>

namespace {
volatile std::sig_atomic_t cancelled = 0;
void cancel_work(int) { cancelled = 1; }
bool wait_retry(std::chrono::milliseconds duration) {
	const auto end = std::chrono::steady_clock::now() + duration;
	while (!cancelled && std::chrono::steady_clock::now() < end)
		std::this_thread::sleep_for(std::chrono::milliseconds(100));
	return !cancelled;
}
bool saved(uint32_t value) {
	return value == LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED || value == LCC_BOUND_CHECKPOINT_SAVED ||
		   value == LCC_BOUND_CHECKPOINT_UNCHANGED || value == LCC_BOUND_CHECKPOINT_LOADED;
}
class Session {
	std::unique_ptr<LccFeatureSession, decltype(&lcc_feature_session_close)> owner_{nullptr, lcc_feature_session_close};
	std::chrono::steady_clock::time_point retry_after_{};
	bool persist(LccFeatureSessionOutcome detail) {
		for (unsigned attempt = 0; !saved(detail.checkpoint_result) && attempt < 3; ++attempt) {
			if (!wait_retry(std::chrono::milliseconds(250))) return false;
			LccFeatureSessionOutcome next;
			lcc_init_feature_session_outcome(&next);
			const auto result = lcc_feature_session_save_checkpoint(owner_.get(), &next);
			if (result != LCC_BOUND_BUSY) detail.checkpoint_result = next.checkpoint_result;
		}
		if (saved(detail.checkpoint_result)) return true;
		std::cerr << "Checkpoint needs recovery (" << detail.checkpoint_result << "). Work stopped.\n";
		return false;
	}

public:
	Session() = default;
	Session(const Session&) = delete;
	Session& operator=(const Session&) = delete;
	Session(Session&&) = default;
	Session& operator=(Session&&) = default;
	bool start(const char* feature) {
		if (owner_ || std::strlen(feature) > 15) return false;
		auto config = example_configuration::options();
		std::strcpy(config.feature, feature);
		LccFeatureSessionOutcome detail;
		lcc_init_feature_session_outcome(&detail);
		LccFeatureSession* raw = nullptr;
		auto result = lcc_feature_session_open(&config, &raw, &detail);
		owner_.reset(raw);
		if (result != LCC_BOUND_OK) {
			std::cerr << feature << ": cannot open session (" << result << ").";
			if (result == LCC_BOUND_ENROLLMENT_REQUIRED) std::cerr << " Enroll this feature first.";
			std::cerr << '\n';
			return false;
		}
		// One owner for this job. An unresolved start retries the same intent.
		for (unsigned attempt = 0; attempt < 3 && !cancelled; ++attempt) {
			lcc_init_feature_session_outcome(&detail);
			result = lcc_feature_session_start(owner_.get(), &detail);
			if (!persist(detail)) return false;
			if (result == LCC_BOUND_OK) return true;
			if (result != LCC_BOUND_RETRY && result != LCC_BOUND_BUSY && result != LCC_BOUND_ONLINE_REQUIRED) break;
			// RETRY is coarse: respect the server's possible 60-second rate limit.
			if (attempt < 2 && !wait_retry(result == LCC_BOUND_BUSY ? std::chrono::milliseconds(250)
																	: std::chrono::milliseconds(60000)))
				break;
		}
		std::cerr << feature << ": online start not approved (" << result << "). No work started.\n";
		return false;
	}
	bool authorize(const char* required_feature) {
		if (cancelled) return false;
		LccFeatureSessionOutcome detail;
		lcc_init_feature_session_outcome(&detail);
		auto result = lcc_feature_session_authorize(owner_.get(), required_feature, &detail);
		// A wrong-feature guard never schedules renewal of a different permission.
		if (result != LCC_BOUND_OK && detail.state != LCC_FEATURE_SESSION_NEEDS_ONLINE) return false;
		if ((result != LCC_BOUND_OK || detail.renewal_due) && std::chrono::steady_clock::now() >= retry_after_) {
			LccFeatureSessionOutcome renewed;
			lcc_init_feature_session_outcome(&renewed);
			const auto renewal = lcc_feature_session_renew(owner_.get(), &renewed);
			if (!persist(renewed)) return false;
			if (renewal == LCC_BOUND_RETRY)
				retry_after_ = std::chrono::steady_clock::now() + std::chrono::seconds(60);
			else if (renewal != LCC_BOUND_OK)
				return false;
			// Recheck even after network success, and after a transient failure.
			lcc_init_feature_session_outcome(&detail);
			result = lcc_feature_session_authorize(owner_.get(), required_feature, &detail);
		}
		return result == LCC_BOUND_OK && !cancelled;
	}
	bool stop() {
		if (!owner_) return true;
		LccFeatureSessionOutcome detail;
		lcc_init_feature_session_outcome(&detail);
		const auto result = lcc_feature_session_stop(owner_.get(), &detail);
		if (!persist(detail) || result != LCC_BOUND_OK) {
			std::cerr << "Local shutdown requires recovery (" << result << ").\n";
			return false;
		}
		owner_.reset();
		return true;
	}
};
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
