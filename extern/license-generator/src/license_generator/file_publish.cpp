/*
 * Secure same-directory file publication helpers.
 */
#include "file_publish.hpp"

#include <algorithm>
#include <boost/filesystem.hpp>
#include <boost/system/error_code.hpp>
#include <boost/version.hpp>
#include <cerrno>
#include <cctype>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <aclapi.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace license {
namespace file_publish {
namespace fs = boost::filesystem;

namespace {

BeforePublishTestHook g_before_publish_test_hook = nullptr;
BeforePrivateFileSecurityVerificationTestHook g_before_private_file_security_verification_test_hook = nullptr;

#ifdef _WIN32
static PrivateFileSecurityVerificationTestAction run_before_private_file_security_verification_test_hook(
	const fs::path& temporary, HANDLE handle);
#endif

static std::runtime_error file_error(const std::string& action, const fs::path& path) {
#ifdef _WIN32
	return std::runtime_error(action + " [" + path.string() + "] (Windows error " +
						  std::to_string(static_cast<unsigned long>(GetLastError())) + ")");
#else
	return std::runtime_error(action + " [" + path.string() + "]: " + std::strerror(errno));
#endif
}

#ifdef _WIN32
static std::runtime_error private_file_security_error(const std::string& action, const fs::path& path, DWORD error) {
	return std::runtime_error(action + " [" + path.string() + "] (Windows error " +
						  std::to_string(static_cast<unsigned long>(error)) + ")");
}

class ScopedWindowsHandle {
public:
	explicit ScopedWindowsHandle(HANDLE handle = INVALID_HANDLE_VALUE) : m_handle(handle) {}

	~ScopedWindowsHandle() {
		close_noexcept();
	}

	ScopedWindowsHandle(const ScopedWindowsHandle&) = delete;
	ScopedWindowsHandle& operator=(const ScopedWindowsHandle&) = delete;

	HANDLE get() const { return m_handle; }

	bool close(DWORD* error) {
		if (m_handle == nullptr || m_handle == INVALID_HANDLE_VALUE) {
			return true;
		}
		const HANDLE handle = m_handle;
		m_handle = INVALID_HANDLE_VALUE;
		if (CloseHandle(handle)) {
			return true;
		}
		if (error != nullptr) {
			*error = GetLastError();
		}
		return false;
	}

	void close_noexcept() {
		DWORD ignored_error = ERROR_SUCCESS;
		(void)close(&ignored_error);
	}

private:
	HANDLE m_handle;
};

class ScopedLocalSecurityDescriptor {
public:
	explicit ScopedLocalSecurityDescriptor(PSECURITY_DESCRIPTOR descriptor = nullptr) : m_descriptor(descriptor) {}

	~ScopedLocalSecurityDescriptor() {
		if (m_descriptor != nullptr) {
			LocalFree(m_descriptor);
		}
	}

	ScopedLocalSecurityDescriptor(const ScopedLocalSecurityDescriptor&) = delete;
	ScopedLocalSecurityDescriptor& operator=(const ScopedLocalSecurityDescriptor&) = delete;

private:
	PSECURITY_DESCRIPTOR m_descriptor;
};

// Build the private-key descriptor before CreateFileW creates the temporary
// file. Supplying an explicit protected DACL here is essential: inheriting a
// permissive project-directory DACL and fixing it after WriteFile would expose
// private key bytes during that interval. The current process user is the only
// required principal; no broad inherited or system ACE is needed to generate,
// read, or atomically publish a user-owned signing key.
class PrivateFileSecurityAttributes {
public:
	explicit PrivateFileSecurityAttributes(const fs::path& destination) : m_descriptor(), m_attributes() {
		HANDLE token = nullptr;
		if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
			throw private_file_security_error("Cannot open the current process token for private-key publication",
											 destination, GetLastError());
		}
		ScopedWindowsHandle token_handle(token);
		DWORD token_bytes = 0;
		(void)GetTokenInformation(token, TokenUser, nullptr, 0, &token_bytes);
		const DWORD size_error = GetLastError();
		if (token_bytes == 0U || size_error != ERROR_INSUFFICIENT_BUFFER) {
			throw private_file_security_error("Cannot size the current process user for private-key publication",
											 destination, size_error);
		}
		m_token_user.resize(token_bytes);
		if (!GetTokenInformation(token, TokenUser, m_token_user.data(), token_bytes, &token_bytes)) {
			const DWORD error = GetLastError();
			throw private_file_security_error("Cannot read the current process user for private-key publication",
											 destination, error);
		}
		DWORD token_close_error = ERROR_SUCCESS;
		if (!token_handle.close(&token_close_error)) {
			throw private_file_security_error("Cannot close the current process token for private-key publication",
											 destination, token_close_error);
		}

