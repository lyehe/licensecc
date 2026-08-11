#include "../device_key_provider.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>
#else
#include <openssl/ec.h>
#include <openssl/evp.h>
#include <openssl/obj_mac.h>
#include <openssl/x509.h>
#endif

namespace license {
namespace device_identity {
namespace {

#ifdef _WIN32
#ifndef NT_SUCCESS
#define NT_SUCCESS(Status) (((NTSTATUS)(Status)) >= 0)
#endif

struct SoftwareKey {
	~SoftwareKey() {
		if (key != nullptr) {
			BCryptDestroyKey(key);
		}
	}
	BCRYPT_KEY_HANDLE key = nullptr;
};
#else
using PkeyContextPtr = std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)>;

struct SoftwareKey {
	~SoftwareKey() {
		if (key != nullptr) {
			EVP_PKEY_free(key);
		}
	}
	EVP_PKEY* key = nullptr;
};
#endif

struct RegistryEntry {
	std::shared_ptr<SoftwareKey> key;
	std::uint32_t scope = LCC_DEVICE_SCOPE_UNSPECIFIED;
};

std::timed_mutex& registry_mutex() {
	static std::timed_mutex value;
	return value;
}

std::map<std::string, RegistryEntry>& registry() {
	static std::map<std::string, RegistryEntry> value;
	return value;
}

bool lock_registry(std::unique_lock<std::timed_mutex>& lock, std::uint32_t timeout_ms) {
	return timeout_ms == 0U ? lock.try_lock() : lock.try_lock_for(std::chrono::milliseconds(timeout_ms));
}

bool constant_time_equal(const std::string& left, const std::string& right) {
	std::size_t difference = left.size() ^ right.size();
	const std::size_t maximum = (std::max)(left.size(), right.size());
	for (std::size_t index = 0U; index < maximum; ++index) {
		const unsigned char a = index < left.size() ? static_cast<unsigned char>(left[index]) : 0U;
		const unsigned char b = index < right.size() ? static_cast<unsigned char>(right[index]) : 0U;
		difference |= static_cast<std::size_t>(a ^ b);
	}
	return difference == 0U;
}

LCC_DEVICE_RESULT generate_key(std::shared_ptr<SoftwareKey>& out) {
	try {
		std::shared_ptr<SoftwareKey> candidate = std::make_shared<SoftwareKey>();
#ifdef _WIN32
		BCRYPT_ALG_HANDLE algorithm = nullptr;
		if (!NT_SUCCESS(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0))) {
			return LCC_DEVICE_PROVIDER_UNAVAILABLE;
		}
		BCRYPT_KEY_HANDLE key = nullptr;
		const NTSTATUS generated = BCryptGenerateKeyPair(algorithm, &key, 256U, 0);
		const NTSTATUS finalized = NT_SUCCESS(generated) ? BCryptFinalizeKeyPair(key, 0) : generated;
		BCryptCloseAlgorithmProvider(algorithm, 0);
		if (!NT_SUCCESS(generated) || !NT_SUCCESS(finalized)) {
			if (key != nullptr) {
				BCryptDestroyKey(key);
			}
			return LCC_DEVICE_INTERNAL_ERROR;
		}
		candidate->key = key;
#else
		PkeyContextPtr context(EVP_PKEY_CTX_new_id(EVP_PKEY_EC, nullptr), EVP_PKEY_CTX_free);
		if (!context) {
			return LCC_DEVICE_PROVIDER_UNAVAILABLE;
		}
		EVP_PKEY* key = nullptr;
		const bool generated = EVP_PKEY_keygen_init(context.get()) > 0 &&
							   EVP_PKEY_CTX_set_ec_paramgen_curve_nid(context.get(), NID_X9_62_prime256v1) > 0 &&
							   EVP_PKEY_keygen(context.get(), &key) > 0;
		if (!generated || key == nullptr) {
			if (key != nullptr) {
				EVP_PKEY_free(key);
			}
			return LCC_DEVICE_INTERNAL_ERROR;
		}
		candidate->key = key;
#endif
		out = std::move(candidate);
		return LCC_DEVICE_OK;
	} catch (...) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
}

LCC_DEVICE_RESULT export_spki(const std::shared_ptr<SoftwareKey>& key, P256Spki& out) {
	if (!key || key->key == nullptr) {
		return LCC_DEVICE_KEY_LOST;
	}
	try {
#ifdef _WIN32
		ULONG required = 0U;
		if (!NT_SUCCESS(BCryptExportKey(key->key, nullptr, BCRYPT_ECCPUBLIC_BLOB, nullptr, 0U, &required, 0)) ||
			required != sizeof(BCRYPT_ECCKEY_BLOB) + 64U) {
			return LCC_DEVICE_KEY_CORRUPT;
		}
		SensitiveVector blob(required);
		ULONG written = 0U;
		if (!NT_SUCCESS(
				BCryptExportKey(key->key, nullptr, BCRYPT_ECCPUBLIC_BLOB, blob.value.data(), required, &written, 0)) ||
			written != required) {
			return LCC_DEVICE_KEY_CORRUPT;
		}
		const BCRYPT_ECCKEY_BLOB* header = reinterpret_cast<const BCRYPT_ECCKEY_BLOB*>(blob.value.data());
		if (header->dwMagic != BCRYPT_ECDSA_PUBLIC_P256_MAGIC || header->cbKey != 32U) {
			return LCC_DEVICE_KEY_CORRUPT;
		}
		static constexpr std::array<std::uint8_t, 27> prefix = {{0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
																 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
																 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04}};
		P256Spki candidate{};
		std::copy(prefix.begin(), prefix.end(), candidate.begin());
		std::copy(blob.value.begin() + sizeof(BCRYPT_ECCKEY_BLOB), blob.value.end(), candidate.begin() + prefix.size());
#else
		const int required = i2d_PUBKEY(key->key, nullptr);
		if (required != 91) {
			return LCC_DEVICE_KEY_CORRUPT;
		}
		std::vector<std::uint8_t> encoded(static_cast<std::size_t>(required));
		unsigned char* cursor = encoded.data();
		if (i2d_PUBKEY(key->key, &cursor) != required || cursor != encoded.data() + encoded.size()) {
			return LCC_DEVICE_KEY_CORRUPT;
		}
		P256Spki candidate{};
		if (!canonicalize_p256_spki(encoded.data(), encoded.size(), candidate)) {
			return LCC_DEVICE_KEY_CORRUPT;
		}
#endif
		P256Spki canonical{};
		if (!canonicalize_p256_spki(candidate.data(), candidate.size(), canonical)) {
			return LCC_DEVICE_KEY_CORRUPT;
		}
		out = canonical;
		return LCC_DEVICE_OK;
	} catch (...) {
		return LCC_DEVICE_INTERNAL_ERROR;
	}
}

LCC_DEVICE_RESULT sign_with_key(const std::shared_ptr<SoftwareKey>& key, const P256Digest& digest, P256Signature& out) {
	if (!key || key->key == nullptr) {
		return LCC_DEVICE_KEY_LOST;
	}
	try {
#ifdef _WIN32
		SensitiveArray<64> candidate;
		ULONG written = 0U;
		if (!NT_SUCCESS(BCryptSignHash(key->key, nullptr, const_cast<PUCHAR>(digest.data()),
									   static_cast<ULONG>(digest.size()), candidate.value.data(),
									   static_cast<ULONG>(candidate.value.size()), &written, 0)) ||
			written != candidate.value.size() || !p1363_signature_in_range(candidate.value)) {
			return LCC_DEVICE_SIGN_FAILED;
		}
#else
		PkeyContextPtr context(EVP_PKEY_CTX_new(key->key, nullptr), EVP_PKEY_CTX_free);
		if (!context) {
			return LCC_DEVICE_SIGN_FAILED;
		}
		std::size_t der_size = 0U;
		const bool initialized = EVP_PKEY_sign_init(context.get()) > 0 &&
								 EVP_PKEY_CTX_set_signature_md(context.get(), EVP_sha256()) > 0 &&
								 EVP_PKEY_sign(context.get(), nullptr, &der_size, digest.data(), digest.size()) > 0;
		const bool der_size_valid = initialized && der_size >= 8U && der_size <= 72U;
		SensitiveVector der(der_size_valid ? der_size : 0U);
		const bool signed_digest = der_size_valid && EVP_PKEY_sign(context.get(), der.value.data(), &der_size,
																   digest.data(), digest.size()) > 0;
		SensitiveArray<64> candidate;
		if (!signed_digest || !der_signature_to_p1363(der.value.data(), der_size, candidate.value)) {
			return LCC_DEVICE_SIGN_FAILED;
		}
#endif
		out = candidate.value;
		return LCC_DEVICE_OK;
	} catch (...) {
		return LCC_DEVICE_SIGN_FAILED;
	}
}

class SoftwareTestProvider final : public DeviceKeyProvider {
public:
	LCC_DEVICE_RESULT open(const ProviderOpenRequest& request) noexcept override {
		try {
			std::unique_lock<std::timed_mutex> lock(registry_mutex(), std::defer_lock);
			if (!lock_registry(lock, request.lock_timeout_ms)) {
				return LCC_DEVICE_BUSY;
			}
			const auto found = registry().find(request.device_namespace.hash);
			if (found == registry().end()) {
				return LCC_DEVICE_KEY_NOT_FOUND;
			}
			key_ = found->second.key;
			scope_ = found->second.scope;
			return LCC_DEVICE_OK;
		} catch (...) {
			return LCC_DEVICE_INTERNAL_ERROR;
		}
	}

