#ifndef LICENSECC_EXAMPLE_FEATURE_WORK_HPP_
#define LICENSECC_EXAMPLE_FEATURE_WORK_HPP_
#include <licensecc/feature_session.h>
#include "options.hpp"
#include <chrono>
#include <csignal>
#include <iostream>
#include <memory>
#include <thread>

// Shared example-level orchestration; the native owner remains the authority.
namespace example_work {
inline volatile std::sig_atomic_t cancelled = 0;
inline void cancel_work(int) { cancelled = 1; }
inline bool wait_retry(std::chrono::milliseconds duration) {
	const auto end = std::chrono::steady_clock::now() + duration;
	while (!cancelled && std::chrono::steady_clock::now() < end)
		std::this_thread::sleep_for(std::chrono::milliseconds(100));
	return !cancelled;
}
inline bool saved(uint32_t value) {
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
			std::cerr << feature << ": ";
			if (result == LCC_BOUND_ENROLLMENT_REQUIRED) std::cerr << "Activate this feature from your app first.";
			else if (result == LCC_BOUND_PROVIDER_ERROR) std::cerr << "Device identity is unavailable. Check the device key and TPM before retrying activation.";
			else std::cerr << "Unable to open licensing. Retry or contact support.";
			std::cerr << "\nDiagnostic code: " << result << '\n';
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
}  // namespace example_work
#endif
