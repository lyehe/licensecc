#define BOOST_TEST_MODULE device_bound_possession_test
#include <boost/test/unit_test.hpp>
#include "bound_possession.hpp"
#include "device_identity_handle.hpp"
#include <cstring>
#include <memory>

using namespace license::device_identity;
namespace {
class RecordingProvider final : public DeviceKeyProvider {
public:
	explicit RecordingProvider(std::unique_ptr<DeviceKeyProvider> inner) : inner_(std::move(inner)) {}
	unsigned calls = 0;
	bool replay = false;
	LCC_DEVICE_RESULT forced = LCC_DEVICE_OK;
	P256Digest digest{};
	P256Signature cached{};
	LCC_DEVICE_RESULT sign_digest(const P256Digest& input, P256Signature& out) noexcept override {
		++calls;
		digest = input;
		if (forced != LCC_DEVICE_OK) return forced;
		if (replay) {
			out = cached;
			return LCC_DEVICE_OK;
		}
		const auto result = inner_->sign_digest(input, out);
		cached = out;
		return result;
	}
	LCC_DEVICE_RESULT open(const ProviderOpenRequest&) noexcept override { return LCC_DEVICE_INTERNAL_ERROR; }
	LCC_DEVICE_RESULT create(const ProviderOpenRequest&) noexcept override { return LCC_DEVICE_INTERNAL_ERROR; }
	LCC_DEVICE_RESULT public_spki(P256Spki& out) noexcept override { return inner_->public_spki(out); }
	LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept override { return inner_->metadata(out); }
	LCC_DEVICE_RESULT delete_with_expected_id(const ProviderOpenRequest&, const std::string&) noexcept override {
		return LCC_DEVICE_INTERNAL_ERROR;
	}

private:
	std::unique_ptr<DeviceKeyProvider> inner_;
};
struct Handle {
	std::unique_ptr<LccDeviceIdentity, decltype(&lcc_device_identity_close)> identity{nullptr,
																					  lcc_device_identity_close};
	RecordingProvider* provider = nullptr;
	explicit Handle(const char* application = "licensecc.test.bound-possession") {
		LccDeviceIdentityOptions options;
		lcc_init_device_identity_options(&options);
		options.backend = LCC_DEVICE_BACKEND_SOFTWARE_TEST;
		options.policy = LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
		options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
		std::strcpy(options.application_id, application);
		std::strcpy(options.project, "CAD");
		LccDeviceIdentity* raw = nullptr;
		BOOST_REQUIRE_EQUAL(lcc_device_identity_open(&options, &raw), LCC_DEVICE_OK);
		identity.reset(raw);
		auto wrapper = std::make_unique<RecordingProvider>(std::move(raw->provider));
		provider = wrapper.get();
		raw->provider = std::move(wrapper);
	}
	LCC_DEVICE_RESULT prove() {
		return prove_bound_key_possession(identity.get(), "CAD", identity->device_key_id, std::string(64, 'a'));
	}
};
}  // namespace

BOOST_AUTO_TEST_CASE(each_possession_check_requires_a_fresh_signature_from_the_pinned_key) {
	Handle h;
	BOOST_REQUIRE_EQUAL(h.prove(), LCC_DEVICE_OK);
	const auto first_digest = h.provider->digest;
	const auto first_signature = h.provider->cached;
	BOOST_REQUIRE_EQUAL(h.prove(), LCC_DEVICE_OK);
	BOOST_CHECK(h.provider->digest != first_digest);
	BOOST_CHECK(!verify_p256_p1363(h.identity->spki, h.provider->digest, first_signature));
	h.provider->replay = true;
	BOOST_CHECK_EQUAL(h.prove(), LCC_DEVICE_SIGN_FAILED);
	h.provider->cached.fill(0);
	BOOST_CHECK_EQUAL(h.prove(), LCC_DEVICE_SIGN_FAILED);
	h.provider->replay = false;
	BOOST_REQUIRE_EQUAL(h.prove(), LCC_DEVICE_OK);
	BOOST_CHECK_EQUAL(h.provider->calls, 5U);
}

BOOST_AUTO_TEST_CASE(invalid_or_mismatched_local_context_never_reaches_the_provider) {
	Handle h;
	const auto key = h.identity->device_key_id;
	const std::string lease(64, 'a');
	BOOST_CHECK_EQUAL(prove_bound_key_possession(nullptr, "CAD", key, lease), LCC_DEVICE_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(prove_bound_key_possession(h.identity.get(), "CAD\n", key, lease), LCC_DEVICE_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(prove_bound_key_possession(h.identity.get(), "CAD", "bad", lease), LCC_DEVICE_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(prove_bound_key_possession(h.identity.get(), "CAD", key, "bad"), LCC_DEVICE_INVALID_ARGUMENT);
	BOOST_CHECK_EQUAL(prove_bound_key_possession(h.identity.get(), "WRONG", key, lease), LCC_DEVICE_POLICY_VIOLATION);
	BOOST_CHECK_EQUAL(prove_bound_key_possession(h.identity.get(), "CAD", "sha256:" + std::string(64, '0'), lease),
					  LCC_DEVICE_POLICY_VIOLATION);
	// A corrupted stored key ID cannot conceal a different SPKI identity.
	h.identity->device_key_id = "sha256:" + std::string(64, '0');
	BOOST_CHECK_EQUAL(h.prove(), LCC_DEVICE_POLICY_VIOLATION);
	BOOST_CHECK_EQUAL(h.provider->calls, 0U);
}

BOOST_AUTO_TEST_CASE(provider_failures_propagate_without_regenerating_or_using_cached_success) {
	Handle h;
	BOOST_REQUIRE_EQUAL(h.prove(), LCC_DEVICE_OK);
	for (const auto result : {LCC_DEVICE_KEY_LOST, LCC_DEVICE_BUSY, LCC_DEVICE_ACCESS_DENIED, LCC_DEVICE_SIGN_FAILED,
							  LCC_DEVICE_INTERNAL_ERROR}) {
		h.provider->forced = result;
		BOOST_CHECK_EQUAL(h.prove(), result);
	}
	BOOST_CHECK_EQUAL(h.provider->calls, 6U);
}

BOOST_AUTO_TEST_CASE(a_successful_signature_from_a_different_provider_key_is_rejected) {
	Handle pinned, other("licensecc.test.bound-possession.other");
	BOOST_REQUIRE_NE(pinned.identity->device_key_id, other.identity->device_key_id);
	pinned.identity->provider = std::move(other.identity->provider);
	BOOST_CHECK_EQUAL(pinned.prove(), LCC_DEVICE_SIGN_FAILED);
}