	LCC_DEVICE_RESULT create(const ProviderOpenRequest& request) noexcept override {
		try {
			std::unique_lock<std::timed_mutex> lock(registry_mutex(), std::defer_lock);
			if (!lock_registry(lock, request.lock_timeout_ms)) {
				return LCC_DEVICE_BUSY;
			}
			const auto found = registry().find(request.device_namespace.hash);
			if (found != registry().end()) {
				key_ = found->second.key;
				scope_ = found->second.scope;
				return LCC_DEVICE_OK;
			}
			std::shared_ptr<SoftwareKey> generated;
			const LCC_DEVICE_RESULT result = generate_key(generated);
			if (result != LCC_DEVICE_OK) {
				return result;
			}
			P256Spki generated_spki{};
			SensitiveArray<32> self_test_digest;
			SensitiveArray<64> self_test_signature;
			const LCC_DEVICE_RESULT exported = export_spki(generated, generated_spki);
			const bool digest_ready =
				exported == LCC_DEVICE_OK &&
				sha256(reinterpret_cast<const std::uint8_t*>(request.device_namespace.payload.data()),
					   request.device_namespace.payload.size(), self_test_digest.value);
			const LCC_DEVICE_RESULT signed_result =
				digest_ready ? sign_with_key(generated, self_test_digest.value, self_test_signature.value)
							 : LCC_DEVICE_INTERNAL_ERROR;
			const bool verified = signed_result == LCC_DEVICE_OK &&
								  verify_p256_p1363(generated_spki, self_test_digest.value, self_test_signature.value);
			if (!verified) {
				return exported != LCC_DEVICE_OK		? exported
					   : signed_result != LCC_DEVICE_OK ? signed_result
														: LCC_DEVICE_SIGN_FAILED;
			}
			RegistryEntry entry;
			entry.key = generated;
			entry.scope = request.scope;
			registry().emplace(request.device_namespace.hash, entry);
			key_ = std::move(generated);
			scope_ = request.scope;
			return LCC_DEVICE_OK;
		} catch (...) {
			return LCC_DEVICE_INTERNAL_ERROR;
		}
	}

