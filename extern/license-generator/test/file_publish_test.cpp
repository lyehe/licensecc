#define BOOST_TEST_MODULE test_file_publish

#include <boost/filesystem.hpp>
#include <boost/test/unit_test.hpp>
#include <build_properties.h>

#include <fstream>
#include <stdexcept>
#include <string>

#ifndef _WIN32
#include <sys/stat.h>
#else
#include "windows_acl_test.hpp"
#endif

#include "../src/license_generator/file_publish.hpp"

namespace fs = boost::filesystem;
using namespace license::file_publish;
using namespace std;

static fs::path test_directory() {
	const fs::path directory = fs::path(PROJECT_TEST_TEMP_DIR) / "file_publish";
	fs::remove_all(directory);
	fs::create_directories(directory);
	return directory;
}

static string read_file(const fs::path& path) {
	ifstream input(path.string().c_str(), ios::binary);
	return string((istreambuf_iterator<char>(input)), istreambuf_iterator<char>());
}

static void write_file(const fs::path& path, const string& contents) {
	ofstream output(path.string().c_str(), ios::binary | ios::trunc);
	BOOST_REQUIRE(output.is_open());
	output << contents;
	BOOST_REQUIRE(output.good());
}

static void create_racing_destination(const fs::path& destination) {
	write_file(destination, "created-by-race");
}

static void fail_before_publish(const fs::path&) {
	throw runtime_error("forced deterministic publication failure");
}

static bool has_temporary_files(const fs::path& directory) {
	for (fs::directory_iterator entry(directory), end; entry != end; ++entry) {
		if (entry->path().extension() == ".tmp") {
			return true;
		}
	}
	return false;
}

BOOST_AUTO_TEST_CASE(no_replace_is_atomic_at_the_publication_boundary) {
	const fs::path destination = test_directory() / "private_key.rsa";
	set_before_publish_test_hook(&create_racing_destination);
	BOOST_CHECK_THROW(write_new_file_no_replace(destination, "new-private-key"), runtime_error);
	set_before_publish_test_hook(nullptr);
	BOOST_REQUIRE(fs::exists(destination));
	BOOST_CHECK_EQUAL(read_file(destination), "created-by-race");
	BOOST_CHECK_MESSAGE(!has_temporary_files(destination.parent_path()),
						"private-key publication race leaves no temporary file behind");
}

BOOST_AUTO_TEST_CASE(no_replace_preserves_existing_private_key) {
	const fs::path destination = test_directory() / "private_key.rsa";
	write_file(destination, "original-private-key");
	BOOST_CHECK_THROW(write_new_file_no_replace(destination, "replacement-private-key"), runtime_error);
	BOOST_CHECK_EQUAL(read_file(destination), "original-private-key");
	BOOST_CHECK_MESSAGE(!has_temporary_files(destination.parent_path()),
						"existing private-key rejection leaves no temporary file behind");
}

BOOST_AUTO_TEST_CASE(replace_leaves_old_output_untouched_on_prepublication_failure) {
	const fs::path destination = test_directory() / "license.lic";
	write_file(destination, "old-license");
	set_before_publish_test_hook(&fail_before_publish);
	BOOST_CHECK_THROW(write_file_atomically_replace(destination, "new-license"), runtime_error);
	set_before_publish_test_hook(nullptr);
	BOOST_CHECK_EQUAL(read_file(destination), "old-license");
	BOOST_CHECK_MESSAGE(!has_temporary_files(destination.parent_path()),
						"failed replacement leaves no temporary file behind");
}

BOOST_AUTO_TEST_CASE(replace_publishes_complete_new_output) {
	const fs::path destination = test_directory() / "license.lic";
	write_file(destination, "old-license");
	write_file_atomically_replace(destination, "new-license");
	BOOST_CHECK_EQUAL(read_file(destination), "new-license");
}

#ifdef _WIN32
static bool g_private_security_hook_observed_empty_file = false;

static void observe_empty_private_security_temporary(void* native_handle) {
	LARGE_INTEGER size = {};
	if (!GetFileSizeEx(static_cast<HANDLE>(native_handle), &size)) {
		throw test_windows_acl::windows_error("Cannot inspect private-key temporary length", GetLastError());
	}
	g_private_security_hook_observed_empty_file = size.QuadPart == 0;
}

