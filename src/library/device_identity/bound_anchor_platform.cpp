#include "bound_anchor.hpp"
#include "../os/os.h"
#if defined(_WIN32)
#define NOMINMAX
#include <windows.h>
#elif defined(__linux__)
#include <time.h>
#include <unistd.h>
#include <limits>
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
#elif defined(__linux__)
namespace {
class LinuxAnchorPlatform final : public BoundAnchorPlatform {
	static bool read(clockid_t clock, std::uint64_t& out, bool ceiling = false) noexcept {
		timespec value{};
		if (clock_gettime(clock, &value) != 0 || value.tv_sec < 0 || value.tv_nsec < 0 || value.tv_nsec >= 1000000000)
			return false;
		const auto seconds = static_cast<std::uint64_t>(value.tv_sec);
		if (seconds > (std::numeric_limits<std::uint64_t>::max() - 10000000) / 10000000) return false;
		out = seconds * 10000000 + static_cast<std::uint64_t>(value.tv_nsec) / 100 +
			  (ceiling && value.tv_nsec % 100 != 0 ? 1 : 0);
		return true;
	}

public:
	bool random_operation(std::array<std::uint8_t, 32>& out) noexcept override {
		return getSecureRandomBytes(out.data(), out.size()) == FUNC_RET_OK;
	}
	bool sample(BoundClockSample& out) noexcept override {
		// Round the final bracket outward so sub-tick clock bias cannot appear
		// to change merely because nanoseconds were converted to 100 ns ticks.
		BoundClockSample next{};
		if (!read(CLOCK_MONOTONIC, next.awake_before) || !read(CLOCK_BOOTTIME, next.inclusive) ||
			!read(CLOCK_MONOTONIC, next.awake_after, true))
			return false;
		next.process_id = static_cast<std::uint64_t>(getpid());
		out = next;
		return true;
	}
};
}  // namespace
#endif
std::unique_ptr<BoundAnchorPlatform> make_bound_anchor_platform() noexcept {
	try {
#if defined(_WIN32)
		auto platform = std::unique_ptr<WindowsAnchorPlatform>(new WindowsAnchorPlatform);
		if (!platform->available()) return nullptr;
		return platform;
#elif defined(__linux__)
		auto platform = std::make_unique<LinuxAnchorPlatform>();
		BoundClockSample probe{};
		return platform->sample(probe) ? std::move(platform) : nullptr;
#else
		return nullptr;
#endif
	} catch (...) {
		return nullptr;
	}
}
}  // namespace device_identity
}  // namespace license
