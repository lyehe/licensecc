#define BOOST_TEST_MODULE device_identity_concurrency_test

#include <boost/test/unit_test.hpp>
#include <licensecc/device_identity.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifndef _WIN32
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace {

template <std::size_t N>
void set_field(char (&field)[N], const char* value) {
    const std::size_t length = std::strlen(value);
    BOOST_REQUIRE(length < N);
    std::memcpy(field, value, length + 1U);
}

LccDeviceIdentityOptions options_for(const char* application_id) {
    LccDeviceIdentityOptions options;
    lcc_init_device_identity_options(&options);
    options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
    options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
    options.scope = LCC_DEVICE_SCOPE_USER;
    options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
    set_field(options.application_id, application_id);
    set_field(options.project, "DEFAULT");
    return options;
}

LccDeviceProofInput proof_input() {
    LccDeviceProofInput input;
    lcc_init_device_proof_input(&input);
    input.audience = LCC_DEVICE_PROOF_AUDIENCE_VERIFY;
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

#ifndef _WIN32
BOOST_AUTO_TEST_CASE(fork_before_open_creates_independent_parent_and_child_handles) {
    int descriptors[2];
    BOOST_REQUIRE(::pipe(descriptors) == 0);
    const pid_t child = ::fork();
    BOOST_REQUIRE(child >= 0);
    if (child == 0) {
        ::close(descriptors[0]);
        LccDeviceIdentityOptions options = options_for("licensecc.test.fork");
        LccDeviceIdentity* handle = nullptr;
        LccDeviceIdentityMetadata metadata;
        lcc_init_device_identity_metadata(&metadata);
        bool ok = lcc_device_identity_open(&options, &handle) == LCC_DEVICE_OK && handle != nullptr &&
                  lcc_device_identity_get_metadata(handle, &metadata) == LCC_DEVICE_OK;
        if (ok) {
            const std::size_t size = sizeof(metadata.device_key_id);
            ok = ::write(descriptors[1], metadata.device_key_id, size) == static_cast<ssize_t>(size);
        }
        lcc_device_identity_close(handle);
        options.flags = 0U;
        if (metadata.device_key_id[0] != '\0') {
            lcc_device_identity_delete_key(&options, metadata.device_key_id);
        }
        ::close(descriptors[1]);
        ::_exit(ok ? 0 : 1);
    }

    ::close(descriptors[1]);
    LccDeviceIdentityOptions options = options_for("licensecc.test.fork");
    LccDeviceIdentity* handle = nullptr;
    BOOST_REQUIRE(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_OK);
    LccDeviceIdentityMetadata metadata;
    lcc_init_device_identity_metadata(&metadata);
    BOOST_REQUIRE(lcc_device_identity_get_metadata(handle, &metadata) == LCC_DEVICE_OK);
    char child_key_id[LCC_DEVICE_KEY_ID_MAX + 1]{};
    BOOST_REQUIRE(::read(descriptors[0], child_key_id, sizeof(child_key_id)) ==
                  static_cast<ssize_t>(sizeof(child_key_id)));
    ::close(descriptors[0]);
    int status = 0;
    BOOST_REQUIRE(::waitpid(child, &status, 0) == child);
    BOOST_TEST(WIFEXITED(status));
    BOOST_TEST(WEXITSTATUS(status) == 0);
    BOOST_TEST(std::string(child_key_id) != std::string(metadata.device_key_id));
    lcc_device_identity_close(handle);
    options.flags = 0U;
    BOOST_TEST(lcc_device_identity_delete_key(&options, metadata.device_key_id) == LCC_DEVICE_OK);
}
#endif

BOOST_AUTO_TEST_CASE(concurrent_create_if_missing_converges_on_one_key) {
    const LccDeviceIdentityOptions options = options_for("licensecc.test.concurrent-create");
    constexpr std::size_t thread_count = 24U;
    std::vector<std::thread> threads;
    std::vector<LCC_DEVICE_RESULT> results(thread_count, LCC_DEVICE_INTERNAL_ERROR);
    std::vector<std::string> key_ids(thread_count);
    for (std::size_t index = 0; index < thread_count; ++index) {
        threads.emplace_back([&, index]() {
            LccDeviceIdentity* handle = nullptr;
            results[index] = lcc_device_identity_open(&options, &handle);
            if (results[index] == LCC_DEVICE_OK) {
                LccDeviceIdentityMetadata metadata;
                lcc_init_device_identity_metadata(&metadata);
                results[index] = lcc_device_identity_get_metadata(handle, &metadata);
                key_ids[index] = metadata.device_key_id;
            }
            lcc_device_identity_close(handle);
        });
    }
    for (std::thread& thread : threads) {
        thread.join();
    }
    for (std::size_t index = 0; index < thread_count; ++index) {
        BOOST_TEST(results[index] == LCC_DEVICE_OK);
        BOOST_TEST(key_ids[index] == key_ids.front());
    }
    LccDeviceIdentityOptions delete_options = options;
    delete_options.flags = 0U;
    BOOST_TEST(lcc_device_identity_delete_key(&delete_options, key_ids.front().c_str()) == LCC_DEVICE_OK);
}

BOOST_AUTO_TEST_CASE(shared_handle_serializes_signing_and_keeps_getters_safe) {
    LccDeviceIdentityOptions options = options_for("licensecc.test.concurrent-sign");
    LccDeviceIdentity* handle = nullptr;
    BOOST_REQUIRE(lcc_device_identity_open(&options, &handle) == LCC_DEVICE_OK);
    LccDeviceIdentityMetadata metadata;
    lcc_init_device_identity_metadata(&metadata);
    BOOST_REQUIRE(lcc_device_identity_get_metadata(handle, &metadata) == LCC_DEVICE_OK);
    const LccDeviceProofInput input = proof_input();
    constexpr std::size_t thread_count = 16U;
    constexpr std::size_t iterations = 25U;
    std::atomic<bool> start(false);
    std::atomic<unsigned int> failures(0U);
    std::vector<std::thread> threads;
    for (std::size_t index = 0; index < thread_count; ++index) {
        threads.emplace_back([&]() {
            while (!start.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            for (std::size_t iteration = 0; iteration < iterations; ++iteration) {
                LccDeviceProof proof;
                lcc_init_device_proof(&proof);
                LccDeviceIdentityMetadata current;
                lcc_init_device_identity_metadata(&current);
                std::size_t spki_size = 0U;
                if (lcc_device_identity_get_metadata(handle, &current) != LCC_DEVICE_OK ||
                    lcc_device_identity_get_public_spki(handle, nullptr, &spki_size) !=
                        LCC_DEVICE_BUFFER_TOO_SMALL ||
                    spki_size != 91U ||
                    lcc_device_identity_build_request_proof_v1(handle, &input, &proof) != LCC_DEVICE_OK ||
                    std::strlen(proof.request_signature) != LCC_DEVICE_SIGNATURE_BASE64_MAX ||
                    std::strcmp(current.device_key_id, metadata.device_key_id) != 0) {
                    failures.fetch_add(1U, std::memory_order_relaxed);
                }
            }
        });
    }
    start.store(true, std::memory_order_release);
    for (std::thread& thread : threads) {
        thread.join();
    }
    BOOST_TEST(failures.load() == 0U);
    lcc_device_identity_close(handle);
    options.flags = 0U;
    BOOST_TEST(lcc_device_identity_delete_key(&options, metadata.device_key_id) == LCC_DEVICE_OK);
}
