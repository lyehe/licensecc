#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <objbase.h>
#include "bound_browser.hpp"
#include "bound_http.hpp"
#include "bound_encoding.hpp"
#include "p256_crypto.hpp"
#include <thread>

namespace license {
namespace device_identity {
namespace {
class WindowsBrowser final : public BoundBrowserLauncher {
	std::string prefix_;

public:
	explicit WindowsBrowser(std::string base) : prefix_(std::move(base) + "#attempt_handle=") {}
	BoundBrowserStatus open(const std::string& url) noexcept override {
		try {
			if (url.size() != prefix_.size() + 43 || url.compare(0, prefix_.size(), prefix_) != 0 ||
				!bound_encoding::token(std::string_view(url).substr(prefix_.size()), 32))
				return BoundBrowserStatus::invalid_input;
			// A dedicated STA avoids changing the application's COM apartment.
			// Waiting keeps borrowed URL storage alive through shell submission.
			// NOASYNC does not guarantee URI navigation completion. This call
			// has no hard bound and must not run under the DLL loader lock.
			BoundBrowserStatus result = BoundBrowserStatus::unavailable;
			std::thread opening([&url, &result] {
				try {
					result = [&url] {
						const auto initialized =
							CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
						if (FAILED(initialized)) return BoundBrowserStatus::unavailable;
						struct Apartment {
							~Apartment() { CoUninitialize(); }
						} apartment;
						struct Url {
							std::wstring text;
							~Url() { secure_zero(text.data(), text.size() * sizeof(wchar_t)); }
						} wide;
						wide.text.reserve(url.size());
						for (unsigned char c : url) wide.text.push_back(static_cast<wchar_t>(c));
						SHELLEXECUTEINFOW info{};
						info.cbSize = sizeof(info);
						info.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOCLOSEPROCESS;
						info.lpVerb = L"open";
						info.lpFile = wide.text.c_str();
						info.nShow = SW_SHOWNORMAL;
						const bool opened = ShellExecuteExW(&info) != FALSE;
						if (info.hProcess) CloseHandle(info.hProcess);
						return opened ? BoundBrowserStatus::opened : BoundBrowserStatus::unavailable;
					}();
				} catch (...) {
					result = BoundBrowserStatus::unavailable;
				}
			});
			opening.join();
			return result;
		} catch (...) {
			return BoundBrowserStatus::unavailable;
		}
	}
};
}  // namespace
std::unique_ptr<BoundBrowserLauncher> make_bound_browser_launcher(const std::string& base) noexcept {
	try {
		return valid_bound_portal_url(base) ? std::make_unique<WindowsBrowser>(base) : nullptr;
	} catch (...) {
		return nullptr;
	}
}
}  // namespace device_identity
}  // namespace license
