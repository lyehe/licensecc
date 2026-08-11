#define BOOST_TEST_MODULE device_identity_policy_test

#include <boost/test/unit_test.hpp>
#include <licensecc/device_identity.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <string>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#include <unistd.h>
#endif

namespace {

template <std::size_t N>
void set_field(char (&field)[N], const char* value) {
    const std::size_t length = std::strlen(value);
    BOOST_REQUIRE(length < N);
    std::memcpy(field, value, length + 1U);
}

LccDeviceIdentityOptions options_for(const char* suffix, bool create = false) {
    LccDeviceIdentityOptions options;
    lcc_init_device_identity_options(&options);
    options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
    options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
    options.flags = create ? LCC_DEVICE_OPEN_CREATE_IF_MISSING : 0U;
    const std::string application_id = std::string("licensecc.test.policy.") + suffix;
    set_field(options.application_id, application_id.c_str());
    set_field(options.project, "DEFAULT");
    return options;
}

LccDeviceProofInput valid_input() {
    LccDeviceProofInput input;
    lcc_init_device_proof_input(&input);
    input.audience = LCC_DEVICE_PROOF_AUDIENCE_VERIFY;
    input.client_hardening = 5U;
    input.request_timestamp = 1700000000ULL;
    set_field(input.project, "DEFAULT");
    set_field(input.feature, "EXPORT");
    set_field(input.license_fingerprint,
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    set_field(input.device_hash, "");
    set_field(input.nonce, "f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687");
    return input;
}

}  // namespace

BOOST_AUTO_TEST_CASE(provider_policy_matrix_fails_closed_without_fallback) {
    LccDeviceIdentity* handle = reinterpret_cast<LccDeviceIdentity*>(static_cast<std::uintptr_t>(1U));
    LccDeviceIdentityOptions options = options_for("matrix", true);

    options.backend = LCC_DEVICE_BACKEND_AUTO;
    options.policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_PROVIDER_UNAVAILABLE);
    BOOST_TEST(handle == nullptr);

    options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
    options.policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_POLICY_VIOLATION);

    options.backend = LCC_DEVICE_BACKEND_WINDOWS_TPM;
    options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_POLICY_VIOLATION);

    options.backend = LCC_DEVICE_BACKEND_TPM2_OPENSSL;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_POLICY_VIOLATION);

    options = options_for("matrix", true);
    options.backend = 3U;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_INVALID_ARGUMENT);
    options = options_for("matrix", true);
    options.policy = LCC_DEVICE_POLICY_UNSPECIFIED;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_INVALID_ARGUMENT);
    options = options_for("matrix", true);
    options.scope = LCC_DEVICE_SCOPE_UNSPECIFIED;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_INVALID_ARGUMENT);
}

BOOST_AUTO_TEST_CASE(options_are_strictly_validated_before_provider_access) {
    LccDeviceIdentity* handle = nullptr;
    LccDeviceIdentityOptions options = options_for("validation");
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_KEY_NOT_FOUND);

    options = options_for("validation", true);
    options.flags |= 0x80000000U;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_INVALID_ARGUMENT);
    options = options_for("validation", true);
    options.reserved = 1U;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_INVALID_ARGUMENT);
    options = options_for("validation", true);
    options.lock_timeout_ms = 60001U;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_INVALID_ARGUMENT);
    options = options_for("validation", true);
    set_field(options.application_id, "Invalid.Application");
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_INVALID_ARGUMENT);
    options = options_for("validation", true);
    set_field(options.project, "bad project");
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_INVALID_ARGUMENT);
    options = options_for("validation", true);
    std::memset(options.application_id, 'a', sizeof(options.application_id));
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_INVALID_ARGUMENT);
}

