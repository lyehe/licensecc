#include "bound_anchor.hpp"
#include "../os/os.h"
#if defined(_WIN32)
#define NOMINMAX
#include <windows.h>
#endif

namespace license {
namespace device_identity {
#if defined(_WIN32)
namespace {
class WindowsAnchorPlatform final : public BoundAnchorPlatform {
public:
	using ReadClock = VOID(WINAPI*)(PULONGLONG);
	WindowsAnchorPlatform() {
		module_ = LoadLibraryExW(L"api-ms-win-core-realtime-l1-1-1.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
		if (module_) {
			inclusive_ = reinterpret_cast<ReadClock>(GetProcAddress(module_, "QueryInterruptTimePrecise"));
			awake_ = reinterpret_cast<ReadClock>(GetProcAddress(module_, "QueryUnbiasedInterruptTimePrecise"));
		}
	}
	~WindowsAnchorPlatform() override {
		if (module_) FreeLibrary(module_);
	}
	bool available() const noexcept { return inclusive_ && awake_; }
	bool random_operation(std::array<std::uint8_t, 32>& out) noexcept override {
		return getSecureRandomBytes(out.data(), out.size()) == FUNC_RET_OK;
	}
	bool sample(BoundClockSample& out) noexcept override {
		if (!available()) return false;
		ULONGLONG before = 0, inclusive = 0, after = 0;
		awake_(&before);
		inclusive_(&inclusive);
		awake_(&after);
		out = {inclusive, before, after, GetCurrentProcessId()};
		return true;
	}

private:
	HMODULE module_ = nullptr;
	ReadClock inclusive_ = nullptr, awake_ = nullptr;
};
}  // namespace
#endif
std::unique_ptr<BoundAnchorPlatform> make_bound_anchor_platform() noexcept {
	try {
#if defined(_WIN32)
		auto platform = std::unique_ptr<WindowsAnchorPlatform>(new WindowsAnchorPlatform);
		if (!platform->available()) return nullptr;
		return platform;
#else
		return nullptr;
#endif
	} catch (...) {
		return nullptr;
	}
}
}  // namespace device_identity
}  // namespace license