		const TOKEN_USER* user = reinterpret_cast<const TOKEN_USER*>(m_token_user.data());
		if (user->User.Sid == nullptr || !IsValidSid(user->User.Sid)) {
			throw std::runtime_error("Current process user has no valid SID for private-key publication [" +
							 destination.string() + "]");
		}
		const DWORD sid_bytes = GetLengthSid(user->User.Sid);
		if (sid_bytes == 0U) {
			throw private_file_security_error("Cannot size the current process SID for private-key publication",
											 destination, GetLastError());
		}
		m_user_sid.resize(sid_bytes);
		if (!CopySid(sid_bytes, m_user_sid.data(), user->User.Sid)) {
			throw private_file_security_error("Cannot copy the current process SID for private-key publication",
											 destination, GetLastError());
		}

		const size_t ace_bytes = sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + sid_bytes;
		const size_t acl_bytes = sizeof(ACL) + ace_bytes;
		m_acl_storage.resize((acl_bytes + sizeof(DWORD) - 1U) / sizeof(DWORD));
		PACL dacl = reinterpret_cast<PACL>(m_acl_storage.data());
		if (!InitializeAcl(dacl, static_cast<DWORD>(m_acl_storage.size() * sizeof(DWORD)), ACL_REVISION)) {
			throw private_file_security_error("Cannot initialize private-key DACL", destination, GetLastError());
		}
		if (!AddAccessAllowedAceEx(dacl, ACL_REVISION, 0, FILE_ALL_ACCESS, m_user_sid.data())) {
			throw private_file_security_error("Cannot restrict private-key DACL to the current process user", destination,
											 GetLastError());
		}
		if (!InitializeSecurityDescriptor(&m_descriptor, SECURITY_DESCRIPTOR_REVISION)) {
			throw private_file_security_error("Cannot initialize private-key security descriptor", destination,
											 GetLastError());
		}
		if (!SetSecurityDescriptorOwner(&m_descriptor, m_user_sid.data(), FALSE)) {
			throw private_file_security_error("Cannot set the private-key owner", destination, GetLastError());
		}
		if (!SetSecurityDescriptorDacl(&m_descriptor, TRUE, dacl, FALSE)) {
			throw private_file_security_error("Cannot set the private-key DACL", destination, GetLastError());
		}
		if (!SetSecurityDescriptorControl(&m_descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
			throw private_file_security_error("Cannot protect the private-key DACL from inheritance", destination,
											 GetLastError());
		}
		m_attributes.nLength = sizeof(m_attributes);
		m_attributes.lpSecurityDescriptor = &m_descriptor;
		m_attributes.bInheritHandle = FALSE;
	}

