#ifndef LICENSECC_BOUND_DESKTOP_HPP_
#define LICENSECC_BOUND_DESKTOP_HPP_
#include "bound_browser.hpp"
#include "bound_loopback.hpp"

namespace license {
namespace device_identity {
// Windows internal lifecycle owner. Components transfer exclusively at create;
// no external actor may use their previous raw pointers afterward. This is not
// the public C/C++ API. The native UI displays prepare()'s comparison before
// calling launch(), and retains it while the browser consent page is open.
// Destruction requires that no concurrent method call is in progress.
class BoundDesktopEnrollment {
public:
	static std::unique_ptr<BoundDesktopEnrollment> create(std::unique_ptr<BoundEnrollmentFlow>,
														  std::unique_ptr<BoundLoopbackListener>,
														  std::unique_ptr<BoundBrowserLauncher>) noexcept;
	~BoundDesktopEnrollment();
	BoundEnrollmentResult prepare(BoundEnrollmentView&) noexcept;
	BoundBrowserStatus launch() noexcept;
	BoundLoopbackStatus poll(unsigned wait_ms = 100) noexcept;
	BoundRenewResult activate() noexcept;
	BoundRenewResult abandon_exchange() noexcept;
	bool export_resume_statement(std::string& out) noexcept;
	BoundResumeExport capture_resume_statement(std::string& out) noexcept;
	BoundEnrollmentResult cancel() noexcept;
	std::unique_ptr<BoundRenewalClient> take_client() noexcept;

private:
	BoundDesktopEnrollment() = default;
	enum class Stage { idle, ready, code_ready, finished, cancelled, failed, transferred };
	void clear_view() noexcept;
	void stop(Stage) noexcept;
	BoundEnrollmentStatus check_ready();
	BoundRenewResult finish(BoundRenewResult);
	std::unique_ptr<BoundEnrollmentFlow> flow_;
	std::unique_ptr<BoundLoopbackListener> listener_;
	std::unique_ptr<BoundBrowserLauncher> browser_;
	std::unique_ptr<BoundRenewalClient> client_;
	BoundEnrollmentView view_;
	Stage stage_ = Stage::idle;
	bool launched_ = false;
	std::mutex mutex_;
};
}  // namespace device_identity
}  // namespace license
#endif
