#include "bound_desktop.hpp"

namespace license {
namespace device_identity {
namespace {
BoundEnrollmentResult enrollment(BoundEnrollmentStatus status) { return {status, {}}; }
BoundRenewResult renewal(BoundRenewStatus status) {
	BoundRenewResult out;
	out.status = status;
	return out;
}
}  // namespace
std::unique_ptr<BoundDesktopEnrollment> BoundDesktopEnrollment::create(
	std::unique_ptr<BoundEnrollmentFlow> flow, std::unique_ptr<BoundLoopbackListener> listener,
	std::unique_ptr<BoundBrowserLauncher> browser) noexcept {
	try {
		if (!flow || !listener || !browser) return nullptr;
		auto owner = std::unique_ptr<BoundDesktopEnrollment>(new BoundDesktopEnrollment);
		owner->flow_ = std::move(flow);
		owner->listener_ = std::move(listener);
		owner->browser_ = std::move(browser);
		return owner;
	} catch (...) {
		return nullptr;
	}
}
BoundDesktopEnrollment::~BoundDesktopEnrollment() { stop(Stage::cancelled); }
void BoundDesktopEnrollment::clear_view() noexcept {
	secure_zero(view_.authorization_url.data(), view_.authorization_url.size());
	view_.authorization_url.clear();
	view_.comparison_code.clear();
	view_.expires_at = 0;
}
void BoundDesktopEnrollment::stop(Stage stage) noexcept {
	listener_.reset();
	flow_.reset();
	browser_.reset();
	client_.reset();
	clear_view();
	stage_ = stage;
}
BoundEnrollmentResult BoundDesktopEnrollment::prepare(BoundEnrollmentView& out) noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return enrollment(BoundEnrollmentStatus::busy);
		if (stage_ != Stage::idle && stage_ != Stage::ready) return enrollment(BoundEnrollmentStatus::invalid_input);
		try {
			auto alive = listener_->check();
			if (alive != BoundLoopbackStatus::waiting) {
				stop(Stage::failed);
				return enrollment(alive == BoundLoopbackStatus::expired ? BoundEnrollmentStatus::expired
																		: BoundEnrollmentStatus::failed);
			}
			BoundEnrollmentView candidate;
			auto result = flow_->begin(listener_->redirect_uri(), candidate);
			alive = listener_->check();
			if (alive != BoundLoopbackStatus::waiting) {
				stop(Stage::failed);
				return enrollment(alive == BoundLoopbackStatus::expired ? BoundEnrollmentStatus::expired
																		: BoundEnrollmentStatus::failed);
			}
			if (result.status == BoundEnrollmentStatus::ready) {
				auto output = candidate;
				const auto ready = check_ready();
				if (ready != BoundEnrollmentStatus::ready) return enrollment(ready);
				clear_view();
				view_ = std::move(candidate);
				out = std::move(output);
				stage_ = Stage::ready;
			} else if (result.status != BoundEnrollmentStatus::retry &&
					   result.status != BoundEnrollmentStatus::invalid_response)
				stop(Stage::failed);
			return result;
		} catch (...) {
			stop(Stage::failed);
			return enrollment(BoundEnrollmentStatus::failed);
		}
	} catch (...) {
		return enrollment(BoundEnrollmentStatus::failed);
	}
}
BoundEnrollmentStatus BoundDesktopEnrollment::check_ready() {
	const auto listener = listener_->check();
	const auto flow = flow_->check_browser_ready();
	if (listener == BoundLoopbackStatus::expired || flow.status == BoundEnrollmentStatus::expired) {
		stop(Stage::failed);
		return BoundEnrollmentStatus::expired;
	}
	if (listener != BoundLoopbackStatus::waiting || flow.status != BoundEnrollmentStatus::ready) {
		stop(Stage::failed);
		return BoundEnrollmentStatus::failed;
	}
	return BoundEnrollmentStatus::ready;
}
BoundBrowserStatus BoundDesktopEnrollment::launch() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return BoundBrowserStatus::busy;
		if (stage_ != Stage::ready) return BoundBrowserStatus::invalid_input;
		const auto before = check_ready();
		if (before != BoundEnrollmentStatus::ready)
			return before == BoundEnrollmentStatus::expired ? BoundBrowserStatus::expired
															: BoundBrowserStatus::unavailable;
		if (launched_) return BoundBrowserStatus::opened;
		const auto opened = browser_->open(view_.authorization_url);
		const auto after = check_ready();
		if (after != BoundEnrollmentStatus::ready)
			return after == BoundEnrollmentStatus::expired ? BoundBrowserStatus::expired
														   : BoundBrowserStatus::unavailable;
		if (opened == BoundBrowserStatus::opened) launched_ = true;
		return opened;
	} catch (...) {
		return BoundBrowserStatus::unavailable;
	}
}
BoundLoopbackStatus BoundDesktopEnrollment::poll(unsigned wait_ms) noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return BoundLoopbackStatus::busy;
		if (stage_ != Stage::ready) return BoundLoopbackStatus::closed;
		const auto result = listener_->poll(*flow_, wait_ms);
		if (result == BoundLoopbackStatus::received) {
			listener_.reset();
			browser_.reset();
			clear_view();
			stage_ = Stage::code_ready;
		} else if (result == BoundLoopbackStatus::expired || result == BoundLoopbackStatus::closed ||
				   result == BoundLoopbackStatus::failed)
			stop(Stage::failed);
		return result;
	} catch (...) {
		return BoundLoopbackStatus::failed;
	}
}
BoundRenewResult BoundDesktopEnrollment::finish(BoundRenewResult result) {
	client_ = flow_->take_client();
	if ((result.status == BoundRenewStatus::accepted || result.status == BoundRenewStatus::renewal_required) &&
		!client_)
		result.status = BoundRenewStatus::internal_error;
	flow_.reset();
	listener_.reset();
	browser_.reset();
	clear_view();
	stage_ = client_ ? Stage::finished : Stage::failed;
	return result;
}
BoundRenewResult BoundDesktopEnrollment::activate() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return renewal(BoundRenewStatus::busy);
		if (stage_ != Stage::code_ready) return renewal(BoundRenewStatus::rejected);
		auto result = flow_->activate();
		if (result.status == BoundRenewStatus::accepted || result.status == BoundRenewStatus::renewal_required ||
			result.status == BoundRenewStatus::enrollment_required || result.status == BoundRenewStatus::denied ||
			result.status == BoundRenewStatus::rejected)
			return finish(std::move(result));
		return result;
	} catch (...) {
		return renewal(BoundRenewStatus::internal_error);
	}
}
BoundRenewResult BoundDesktopEnrollment::abandon_exchange() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return renewal(BoundRenewStatus::busy);
		if (stage_ != Stage::code_ready) return renewal(BoundRenewStatus::rejected);
		auto result = flow_->abandon_exchange();
		if (result.status == BoundRenewStatus::renewal_required ||
			result.status == BoundRenewStatus::enrollment_required)
			return finish(std::move(result));
		return result;
	} catch (...) {
		return renewal(BoundRenewStatus::internal_error);
	}
}
BoundEnrollmentResult BoundDesktopEnrollment::cancel() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return enrollment(BoundEnrollmentStatus::busy);
		if (stage_ == Stage::transferred) return enrollment(BoundEnrollmentStatus::invalid_input);
		stop(Stage::cancelled);
		return enrollment(BoundEnrollmentStatus::cancelled);
	} catch (...) {
		return enrollment(BoundEnrollmentStatus::failed);
	}
}
bool BoundDesktopEnrollment::export_resume_statement(std::string& out) noexcept {
	return capture_resume_statement(out) == BoundResumeExport::exported;
}
BoundResumeExport BoundDesktopEnrollment::capture_resume_statement(std::string& out) noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return BoundResumeExport::busy;
		if (client_) return client_->capture_resume_statement(out);
		return flow_ ? flow_->capture_resume_statement(out) : BoundResumeExport::absent;
	} catch (...) {
		return BoundResumeExport::error;
	}
}
std::unique_ptr<BoundRenewalClient> BoundDesktopEnrollment::take_client() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock() || stage_ != Stage::finished) return nullptr;
		stage_ = Stage::transferred;
		return std::move(client_);
	} catch (...) {
		return nullptr;
	}
}
}  // namespace device_identity
}  // namespace license