BOOST_AUTO_TEST_CASE(expected_id_deletion_is_guarded_and_close_is_non_destructive) {
    LccDeviceIdentityOptions options = options_for("delete", true);
    LccDeviceIdentity* handle = nullptr;
    BOOST_REQUIRE(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_OK);
    LccDeviceIdentityMetadata metadata;
    lcc_init_device_identity_metadata(&metadata);
    BOOST_REQUIRE(lcc_device_identity_get_metadata(handle, &metadata) == LCC_DEVICE_OK);
    const std::string key_id(metadata.device_key_id);
    lcc_device_identity_close(handle);

    options.flags = 0U;
    std::fill(options.application_id + std::strlen(options.application_id) + 1U,
              options.application_id + sizeof(options.application_id), 'x');
    std::fill(options.project + std::strlen(options.project) + 1U,
              options.project + sizeof(options.project), 'y');
    BOOST_REQUIRE(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_OK);
    LccDeviceIdentityMetadata reopened;
    lcc_init_device_identity_metadata(&reopened);
    BOOST_REQUIRE(lcc_device_identity_get_metadata(handle, &reopened) == LCC_DEVICE_OK);
    BOOST_TEST(std::string(reopened.device_key_id) == key_id);
    lcc_device_identity_close(handle);

    BOOST_TEST(lcc_device_identity_delete_key(&options, nullptr) == LCC_DEVICE_INVALID_ARGUMENT);
    const char early_terminator[] = "sha256:";
    BOOST_TEST(lcc_device_identity_delete_key(&options, early_terminator) == LCC_DEVICE_INVALID_ARGUMENT);
    BOOST_TEST(lcc_device_identity_delete_key(
                   &options, "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") ==
               LCC_DEVICE_INVALID_ARGUMENT);
    BOOST_TEST(lcc_device_identity_delete_key(
                   &options, "sha256:0000000000000000000000000000000000000000000000000000000000000000") ==
               LCC_DEVICE_POLICY_VIOLATION);
    options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
    BOOST_TEST(lcc_device_identity_delete_key(&options, key_id.c_str()) == LCC_DEVICE_INVALID_ARGUMENT);

    options.flags = 0U;
    std::array<char, LCC_DEVICE_KEY_ID_MAX + 2U> exact_id_with_ignored_trailing_byte{};
    std::memcpy(exact_id_with_ignored_trailing_byte.data(), key_id.data(), key_id.size());
    exact_id_with_ignored_trailing_byte[LCC_DEVICE_KEY_ID_MAX] = '\0';
    exact_id_with_ignored_trailing_byte[LCC_DEVICE_KEY_ID_MAX + 1U] = 'x';
    BOOST_TEST(lcc_device_identity_delete_key(&options, exact_id_with_ignored_trailing_byte.data()) ==
               LCC_DEVICE_OK);
    BOOST_TEST(lcc_device_identity_delete_key(&options, key_id.c_str()) == LCC_DEVICE_KEY_NOT_FOUND);
}