	LCC_DEVICE_RESULT public_spki(P256Spki& out) noexcept override { return export_spki(key_, out); }

	LCC_DEVICE_RESULT sign_digest(const P256Digest& digest, P256Signature& out) noexcept override {
		return sign_with_key(key_, digest, out);
	}

	LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept override {
		try {
			if (!key_) {
				return LCC_DEVICE_KEY_LOST;
			}
			const ProviderContract* contract = provider_contract_for_backend(LCC_DEVICE_BACKEND_SOFTWARE_TEST);
			if (contract == nullptr) {
				return LCC_DEVICE_INTERNAL_ERROR;
			}
			ProviderMetadata candidate;
			candidate.backend = contract->backend;
			candidate.scope = scope_;
			candidate.assurance = contract->assurance;
			candidate.provider = contract->provider;
			candidate.algorithm = contract->algorithm;
			out = std::move(candidate);
			return LCC_DEVICE_OK;
		} catch (...) {
			return LCC_DEVICE_INTERNAL_ERROR;
		}
	}

	LCC_DEVICE_RESULT delete_with_expected_id(const ProviderOpenRequest& request,
											  const std::string& expected_device_key_id) noexcept override {
		try {
			std::unique_lock<std::timed_mutex> lock(registry_mutex(), std::defer_lock);
			if (!lock_registry(lock, request.lock_timeout_ms)) {
				return LCC_DEVICE_BUSY;
			}
			const auto found = registry().find(request.device_namespace.hash);
			if (found == registry().end()) {
				return LCC_DEVICE_KEY_NOT_FOUND;
			}
			P256Spki spki{};
			const LCC_DEVICE_RESULT exported = export_spki(found->second.key, spki);
			if (exported != LCC_DEVICE_OK) {
				return exported;
			}
			const std::string actual = device_key_id(spki);
			if (actual.empty()) {
				return LCC_DEVICE_KEY_CORRUPT;
			}
			if (!constant_time_equal(actual, expected_device_key_id)) {
				return LCC_DEVICE_POLICY_VIOLATION;
			}
			const bool deleting_open_key = key_ && key_ == found->second.key;
			registry().erase(found);
			if (deleting_open_key) {
				key_.reset();
			}
			return LCC_DEVICE_OK;
		} catch (...) {
			return LCC_DEVICE_INTERNAL_ERROR;
		}
	}

private:
	std::shared_ptr<SoftwareKey> key_;
	std::uint32_t scope_ = LCC_DEVICE_SCOPE_UNSPECIFIED;
};

}  // namespace

std::unique_ptr<DeviceKeyProvider> make_software_test_provider() noexcept {
	try {
		return std::unique_ptr<DeviceKeyProvider>(new SoftwareTestProvider());
	} catch (...) {
		return nullptr;
	}
}

}  // namespace device_identity
}  // namespace license
