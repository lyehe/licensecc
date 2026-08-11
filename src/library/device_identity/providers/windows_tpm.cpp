#include "windows_cng_api.hpp"

#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <cwchar>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace license {
namespace device_identity {
namespace {

constexpr std::array<std::uint8_t, 27> kP256SpkiPrefix = {{0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
														   0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
														   0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04}};

bool status_is(SECURITY_STATUS status, HRESULT expected) noexcept {
	return status == static_cast<SECURITY_STATUS>(expected);
}

bool operation_is_capability_check(WindowsCngOperation operation) noexcept {
	return operation == WindowsCngOperation::open_key || operation == WindowsCngOperation::create_key ||
		   operation == WindowsCngOperation::set_property || operation == WindowsCngOperation::finalize_key ||
		   operation == WindowsCngOperation::get_property || operation == WindowsCngOperation::export_public ||
		   operation == WindowsCngOperation::sign_digest;
}

bool constant_time_equal(const std::string& left, const std::string& right) noexcept {
	std::size_t difference = left.size() ^ right.size();
	const std::size_t maximum = (std::max)(left.size(), right.size());
	for (std::size_t index = 0U; index < maximum; ++index) {
		const unsigned char a = index < left.size() ? static_cast<unsigned char>(left[index]) : 0U;
		const unsigned char b = index < right.size() ? static_cast<unsigned char>(right[index]) : 0U;
		difference |= static_cast<std::size_t>(a ^ b);
	}
	return difference == 0U;
}

class NativeWindowsCngApi final : public WindowsCngApi {
public:
	SECURITY_STATUS open_storage_provider(NCRYPT_PROV_HANDLE* provider, LPCWSTR provider_name,
										  DWORD flags) noexcept override {
		return NCryptOpenStorageProvider(provider, provider_name, flags);
	}

	SECURITY_STATUS open_key(NCRYPT_PROV_HANDLE provider, NCRYPT_KEY_HANDLE* key, LPCWSTR key_name,
							 DWORD legacy_key_spec, DWORD flags) noexcept override {
		return NCryptOpenKey(provider, key, key_name, legacy_key_spec, flags);
	}

	SECURITY_STATUS create_persisted_key(NCRYPT_PROV_HANDLE provider, NCRYPT_KEY_HANDLE* key, LPCWSTR algorithm,
										 LPCWSTR key_name, DWORD legacy_key_spec, DWORD flags) noexcept override {
		return NCryptCreatePersistedKey(provider, key, algorithm, key_name, legacy_key_spec, flags);
	}

	SECURITY_STATUS set_property(NCRYPT_HANDLE object, LPCWSTR property, PBYTE input, DWORD input_size,
								 DWORD flags) noexcept override {
		return NCryptSetProperty(object, property, input, input_size, flags);
	}

	SECURITY_STATUS finalize_key(NCRYPT_KEY_HANDLE key, DWORD flags) noexcept override {
		return NCryptFinalizeKey(key, flags);
	}

	SECURITY_STATUS get_property(NCRYPT_HANDLE object, LPCWSTR property, PBYTE output, DWORD output_size,
								 DWORD* result_size, DWORD flags) noexcept override {
		return NCryptGetProperty(object, property, output, output_size, result_size, flags);
	}

	SECURITY_STATUS export_key(NCRYPT_KEY_HANDLE key, NCRYPT_KEY_HANDLE export_key, LPCWSTR blob_type,
							   NCryptBufferDesc* parameters, PBYTE output, DWORD output_size, DWORD* result_size,
							   DWORD flags) noexcept override {
		return NCryptExportKey(key, export_key, blob_type, parameters, output, output_size, result_size, flags);
	}

	SECURITY_STATUS sign_hash(NCRYPT_KEY_HANDLE key, void* padding_info, PBYTE digest, DWORD digest_size,
							  PBYTE signature, DWORD signature_size, DWORD* result_size,
							  DWORD flags) noexcept override {
		return NCryptSignHash(key, padding_info, digest, digest_size, signature, signature_size, result_size, flags);
	}

