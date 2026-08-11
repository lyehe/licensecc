#define BOOST_TEST_MODULE device_identity_abi_test

#include <boost/test/unit_test.hpp>
#include <licensecc/device_identity.h>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <type_traits>

namespace {

constexpr std::size_t align_up(std::size_t value, std::size_t alignment) {
    return (value + alignment - 1U) / alignment * alignment;
}

static_assert(LCC_DEVICE_OK == 0, "ABI value drift");
static_assert(LCC_DEVICE_INVALID_ARGUMENT == 1, "ABI value drift");
static_assert(LCC_DEVICE_UNSUPPORTED_VERSION == 2, "ABI value drift");
static_assert(LCC_DEVICE_BUFFER_TOO_SMALL == 3, "ABI value drift");
static_assert(LCC_DEVICE_PROVIDER_UNAVAILABLE == 4, "ABI value drift");
static_assert(LCC_DEVICE_HARDWARE_UNAVAILABLE == 5, "ABI value drift");
static_assert(LCC_DEVICE_ACCESS_DENIED == 6, "ABI value drift");
static_assert(LCC_DEVICE_KEY_NOT_FOUND == 7, "ABI value drift");
static_assert(LCC_DEVICE_KEY_CORRUPT == 8, "ABI value drift");
static_assert(LCC_DEVICE_KEY_LOST == 9, "ABI value drift");
static_assert(LCC_DEVICE_UNSUPPORTED_ALGORITHM == 10, "ABI value drift");
static_assert(LCC_DEVICE_SIGN_FAILED == 11, "ABI value drift");
static_assert(LCC_DEVICE_IO_ERROR == 12, "ABI value drift");
static_assert(LCC_DEVICE_BUSY == 13, "ABI value drift");
static_assert(LCC_DEVICE_POLICY_VIOLATION == 14, "ABI value drift");
static_assert(LCC_DEVICE_INTERNAL_ERROR == 255, "ABI value drift");
static_assert(LCC_DEVICE_BACKEND_AUTO == 0 && LCC_DEVICE_BACKEND_WINDOWS_TPM == 1 &&
                  LCC_DEVICE_BACKEND_TPM2_OPENSSL == 2 && LCC_DEVICE_BACKEND_SOFTWARE_TEST == 255,
              "backend ABI drift");
static_assert(LCC_DEVICE_POLICY_UNSPECIFIED == 0 && LCC_DEVICE_POLICY_HARDWARE_REQUIRED == 1 &&
                  LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT == 2,
              "policy ABI drift");
static_assert(LCC_DEVICE_SCOPE_UNSPECIFIED == 0 && LCC_DEVICE_SCOPE_USER == 1 &&
                  LCC_DEVICE_SCOPE_MACHINE == 2,
              "scope ABI drift");
static_assert(LCC_DEVICE_ASSURANCE_UNKNOWN == 0 && LCC_DEVICE_ASSURANCE_SOFTWARE == 1 &&
                  LCC_DEVICE_ASSURANCE_REPORTED_HARDWARE == 2,
              "assurance ABI drift");
static_assert(LCC_DEVICE_PROOF_AUDIENCE_UNSPECIFIED == 0 && LCC_DEVICE_PROOF_AUDIENCE_VERIFY == 1 &&
                  LCC_DEVICE_PROOF_AUDIENCE_LEASE == 2 && LCC_DEVICE_PROOF_AUDIENCE_SEAT == 3,
              "audience ABI drift");
static_assert(LCC_DEVICE_IDENTITY_VERSION == 1U, "identity version ABI drift");
static_assert(LCC_DEVICE_PROOF_VERSION == 1U, "proof version ABI drift");
static_assert(LCC_DEVICE_OPEN_CREATE_IF_MISSING == 0x00000001U, "open flag ABI drift");
static_assert(LCC_DEVICE_APPLICATION_ID_MAX == 128U, "application-id maximum ABI drift");
static_assert(LCC_DEVICE_PROVIDER_NAME_MAX == 63U, "provider-name maximum ABI drift");
static_assert(LCC_DEVICE_ALGORITHM_MAX == 31U, "algorithm maximum ABI drift");
static_assert(LCC_DEVICE_KEY_ID_MAX == 71U, "key-id maximum ABI drift");
static_assert(LCC_DEVICE_SIGNATURE_BASE64_MAX == 88U, "signature maximum ABI drift");

static_assert(std::is_standard_layout<LccDeviceIdentityOptions>::value, "public ABI must be standard-layout");
static_assert(alignof(LccDeviceIdentityOptions) == alignof(std::uint32_t), "options alignment drift");
static_assert(offsetof(LccDeviceIdentityOptions, size) == 0U, "options.size offset drift");
static_assert(offsetof(LccDeviceIdentityOptions, version) == 4U, "options.version offset drift");
static_assert(offsetof(LccDeviceIdentityOptions, backend) == 8U, "options.backend offset drift");
static_assert(offsetof(LccDeviceIdentityOptions, policy) == 12U, "options.policy offset drift");
static_assert(offsetof(LccDeviceIdentityOptions, scope) == 16U, "options.scope offset drift");
static_assert(offsetof(LccDeviceIdentityOptions, flags) == 20U, "options.flags offset drift");
static_assert(offsetof(LccDeviceIdentityOptions, lock_timeout_ms) == 24U, "options.lock timeout offset drift");
static_assert(offsetof(LccDeviceIdentityOptions, reserved) == 28U, "options.reserved offset drift");
static_assert(offsetof(LccDeviceIdentityOptions, application_id) == 32U, "options.application id offset drift");
static_assert(offsetof(LccDeviceIdentityOptions, project) == 32U + LCC_DEVICE_APPLICATION_ID_MAX + 1U,
              "options.project offset drift");
static_assert(offsetof(LccDeviceIdentityOptions, storage_directory) ==
                  32U + LCC_DEVICE_APPLICATION_ID_MAX + 1U + LCC_API_ONLINE_PROJECT_SIZE + 1U,
              "options.storage directory offset drift");

static_assert(std::is_standard_layout<LccDeviceIdentityMetadata>::value, "public ABI must be standard-layout");
static_assert(alignof(LccDeviceIdentityMetadata) == alignof(std::uint32_t), "metadata alignment drift");
static_assert(offsetof(LccDeviceIdentityMetadata, size) == 0U, "metadata.size offset drift");
static_assert(offsetof(LccDeviceIdentityMetadata, version) == 4U, "metadata.version offset drift");
static_assert(offsetof(LccDeviceIdentityMetadata, backend) == 8U, "metadata.backend offset drift");
static_assert(offsetof(LccDeviceIdentityMetadata, scope) == 12U, "metadata.scope offset drift");
static_assert(offsetof(LccDeviceIdentityMetadata, assurance) == 16U, "metadata.assurance offset drift");
static_assert(offsetof(LccDeviceIdentityMetadata, reserved) == 20U, "metadata.reserved offset drift");
static_assert(offsetof(LccDeviceIdentityMetadata, provider) == 24U, "metadata.provider offset drift");
static_assert(offsetof(LccDeviceIdentityMetadata, algorithm) == 24U + LCC_DEVICE_PROVIDER_NAME_MAX + 1U,
              "metadata.algorithm offset drift");
static_assert(offsetof(LccDeviceIdentityMetadata, device_key_id) ==
                  24U + LCC_DEVICE_PROVIDER_NAME_MAX + 1U + LCC_DEVICE_ALGORITHM_MAX + 1U,
              "metadata.device key id offset drift");

static_assert(std::is_standard_layout<LccDeviceProofInput>::value, "public ABI must be standard-layout");
static_assert(alignof(LccDeviceProofInput) ==
                  (alignof(std::uint64_t) > alignof(std::uint32_t) ? alignof(std::uint64_t) :
                                                                    alignof(std::uint32_t)),
              "proof input alignment drift");
static_assert(offsetof(LccDeviceProofInput, size) == 0U, "proof input.size offset drift");
static_assert(offsetof(LccDeviceProofInput, version) == 4U, "proof input.version offset drift");
static_assert(offsetof(LccDeviceProofInput, audience) == 8U, "proof input.audience offset drift");
static_assert(offsetof(LccDeviceProofInput, client_hardening) == 12U, "proof input.hardening offset drift");
static_assert(offsetof(LccDeviceProofInput, request_timestamp) == align_up(16U, alignof(std::uint64_t)),
              "proof input.timestamp offset drift");
static_assert(offsetof(LccDeviceProofInput, project) == offsetof(LccDeviceProofInput, request_timestamp) + 8U,
              "proof input.project offset drift");
static_assert(offsetof(LccDeviceProofInput, feature) ==
                  offsetof(LccDeviceProofInput, project) + LCC_API_ONLINE_PROJECT_SIZE + 1U,
              "proof input.feature offset drift");
static_assert(offsetof(LccDeviceProofInput, license_fingerprint) ==
                  offsetof(LccDeviceProofInput, feature) + LCC_API_FEATURE_NAME_SIZE + 1U,
              "proof input.license fingerprint offset drift");
static_assert(offsetof(LccDeviceProofInput, device_hash) ==
                  offsetof(LccDeviceProofInput, license_fingerprint) + 65U,
              "proof input.device hash offset drift");
static_assert(offsetof(LccDeviceProofInput, nonce) == offsetof(LccDeviceProofInput, device_hash) + 65U,
              "proof input.nonce offset drift");

static_assert(std::is_standard_layout<LccDeviceProof>::value, "public ABI must be standard-layout");
static_assert(alignof(LccDeviceProof) ==
                  (alignof(std::uint64_t) > alignof(std::uint32_t) ? alignof(std::uint64_t) :
                                                                    alignof(std::uint32_t)),
              "proof alignment drift");
static_assert(offsetof(LccDeviceProof, size) == 0U, "proof.size offset drift");
static_assert(offsetof(LccDeviceProof, version) == 4U, "proof.version offset drift");
static_assert(offsetof(LccDeviceProof, request_signature_version) == 8U, "proof signature version offset drift");
static_assert(offsetof(LccDeviceProof, reserved) == 12U, "proof.reserved offset drift");
static_assert(offsetof(LccDeviceProof, request_timestamp) == align_up(16U, alignof(std::uint64_t)),
              "proof.timestamp offset drift");
static_assert(offsetof(LccDeviceProof, device_key_id) == offsetof(LccDeviceProof, request_timestamp) + 8U,
              "proof.device key id offset drift");
static_assert(offsetof(LccDeviceProof, request_signature_algorithm) ==
                  offsetof(LccDeviceProof, device_key_id) + LCC_DEVICE_KEY_ID_MAX + 1U,
              "proof.signature algorithm offset drift");
static_assert(offsetof(LccDeviceProof, request_signature) ==
                  offsetof(LccDeviceProof, request_signature_algorithm) + LCC_DEVICE_ALGORITHM_MAX + 1U,
              "proof.signature offset drift");

template <std::size_t N>
void set_field(char (&field)[N], const char* value) {
    const std::size_t length = std::strlen(value);
    BOOST_REQUIRE(length < N);
    std::memcpy(field, value, length + 1U);
}

LccDeviceIdentityOptions valid_options(const char* application_id = "licensecc.test.abi") {
    LccDeviceIdentityOptions options;
    lcc_init_device_identity_options(&options);
    options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
    options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
    options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
    set_field(options.application_id, application_id);
    set_field(options.project, "DEFAULT");
    return options;
}

}  // namespace

