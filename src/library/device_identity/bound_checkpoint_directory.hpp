#ifndef LICENSECC_BOUND_CHECKPOINT_DIRECTORY_HPP_
#define LICENSECC_BOUND_CHECKPOINT_DIRECTORY_HPP_
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace license {
namespace device_identity {
namespace checkpoint_windows {
struct Handle {
	HANDLE value = INVALID_HANDLE_VALUE;
	Handle() = default;
	explicit Handle(HANDLE h) : value(h) {}
	~Handle() { reset(); }
	Handle(const Handle&) = delete;
	Handle& operator=(const Handle&) = delete;
	Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
	Handle& operator=(Handle&& other) noexcept {
		if (this != &other) {
			reset();
			value = other.value;
			other.value = INVALID_HANDLE_VALUE;
		}
		return *this;
	}
	explicit operator bool() const noexcept { return value != INVALID_HANDLE_VALUE && value != nullptr; }
	void reset() noexcept {
		if (*this) CloseHandle(value);
		value = INVALID_HANDLE_VALUE;
	}
};
class Directory {
public:
	static std::unique_ptr<Directory> open(const std::wstring& private_root);
	static std::unique_ptr<Directory> production(const std::string& namespace_hash);
	~Directory();
	Handle file(const wchar_t* name, DWORD access, DWORD creation, DWORD share = FILE_SHARE_READ);
	bool valid_file(HANDLE, const wchar_t* name, std::uint64_t max_size) const;
	bool valid() const noexcept;
	const std::wstring& path() const noexcept { return path_; }

private:
	bool initialize_security();
	bool secure(HANDLE) const;
	bool pin(const std::wstring&, bool private_acl);
	bool pin_root(const std::wstring&, bool private_acl);
	bool child(const wchar_t*);
	std::wstring path_;
	struct Pin {
		Handle handle;
		std::wstring path;
		bool private_acl;
	};
	std::vector<Pin> pins_;
	std::vector<unsigned char> user_;
	PSECURITY_DESCRIPTOR descriptor_ = nullptr;
	DWORD volume_ = 0;
};
}  // namespace checkpoint_windows
}  // namespace device_identity
}  // namespace license
#endif
