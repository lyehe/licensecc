#ifndef TEST_WINDOWS_ACL_TEST_HPP_
#define TEST_WINDOWS_ACL_TEST_HPP_

// Windows-only ACL inspection/setup helpers for generator security tests.
// They intentionally live under test/ so production publication code has no
// test-only access-control surface.

#ifdef _WIN32

#include <windows.h>
#include <aclapi.h>

#include <boost/filesystem/path.hpp>

#include <stdexcept>
#include <string>
#include <vector>

namespace test_windows_acl {

inline std::runtime_error windows_error(const std::string& action, DWORD error) {
	return std::runtime_error(action + " (Windows error " + std::to_string(static_cast<unsigned long>(error)) + ")");
}

inline std::vector<unsigned char> current_user_sid() {
	HANDLE token = nullptr;
	if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
		throw windows_error("Cannot open the current process token", GetLastError());
	}
	DWORD bytes = 0;
	(void)GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
	const DWORD query_error = GetLastError();
	if (bytes == 0U || query_error != ERROR_INSUFFICIENT_BUFFER) {
		CloseHandle(token);
		throw windows_error("Cannot size the current process user token", query_error);
	}
	std::vector<unsigned char> token_info(bytes);
	if (!GetTokenInformation(token, TokenUser, token_info.data(), bytes, &bytes)) {
		const DWORD error = GetLastError();
		CloseHandle(token);
		throw windows_error("Cannot read the current process user token", error);
	}
	CloseHandle(token);
	const TOKEN_USER* user = reinterpret_cast<const TOKEN_USER*>(token_info.data());
	const DWORD sid_bytes = GetLengthSid(user->User.Sid);
	if (sid_bytes == 0U) {
		throw windows_error("Cannot size the current process user SID", GetLastError());
	}
	std::vector<unsigned char> sid(sid_bytes);
	if (!CopySid(sid_bytes, sid.data(), user->User.Sid)) {
		throw windows_error("Cannot copy the current process user SID", GetLastError());
	}
	return sid;
}

inline std::vector<unsigned char> world_sid() {
	DWORD bytes = 0;
	(void)CreateWellKnownSid(WinWorldSid, nullptr, nullptr, &bytes);
	if (bytes == 0U || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
		throw windows_error("Cannot size the World SID", GetLastError());
	}
	std::vector<unsigned char> sid(bytes);
	if (!CreateWellKnownSid(WinWorldSid, nullptr, sid.data(), &bytes)) {
		throw windows_error("Cannot create the World SID", GetLastError());
	}
	return sid;
}

inline size_t access_allowed_ace_size(PSID sid) {
	return sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid);
}

inline bool grants_read(DWORD access_mask) {
	return (access_mask & (GENERIC_READ | GENERIC_ALL | FILE_GENERIC_READ | FILE_ALL_ACCESS)) != 0U;
}

class FileSecurityDescriptor {
public:
	explicit FileSecurityDescriptor(const boost::filesystem::path& path)
		: m_descriptor(nullptr), m_owner(nullptr), m_dacl(nullptr) {
		const std::wstring native_path = path.wstring();
		const DWORD error = GetNamedSecurityInfoW(const_cast<wchar_t*>(native_path.c_str()), SE_FILE_OBJECT,
			OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &m_owner, nullptr, &m_dacl, nullptr,
			&m_descriptor);
		if (error != ERROR_SUCCESS) {
			throw windows_error("Cannot inspect file security descriptor", error);
		}
	}

	~FileSecurityDescriptor() {
		if (m_descriptor != nullptr) {
			LocalFree(m_descriptor);
		}
	}

	FileSecurityDescriptor(const FileSecurityDescriptor&) = delete;
	FileSecurityDescriptor& operator=(const FileSecurityDescriptor&) = delete;

	bool dacl_is_protected() const {
		SECURITY_DESCRIPTOR_CONTROL control = 0;
		DWORD revision = 0;
		if (!GetSecurityDescriptorControl(m_descriptor, &control, &revision)) {
			throw windows_error("Cannot inspect DACL protection", GetLastError());
		}
		return (control & SE_DACL_PROTECTED) != 0U;
	}

	PACL dacl() const { return m_dacl; }
	PSID owner() const { return m_owner; }

private:
	PSECURITY_DESCRIPTOR m_descriptor;
	PSID m_owner;
	PACL m_dacl;
};

inline size_t ace_count(PACL dacl) {
	if (dacl == nullptr) {
		return 0U;
	}
	ACL_SIZE_INFORMATION information = {};
	if (!GetAclInformation(dacl, &information, sizeof(information), AclSizeInformation)) {
		throw windows_error("Cannot inspect DACL entries", GetLastError());
	}
	return information.AceCount;
}

inline ACCESS_ALLOWED_ACE* access_allowed_ace(PACL dacl, DWORD index) {
	void* raw_ace = nullptr;
	if (!GetAce(dacl, index, &raw_ace)) {
		throw windows_error("Cannot inspect DACL entry", GetLastError());
	}
	ACE_HEADER* header = static_cast<ACE_HEADER*>(raw_ace);
	return header->AceType == ACCESS_ALLOWED_ACE_TYPE ? static_cast<ACCESS_ALLOWED_ACE*>(raw_ace) : nullptr;
}

struct AclSnapshot {
	bool dacl_protected;
	bool owner_is_current_user;
	bool only_current_user_allow_ace;
	bool current_user_can_read;
	bool has_inherited_world_read;
	bool temporary_attribute;
	size_t entries;
};