BOOST_AUTO_TEST_CASE(initializers_write_only_the_v1_prefix_and_secure_defaults) {
    struct ExtendedOptions {
        LccDeviceIdentityOptions value;
        unsigned char trailing[19];
    } extended;
    std::memset(&extended, 0xa5, sizeof(extended));
    lcc_init_device_identity_options(&extended.value);

    LccDeviceIdentityOptions expected{};
    expected.size = sizeof(expected);
    expected.version = LCC_DEVICE_IDENTITY_VERSION;
    expected.backend = LCC_DEVICE_BACKEND_AUTO;
    expected.policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
    expected.scope = LCC_DEVICE_SCOPE_USER;
    expected.lock_timeout_ms = 5000U;
    BOOST_TEST(std::memcmp(&extended.value, &expected, sizeof(expected)) == 0);
    for (const unsigned char value : extended.trailing) {
        BOOST_TEST(value == 0xa5U);
    }

    struct ExtendedMetadata {
        LccDeviceIdentityMetadata value;
        unsigned char trailing[11];
    } extended_metadata;
    std::memset(&extended_metadata, 0xa5, sizeof(extended_metadata));
    lcc_init_device_identity_metadata(&extended_metadata.value);
    BOOST_TEST(extended_metadata.value.size == sizeof(extended_metadata.value));
    BOOST_TEST(extended_metadata.value.version == LCC_DEVICE_IDENTITY_VERSION);
    BOOST_TEST(extended_metadata.value.reserved == 0U);
    BOOST_TEST(extended_metadata.value.provider[0] == '\0');
    for (const unsigned char value : extended_metadata.trailing) {
        BOOST_TEST(value == 0xa5U);
    }

    struct ExtendedProofInput {
        LccDeviceProofInput value;
        unsigned char trailing[13];
    } extended_input;
    std::memset(&extended_input, 0xa5, sizeof(extended_input));
    lcc_init_device_proof_input(&extended_input.value);
    BOOST_TEST(extended_input.value.size == sizeof(extended_input.value));
    BOOST_TEST(extended_input.value.version == LCC_DEVICE_PROOF_VERSION);
    BOOST_TEST(extended_input.value.audience == LCC_DEVICE_PROOF_AUDIENCE_UNSPECIFIED);
    for (const unsigned char value : extended_input.trailing) {
        BOOST_TEST(value == 0xa5U);
    }

    struct ExtendedProof {
        LccDeviceProof value;
        unsigned char trailing[17];
    } extended_proof;
    std::memset(&extended_proof, 0xa5, sizeof(extended_proof));
    lcc_init_device_proof(&extended_proof.value);
    BOOST_TEST(extended_proof.value.size == sizeof(extended_proof.value));
    BOOST_TEST(extended_proof.value.version == LCC_DEVICE_PROOF_VERSION);
    BOOST_TEST(extended_proof.value.reserved == 0U);
    for (const unsigned char value : extended_proof.trailing) {
        BOOST_TEST(value == 0xa5U);
    }

    lcc_init_device_identity_options(nullptr);
    lcc_init_device_identity_metadata(nullptr);
    lcc_init_device_proof_input(nullptr);
    lcc_init_device_proof(nullptr);
}