	SECURITY_ATTRIBUTES* get() { return &m_attributes; }
	PSID user_sid() const { return const_cast<unsigned char*>(m_user_sid.data()); }

private:
	std::vector<unsigned char> m_token_user;
	std::vector<unsigned char> m_user_sid;
	std::vector<DWORD> m_acl_storage;
	SECURITY_DESCRIPTOR m_descriptor;
	SECURITY_ATTRIBUTES m_attributes;
};

static bool has_remote_protocol_information(HANDLE handle) {
	FILE_REMOTE_PROTOCOL_INFO information = {};
	information.StructureVersion = 1;
	information.StructureSize = static_cast<USHORT>(sizeof(information));
	if (!GetFileInformationByHandleEx(handle, FileRemoteProtocolInfo, &information,
			static_cast<DWORD>(sizeof(information)))) {
		return false;
	}
	return information.Protocol != 0U;
}

static void require_private_file_acl_persistence(HANDLE handle, const fs::path& temporary) {
	DWORD file_system_flags = 0;
	if (GetVolumeInformationByHandleW(handle, nullptr, 0, nullptr, nullptr, &file_system_flags, nullptr, 0)) {
		if ((file_system_flags & FILE_PERSISTENT_ACLS) == 0U) {
			throw private_file_security_error(
				"Private-key publication requires a filesystem with persistent ACL enforcement", temporary,
				ERROR_NOT_SUPPORTED);
		}
		return;
	}

	// SMB and other remote providers can reject volume capability queries even
	// when the open handle still supports security-descriptor readback.  Do not
	// guess from the path: only let that case proceed when the handle itself
	// identifies a remote protocol; every other unknown capability fails closed.
	const DWORD volume_error = GetLastError();
	if (!has_remote_protocol_information(handle)) {
		throw private_file_security_error(
			"Cannot verify filesystem ACL enforcement for private-key publication", temporary, volume_error);
	}
}

static void require_exact_private_file_security(HANDLE handle, PSID expected_owner,
												 const fs::path& temporary) {
	PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
	PSID owner = nullptr;
	PACL dacl = nullptr;
	const DWORD descriptor_error = GetSecurityInfo(handle, SE_FILE_OBJECT,
		OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, &raw_descriptor);
	if (descriptor_error != ERROR_SUCCESS) {
		throw private_file_security_error(
			"Cannot read back the private-key ACL through the new file handle", temporary, descriptor_error);
	}
	ScopedLocalSecurityDescriptor descriptor(raw_descriptor);
	if (raw_descriptor == nullptr || owner == nullptr || dacl == nullptr || expected_owner == nullptr ||
		!IsValidSid(owner) || !IsValidSid(expected_owner)) {
		throw private_file_security_error("Private-key ACL readback is incomplete", temporary, ERROR_INVALID_SECURITY_DESCR);
	}

	SECURITY_DESCRIPTOR_CONTROL control = 0;
	DWORD revision = 0;
	if (!GetSecurityDescriptorControl(raw_descriptor, &control, &revision)) {
		throw private_file_security_error("Cannot inspect private-key ACL protection", temporary, GetLastError());
	}
	if ((control & SE_DACL_PROTECTED) == 0U) {
		throw private_file_security_error(
			"Private-key ACL is not protected from inherited access", temporary, ERROR_ACCESS_DENIED);
	}
	if (EqualSid(owner, expected_owner) == FALSE) {
		throw private_file_security_error("Private-key owner does not match the current process user", temporary,
			ERROR_ACCESS_DENIED);
	}

	if (!IsValidAcl(dacl)) {
		throw private_file_security_error("Private-key ACL readback is invalid", temporary, ERROR_INVALID_ACL);
	}
	ACL_SIZE_INFORMATION information = {};
	if (!GetAclInformation(dacl, &information, sizeof(information), AclSizeInformation)) {
		throw private_file_security_error("Cannot inspect private-key ACL entries", temporary, GetLastError());
	}
	if (information.AceCount != 1U) {
		throw private_file_security_error(
			"Private-key ACL grants access to a principal other than the current process user", temporary,
			ERROR_ACCESS_DENIED);
	}

	void* raw_ace = nullptr;
	if (!GetAce(dacl, 0, &raw_ace)) {
		throw private_file_security_error("Cannot inspect private-key ACL entry", temporary, GetLastError());
	}
	ACE_HEADER* header = static_cast<ACE_HEADER*>(raw_ace);
	if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || (header->AceFlags & INHERITED_ACE) != 0U) {
		throw private_file_security_error(
			"Private-key ACL is not an explicit current-user allow entry", temporary, ERROR_ACCESS_DENIED);
	}
	ACCESS_ALLOWED_ACE* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw_ace);
	PSID ace_sid = static_cast<PSID>(&ace->SidStart);
	if (!IsValidSid(ace_sid) || EqualSid(ace_sid, expected_owner) == FALSE || ace->Mask != FILE_ALL_ACCESS) {
		throw private_file_security_error(
			"Private-key ACL does not grant exactly the required current-user access", temporary, ERROR_ACCESS_DENIED);
	}
}

