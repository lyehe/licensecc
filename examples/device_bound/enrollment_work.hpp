#ifndef LICENSECC_EXAMPLE_ENROLLMENT_WORK_HPP_
#define LICENSECC_EXAMPLE_ENROLLMENT_WORK_HPP_
#include <licensecc/device_bound.h>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>

namespace example_enrollment {
inline bool persistence(LccDeviceBoundClient* client, LccDeviceBoundOutcome& detail) {
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
inline LCC_BOUND_RESULT update(LccDeviceBoundClient* client, bool activation) {
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
inline bool enroll(LccDeviceBoundClient* client) {
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
}  // namespace example_enrollment
#endif