inline AclSnapshot inspect_file_acl(const boost::filesystem::path& path) {
	std::vector<unsigned char> current_user = current_user_sid();
	std::vector<unsigned char> world = world_sid();
	FileSecurityDescriptor descriptor(path);
	const size_t entries = ace_count(descriptor.dacl());
	bool current_user_can_read = false;
	bool inherited_world_read = false;
	bool only_current_user_allow_ace = entries == 1U;
	for (DWORD index = 0; index < static_cast<DWORD>(entries); ++index) {
		ACCESS_ALLOWED_ACE* ace = access_allowed_ace(descriptor.dacl(), index);
		if (ace == nullptr) {
			only_current_user_allow_ace = false;
			continue;
		}
		PSID ace_sid = static_cast<PSID>(&ace->SidStart);
		const bool is_current_user = EqualSid(ace_sid, current_user.data()) != FALSE;
		if (is_current_user && grants_read(ace->Mask)) {
			current_user_can_read = true;
		}
		if ((ace->Header.AceFlags & INHERITED_ACE) != 0U && EqualSid(ace_sid, world.data()) != FALSE &&
			grants_read(ace->Mask)) {
			inherited_world_read = true;
		}
		if (!is_current_user || (ace->Header.AceFlags & INHERITED_ACE) != 0U) {
			only_current_user_allow_ace = false;
		}
	}
	const std::wstring native_path = path.wstring();
	const DWORD attributes = GetFileAttributesW(native_path.c_str());
	if (attributes == INVALID_FILE_ATTRIBUTES) {
		throw windows_error("Cannot inspect file attributes", GetLastError());
	}
	return {descriptor.dacl_is_protected(), descriptor.owner() != nullptr &&
			EqualSid(descriptor.owner(), current_user.data()) != FALSE,
		only_current_user_allow_ace, current_user_can_read, inherited_world_read,
		(attributes & FILE_ATTRIBUTE_TEMPORARY) != 0U, entries};
}

inline void make_directory_permissive_for_test(const boost::filesystem::path& directory) {
	std::vector<unsigned char> current_user = current_user_sid();
	std::vector<unsigned char> world = world_sid();
	const DWORD inherit_flags = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
	const size_t bytes = sizeof(ACL) + access_allowed_ace_size(current_user.data()) +
		access_allowed_ace_size(world.data());
	std::vector<DWORD> storage((bytes + sizeof(DWORD) - 1U) / sizeof(DWORD));
	PACL dacl = reinterpret_cast<PACL>(storage.data());
	if (!InitializeAcl(dacl, static_cast<DWORD>(storage.size() * sizeof(DWORD)), ACL_REVISION)) {
		throw windows_error("Cannot initialize permissive test DACL", GetLastError());
	}
	if (!AddAccessAllowedAceEx(dacl, ACL_REVISION, inherit_flags, FILE_ALL_ACCESS, current_user.data())) {
		throw windows_error("Cannot add current-user test DACL entry", GetLastError());
	}
	if (!AddAccessAllowedAceEx(dacl, ACL_REVISION, inherit_flags, GENERIC_READ, world.data())) {
		throw windows_error("Cannot add World-read test DACL entry", GetLastError());
	}
	const std::wstring native_path = directory.wstring();
	const DWORD error = SetNamedSecurityInfoW(const_cast<wchar_t*>(native_path.c_str()), SE_FILE_OBJECT,
		DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr);
	if (error != ERROR_SUCCESS) {
		throw windows_error("Cannot set permissive test directory DACL", error);
	}
}

// Deliberately replace an already-open test file's DACL with a broad, but
// protected, descriptor.  The generator's production verifier must reject
// this even though the creating process still retains full control.  Keeping
// the mutation handle-based avoids a path/reparse race in the test seam.
inline void make_open_file_permissive_for_test(HANDLE handle) {
	std::vector<unsigned char> current_user = current_user_sid();
	std::vector<unsigned char> world = world_sid();
	const size_t bytes = sizeof(ACL) + access_allowed_ace_size(current_user.data()) +
		access_allowed_ace_size(world.data());
	std::vector<DWORD> storage((bytes + sizeof(DWORD) - 1U) / sizeof(DWORD));
	PACL dacl = reinterpret_cast<PACL>(storage.data());
	if (!InitializeAcl(dacl, static_cast<DWORD>(storage.size() * sizeof(DWORD)), ACL_REVISION)) {
		throw windows_error("Cannot initialize permissive open-file test DACL", GetLastError());
	}
	if (!AddAccessAllowedAceEx(dacl, ACL_REVISION, 0, FILE_ALL_ACCESS, current_user.data())) {
		throw windows_error("Cannot add current-user open-file test DACL entry", GetLastError());
	}
	if (!AddAccessAllowedAceEx(dacl, ACL_REVISION, 0, GENERIC_READ, world.data())) {
		throw windows_error("Cannot add World-read open-file test DACL entry", GetLastError());
	}
	const DWORD error = SetSecurityInfo(handle, SE_FILE_OBJECT,
		DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr);
	if (error != ERROR_SUCCESS) {
		throw windows_error("Cannot set permissive open-file test DACL", error);
	}
}

}  // namespace test_windows_acl

#endif  // _WIN32

#endif  // TEST_WINDOWS_ACL_TEST_HPP_
