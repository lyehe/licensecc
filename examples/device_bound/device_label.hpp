#ifndef LICENSECC_EXAMPLE_DEVICE_LABEL_HPP_
#define LICENSECC_EXAMPLE_DEVICE_LABEL_HPP_
// The device label the approval page shows beside the comparison code. Customers use it to tell
// their computers apart when they approve or disconnect one, so the example defaults it to the
// operating system's computer name instead of compiling one label into every installation.
#include <licensecc/device_bound.h>
#include <cstring>
#include <string>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif
namespace example_device_label {
// Used when the computer name cannot be read, does not fit, or breaks the device-label rule.
constexpr char fallback[] = "Computer";

// The operating system's computer name as UTF-8 (the DNS host name on Windows, gethostname on
// Linux), or an empty string when it cannot be read.
inline std::string computer_name() {
#ifdef _WIN32
	wchar_t name[256];
	DWORD length = static_cast<DWORD>(sizeof(name) / sizeof(name[0]));
	if (!GetComputerNameExW(ComputerNamePhysicalDnsHostname, name, &length) || length == 0) return std::string();
	const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name, static_cast<int>(length), nullptr, 0,
										  nullptr, nullptr);
	if (bytes <= 0) return std::string();
	std::string utf8(static_cast<std::size_t>(bytes), '\0');
	if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name, static_cast<int>(length), &utf8[0], bytes, nullptr,
							nullptr) != bytes)
		return std::string();
	return utf8;
#else
	char name[256] = {};
	if (gethostname(name, sizeof(name) - 1) != 0) return std::string();
	return std::string(name);
#endif
}

// The label to offer first: the configure-time label when one was set, otherwise the computer
// name, or the fallback when the name is empty or does not fit the public option.
inline std::string preferred(const char* configured, const std::string& name = computer_name()) {
	if (configured[0] != '\0') return configured;
	if (name.empty() || name.size() >= sizeof(LccDeviceBoundOptions::device_label)) return fallback;
	return name;
}

// The native client applies the device-label rule before it stores or sends anything: a label with a
// control or format character, or text shaped like a comparison code, is refused with
// LCC_BOUND_INVALID_ARGUMENT. A computer name it refuses is replaced by the fallback and the open is
// retried once. A configure-time label is the developer's choice and is never replaced.
template <typename Open>
LCC_BOUND_RESULT open_with_fallback(LccDeviceBoundOptions& options, bool configured, Open&& open) {
	const LCC_BOUND_RESULT result = open(options);
	if (result != LCC_BOUND_INVALID_ARGUMENT || configured || std::strcmp(options.device_label, fallback) == 0)
		return result;
	std::memcpy(options.device_label, fallback, sizeof(fallback));
	return open(options);
}
}  // namespace example_device_label
#endif
