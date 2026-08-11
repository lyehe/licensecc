/*
 * Secure same-directory file publication helpers.
 *
 * These helpers are deliberately small because licenses and private keys are
 * security-sensitive artifacts.  Data is written to an exclusively-created
 * temporary file in the destination directory, then published atomically.
 */
#ifndef SRC_LICENSE_GENERATOR_FILE_PUBLISH_HPP_
#define SRC_LICENSE_GENERATOR_FILE_PUBLISH_HPP_

#include <boost/filesystem/path.hpp>
#include <string>

namespace license {
namespace file_publish {

// Create destination only when it does not exist.  This is used for private
// keys: an existing key is never replaced, including when it appears in the
// interval between validation and publication.  On POSIX it is published as
// an owner-read/write-only file (0600).
void write_new_file_no_replace(const boost::filesystem::path& destination, const std::string& contents);

// Safely replace a regular (non-secret) output file after its complete new
// contents have been durably written.  A failed write/publish leaves the
// previous output intact.  New files use the caller's normal umask; existing
// regular-file permissions are preserved on POSIX.
void write_file_atomically_replace(const boost::filesystem::path& destination, const std::string& contents);

// Return true when an output target names the same file as a protected input.
// Absolute lexical paths are normalized (including Windows case), then
// filesystem identity is checked when both entries exist so hardlink and
// symlink aliases cannot turn an output operation into key destruction.
// Inspection errors fail closed by throwing std::runtime_error.
bool output_target_matches_input_file(const boost::filesystem::path& output,
										  const boost::filesystem::path& protected_input);

// Test-only synchronization seam.  It runs after the temporary file has been
// fully written and before publication.  It is intentionally inert unless a
// unit test installs it, and enables deterministic race/failure coverage.
typedef void (*BeforePublishTestHook)(const boost::filesystem::path& destination);
void set_before_publish_test_hook(BeforePublishTestHook hook);

// Windows-only test seam for the private-key temporary-file security check.
// It runs after exclusive creation and before the first byte is written.  The
// native handle is deliberately opaque so callers outside the Windows tests do
// not acquire a production access-control API.  Production leaves this hook
// unset; its fault values let the tests characterize fail-closed capability
// and readback failures without depending on a particular filesystem.
enum PrivateFileSecurityVerificationTestAction {
	PRIVATE_FILE_SECURITY_VERIFICATION_TEST_CONTINUE = 0,
	PRIVATE_FILE_SECURITY_VERIFICATION_TEST_PERSISTENT_ACLS_UNSUPPORTED,
	PRIVATE_FILE_SECURITY_VERIFICATION_TEST_READBACK_FAILURE
};
typedef PrivateFileSecurityVerificationTestAction (*BeforePrivateFileSecurityVerificationTestHook)(
	const boost::filesystem::path& temporary, void* native_handle);
void set_before_private_file_security_verification_test_hook(
	BeforePrivateFileSecurityVerificationTestHook hook);

}  // namespace file_publish
}  // namespace license

#endif  // SRC_LICENSE_GENERATOR_FILE_PUBLISH_HPP_