BOOST_AUTO_TEST_CASE(expected_id_nontermination_is_bounded_at_max_plus_one) {
    LccDeviceIdentityOptions options = options_for("guard-page");
    constexpr std::size_t scan_size = LCC_DEVICE_KEY_ID_MAX + 1U;
#ifdef _WIN32
    SYSTEM_INFO system_info{};
    GetSystemInfo(&system_info);
    const std::size_t page_size = system_info.dwPageSize;
    void* allocation = VirtualAlloc(nullptr, page_size * 2U, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    BOOST_REQUIRE(allocation != nullptr);
    DWORD old_protection = 0U;
    BOOST_REQUIRE(VirtualProtect(static_cast<unsigned char*>(allocation) + page_size,
                                 page_size,
                                 PAGE_NOACCESS,
                                 &old_protection) != 0);
    char* early_terminator =
        reinterpret_cast<char*>(static_cast<unsigned char*>(allocation) + page_size - sizeof("sha256:"));
    std::memcpy(early_terminator, "sha256:", sizeof("sha256:"));
    BOOST_TEST(lcc_device_identity_delete_key(&options, early_terminator) ==
               LCC_DEVICE_INVALID_ARGUMENT);
    char* unterminated = reinterpret_cast<char*>(static_cast<unsigned char*>(allocation) + page_size - scan_size);
    std::memset(unterminated, 'a', scan_size);
    BOOST_TEST(lcc_device_identity_delete_key(&options, unterminated) == LCC_DEVICE_INVALID_ARGUMENT);
    BOOST_TEST(VirtualFree(allocation, 0U, MEM_RELEASE) != 0);
#else
    const long configured_page_size = ::sysconf(_SC_PAGESIZE);
    BOOST_REQUIRE(configured_page_size > 0);
    const std::size_t page_size = static_cast<std::size_t>(configured_page_size);
    void* allocation = ::mmap(nullptr,
                              page_size * 2U,
                              PROT_READ | PROT_WRITE,
                              MAP_PRIVATE | MAP_ANONYMOUS,
                              -1,
                              0);
    BOOST_REQUIRE(allocation != MAP_FAILED);
    BOOST_REQUIRE(::mprotect(static_cast<unsigned char*>(allocation) + page_size, page_size, PROT_NONE) == 0);
    char* early_terminator =
        reinterpret_cast<char*>(static_cast<unsigned char*>(allocation) + page_size - sizeof("sha256:"));
    std::memcpy(early_terminator, "sha256:", sizeof("sha256:"));
    BOOST_TEST(lcc_device_identity_delete_key(&options, early_terminator) ==
               LCC_DEVICE_INVALID_ARGUMENT);
    char* unterminated = reinterpret_cast<char*>(static_cast<unsigned char*>(allocation) + page_size - scan_size);
    std::memset(unterminated, 'a', scan_size);
    BOOST_TEST(lcc_device_identity_delete_key(&options, unterminated) == LCC_DEVICE_INVALID_ARGUMENT);
    BOOST_TEST(::munmap(allocation, page_size * 2U) == 0);
#endif
}

BOOST_AUTO_TEST_CASE(proof_inputs_and_outputs_are_strict_and_transactional) {
    LccDeviceIdentityOptions options = options_for("proof", true);
    LccDeviceIdentity* handle = nullptr;
    BOOST_REQUIRE(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_OK);
    LccDeviceIdentityMetadata metadata;
    lcc_init_device_identity_metadata(&metadata);
    BOOST_REQUIRE(lcc_device_identity_get_metadata(handle, &metadata) == LCC_DEVICE_OK);

    LccDeviceProofInput input = valid_input();
    std::fill(input.feature + std::strlen(input.feature) + 1U, input.feature + sizeof(input.feature), 'x');
    std::fill(input.license_fingerprint + std::strlen(input.license_fingerprint) + 1U,
              input.license_fingerprint + sizeof(input.license_fingerprint), 'y');
    LccDeviceProof output;
    lcc_init_device_proof(&output);
    BOOST_REQUIRE(lcc_device_identity_build_request_proof_v1(handle, &input, &output) == LCC_DEVICE_OK);
    BOOST_TEST(output.request_signature_version == LCC_DEVICE_PROOF_VERSION);
    BOOST_TEST(output.request_timestamp == input.request_timestamp);
    BOOST_TEST(std::string(output.device_key_id) == metadata.device_key_id);
    BOOST_TEST(std::string(output.request_signature_algorithm) == "ecdsa-p256-sha256");
    BOOST_TEST(std::string(output.request_signature).size() == LCC_DEVICE_SIGNATURE_BASE64_MAX);

    auto expect_failure_unchanged = [&](LccDeviceProofInput invalid, LCC_DEVICE_RESULT expected) {
        LccDeviceProof sentinel;
        lcc_init_device_proof(&sentinel);
        std::memset(sentinel.request_signature, 'x', sizeof(sentinel.request_signature) - 1U);
        sentinel.request_signature[sizeof(sentinel.request_signature) - 1U] = '\0';
        const LccDeviceProof before = sentinel;
        BOOST_TEST(lcc_device_identity_build_request_proof_v1(handle, &invalid, &sentinel) == expected);
        BOOST_TEST(std::memcmp(&sentinel, &before, sizeof(sentinel)) == 0);
    };

    LccDeviceProofInput invalid = input;
    invalid.audience = LCC_DEVICE_PROOF_AUDIENCE_UNSPECIFIED;
    expect_failure_unchanged(invalid, LCC_DEVICE_INVALID_ARGUMENT);
    invalid = input;
    invalid.client_hardening = 0x10000U;
    expect_failure_unchanged(invalid, LCC_DEVICE_INVALID_ARGUMENT);
    invalid = input;
    invalid.request_timestamp = 9007199254740992ULL;
    expect_failure_unchanged(invalid, LCC_DEVICE_INVALID_ARGUMENT);
    invalid = input;
    set_field(invalid.project, "OTHER");
    expect_failure_unchanged(invalid, LCC_DEVICE_POLICY_VIOLATION);
    invalid = input;
    invalid.license_fingerprint[0] = 'A';
    expect_failure_unchanged(invalid, LCC_DEVICE_INVALID_ARGUMENT);
    invalid = input;
    std::memset(invalid.nonce, 'a', sizeof(invalid.nonce));
    expect_failure_unchanged(invalid, LCC_DEVICE_INVALID_ARGUMENT);
    invalid = input;
    invalid.size = sizeof(invalid) - 1U;
    expect_failure_unchanged(invalid, LCC_DEVICE_INVALID_ARGUMENT);
    invalid = input;
    invalid.version = LCC_DEVICE_PROOF_VERSION + 1U;
    expect_failure_unchanged(invalid, LCC_DEVICE_UNSUPPORTED_VERSION);

    LccDeviceProof invalid_output;
    lcc_init_device_proof(&invalid_output);
    invalid_output.reserved = 1U;
    const LccDeviceProof before = invalid_output;
    BOOST_TEST(lcc_device_identity_build_request_proof_v1(handle, &input, &invalid_output) ==
               LCC_DEVICE_INVALID_ARGUMENT);
    BOOST_TEST(std::memcmp(&invalid_output, &before, sizeof(before)) == 0);

    LccDeviceIdentityMetadata invalid_metadata;
    lcc_init_device_identity_metadata(&invalid_metadata);
    invalid_metadata.size = sizeof(invalid_metadata) - 1U;
    const LccDeviceIdentityMetadata metadata_before = invalid_metadata;
    BOOST_TEST(lcc_device_identity_get_metadata(handle, &invalid_metadata) == LCC_DEVICE_INVALID_ARGUMENT);
    BOOST_TEST(std::memcmp(&invalid_metadata, &metadata_before, sizeof(metadata_before)) == 0);

    lcc_device_identity_close(handle);
    options.flags = 0U;
    BOOST_TEST(lcc_device_identity_delete_key(&options, metadata.device_key_id) == LCC_DEVICE_OK);
}