	SECURITY_STATUS delete_key(NCRYPT_KEY_HANDLE key, DWORD flags) noexcept override {
		return NCryptDeleteKey(key, flags);
	}

	SECURITY_STATUS free_object(NCRYPT_HANDLE object) noexcept override { return NCryptFreeObject(object); }
};

class WindowsTpmProvider final : public DeviceKeyProvider {
public:
	explicit WindowsTpmProvider(std::shared_ptr<WindowsCngApi> api) : api_(std::move(api)) {}

	~WindowsTpmProvider() override {
		release_key();
		release_provider();
	}

	LCC_DEVICE_RESULT open(const ProviderOpenRequest& request) noexcept override {
		try {
			reset();
			const LCC_DEVICE_RESULT request_result = validate_request(request);
			if (request_result != LCC_DEVICE_OK) {
				return request_result;
			}
			LCC_DEVICE_RESULT result = open_provider();
			if (result != LCC_DEVICE_OK) {
				return result;
			}
			return open_scoped_key(request);
		} catch (...) {
			reset();
			return LCC_DEVICE_INTERNAL_ERROR;
		}
	}

	LCC_DEVICE_RESULT create(const ProviderOpenRequest& request) noexcept override {
		try {
			release_key();
			const LCC_DEVICE_RESULT request_result = validate_request(request);
			if (request_result != LCC_DEVICE_OK) {
				return request_result;
			}
			if (provider_ == 0U) {
				const LCC_DEVICE_RESULT provider_result = open_provider();
				if (provider_result != LCC_DEVICE_OK) {
					return provider_result;
				}
			}

			const std::wstring key_name(request.device_namespace.windows_name.begin(),
										request.device_namespace.windows_name.end());
			NCRYPT_KEY_HANDLE created = 0U;
			const DWORD flags = scope_flags(request.scope) | NCRYPT_SILENT_FLAG;
			const SECURITY_STATUS create_status = api_->create_persisted_key(
				provider_, &created, NCRYPT_ECDSA_P256_ALGORITHM, key_name.c_str(), 0U, flags);
			if (status_is(create_status, NTE_EXISTS)) {
				if (created != 0U) {
					const SECURITY_STATUS free_status = api_->free_object(created);
					if (free_status != ERROR_SUCCESS) {
						return map_windows_cng_error(free_status, WindowsCngOperation::free_object);
					}
				}
				return open_scoped_key(request);
			}
			if (create_status != ERROR_SUCCESS || created == 0U) {
				if (created != 0U) {
					(void)api_->free_object(created);
				}
				return create_status == ERROR_SUCCESS
						   ? LCC_DEVICE_INTERNAL_ERROR
						   : map_windows_cng_error(create_status, WindowsCngOperation::create_key);
			}

			DWORD usage = NCRYPT_ALLOW_SIGNING_FLAG;
			SECURITY_STATUS status =
				api_->set_property(created, NCRYPT_KEY_USAGE_PROPERTY, reinterpret_cast<PBYTE>(&usage),
								   static_cast<DWORD>(sizeof(usage)), NCRYPT_PERSIST_FLAG | NCRYPT_SILENT_FLAG);
			if (status != ERROR_SUCCESS) {
				(void)api_->free_object(created);
				return map_windows_cng_error(status, WindowsCngOperation::set_property);
			}

			DWORD export_policy = 0U;
			status =
				api_->set_property(created, NCRYPT_EXPORT_POLICY_PROPERTY, reinterpret_cast<PBYTE>(&export_policy),
								   static_cast<DWORD>(sizeof(export_policy)), NCRYPT_PERSIST_FLAG | NCRYPT_SILENT_FLAG);
			if (status != ERROR_SUCCESS) {
				(void)api_->free_object(created);
				return map_windows_cng_error(status, WindowsCngOperation::set_property);
			}

			status = api_->finalize_key(created, NCRYPT_SILENT_FLAG);
			if (status != ERROR_SUCCESS) {
				(void)api_->free_object(created);
				return map_windows_cng_error(status, WindowsCngOperation::finalize_key);
			}

			NCRYPT_KEY_HANDLE reopened = 0U;
			status = api_->open_key(provider_, &reopened, key_name.c_str(), 0U, flags);
			if (status != ERROR_SUCCESS || reopened == 0U) {
				if (reopened != 0U) {
					(void)api_->free_object(reopened);
				}
				rollback_created_key(created);
				return status == ERROR_SUCCESS ? LCC_DEVICE_INTERNAL_ERROR
											   : map_windows_cng_error(status, WindowsCngOperation::open_key);
			}

			P256Spki reopened_spki{};
			LCC_DEVICE_RESULT result = validate_key(reopened, reopened_spki);
			if (result == LCC_DEVICE_OK) {
				result = self_test(reopened, request, reopened_spki);
			}
			if (result != LCC_DEVICE_OK) {
				(void)api_->free_object(reopened);
				rollback_created_key(created);
				return result;
			}

			const SECURITY_STATUS release_status = api_->free_object(created);
			if (release_status != ERROR_SUCCESS) {
				(void)api_->free_object(reopened);
				rollback_created_key(created);
				return map_windows_cng_error(release_status, WindowsCngOperation::free_object);
			}

			key_ = reopened;
			spki_ = reopened_spki;
			scope_ = request.scope;
			validated_ = true;
			return LCC_DEVICE_OK;
		} catch (...) {
			release_key();
			return LCC_DEVICE_INTERNAL_ERROR;
		}
	}