static void verify_private_file_security_before_write(HANDLE handle, const PrivateFileSecurityAttributes& attributes,
													const fs::path& temporary) {
	const PrivateFileSecurityVerificationTestAction test_action =
		run_before_private_file_security_verification_test_hook(temporary, handle);
	if (test_action == PRIVATE_FILE_SECURITY_VERIFICATION_TEST_PERSISTENT_ACLS_UNSUPPORTED) {
		throw private_file_security_error(
			"Private-key publication requires a filesystem with persistent ACL enforcement", temporary,
			ERROR_NOT_SUPPORTED);
	}
	if (test_action == PRIVATE_FILE_SECURITY_VERIFICATION_TEST_READBACK_FAILURE) {
		throw private_file_security_error(
			"Cannot read back the private-key ACL through the new file handle", temporary, ERROR_ACCESS_DENIED);
	}
	if (test_action != PRIVATE_FILE_SECURITY_VERIFICATION_TEST_CONTINUE) {
		throw private_file_security_error(
			"Private-key ACL verification returned an unknown failure state", temporary, ERROR_ACCESS_DENIED);
	}
	require_private_file_acl_persistence(handle, temporary);
	require_exact_private_file_security(handle, attributes.user_sid(), temporary);
}
#endif

static void remove_temporary_file(const fs::path& path) {
	boost::system::error_code ec;
	fs::remove(path, ec);
}

static void require_destination_directory(const fs::path& destination) {
	const fs::path directory = destination.parent_path().empty() ? fs::current_path() : destination.parent_path();
	if (!fs::exists(directory) || !fs::is_directory(directory)) {
		throw std::runtime_error("Destination directory does not exist or is not a directory [" + directory.string() + "]");
	}
}

static fs::path normalized_path(fs::path path) {
#if BOOST_VERSION >= 108700
	return path.lexically_normal();
#else
	path.normalize();
	return path;
#endif
}

static fs::path absolute_normalized_path(const fs::path& path) {
	return normalized_path(fs::absolute(path));
}

static std::string comparable_path_key(fs::path path) {
	path = absolute_normalized_path(path);
	path.make_preferred();
	std::string value = path.string();
#ifdef _WIN32
	std::transform(value.begin(), value.end(), value.begin(), [](const unsigned char ch) {
		return static_cast<char>(std::tolower(ch));
	});
#endif
	return value;
}

static bool is_missing_path_error(const boost::system::error_code& error) {
	return error == boost::system::errc::make_error_condition(boost::system::errc::no_such_file_or_directory) ||
		   error == boost::system::errc::make_error_condition(boost::system::errc::not_a_directory);
}

static void reject_unsafe_existing_destination(const fs::path& destination) {
#ifdef _WIN32
	const DWORD attributes = GetFileAttributesW(destination.wstring().c_str());
	if (attributes == INVALID_FILE_ATTRIBUTES) {
		if (GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND) {
			return;
		}
		throw file_error("Cannot inspect destination", destination);
	}
	if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U) {
		throw std::runtime_error("Destination is a directory [" + destination.string() + "]");
	}
	if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0U) {
		throw std::runtime_error("Refusing to publish over a reparse point [" + destination.string() + "]");
	}
#else
	struct stat st;
	if (lstat(destination.string().c_str(), &st) != 0) {
		if (errno == ENOENT) {
			return;
		}
		throw file_error("Cannot inspect destination", destination);
	}
	if (S_ISLNK(st.st_mode)) {
		throw std::runtime_error("Refusing to publish over a symbolic link [" + destination.string() + "]");
	}
	if (S_ISDIR(st.st_mode)) {
		throw std::runtime_error("Destination is a directory [" + destination.string() + "]");
	}
	if (!S_ISREG(st.st_mode)) {
		throw std::runtime_error("Destination is not a regular file [" + destination.string() + "]");
	}
#endif
}

