#ifndef LICENSECC_DEVICE_IDENTITY_WINDOWS_CNG_API_HPP_
#define LICENSECC_DEVICE_IDENTITY_WINDOWS_CNG_API_HPP_

#include "../device_key_provider.hpp"

#include <windows.h>
#include <ncrypt.h>

#include <cstdint>
#include <memory>

namespace license {
namespace device_identity {

enum class WindowsCngOperation : std::uint32_t {
	open_provider,
	open_key,
	create_key,
	set_property,
	finalize_key,
	get_property,
	export_public,
	sign_digest,
	delete_key,
	free_object
};

class WindowsCngApi {
public:
	virtual ~WindowsCngApi() = default;

	virtual SECURITY_STATUS open_storage_provider(NCRYPT_PROV_HANDLE* provider, LPCWSTR provider_name,
												  DWORD flags) noexcept = 0;
	virtual SECURITY_STATUS open_key(NCRYPT_PROV_HANDLE provider, NCRYPT_KEY_HANDLE* key, LPCWSTR key_name,
									 DWORD legacy_key_spec, DWORD flags) noexcept = 0;
	virtual SECURITY_STATUS create_persisted_key(NCRYPT_PROV_HANDLE provider, NCRYPT_KEY_HANDLE* key, LPCWSTR algorithm,
												 LPCWSTR key_name, DWORD legacy_key_spec, DWORD flags) noexcept = 0;
	virtual SECURITY_STATUS set_property(NCRYPT_HANDLE object, LPCWSTR property, PBYTE input, DWORD input_size,
										 DWORD flags) noexcept = 0;
	virtual SECURITY_STATUS finalize_key(NCRYPT_KEY_HANDLE key, DWORD flags) noexcept = 0;
	virtual SECURITY_STATUS get_property(NCRYPT_HANDLE object, LPCWSTR property, PBYTE output, DWORD output_size,
										 DWORD* result_size, DWORD flags) noexcept = 0;
	virtual SECURITY_STATUS export_key(NCRYPT_KEY_HANDLE key, NCRYPT_KEY_HANDLE export_key, LPCWSTR blob_type,
									   NCryptBufferDesc* parameters, PBYTE output, DWORD output_size,
									   DWORD* result_size, DWORD flags) noexcept = 0;
	virtual SECURITY_STATUS sign_hash(NCRYPT_KEY_HANDLE key, void* padding_info, PBYTE digest, DWORD digest_size,
									  PBYTE signature, DWORD signature_size, DWORD* result_size,
									  DWORD flags) noexcept = 0;
	virtual SECURITY_STATUS delete_key(NCRYPT_KEY_HANDLE key, DWORD flags) noexcept = 0;
	virtual SECURITY_STATUS free_object(NCRYPT_HANDLE object) noexcept = 0;
};

LCC_DEVICE_RESULT map_windows_cng_error(SECURITY_STATUS status, WindowsCngOperation operation) noexcept;

std::unique_ptr<DeviceKeyProvider> make_windows_tpm_provider(std::shared_ptr<WindowsCngApi> api) noexcept;

}  // namespace device_identity
}  // namespace license

#endif