	LCC_DEVICE_RESULT public_spki(P256Spki& out) noexcept override {
		if (!validated_ || key_ == 0U) {
			return LCC_DEVICE_KEY_LOST;
		}
		out = spki_;
		return LCC_DEVICE_OK;
	}

	LCC_DEVICE_RESULT sign_digest(const P256Digest& digest, P256Signature& out) noexcept override {
		if (!validated_ || key_ == 0U) {
			return LCC_DEVICE_KEY_LOST;
		}
		return sign_with_key(key_, digest, out);
	}

	LCC_DEVICE_RESULT metadata(ProviderMetadata& out) noexcept override {
		try {
			if (!validated_ || key_ == 0U) {
				return LCC_DEVICE_KEY_LOST;
			}
			ProviderMetadata candidate;
			candidate.backend = kWindowsTpmProviderContract.backend;
			candidate.scope = scope_;
			candidate.assurance = kWindowsTpmProviderContract.assurance;
			candidate.provider = kWindowsTpmProviderContract.provider;
			candidate.algorithm = kWindowsTpmProviderContract.algorithm;
			out = std::move(candidate);
			return LCC_DEVICE_OK;
		} catch (...) {
			return LCC_DEVICE_INTERNAL_ERROR;
		}
	}

	LCC_DEVICE_RESULT delete_with_expected_id(const ProviderOpenRequest& request,
											  const std::string& expected_device_key_id) noexcept override {
		try {
			reset();
			const LCC_DEVICE_RESULT request_result = validate_request(request);
			if (request_result != LCC_DEVICE_OK || expected_device_key_id.size() != LCC_DEVICE_KEY_ID_MAX) {
				return request_result != LCC_DEVICE_OK ? request_result : LCC_DEVICE_INVALID_ARGUMENT;
			}
			LCC_DEVICE_RESULT result = open_provider();
			if (result != LCC_DEVICE_OK) {
				return result;
			}
			result = open_scoped_key(request);
			if (result != LCC_DEVICE_OK) {
				return result;
			}
			const std::string actual_device_key_id = device_key_id(spki_);
			if (actual_device_key_id.empty()) {
				release_key();
				return LCC_DEVICE_KEY_CORRUPT;
			}
			if (!constant_time_equal(actual_device_key_id, expected_device_key_id)) {
				release_key();
				return LCC_DEVICE_POLICY_VIOLATION;
			}
			const SECURITY_STATUS status = api_->delete_key(key_, NCRYPT_SILENT_FLAG);
			if (status == ERROR_SUCCESS) {
				key_ = 0U;
				validated_ = false;
				scope_ = LCC_DEVICE_SCOPE_UNSPECIFIED;
				spki_.fill(0U);
				return LCC_DEVICE_OK;
			}
			release_key();
			return map_windows_cng_error(status, WindowsCngOperation::delete_key);
		} catch (...) {
			release_key();
			return LCC_DEVICE_INTERNAL_ERROR;
		}
	}

private:
	static DWORD scope_flags(std::uint32_t scope) noexcept {
		return scope == LCC_DEVICE_SCOPE_MACHINE ? NCRYPT_MACHINE_KEY_FLAG : 0U;
	}