static fs::path create_and_write_temporary_file(const fs::path& destination, const std::string& contents,
															 bool private_file) {
	require_destination_directory(destination);
	const fs::path directory = destination.parent_path().empty() ? fs::current_path() : destination.parent_path();
#ifndef _WIN32
	// A private key must never be exposed through the process umask.  Ordinary
	// outputs keep normal new-file permissions, or the existing file's mode on
	// replacement so publication does not unexpectedly make a public header or
	// license owner-only.
	bool preserve_existing_mode = false;
	mode_t existing_mode = 0;
	if (!private_file) {
		struct stat destination_stat;
		if (lstat(destination.string().c_str(), &destination_stat) == 0) {
			if (S_ISLNK(destination_stat.st_mode) || !S_ISREG(destination_stat.st_mode)) {
				throw std::runtime_error("Refusing to publish over a non-regular destination [" +
								 destination.string() + "]");
			}
			preserve_existing_mode = true;
			existing_mode = destination_stat.st_mode & (S_IRWXU | S_IRWXG | S_IRWXO);
		} else if (errno != ENOENT) {
			throw file_error("Cannot inspect destination", destination);
		}
	}
#endif
	for (unsigned int attempt = 0; attempt != 128U; ++attempt) {
		const fs::path temporary = directory /
			fs::unique_path(destination.filename().string() + ".%%%%-%%%%-%%%%-%%%%.tmp");
#ifdef _WIN32
		HANDLE handle = INVALID_HANDLE_VALUE;
		std::unique_ptr<PrivateFileSecurityAttributes> private_security_attributes;
		if (private_file) {
			private_security_attributes.reset(new PrivateFileSecurityAttributes(temporary));
			// READ_CONTROL and file attributes are required for the handle-only
			// capability and DACL readback below. WRITE_DAC is deliberately
			// absent in production; the inert unit-test seam temporarily requests
			// it only to simulate a filesystem/provider that mutates the new ACL.
			DWORD private_access = GENERIC_WRITE | FILE_READ_ATTRIBUTES | READ_CONTROL;
			if (g_before_private_file_security_verification_test_hook != nullptr) {
				private_access |= WRITE_DAC;
			}
			handle = CreateFileW(temporary.wstring().c_str(),
								 private_access, 0,
								 private_security_attributes->get(), CREATE_NEW,
									 FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT,
									 nullptr);
		} else {
			handle = CreateFileW(temporary.wstring().c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
									 FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT,
									 nullptr);
		}
		if (handle == INVALID_HANDLE_VALUE) {
			const DWORD error = GetLastError();
			if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) {
				continue;
			}
			throw file_error("Cannot create exclusive temporary file", temporary);
		}
		ScopedWindowsHandle file_handle(handle);
		try {
			if (private_file) {
				verify_private_file_security_before_write(file_handle.get(), *private_security_attributes, temporary);
			}
			bool ok = true;
			size_t offset = 0;
			while (offset < contents.size()) {
				const size_t remaining = contents.size() - offset;
				const size_t max_chunk = static_cast<size_t>(MAXDWORD);
				const DWORD chunk = remaining > max_chunk ? MAXDWORD : static_cast<DWORD>(remaining);
				DWORD written = 0;
				if (!WriteFile(file_handle.get(), contents.data() + offset, chunk, &written, nullptr) || written == 0U) {
					ok = false;
					break;
				}
				offset += static_cast<size_t>(written);
			}
			if (ok && !FlushFileBuffers(file_handle.get())) {
				ok = false;
			}
			const DWORD write_error = ok ? ERROR_SUCCESS : GetLastError();
			DWORD close_error = ERROR_SUCCESS;
			if (!file_handle.close(&close_error)) {
				SetLastError(close_error);
				throw file_error("Cannot close temporary file", temporary);
			}
			if (!ok) {
				SetLastError(write_error);
				throw file_error("Cannot write temporary file", temporary);
			}
			return temporary;
		} catch (...) {
			file_handle.close_noexcept();
			remove_temporary_file(temporary);
			throw;
		}
#else
		int flags = O_WRONLY | O_CREAT | O_EXCL;
#ifdef O_NOFOLLOW
		flags |= O_NOFOLLOW;
#endif
		const int fd = open(temporary.string().c_str(), flags,
								private_file ? (S_IRUSR | S_IWUSR) : (S_IRUSR | S_IWUSR | S_IRGRP | S_IWGRP | S_IROTH | S_IWOTH));
		if (fd < 0) {
			if (errno == EEXIST) {
				continue;
			}
			throw file_error("Cannot create exclusive temporary file", temporary);
		}
		bool ok = true;
		int write_errno = 0;
		if ((private_file && fchmod(fd, S_IRUSR | S_IWUSR) != 0) ||
			(!private_file && preserve_existing_mode && fchmod(fd, existing_mode) != 0)) {
			ok = false;
			write_errno = errno;
		}
		size_t offset = 0;
		while (ok && offset < contents.size()) {
			const ssize_t written = write(fd, contents.data() + offset, contents.size() - offset);
			if (written <= 0) {
				ok = false;
				write_errno = errno;
				break;
			}
			offset += static_cast<size_t>(written);
		}
		if (ok && fsync(fd) != 0) {
			ok = false;
			write_errno = errno;
		}
		if (close(fd) != 0 && ok) {
			ok = false;
			write_errno = errno;
		}
		if (!ok) {
			errno = write_errno;
			remove_temporary_file(temporary);
			throw file_error("Cannot write temporary file", temporary);
		}
		return temporary;
#endif
	}
	throw std::runtime_error("Could not allocate an exclusive temporary filename beside [" + destination.string() + "]");
}