static PrivateFileSecurityVerificationTestAction private_security_persistent_acls_unsupported(
	const fs::path&, void* native_handle) {
	observe_empty_private_security_temporary(native_handle);
	return PRIVATE_FILE_SECURITY_VERIFICATION_TEST_PERSISTENT_ACLS_UNSUPPORTED;
}

static PrivateFileSecurityVerificationTestAction private_security_readback_failure(
	const fs::path&, void* native_handle) {
	observe_empty_private_security_temporary(native_handle);
	return PRIVATE_FILE_SECURITY_VERIFICATION_TEST_READBACK_FAILURE;
}

static PrivateFileSecurityVerificationTestAction private_security_mutate_dacl(
	const fs::path&, void* native_handle) {
	observe_empty_private_security_temporary(native_handle);
	test_windows_acl::make_open_file_permissive_for_test(static_cast<HANDLE>(native_handle));
	return PRIVATE_FILE_SECURITY_VERIFICATION_TEST_CONTINUE;
}

class PrivateSecurityVerificationHookScope {
public:
	explicit PrivateSecurityVerificationHookScope(BeforePrivateFileSecurityVerificationTestHook hook) {
		set_before_private_file_security_verification_test_hook(hook);
	}

	~PrivateSecurityVerificationHookScope() {
		set_before_private_file_security_verification_test_hook(nullptr);
	}

	PrivateSecurityVerificationHookScope(const PrivateSecurityVerificationHookScope&) = delete;
	PrivateSecurityVerificationHookScope& operator=(const PrivateSecurityVerificationHookScope&) = delete;
};

static void expect_private_security_verification_failure(BeforePrivateFileSecurityVerificationTestHook hook,
														 const char* description) {
	const fs::path directory = test_directory();
	const fs::path destination = directory / "private_key.rsa";
	g_private_security_hook_observed_empty_file = false;
	{
		PrivateSecurityVerificationHookScope hook_scope(hook);
		BOOST_CHECK_THROW(write_new_file_no_replace(destination, "private-key-bytes"), runtime_error);
	}
	BOOST_CHECK_MESSAGE(g_private_security_hook_observed_empty_file,
		"private-key verification runs before the first WriteFile for " << description);
	BOOST_CHECK_MESSAGE(!fs::exists(destination),
		"private-key verification failure leaves no destination for " << description);
	BOOST_CHECK_MESSAGE(!has_temporary_files(directory),
		"private-key verification failure leaves no temporary file for " << description);
}

BOOST_AUTO_TEST_CASE(private_key_publication_fails_closed_when_acl_enforcement_or_readback_cannot_be_verified) {
	expect_private_security_verification_failure(&private_security_persistent_acls_unsupported,
		"unsupported persistent ACLs");
	expect_private_security_verification_failure(&private_security_readback_failure, "ACL readback failure");
	expect_private_security_verification_failure(&private_security_mutate_dacl,
		"a silently altered private-key DACL");
}

BOOST_AUTO_TEST_CASE(private_key_security_verification_hook_never_changes_regular_output_behavior) {
	const fs::path directory = test_directory();
	const fs::path destination = directory / "ordinary-output.lic";
	{
		PrivateSecurityVerificationHookScope hook_scope(&private_security_persistent_acls_unsupported);
		write_file_atomically_replace(destination, "ordinary-output");
	}
	BOOST_CHECK_EQUAL(read_file(destination), "ordinary-output");
	BOOST_CHECK_MESSAGE(!has_temporary_files(directory),
		"regular output remains publishable while private-key verification testing is active");
}