BOOST_AUTO_TEST_CASE(size_version_and_two_call_spki_contract) {
    LccDeviceIdentityOptions options = valid_options();
    LccDeviceIdentity* handle = reinterpret_cast<LccDeviceIdentity*>(static_cast<std::uintptr_t>(1U));

    options.size = sizeof(options) - 1U;
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_INVALID_ARGUMENT);
    BOOST_TEST(handle == nullptr);

    options = valid_options();
    options.version = LCC_DEVICE_IDENTITY_VERSION + 1U;
    handle = reinterpret_cast<LccDeviceIdentity*>(static_cast<std::uintptr_t>(1U));
    BOOST_TEST(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_UNSUPPORTED_VERSION);
    BOOST_TEST(handle == nullptr);

#if LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER
    struct ExtendedOptions {
        LccDeviceIdentityOptions value;
        unsigned char trailing[8];
    } extended{};
    extended.value = valid_options();
    extended.value.size = sizeof(extended);
    std::memset(extended.trailing, 0x7c, sizeof(extended.trailing));
    BOOST_REQUIRE(lcc_device_identity_open(&extended.value, &handle) == LCC_DEVICE_OK);
    BOOST_REQUIRE(handle != nullptr);

    std::size_t size = 999U;
    BOOST_TEST(lcc_device_identity_get_public_spki(handle, nullptr, &size) == LCC_DEVICE_BUFFER_TOO_SMALL);
    BOOST_TEST(size == 91U);
    unsigned char short_buffer[90];
    std::memset(short_buffer, 0x5a, sizeof(short_buffer));
    size = sizeof(short_buffer);
    BOOST_TEST(lcc_device_identity_get_public_spki(handle, short_buffer, &size) == LCC_DEVICE_BUFFER_TOO_SMALL);
    BOOST_TEST(size == 91U);
    for (const unsigned char value : short_buffer) {
        BOOST_TEST(value == 0x5aU);
    }
    unsigned char spki[91]{};
    size = sizeof(spki);
    BOOST_TEST(lcc_device_identity_get_public_spki(handle, spki, &size) == LCC_DEVICE_OK);
    BOOST_TEST(size == sizeof(spki));
    BOOST_TEST(spki[0] == 0x30U);

    LccDeviceIdentityMetadata metadata;
    lcc_init_device_identity_metadata(&metadata);
    BOOST_TEST(lcc_device_identity_get_metadata(handle, &metadata) == LCC_DEVICE_OK);
    BOOST_TEST(metadata.backend == LCC_DEVICE_BACKEND_SOFTWARE_TEST);
    BOOST_TEST(std::string(metadata.provider) == "software-test");
    BOOST_TEST(std::string(metadata.algorithm) == "ecdsa-p256-sha256");
    BOOST_TEST(std::string(metadata.device_key_id).size() == 71U);

    lcc_device_identity_close(handle);
    extended.value.flags = 0U;
    BOOST_TEST(lcc_device_identity_delete_key(&extended.value, metadata.device_key_id) == LCC_DEVICE_OK);
