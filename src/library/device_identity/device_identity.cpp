#include <licensecc/device_identity.h>

#include "device_key_provider.hpp"
#include "p256_crypto.hpp"
#include "device_identity_handle.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>

namespace license {
namespace device_identity {
namespace {

constexpr std::size_t align_up(std::size_t value, std::size_t alignment) {
	return (value + alignment - 1U) / alignment * alignment;
}

static_assert(std::is_standard_layout<LccDeviceIdentityOptions>::value, "options ABI must be standard-layout");
static_assert(alignof(LccDeviceIdentityOptions) == alignof(std::uint32_t), "options ABI alignment");
static_assert(offsetof(LccDeviceIdentityOptions, size) == 0U, "options.size ABI offset");
static_assert(offsetof(LccDeviceIdentityOptions, version) == 4U, "options.version ABI offset");
static_assert(offsetof(LccDeviceIdentityOptions, backend) == 8U, "options.backend ABI offset");
static_assert(offsetof(LccDeviceIdentityOptions, policy) == 12U, "options.policy ABI offset");
static_assert(offsetof(LccDeviceIdentityOptions, scope) == 16U, "options.scope ABI offset");
static_assert(offsetof(LccDeviceIdentityOptions, flags) == 20U, "options.flags ABI offset");
static_assert(offsetof(LccDeviceIdentityOptions, lock_timeout_ms) == 24U, "options.lock timeout ABI offset");
static_assert(offsetof(LccDeviceIdentityOptions, reserved) == 28U, "options.reserved ABI offset");
static_assert(offsetof(LccDeviceIdentityOptions, application_id) == 32U, "options.application id ABI offset");
static_assert(offsetof(LccDeviceIdentityOptions, project) == 32U + LCC_DEVICE_APPLICATION_ID_MAX + 1U,
			  "options.project ABI offset");
static_assert(offsetof(LccDeviceIdentityOptions, storage_directory) ==
				  32U + LCC_DEVICE_APPLICATION_ID_MAX + 1U + LCC_API_ONLINE_PROJECT_SIZE + 1U,
			  "options.storage ABI offset");

static_assert(std::is_standard_layout<LccDeviceIdentityMetadata>::value, "metadata ABI must be standard-layout");
static_assert(alignof(LccDeviceIdentityMetadata) == alignof(std::uint32_t), "metadata ABI alignment");
static_assert(offsetof(LccDeviceIdentityMetadata, size) == 0U, "metadata.size ABI offset");
static_assert(offsetof(LccDeviceIdentityMetadata, version) == 4U, "metadata.version ABI offset");
static_assert(offsetof(LccDeviceIdentityMetadata, backend) == 8U, "metadata.backend ABI offset");
static_assert(offsetof(LccDeviceIdentityMetadata, scope) == 12U, "metadata.scope ABI offset");
static_assert(offsetof(LccDeviceIdentityMetadata, assurance) == 16U, "metadata.assurance ABI offset");
static_assert(offsetof(LccDeviceIdentityMetadata, reserved) == 20U, "metadata.reserved ABI offset");
static_assert(offsetof(LccDeviceIdentityMetadata, provider) == 24U, "metadata.provider ABI offset");
static_assert(offsetof(LccDeviceIdentityMetadata, algorithm) == 24U + LCC_DEVICE_PROVIDER_NAME_MAX + 1U,
			  "metadata.algorithm ABI offset");
static_assert(offsetof(LccDeviceIdentityMetadata, device_key_id) ==
				  24U + LCC_DEVICE_PROVIDER_NAME_MAX + 1U + LCC_DEVICE_ALGORITHM_MAX + 1U,
			  "metadata.key id ABI offset");

template <std::size_t N>
bool fixed_string(const char (&value)[N], std::string& out) {
	const void* terminator = std::memchr(value, '\0', N);
	if (terminator == nullptr) {
		return false;
	}
	const char* end = static_cast<const char*>(terminator);
	out.assign(value, end);
	return true;
}

template <std::size_t N>
bool copy_output(char (&target)[N], const std::string& value) {
	if (value.size() >= N) {
		return false;
	}
	std::memcpy(target, value.c_str(), value.size() + 1U);
	return true;
}

bool is_application_id(const std::string& value) {
	if (value.empty() || value.size() > LCC_DEVICE_APPLICATION_ID_MAX ||
		!((value[0] >= 'a' && value[0] <= 'z') || (value[0] >= '0' && value[0] <= '9'))) {
		return false;
	}
	for (const unsigned char ch : value) {
		if (!((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-')) {
			return false;
		}
	}
	return true;
}

bool is_proof_name(const std::string& value, std::size_t maximum) {
	if (value.empty() || value.size() > maximum) {
		return false;
	}
	for (const unsigned char ch : value) {
		if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' ||
			  ch == '.' || ch == ':' || ch == '-')) {
			return false;
		}
	}
	return true;
}

bool is_canonical_key_id(const std::string& value) {
	if (value.size() != LCC_DEVICE_KEY_ID_MAX || value.compare(0U, 7U, "sha256:") != 0) {
		return false;
	}
	for (std::size_t index = 7U; index < value.size(); ++index) {
		const unsigned char ch = static_cast<unsigned char>(value[index]);
		if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) {
			return false;
		}
	}
	return true;
}

bool known_backend(std::uint32_t backend) {
	return backend == LCC_DEVICE_BACKEND_AUTO || backend == LCC_DEVICE_BACKEND_WINDOWS_TPM ||
		   backend == LCC_DEVICE_BACKEND_TPM2_OPENSSL || backend == LCC_DEVICE_BACKEND_SOFTWARE_TEST;
}

bool known_policy(std::uint32_t policy) {
	return policy == LCC_DEVICE_POLICY_HARDWARE_REQUIRED || policy == LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT;
}

bool known_scope(std::uint32_t scope) { return scope == LCC_DEVICE_SCOPE_USER || scope == LCC_DEVICE_SCOPE_MACHINE; }

struct ValidatedOptions {
	ProviderOpenRequest request;
	std::string project;
};

LCC_DEVICE_RESULT validate_options(const LccDeviceIdentityOptions* options, bool deleting, ValidatedOptions& out) {
	if (options == nullptr || options->size < sizeof(LccDeviceIdentityOptions)) {
		return LCC_DEVICE_INVALID_ARGUMENT;
	}
	if (options->version != LCC_DEVICE_IDENTITY_VERSION) {
		return LCC_DEVICE_UNSUPPORTED_VERSION;
	}
	if (options->reserved != 0U || options->lock_timeout_ms > 60000U || !known_backend(options->backend) ||
		!known_policy(options->policy) || !known_scope(options->scope)) {
		return LCC_DEVICE_INVALID_ARGUMENT;
	}
	if ((deleting && (options->flags & ~LCC_DEVICE_DELETE_ALLOW_UI) != 0U) ||
		(!deleting && (options->flags & ~LCC_DEVICE_OPEN_CREATE_IF_MISSING) != 0U)) {
		return LCC_DEVICE_INVALID_ARGUMENT;
	}
	std::string application_id;
	std::string project;
	std::string storage_directory;
	if (!fixed_string(options->application_id, application_id) || !fixed_string(options->project, project) ||
		!fixed_string(options->storage_directory, storage_directory) || !is_application_id(application_id) ||
		!is_proof_name(project, LCC_API_ONLINE_PROJECT_SIZE)) {
		return LCC_DEVICE_INVALID_ARGUMENT;
	}

	std::uint32_t resolved_backend = options->backend;
	if (options->backend == LCC_DEVICE_BACKEND_SOFTWARE_TEST) {
		if (options->policy != LCC_DEVICE_POLICY_SOFTWARE_EXPLICIT) {
			return LCC_DEVICE_POLICY_VIOLATION;
		}
	} else {
		if (options->policy != LCC_DEVICE_POLICY_HARDWARE_REQUIRED) {
			return LCC_DEVICE_POLICY_VIOLATION;
		}
		if (options->backend == LCC_DEVICE_BACKEND_AUTO) {
#ifdef _WIN32
			resolved_backend = LCC_DEVICE_BACKEND_WINDOWS_TPM;
#else
			resolved_backend = LCC_DEVICE_BACKEND_TPM2_OPENSSL;
#endif
		}
	}

	const bool delete_allow_ui = deleting && (options->flags & LCC_DEVICE_DELETE_ALLOW_UI) != 0U;
	if (delete_allow_ui && resolved_backend != LCC_DEVICE_BACKEND_WINDOWS_TPM) {
		return LCC_DEVICE_INVALID_ARGUMENT;
	}
	ValidatedOptions candidate;
	candidate.request.delete_allow_ui = delete_allow_ui;
	if (!derive_namespace_v1(application_id, project, options->scope, candidate.request.device_namespace)) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
	candidate.request.backend = resolved_backend;
	candidate.request.scope = options->scope;
	candidate.request.lock_timeout_ms = options->lock_timeout_ms;
	candidate.request.storage_directory = std::move(storage_directory);
	candidate.project = std::move(project);
	out = std::move(candidate);
	return LCC_DEVICE_OK;
}

LCC_DEVICE_RESULT select_provider(const ValidatedOptions& options, std::unique_ptr<DeviceKeyProvider>& provider) {
	if (options.request.backend == LCC_DEVICE_BACKEND_WINDOWS_TPM) {
#if defined(_WIN32) && LCC_ENABLE_WINDOWS_TPM
		provider = make_windows_tpm_provider();
		return provider ? LCC_DEVICE_OK : LCC_DEVICE_INTERNAL_ERROR;
#else
		return LCC_DEVICE_PROVIDER_UNAVAILABLE;
#endif
	}
	if (options.request.backend == LCC_DEVICE_BACKEND_SOFTWARE_TEST) {
#if LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER
		provider = make_software_test_provider();
		return provider ? LCC_DEVICE_OK : LCC_DEVICE_INTERNAL_ERROR;
#else
		return LCC_DEVICE_PROVIDER_UNAVAILABLE;
#endif
	}

#if !defined(_WIN32) && LCC_ENABLE_TPM2_OPENSSL
	provider = make_tpm2_openssl_provider();
	return provider ? LCC_DEVICE_OK : LCC_DEVICE_INTERNAL_ERROR;
#else
	return LCC_DEVICE_PROVIDER_UNAVAILABLE;
#endif
}

LCC_DEVICE_RESULT validate_output(const LccDeviceIdentityMetadata* output) {
	if (output == nullptr || output->size < sizeof(LccDeviceIdentityMetadata)) {
		return LCC_DEVICE_INVALID_ARGUMENT;
	}
	if (output->version != LCC_DEVICE_IDENTITY_VERSION) {
		return LCC_DEVICE_UNSUPPORTED_VERSION;
	}
	return output->reserved == 0U ? LCC_DEVICE_OK : LCC_DEVICE_INVALID_ARGUMENT;
}

}  // namespace
}  // namespace device_identity
}  // namespace license