	LCC_DEVICE_RESULT validate_request(const ProviderOpenRequest& request) const {
		if (request.backend != LCC_DEVICE_BACKEND_WINDOWS_TPM ||
			(request.scope != LCC_DEVICE_SCOPE_USER && request.scope != LCC_DEVICE_SCOPE_MACHINE) ||
			request.device_namespace.hash.size() != 64U ||
			request.device_namespace.windows_name != "licensecc-v1-" + request.device_namespace.hash) {
			return LCC_DEVICE_INVALID_ARGUMENT;
		}
		return LCC_DEVICE_OK;
	}

	LCC_DEVICE_RESULT open_provider() noexcept {
		if (!api_) {
			return LCC_DEVICE_INTERNAL_ERROR;
		}
		if (provider_ != 0U) {
			return LCC_DEVICE_OK;
		}
		NCRYPT_PROV_HANDLE candidate = 0U;
		const SECURITY_STATUS status = api_->open_storage_provider(&candidate, MS_PLATFORM_CRYPTO_PROVIDER, 0U);
		if (status != ERROR_SUCCESS || candidate == 0U) {
			if (candidate != 0U) {
				(void)api_->free_object(candidate);
			}
			return status == ERROR_SUCCESS ? LCC_DEVICE_INTERNAL_ERROR
										   : map_windows_cng_error(status, WindowsCngOperation::open_provider);
		}
		provider_ = candidate;
		return LCC_DEVICE_OK;
	}

	LCC_DEVICE_RESULT open_scoped_key(const ProviderOpenRequest& request) {
		const std::wstring key_name(request.device_namespace.windows_name.begin(),
									request.device_namespace.windows_name.end());
		NCRYPT_KEY_HANDLE candidate = 0U;
		const SECURITY_STATUS status = api_->open_key(provider_, &candidate, key_name.c_str(), 0U,
													  scope_flags(request.scope) | NCRYPT_SILENT_FLAG);
		if (status != ERROR_SUCCESS || candidate == 0U) {
			if (candidate != 0U) {
				(void)api_->free_object(candidate);
			}
			return status == ERROR_SUCCESS ? LCC_DEVICE_INTERNAL_ERROR
										   : map_windows_cng_error(status, WindowsCngOperation::open_key);
		}
		P256Spki candidate_spki{};
		const LCC_DEVICE_RESULT result = validate_key(candidate, candidate_spki);
		if (result != LCC_DEVICE_OK) {
			(void)api_->free_object(candidate);
			return result;
		}
		key_ = candidate;
		spki_ = candidate_spki;
		scope_ = request.scope;
		validated_ = true;
		return LCC_DEVICE_OK;
	}