#endif
    lcc_device_identity_close(nullptr);
}

BOOST_AUTO_TEST_CASE(stable_error_strings_cover_every_public_value) {
    struct Case {
        LCC_DEVICE_RESULT result;
        const char* text;
    };
    const Case cases[] = {
        {LCC_DEVICE_OK, "ok"},
        {LCC_DEVICE_INVALID_ARGUMENT, "invalid argument"},
        {LCC_DEVICE_UNSUPPORTED_VERSION, "unsupported version"},
        {LCC_DEVICE_BUFFER_TOO_SMALL, "buffer too small"},
        {LCC_DEVICE_PROVIDER_UNAVAILABLE, "provider unavailable"},
        {LCC_DEVICE_HARDWARE_UNAVAILABLE, "hardware unavailable"},
        {LCC_DEVICE_ACCESS_DENIED, "access denied"},
        {LCC_DEVICE_KEY_NOT_FOUND, "device key not found"},
        {LCC_DEVICE_KEY_CORRUPT, "device key corrupt"},
        {LCC_DEVICE_KEY_LOST, "device key lost"},
        {LCC_DEVICE_UNSUPPORTED_ALGORITHM, "unsupported algorithm"},
        {LCC_DEVICE_SIGN_FAILED, "device signing failed"},
        {LCC_DEVICE_IO_ERROR, "I/O error"},
        {LCC_DEVICE_BUSY, "device key busy"},
        {LCC_DEVICE_POLICY_VIOLATION, "device policy violation"},
        {LCC_DEVICE_INTERNAL_ERROR, "internal device error"},
    };
    for (const Case& item : cases) {
        BOOST_TEST(std::string(lcc_device_strerror(item.result)) == item.text);
    }
    BOOST_TEST(std::string(lcc_device_strerror(static_cast<LCC_DEVICE_RESULT>(254))) == "unknown device result");
}