BOOST_AUTO_TEST_CASE(private_key_publication_restricts_a_permissive_parent_acl_without_changing_normal_outputs) {
	const fs::path directory = test_directory();
	test_windows_acl::make_directory_permissive_for_test(directory);

	// A normal baseline private-key-shaped file inherits the broad World-read
	// ACE from this deliberately permissive project directory. This captures
	// the vulnerable Windows default before exercising the protected publisher.
	const fs::path baseline_key = directory / "baseline-private-key.rsa";
	write_file(baseline_key, "baseline-private-key");
	const test_windows_acl::AclSnapshot baseline_acl = test_windows_acl::inspect_file_acl(baseline_key);
	BOOST_REQUIRE_MESSAGE(baseline_acl.has_inherited_world_read,
						  "baseline private key inherits broad World read from the permissive parent");

	// write_new_file_no_replace creates a private temporary and atomically
	// publishes it. The final key must retain that protected descriptor rather
	// than inheriting the directory ACL during either phase.
	const fs::path private_key = directory / "private_key.rsa";
	write_new_file_no_replace(private_key, "private-key");
	const test_windows_acl::AclSnapshot private_acl = test_windows_acl::inspect_file_acl(private_key);
	BOOST_CHECK_MESSAGE(private_acl.dacl_protected, "private key DACL blocks inherited ACEs");
	BOOST_CHECK_MESSAGE(private_acl.owner_is_current_user, "private key owner is the current process user");
	BOOST_CHECK_EQUAL(private_acl.entries, static_cast<size_t>(1));
	BOOST_CHECK_MESSAGE(private_acl.only_current_user_allow_ace,
						"private key has no non-current-user allow ACE");
	BOOST_CHECK_MESSAGE(private_acl.current_user_can_read, "current owner can read the private key");
	BOOST_CHECK_MESSAGE(!private_acl.has_inherited_world_read,
						"private key has no inherited broad-read ACE");
	BOOST_CHECK_MESSAGE(!private_acl.temporary_attribute,
						"private key publication does not retain FILE_ATTRIBUTE_TEMPORARY");
	BOOST_CHECK_EQUAL(read_file(private_key), "private-key");

	// Public license/test-sign style outputs remain normal files: they retain
	// the parent ACL and are not accidentally published with the private-key
	// descriptor or temporary attribute.
	const fs::path regular_output = directory / "ordinary-output.lic";
	write_file_atomically_replace(regular_output, "ordinary-output");
	const test_windows_acl::AclSnapshot regular_acl = test_windows_acl::inspect_file_acl(regular_output);
	BOOST_CHECK_MESSAGE(regular_acl.has_inherited_world_read,
						"ordinary output retains the parent ACL instead of becoming private");
	BOOST_CHECK_MESSAGE(!regular_acl.temporary_attribute,
						"ordinary output does not retain FILE_ATTRIBUTE_TEMPORARY");
	BOOST_CHECK_MESSAGE(!has_temporary_files(directory), "successful publication leaves no temporary files behind");
}
#endif

#ifndef _WIN32
static mode_t permissions_for(const fs::path& path) {
	struct stat st;
	BOOST_REQUIRE_EQUAL(stat(path.string().c_str(), &st), 0);
	return st.st_mode & (S_IRWXU | S_IRWXG | S_IRWXO);
}

BOOST_AUTO_TEST_CASE(private_key_publication_is_owner_only) {
	const fs::path destination = test_directory() / "private_key.rsa";
	const mode_t original_umask = umask(0);
	try {
		write_new_file_no_replace(destination, "private-key");
	} catch (...) {
		umask(original_umask);
		throw;
	}
	umask(original_umask);
	BOOST_CHECK_EQUAL(permissions_for(destination), static_cast<mode_t>(S_IRUSR | S_IWUSR));
}

BOOST_AUTO_TEST_CASE(new_regular_output_honors_umask) {
	const fs::path destination = test_directory() / "new-license.lic";
	const mode_t original_umask = umask(S_IWGRP | S_IROTH | S_IWOTH);
	try {
		write_file_atomically_replace(destination, "license");
	} catch (...) {
		umask(original_umask);
		throw;
	}
	umask(original_umask);
	BOOST_CHECK_EQUAL(permissions_for(destination), static_cast<mode_t>(S_IRUSR | S_IWUSR | S_IRGRP));
}

BOOST_AUTO_TEST_CASE(replacement_preserves_regular_output_permissions) {
	const fs::path destination = test_directory() / "license.lic";
	write_file(destination, "old-license");
	BOOST_REQUIRE_EQUAL(chmod(destination.string().c_str(), S_IRUSR | S_IWUSR | S_IRGRP), 0);
	write_file_atomically_replace(destination, "new-license");
	BOOST_CHECK_EQUAL(permissions_for(destination), static_cast<mode_t>(S_IRUSR | S_IWUSR | S_IRGRP));
}
#endif