	LCC_DEVICE_RESULT validate_key(NCRYPT_KEY_HANDLE key, P256Spki& out) noexcept {
		try {
			NCRYPT_PROV_HANDLE owning_provider = 0U;
			DWORD written = 0U;
			SECURITY_STATUS status =
				api_->get_property(key, NCRYPT_PROVIDER_HANDLE_PROPERTY, reinterpret_cast<PBYTE>(&owning_provider),
								   static_cast<DWORD>(sizeof(owning_provider)), &written, NCRYPT_SILENT_FLAG);
			if (status != ERROR_SUCCESS) {
				return map_windows_cng_error(status, WindowsCngOperation::get_property);
			}
			if (written != sizeof(owning_provider) || owning_provider != provider_) {
				return LCC_DEVICE_KEY_CORRUPT;
			}

			std::array<wchar_t, 64> algorithm{};
			written = 0U;
			status = api_->get_property(key, NCRYPT_ALGORITHM_PROPERTY, reinterpret_cast<PBYTE>(algorithm.data()),
										static_cast<DWORD>(algorithm.size() * sizeof(wchar_t)), &written,
										NCRYPT_SILENT_FLAG);
			if (status != ERROR_SUCCESS) {
				return map_windows_cng_error(status, WindowsCngOperation::get_property);
			}
			const DWORD expected_algorithm_size =
				static_cast<DWORD>((std::wcslen(NCRYPT_ECDSA_P256_ALGORITHM) + 1U) * sizeof(wchar_t));
			if (written != expected_algorithm_size || std::wcscmp(algorithm.data(), NCRYPT_ECDSA_P256_ALGORITHM) != 0) {
				return LCC_DEVICE_UNSUPPORTED_ALGORITHM;
			}

			DWORD usage = 0U;
			written = 0U;
			status = api_->get_property(key, NCRYPT_KEY_USAGE_PROPERTY, reinterpret_cast<PBYTE>(&usage),
										static_cast<DWORD>(sizeof(usage)), &written, NCRYPT_SILENT_FLAG);
			if (status != ERROR_SUCCESS) {
				return map_windows_cng_error(status, WindowsCngOperation::get_property);
			}
			if (written != sizeof(usage) || usage != NCRYPT_ALLOW_SIGNING_FLAG) {
				return LCC_DEVICE_KEY_CORRUPT;
			}

			DWORD export_policy = 0U;
			written = 0U;
			status = api_->get_property(key, NCRYPT_EXPORT_POLICY_PROPERTY, reinterpret_cast<PBYTE>(&export_policy),
										static_cast<DWORD>(sizeof(export_policy)), &written, NCRYPT_SILENT_FLAG);
			if (status != ERROR_SUCCESS) {
				return map_windows_cng_error(status, WindowsCngOperation::get_property);
			}
			if (written != sizeof(export_policy) || export_policy != 0U) {
				return LCC_DEVICE_KEY_CORRUPT;
			}

			DWORD blob_size = 0U;
			status =
				api_->export_key(key, 0U, BCRYPT_ECCPUBLIC_BLOB, nullptr, nullptr, 0U, &blob_size, NCRYPT_SILENT_FLAG);
			constexpr DWORD expected_blob_size = static_cast<DWORD>(sizeof(BCRYPT_ECCKEY_BLOB) + 64U);
			if (status != ERROR_SUCCESS) {
				return map_windows_cng_error(status, WindowsCngOperation::export_public);
			}
			if (blob_size != expected_blob_size) {
				return LCC_DEVICE_KEY_CORRUPT;
			}
			std::vector<std::uint8_t> blob(blob_size);
			DWORD exported = 0U;
			status = api_->export_key(key, 0U, BCRYPT_ECCPUBLIC_BLOB, nullptr, blob.data(), blob_size, &exported,
									  NCRYPT_SILENT_FLAG);
			if (status != ERROR_SUCCESS) {
				return map_windows_cng_error(status, WindowsCngOperation::export_public);
			}
			if (exported != expected_blob_size) {
				return LCC_DEVICE_KEY_CORRUPT;
			}
			BCRYPT_ECCKEY_BLOB header{};
			std::memcpy(&header, blob.data(), sizeof(header));
			if (header.dwMagic != BCRYPT_ECDSA_PUBLIC_P256_MAGIC || header.cbKey != 32U) {
				return LCC_DEVICE_KEY_CORRUPT;
			}
			P256Spki candidate{};
			std::copy(kP256SpkiPrefix.begin(), kP256SpkiPrefix.end(), candidate.begin());
			std::copy(blob.begin() + sizeof(header), blob.end(), candidate.begin() + kP256SpkiPrefix.size());
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

	LCC_DEVICE_RESULT sign_with_key(NCRYPT_KEY_HANDLE key, const P256Digest& digest, P256Signature& out) noexcept {
		DWORD signature_size = 0U;
		SECURITY_STATUS status =
			api_->sign_hash(key, nullptr, const_cast<PBYTE>(digest.data()), static_cast<DWORD>(digest.size()), nullptr,
							0U, &signature_size, NCRYPT_SILENT_FLAG);
		if (status != ERROR_SUCCESS) {
			return map_windows_cng_error(status, WindowsCngOperation::sign_digest);
		}
		if (signature_size != P256Signature{}.size()) {
			return LCC_DEVICE_SIGN_FAILED;
		}
		SensitiveArray<64> candidate;
		DWORD written = 0U;
		status = api_->sign_hash(key, nullptr, const_cast<PBYTE>(digest.data()), static_cast<DWORD>(digest.size()),
								 candidate.value.data(), static_cast<DWORD>(candidate.value.size()), &written,
								 NCRYPT_SILENT_FLAG);
		if (status != ERROR_SUCCESS) {
			return map_windows_cng_error(status, WindowsCngOperation::sign_digest);
		}
		if (written != candidate.value.size() || !p1363_signature_in_range(candidate.value)) {
			return LCC_DEVICE_SIGN_FAILED;
		}
		out = candidate.value;
		return LCC_DEVICE_OK;
	}

	LCC_DEVICE_RESULT self_test(NCRYPT_KEY_HANDLE key, const ProviderOpenRequest& request,
								const P256Spki& spki) noexcept {
		SensitiveArray<32> digest;
		if (!sha256(reinterpret_cast<const std::uint8_t*>(request.device_namespace.payload.data()),
					request.device_namespace.payload.size(), digest.value)) {
			return LCC_DEVICE_INTERNAL_ERROR;
		}
		SensitiveArray<64> signature;
		const LCC_DEVICE_RESULT sign_result = sign_with_key(key, digest.value, signature.value);
		if (sign_result != LCC_DEVICE_OK) {
			return sign_result;
		}
		return verify_p256_p1363(spki, digest.value, signature.value) ? LCC_DEVICE_OK : LCC_DEVICE_SIGN_FAILED;
	}

	void rollback_created_key(NCRYPT_KEY_HANDLE created) noexcept {
		if (created == 0U) {
			return;
		}
		if (api_->delete_key(created, NCRYPT_SILENT_FLAG) != ERROR_SUCCESS) {
			(void)api_->free_object(created);
		}
	}

	void release_key() noexcept {
		if (key_ != 0U) {
			(void)api_->free_object(key_);
			key_ = 0U;
		}
		validated_ = false;
		scope_ = LCC_DEVICE_SCOPE_UNSPECIFIED;
		spki_.fill(0U);
	}

	void release_provider() noexcept {
		if (provider_ != 0U) {
			(void)api_->free_object(provider_);
			provider_ = 0U;
		}
	}

	void reset() noexcept {
		release_key();
		release_provider();
	}

	std::shared_ptr<WindowsCngApi> api_;
	NCRYPT_PROV_HANDLE provider_ = 0U;
	NCRYPT_KEY_HANDLE key_ = 0U;
	P256Spki spki_{};
	std::uint32_t scope_ = LCC_DEVICE_SCOPE_UNSPECIFIED;
	bool validated_ = false;
};

}  // namespace

LCC_DEVICE_RESULT map_windows_cng_error(SECURITY_STATUS status, WindowsCngOperation operation) noexcept {
	if (status == ERROR_SUCCESS) {
		return LCC_DEVICE_OK;
	}
	if (status_is(status, NTE_PERM) || status_is(status, NTE_SILENT_CONTEXT) || status_is(status, NTE_UI_REQUIRED) ||
		status_is(status, NTE_USER_CANCELLED) || status == static_cast<SECURITY_STATUS>(ERROR_ACCESS_DENIED) ||
		status_is(status, HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED))) {
		return LCC_DEVICE_ACCESS_DENIED;
	}
	if (status_is(status, NTE_DEVICE_NOT_READY) || status_is(status, NTE_DEVICE_NOT_FOUND)) {
		return LCC_DEVICE_HARDWARE_UNAVAILABLE;
	}
	if (status_is(status, NTE_BAD_PROVIDER) || status_is(status, NTE_BAD_PROV_TYPE) ||
		status_is(status, NTE_PROV_TYPE_NOT_DEF) || status_is(status, NTE_PROV_TYPE_ENTRY_BAD) ||
		status_is(status, NTE_KEYSET_NOT_DEF) || status_is(status, NTE_PROVIDER_DLL_FAIL) ||
		status_is(status, NTE_PROV_DLL_NOT_FOUND)) {
		return LCC_DEVICE_PROVIDER_UNAVAILABLE;
	}
	if (status == static_cast<SECURITY_STATUS>(ERROR_BUSY) || status == static_cast<SECURITY_STATUS>(ERROR_RETRY) ||
		status == static_cast<SECURITY_STATUS>(ERROR_LOCK_VIOLATION) ||
		status == static_cast<SECURITY_STATUS>(ERROR_SHARING_VIOLATION) ||
		status == static_cast<SECURITY_STATUS>(WAIT_TIMEOUT) || status_is(status, HRESULT_FROM_WIN32(ERROR_BUSY)) ||
		status_is(status, HRESULT_FROM_WIN32(ERROR_RETRY)) ||
		status_is(status, HRESULT_FROM_WIN32(ERROR_LOCK_VIOLATION)) ||
		status_is(status, HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION)) ||
		status_is(status, HRESULT_FROM_WIN32(WAIT_TIMEOUT))) {
		return LCC_DEVICE_BUSY;
	}
	if ((operation == WindowsCngOperation::open_key || operation == WindowsCngOperation::delete_key) &&
		(status_is(status, NTE_NOT_FOUND) || status_is(status, NTE_BAD_KEYSET))) {
		return LCC_DEVICE_KEY_NOT_FOUND;
	}
	if (status_is(status, NTE_BAD_KEY_STATE) || status_is(status, NTE_NO_KEY) ||
		status_is(status, NTE_KEYSET_ENTRY_BAD)) {
		return LCC_DEVICE_KEY_LOST;
	}
	if (status_is(status, NTE_BAD_ALGID) ||
		(status_is(status, NTE_NOT_SUPPORTED) && operation_is_capability_check(operation))) {
		return LCC_DEVICE_UNSUPPORTED_ALGORITHM;
	}
	if ((operation == WindowsCngOperation::get_property || operation == WindowsCngOperation::export_public) &&
		(status_is(status, NTE_BAD_DATA) || status_is(status, NTE_BAD_LEN) || status_is(status, NTE_BAD_PUBLIC_KEY))) {
		return LCC_DEVICE_KEY_CORRUPT;
	}
	if (operation == WindowsCngOperation::sign_digest && status_is(status, NTE_BAD_SIGNATURE)) {
		return LCC_DEVICE_SIGN_FAILED;
	}
	if (operation == WindowsCngOperation::open_provider && status_is(status, NTE_NOT_SUPPORTED)) {
		return LCC_DEVICE_PROVIDER_UNAVAILABLE;
	}
	return LCC_DEVICE_INTERNAL_ERROR;
}

std::unique_ptr<DeviceKeyProvider> make_windows_tpm_provider(std::shared_ptr<WindowsCngApi> api) noexcept {
	try {
		if (!api) {
			return nullptr;
		}
		return std::unique_ptr<DeviceKeyProvider>(new WindowsTpmProvider(std::move(api)));
	} catch (...) {
		return nullptr;
	}
}

std::unique_ptr<DeviceKeyProvider> make_windows_tpm_provider() noexcept {
	try {
		return make_windows_tpm_provider(std::make_shared<NativeWindowsCngApi>());
	} catch (...) {
		return nullptr;
	}
}

}  // namespace device_identity
}  // namespace license