static void run_before_publish_hook(const fs::path& destination) {
	if (g_before_publish_test_hook != nullptr) {
		g_before_publish_test_hook(destination);
	}
}

#ifdef _WIN32
static PrivateFileSecurityVerificationTestAction run_before_private_file_security_verification_test_hook(
	const fs::path& temporary, HANDLE handle) {
	if (g_before_private_file_security_verification_test_hook != nullptr) {
		return g_before_private_file_security_verification_test_hook(temporary, static_cast<void*>(handle));
	}
	return PRIVATE_FILE_SECURITY_VERIFICATION_TEST_CONTINUE;
}
#endif

static void publish_no_replace(const fs::path& temporary, const fs::path& destination) {
#ifdef _WIN32
	if (!MoveFileExW(temporary.wstring().c_str(), destination.wstring().c_str(), MOVEFILE_WRITE_THROUGH)) {
		throw file_error("Refusing to overwrite existing destination", destination);
	}
#else
	if (link(temporary.string().c_str(), destination.string().c_str()) != 0) {
		throw file_error("Refusing to overwrite existing destination", destination);
	}
	if (unlink(temporary.string().c_str()) != 0) {
		throw file_error("Cannot remove temporary file after publication", temporary);
	}
#endif
}

static void publish_replace(const fs::path& temporary, const fs::path& destination) {
#ifdef _WIN32
	if (!MoveFileExW(temporary.wstring().c_str(), destination.wstring().c_str(),
						 MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
		throw file_error("Cannot replace destination", destination);
	}
#else
	if (rename(temporary.string().c_str(), destination.string().c_str()) != 0) {
		throw file_error("Cannot replace destination", destination);
	}
#endif
}

}  // namespace

void set_before_publish_test_hook(BeforePublishTestHook hook) {
	g_before_publish_test_hook = hook;
}

void set_before_private_file_security_verification_test_hook(
	BeforePrivateFileSecurityVerificationTestHook hook) {
	g_before_private_file_security_verification_test_hook = hook;
}

bool output_target_matches_input_file(const fs::path& output, const fs::path& protected_input) {
	const fs::path normalized_output = absolute_normalized_path(output);
	const fs::path normalized_input = absolute_normalized_path(protected_input);
	if (comparable_path_key(normalized_output) == comparable_path_key(normalized_input)) {
		return true;
	}

	boost::system::error_code error;
	const bool output_exists = fs::exists(normalized_output, error);
	if (error && !is_missing_path_error(error)) {
		throw std::runtime_error("Cannot inspect output target [" + normalized_output.string() +
							 "]. Refusing to compare it with protected input: " + error.message());
	}
	error.clear();
	const bool input_exists = fs::exists(normalized_input, error);
	if (error && !is_missing_path_error(error)) {
		throw std::runtime_error("Cannot inspect protected input [" + normalized_input.string() +
							 "]. Refusing output publication: " + error.message());
	}
	if (!output_exists || !input_exists) {
		return false;
	}

	const bool equivalent = fs::equivalent(normalized_output, normalized_input, error);
	if (error) {
		throw std::runtime_error("Cannot compare output target [" + normalized_output.string() +
							 "] with protected input [" + normalized_input.string() +
							 "]. Refusing output publication: " + error.message());
	}
	return equivalent;
}

void write_new_file_no_replace(const fs::path& destination, const std::string& contents) {
	reject_unsafe_existing_destination(destination);
	fs::path temporary;
	try {
		temporary = create_and_write_temporary_file(destination, contents, true);
		run_before_publish_hook(destination);
		publish_no_replace(temporary, destination);
	} catch (...) {
		if (!temporary.empty()) {
			remove_temporary_file(temporary);
		}
		throw;
	}
}

void write_file_atomically_replace(const fs::path& destination, const std::string& contents) {
	reject_unsafe_existing_destination(destination);
	fs::path temporary;
	try {
		temporary = create_and_write_temporary_file(destination, contents, false);
		run_before_publish_hook(destination);
		publish_replace(temporary, destination);
	} catch (...) {
		if (!temporary.empty()) {
			remove_temporary_file(temporary);
		}
		throw;
	}
}

}  // namespace file_publish
}  // namespace license
