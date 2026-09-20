#include "bound_checkpoint_directory.hpp"
#include <aclapi.h>
#include <sddl.h>
#include <shlobj.h>
#include <array>
#include <cstdint>

namespace license {
namespace device_identity {
namespace checkpoint_windows {
namespace {
struct Local {
	void* value = nullptr;
	~Local() {
		if (value) LocalFree(value);
	}
};
bool ordinary(HANDLE handle, bool directory, BY_HANDLE_FILE_INFORMATION& info) {
	DWORD flags = 0;
	constexpr DWORD unsafe = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN |
							 FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
	return GetFileType(handle) == FILE_TYPE_DISK && GetHandleInformation(handle, &flags) &&
		   !(flags & HANDLE_FLAG_INHERIT) && GetFileInformationByHandle(handle, &info) &&
		   !(info.dwFileAttributes & unsafe) && !!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory &&
		   (directory || info.nNumberOfLinks == 1);
}
std::wstring resolved(HANDLE handle) {
	const DWORD size = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
	if (!size || size > 30000) return {};
	std::wstring value(size, L'\0');
	const auto written = GetFinalPathNameByHandleW(handle, value.data(), size, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
	if (!written || written >= size) return {};
	value.resize(written);
	return value;
}
bool same_path(const std::wstring& a, const std::wstring& b) {
	return CompareStringOrdinal(a.c_str(), static_cast<int>(a.size()), b.c_str(), static_cast<int>(b.size()), TRUE) ==
		   CSTR_EQUAL;
}
bool local_path(const std::wstring& p) {
	return p.size() >= 7 && p.compare(0, 4, L"\\\\?\\") == 0 &&
		   ((p[4] >= L'A' && p[4] <= L'Z') || (p[4] >= L'a' && p[4] <= L'z')) && p[5] == L':' && p[6] == L'\\';
}
}  // namespace
Directory::~Directory() {
	if (descriptor_) LocalFree(descriptor_);
}
bool Directory::initialize_security() {
	HANDLE impersonation = nullptr;
	if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &impersonation)) {
		CloseHandle(impersonation);
		return false;
	}
	if (GetLastError() != ERROR_NO_TOKEN) return false;
	Handle token;
	HANDLE raw = nullptr;
	if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) return false;
	token = Handle(raw);
	DWORD size = 0;
	GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
	if (!size || size > 65536) return false;
	user_.resize(size);
	if (!GetTokenInformation(token.value, TokenUser, user_.data(), size, &size)) return false;
	auto sid = reinterpret_cast<TOKEN_USER*>(user_.data())->User.Sid;
	LPWSTR raw_sid = nullptr;
	if (!ConvertSidToStringSidW(sid, &raw_sid)) return false;
	Local text;
	text.value = raw_sid;
	const std::wstring sddl = std::wstring(L"O:") + raw_sid + L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + raw_sid + L")";
	return ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor_, nullptr) !=
		   FALSE;
}
bool Directory::secure(HANDLE handle) const {
	PSID owner = nullptr;
	PACL acl = nullptr;
	Local descriptor;
	if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr,
						&acl, nullptr, reinterpret_cast<PSECURITY_DESCRIPTOR*>(&descriptor.value)) != ERROR_SUCCESS ||
		!owner || !acl)
		return false;
	const auto user = reinterpret_cast<const TOKEN_USER*>(user_.data())->User.Sid;
	SECURITY_DESCRIPTOR_CONTROL control = 0;
	DWORD revision = 0;
	if (!EqualSid(owner, user) || !GetSecurityDescriptorControl(descriptor.value, &control, &revision) ||
		!(control & SE_DACL_PROTECTED) || acl->AceCount != 2)
		return false;
	std::array<unsigned char, SECURITY_MAX_SID_SIZE> system{};
	DWORD size = static_cast<DWORD>(system.size());
	if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, system.data(), &size)) return false;
	bool saw_user = false, saw_system = false;
	for (DWORD i = 0; i < acl->AceCount; ++i) {
		void* raw = nullptr;
		if (!GetAce(acl, i, &raw)) return false;
		const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
		if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
			(ace->Header.AceFlags & ~(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) || ace->Mask != FILE_ALL_ACCESS)
			return false;
		auto sid = const_cast<DWORD*>(&ace->SidStart);
		if (EqualSid(sid, user) && !saw_user)
			saw_user = true;
		else if (EqualSid(sid, system.data()) && !saw_system)
			saw_system = true;
		else
			return false;
	}
	return saw_user && saw_system;
}
bool Directory::pin(const std::wstring& path, bool private_acl) {
	Handle handle(CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
							  FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
							  FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
	BY_HANDLE_FILE_INFORMATION info{};
	if (!handle || !ordinary(handle.value, true, info) || (private_acl && !secure(handle.value))) return false;
	auto actual = resolved(handle.value);
	if (!local_path(actual)) return false;
	wchar_t filesystem[32]{};
	DWORD flags = 0;
	if (!GetVolumeInformationByHandleW(handle.value, nullptr, 0, nullptr, nullptr, &flags, filesystem, 32) ||
		std::wstring(filesystem) != L"NTFS" || !(flags & FILE_PERSISTENT_ACLS) ||
		GetDriveTypeW(actual.substr(0, 7).c_str()) != DRIVE_FIXED)
		return false;
	if (!same_path(actual, path) || (!pins_.empty() && info.dwVolumeSerialNumber != volume_)) return false;
	volume_ = info.dwVolumeSerialNumber;
	path_ = actual;
	pins_.push_back({std::move(handle), std::move(actual), private_acl});
	return true;
}
bool Directory::pin_root(const std::wstring& input, bool private_acl) {
	if (input.empty() || input.size() > 30000) return false;
	auto path = input;
	for (auto& c : path)
		if (c == L'/') c = L'\\';
	if (path.size() >= 3 && path[1] == L':' && path[2] == L'\\') path = L"\\\\?\\" + path;
	if (!local_path(path)) return false;
	while (path.size() > 7 && path.back() == L'\\') path.pop_back();
	if (!pin(path.substr(0, 7), path.size() == 7 && private_acl)) return false;
	for (std::size_t start = 7; start < path.size();) {
		const auto found = path.find(L'\\', start), end = found == std::wstring::npos ? path.size() : found;
		const auto part = path.substr(start, end - start);
		if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ' ||
			part.find(L':') != std::wstring::npos)
			return false;
		if (!pin(path.substr(0, end), end == path.size() && private_acl)) return false;
		start = end + 1;
	}
	return true;
}
bool Directory::child(const wchar_t* name) {
	if (!valid()) return false;
	const auto path = path_ + L"\\" + name;
	SECURITY_ATTRIBUTES sa{sizeof(sa), descriptor_, FALSE};
	if (!CreateDirectoryW(path.c_str(), &sa) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
	return pin(path, true);
}
std::unique_ptr<Directory> Directory::open(const std::wstring& path) {
	auto directory = std::unique_ptr<Directory>(new Directory);
	if (!directory->initialize_security() || !directory->pin_root(path, true)) return nullptr;
	return directory;
}
std::unique_ptr<Directory> Directory::production(const std::string& hash) {
	auto directory = std::unique_ptr<Directory>(new Directory);
	if (!directory->initialize_security()) return nullptr;
	PWSTR root = nullptr;
	const auto located = SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &root);
	struct KnownFolder {
		PWSTR value;
		~KnownFolder() { CoTaskMemFree(value); }
	} folder{root};
	if (FAILED(located) || !root || !directory->pin_root(root, false) || !directory->child(L"Licensecc") ||
		!directory->child(L"device-bound-v1") || !directory->child(std::wstring(hash.begin(), hash.end()).c_str()))
		return nullptr;
	return directory;
}
Handle Directory::file(const wchar_t* name, DWORD access, DWORD creation, DWORD share) {
	if (!valid()) {
		SetLastError(ERROR_ACCESS_DENIED);
		return {};
	}
	SECURITY_ATTRIBUTES sa{sizeof(sa), descriptor_, FALSE};
	return Handle(CreateFileW((path_ + L"\\" + name).c_str(), access | READ_CONTROL | FILE_READ_ATTRIBUTES, share, &sa,
							  creation, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
}
bool Directory::valid_file(HANDLE file, const wchar_t* name, std::uint64_t max_size) const {
	BY_HANDLE_FILE_INFORMATION info{};
	return valid() && ordinary(file, false, info) && info.dwVolumeSerialNumber == volume_ &&
		   ((static_cast<std::uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow) <= max_size &&
		   same_path(resolved(file), path_ + L"\\" + name) && secure(file);
}
bool Directory::valid() const noexcept {
	try {
		if (pins_.empty()) return false;
		HANDLE impersonation = nullptr;
		if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &impersonation)) {
			CloseHandle(impersonation);
			return false;
		}
		if (GetLastError() != ERROR_NO_TOKEN) return false;
		for (const auto& pin : pins_) {
			BY_HANDLE_FILE_INFORMATION info{};
			if (!ordinary(pin.handle.value, true, info) || info.dwVolumeSerialNumber != volume_ ||
				!same_path(resolved(pin.handle.value), pin.path) || (pin.private_acl && !secure(pin.handle.value)))
				return false;
		}
		return true;
	} catch (...) {
		return false;
	}
}
}  // namespace checkpoint_windows
}  // namespace device_identity
}  // namespace license