extern "C" {

void lcc_init_device_identity_options(LccDeviceIdentityOptions* options) {
	if (options == nullptr) {
		return;
	}
	std::memset(options, 0, sizeof(*options));
	options->size = sizeof(*options);
	options->version = LCC_DEVICE_IDENTITY_VERSION;
	options->backend = LCC_DEVICE_BACKEND_AUTO;
	options->policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
	options->scope = LCC_DEVICE_SCOPE_USER;
	options->flags = 0U;
	options->lock_timeout_ms = 5000U;
}

void lcc_init_device_identity_metadata(LccDeviceIdentityMetadata* metadata) {
	if (metadata == nullptr) {
		return;
	}
	std::memset(metadata, 0, sizeof(*metadata));
	metadata->size = sizeof(*metadata);
	metadata->version = LCC_DEVICE_IDENTITY_VERSION;
}

LCC_DEVICE_RESULT lcc_device_identity_open(const LccDeviceIdentityOptions* options, LccDeviceIdentity** out) {
	using namespace license::device_identity;
	if (out == nullptr) {
		return LCC_DEVICE_INVALID_ARGUMENT;
	}
	*out = nullptr;
	try {
		ValidatedOptions validated;
		LCC_DEVICE_RESULT result = validate_options(options, false, validated);
		if (result != LCC_DEVICE_OK) {
			return result;
		}
		std::unique_ptr<DeviceKeyProvider> provider;
		result = select_provider(validated, provider);
		if (result != LCC_DEVICE_OK) {
			return result;
		}
		result = provider->open(validated.request);
		if (result == LCC_DEVICE_KEY_NOT_FOUND && (options->flags & LCC_DEVICE_OPEN_CREATE_IF_MISSING) != 0U) {
			result = provider->create(validated.request);
		}
		if (result != LCC_DEVICE_OK) {
			return result;
		}
		P256Spki provider_spki{};
		result = provider->public_spki(provider_spki);
		if (result != LCC_DEVICE_OK) {
			return result;
		}
		P256Spki canonical_spki{};
		if (!canonicalize_p256_spki(provider_spki.data(), provider_spki.size(), canonical_spki)) {
			return LCC_DEVICE_KEY_CORRUPT;
		}
		ProviderMetadata metadata;
		result = provider->metadata(metadata);
		if (result != LCC_DEVICE_OK) {
			return result;
		}
		if (!provider_metadata_matches_contract(metadata, validated.request)) {
			return metadata.algorithm == kP256Algorithm ? LCC_DEVICE_KEY_CORRUPT : LCC_DEVICE_UNSUPPORTED_ALGORITHM;
		}
		const std::string key_id = device_key_id(canonical_spki);
		if (!is_canonical_key_id(key_id)) {
			return LCC_DEVICE_KEY_CORRUPT;
		}

		std::unique_ptr<LccDeviceIdentity> identity(new LccDeviceIdentity());
		identity->provider = std::move(provider);
		identity->spki = canonical_spki;
		identity->provider_metadata = std::move(metadata);
		identity->device_key_id = key_id;
		identity->project = std::move(validated.project);
		*out = identity.release();
		return LCC_DEVICE_OK;
	} catch (...) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
}

LCC_DEVICE_RESULT lcc_device_identity_get_metadata(LccDeviceIdentity* identity, LccDeviceIdentityMetadata* out) {
	using namespace license::device_identity;
	try {
		if (identity == nullptr) {
			return LCC_DEVICE_INVALID_ARGUMENT;
		}
		const LCC_DEVICE_RESULT output_result = validate_output(out);
		if (output_result != LCC_DEVICE_OK) {
			return output_result;
		}
		LccDeviceIdentityMetadata candidate;
		lcc_init_device_identity_metadata(&candidate);
		candidate.backend = identity->provider_metadata.backend;
		candidate.scope = identity->provider_metadata.scope;
		candidate.assurance = identity->provider_metadata.assurance;
		if (!copy_output(candidate.provider, identity->provider_metadata.provider) ||
			!copy_output(candidate.algorithm, identity->provider_metadata.algorithm) ||
			!copy_output(candidate.device_key_id, identity->device_key_id)) {
			return LCC_DEVICE_INTERNAL_ERROR;
		}
		std::memcpy(out, &candidate, sizeof(candidate));
		return LCC_DEVICE_OK;
	} catch (...) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
}

LCC_DEVICE_RESULT lcc_device_identity_get_public_spki(LccDeviceIdentity* identity, std::uint8_t* out,
													  std::size_t* inout_size) {
	if (identity == nullptr || inout_size == nullptr) {
		return LCC_DEVICE_INVALID_ARGUMENT;
	}
	if (out == nullptr || *inout_size < identity->spki.size()) {
		*inout_size = identity->spki.size();
		return LCC_DEVICE_BUFFER_TOO_SMALL;
	}
	std::memcpy(out, identity->spki.data(), identity->spki.size());
	*inout_size = identity->spki.size();
	return LCC_DEVICE_OK;
}

LCC_DEVICE_RESULT lcc_device_identity_delete_key(const LccDeviceIdentityOptions* options,
												 const char* expected_device_key_id) {
	using namespace license::device_identity;
	try {
		if (expected_device_key_id == nullptr) {
			return LCC_DEVICE_INVALID_ARGUMENT;
		}
		constexpr std::size_t expected_size = LCC_DEVICE_KEY_ID_MAX;
		std::size_t expected_length = 0U;
		while (expected_length <= expected_size && expected_device_key_id[expected_length] != '\0') {
			++expected_length;
		}
		if (expected_length != expected_size) {
			return LCC_DEVICE_INVALID_ARGUMENT;
		}
		const std::string expected(expected_device_key_id, expected_size);
		if (!is_canonical_key_id(expected)) {
			return LCC_DEVICE_INVALID_ARGUMENT;
		}
		ValidatedOptions validated;
		LCC_DEVICE_RESULT result = validate_options(options, true, validated);
		if (result != LCC_DEVICE_OK) {
			return result;
		}
		std::unique_ptr<DeviceKeyProvider> provider;
		result = select_provider(validated, provider);
		if (result != LCC_DEVICE_OK) {
			return result;
		}
		return provider->delete_with_expected_id(validated.request, expected);
	} catch (...) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
}

void lcc_device_identity_close(LccDeviceIdentity* identity) {
	try {
		delete identity;
	} catch (...) {
	}
}

const char* lcc_device_strerror(LCC_DEVICE_RESULT result) {
	switch (result) {
		case LCC_DEVICE_OK:
			return "ok";
		case LCC_DEVICE_INVALID_ARGUMENT:
			return "invalid argument";
		case LCC_DEVICE_UNSUPPORTED_VERSION:
			return "unsupported version";
		case LCC_DEVICE_BUFFER_TOO_SMALL:
			return "buffer too small";
		case LCC_DEVICE_PROVIDER_UNAVAILABLE:
			return "provider unavailable";
		case LCC_DEVICE_HARDWARE_UNAVAILABLE:
			return "hardware unavailable";
		case LCC_DEVICE_ACCESS_DENIED:
			return "access denied";
		case LCC_DEVICE_KEY_NOT_FOUND:
			return "device key not found";
		case LCC_DEVICE_KEY_CORRUPT:
			return "device key corrupt";
		case LCC_DEVICE_KEY_LOST:
			return "device key lost";
		case LCC_DEVICE_UNSUPPORTED_ALGORITHM:
			return "unsupported algorithm";
		case LCC_DEVICE_SIGN_FAILED:
			return "device signing failed";
		case LCC_DEVICE_IO_ERROR:
			return "I/O error";
		case LCC_DEVICE_BUSY:
			return "device key busy";
		case LCC_DEVICE_POLICY_VIOLATION:
			return "device policy violation";
		case LCC_DEVICE_INTERNAL_ERROR:
			return "internal device error";
		default:
			return "unknown device result";
	}
}

}  // extern "C"
