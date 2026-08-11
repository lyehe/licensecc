#include "providers/windows_cng_api.hpp"

#include <licensecc/device_identity.h>

#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using license::device_identity::DeviceNamespace;
using license::device_identity::P256Digest;
using license::device_identity::P256Signature;
using license::device_identity::P256Spki;
using license::device_identity::ProviderMetadata;
using license::device_identity::ProviderOpenRequest;
using license::device_identity::WindowsCngApi;
using license::device_identity::WindowsCngOperation;

constexpr NCRYPT_PROV_HANDLE kProviderHandle = static_cast<NCRYPT_PROV_HANDLE>(0x1100U);
constexpr NCRYPT_KEY_HANDLE kExistingKeyHandle = static_cast<NCRYPT_KEY_HANDLE>(0x2200U);
constexpr NCRYPT_KEY_HANDLE kCreatedKeyHandle = static_cast<NCRYPT_KEY_HANDLE>(0x3300U);
constexpr NCRYPT_KEY_HANDLE kReopenedKeyHandle = static_cast<NCRYPT_KEY_HANDLE>(0x4400U);

void require(bool condition, const std::string& message) {
	if (!condition) {
		throw std::runtime_error(message);
	}
}

template <typename Actual, typename Expected>
void require_equal(const Actual& actual, const Expected& expected, const std::string& message) {
	if (!(actual == expected)) {
		std::ostringstream output;
		output << message << " (actual=" << actual << ", expected=" << expected << ')';
		throw std::runtime_error(output.str());
	}
}

std::string narrow(LPCWSTR text) {
	if (text == nullptr) {
		return {};
	}
	std::string result;
	while (*text != L'\0') {
		result.push_back(static_cast<char>(*text++));
	}
	return result;
}

struct Call {
	std::string name;
	NCRYPT_HANDLE object = 0U;
	NCRYPT_HANDLE secondary_object = 0U;
	std::string text;
	std::string secondary_text;
	DWORD flags = 0U;
	DWORD legacy_key_spec = 0U;
	DWORD input_size = 0U;
	DWORD output_size = 0U;
	DWORD input_dword = 0U;
	bool null_parameters = false;
	bool null_padding = false;
	std::vector<std::uint8_t> digest;
};

class FakeCngApi final : public WindowsCngApi {
public:
	FakeCngApi() {
		require(BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0U) == 0,
				"BCrypt test algorithm initialization");
		require(BCryptGenerateKeyPair(algorithm_, &signing_key_, 256U, 0U) == 0, "BCrypt test key generation");
		require(BCryptFinalizeKeyPair(signing_key_, 0U) == 0, "BCrypt test key finalization");
		ULONG required = 0U;
		require(BCryptExportKey(signing_key_, nullptr, BCRYPT_ECCPUBLIC_BLOB, nullptr, 0U, &required, 0U) == 0,
				"BCrypt test public-key sizing");
		public_blob_.resize(required);
		require(BCryptExportKey(signing_key_, nullptr, BCRYPT_ECCPUBLIC_BLOB, public_blob_.data(), required, &required,
								0U) == 0,
				"BCrypt test public-key export");
	}

	~FakeCngApi() override {
		if (signing_key_ != nullptr) {
			BCryptDestroyKey(signing_key_);
		}
		if (algorithm_ != nullptr) {
			BCryptCloseAlgorithmProvider(algorithm_, 0U);
		}
	}

	void script(const std::string& call, std::initializer_list<SECURITY_STATUS> statuses) {
		scripted_[call] = std::vector<SECURITY_STATUS>(statuses);
		script_offsets_[call] = 0U;
	}

	P256Spki expected_spki() const {
		static constexpr std::array<std::uint8_t, 27> prefix = {{0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
																 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
																 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04}};
		P256Spki result{};
		std::copy(prefix.begin(), prefix.end(), result.begin());
		std::copy(public_blob_.begin() + sizeof(BCRYPT_ECCKEY_BLOB), public_blob_.end(),
				  result.begin() + prefix.size());
		return result;
	}

	std::size_t count(const std::string& name) const {
		return static_cast<std::size_t>(
			std::count_if(calls.begin(), calls.end(), [&](const Call& call) { return call.name == name; }));
	}

	const Call& nth(const std::string& name, std::size_t occurrence = 0U) const {
		for (const Call& call : calls) {
			if (call.name == name && occurrence-- == 0U) {
				return call;
			}
		}
		throw std::runtime_error("missing recorded call: " + name);
	}

	bool freed(NCRYPT_HANDLE handle) const {
		return std::find(freed_handles.begin(), freed_handles.end(), handle) != freed_handles.end();
	}

	SECURITY_STATUS open_storage_provider(NCRYPT_PROV_HANDLE* provider, LPCWSTR provider_name,
										  DWORD flags) noexcept override {
		try {
			Call call;
			call.name = "open_provider";
			call.text = narrow(provider_name);
			call.flags = flags;
			calls.push_back(call);
			const SECURITY_STATUS status = next("open_provider", ERROR_SUCCESS);
			if (status == ERROR_SUCCESS && provider != nullptr && !null_provider_on_success) {
				*provider = kProviderHandle;
			}
			return status;
		} catch (...) {
			return NTE_NO_MEMORY;
		}
	}

	SECURITY_STATUS open_key(NCRYPT_PROV_HANDLE provider, NCRYPT_KEY_HANDLE* key, LPCWSTR key_name,
							 DWORD legacy_key_spec, DWORD flags) noexcept override {
		try {
			Call call;
			call.name = "open_key";
			call.object = provider;
			call.text = narrow(key_name);
			call.flags = flags;
			call.legacy_key_spec = legacy_key_spec;
			calls.push_back(call);
			SECURITY_STATUS status =
				next("open_key", key_exists ? ERROR_SUCCESS : static_cast<SECURITY_STATUS>(NTE_NOT_FOUND));
			if (status == ERROR_SUCCESS && key != nullptr && !null_open_key_on_success) {
				*key = finalized_by_test ? kReopenedKeyHandle : kExistingKeyHandle;
			}
			return status;
		} catch (...) {
			return NTE_NO_MEMORY;
		}
	}

	SECURITY_STATUS create_persisted_key(NCRYPT_PROV_HANDLE provider, NCRYPT_KEY_HANDLE* key, LPCWSTR algorithm,
										 LPCWSTR key_name, DWORD legacy_key_spec, DWORD flags) noexcept override {
		try {
			Call call;
			call.name = "create_key";
			call.object = provider;
			call.text = narrow(key_name);
			call.secondary_text = narrow(algorithm);
			call.flags = flags;
			call.legacy_key_spec = legacy_key_spec;
			calls.push_back(call);
			const SECURITY_STATUS status = next("create_key", ERROR_SUCCESS);
			if ((status == ERROR_SUCCESS || (status == NTE_EXISTS && return_handle_on_exists)) && key != nullptr &&
				!null_create_on_success) {
				*key = kCreatedKeyHandle;
			}
			if (status == NTE_EXISTS) {
				key_exists = true;
				finalized_by_test = false;
			}
			return status;
		} catch (...) {
			return NTE_NO_MEMORY;
		}
	}

	SECURITY_STATUS set_property(NCRYPT_HANDLE object, LPCWSTR property, PBYTE input, DWORD input_size,
								 DWORD flags) noexcept override {
		try {
			const std::string property_name = narrow(property);
			const std::string call_name = property_name == narrow(NCRYPT_KEY_USAGE_PROPERTY)	   ? "set_usage"
										  : property_name == narrow(NCRYPT_EXPORT_POLICY_PROPERTY) ? "set_export"
																								   : "set_other";
			Call call;
			call.name = call_name;
			call.object = object;
			call.text = property_name;
			call.flags = flags;
			call.input_size = input_size;
			if (input != nullptr && input_size >= sizeof(DWORD)) {
				std::memcpy(&call.input_dword, input, sizeof(DWORD));
			}
			calls.push_back(call);
			return next(call_name, ERROR_SUCCESS);
		} catch (...) {
			return NTE_NO_MEMORY;
		}
	}

	SECURITY_STATUS finalize_key(NCRYPT_KEY_HANDLE key, DWORD flags) noexcept override {
		try {
			Call call;
			call.name = "finalize";
			call.object = key;
			call.flags = flags;
			calls.push_back(call);
			const SECURITY_STATUS status = next("finalize", ERROR_SUCCESS);
			if (status == ERROR_SUCCESS) {
				key_exists = true;
				finalized_by_test = true;
			}
			return status;
		} catch (...) {
			return NTE_NO_MEMORY;
		}
	}

	SECURITY_STATUS get_property(NCRYPT_HANDLE object, LPCWSTR property, PBYTE output, DWORD output_size,
								 DWORD* result_size, DWORD flags) noexcept override {
		try {
			const std::string property_name = narrow(property);
			const std::string call_name = property_name == narrow(NCRYPT_PROVIDER_HANDLE_PROPERTY) ? "get_provider"
										  : property_name == narrow(NCRYPT_ALGORITHM_PROPERTY)	   ? "get_algorithm"
										  : property_name == narrow(NCRYPT_KEY_USAGE_PROPERTY)	   ? "get_usage"
										  : property_name == narrow(NCRYPT_EXPORT_POLICY_PROPERTY) ? "get_export"
																								   : "get_other";
			Call call;
			call.name = call_name;
			call.object = object;
			call.text = property_name;
			call.flags = flags;
			call.output_size = output_size;
			calls.push_back(call);
			const SECURITY_STATUS status = next(call_name, ERROR_SUCCESS);
			if (status != ERROR_SUCCESS) {
				return status;
			}
			if (call_name == "get_provider") {
				if (output != nullptr && output_size >= sizeof(provider_property)) {
					std::memcpy(output, &provider_property, sizeof(provider_property));
				}
				if (result_size != nullptr) {
					*result_size = provider_property_size;
				}
			} else if (call_name == "get_algorithm") {
				const DWORD bytes = static_cast<DWORD>((algorithm_property.size() + 1U) * sizeof(wchar_t));
				if (output != nullptr && output_size >= bytes) {
					std::memcpy(output, algorithm_property.c_str(), bytes);
				}
				if (result_size != nullptr) {
					*result_size = algorithm_property_size == 0U ? bytes : algorithm_property_size;
				}
			} else if (call_name == "get_usage") {
				if (output != nullptr && output_size >= sizeof(usage_property)) {
					std::memcpy(output, &usage_property, sizeof(usage_property));
				}
				if (result_size != nullptr) {
					*result_size = usage_property_size;
				}
			} else if (call_name == "get_export") {
				if (output != nullptr && output_size >= sizeof(export_property)) {
					std::memcpy(output, &export_property, sizeof(export_property));
				}
				if (result_size != nullptr) {
					*result_size = export_property_size;
				}
			}
			return ERROR_SUCCESS;
		} catch (...) {
			return NTE_NO_MEMORY;
		}
	}

	SECURITY_STATUS export_key(NCRYPT_KEY_HANDLE key, NCRYPT_KEY_HANDLE export_key, LPCWSTR blob_type,
							   NCryptBufferDesc* parameters, PBYTE output, DWORD output_size, DWORD* result_size,
							   DWORD flags) noexcept override {
		try {
			const bool sizing = output == nullptr;
			Call call;
			call.name = sizing ? "export_size" : "export_output";
			call.object = key;
			call.secondary_object = export_key;
			call.text = narrow(blob_type);
			call.flags = flags;
			call.output_size = output_size;
			call.null_parameters = parameters == nullptr;
			calls.push_back(call);
			const SECURITY_STATUS status = next(call.name, ERROR_SUCCESS);
			if (status != ERROR_SUCCESS) {
				return status;
			}
			if (sizing) {
				if (result_size != nullptr) {
					*result_size = reported_blob_size;
				}
				return ERROR_SUCCESS;
			}
			if (output != nullptr && output_size >= public_blob_.size()) {
				std::memcpy(output, public_blob_.data(), public_blob_.size());
			}
			if (result_size != nullptr) {
				*result_size = exported_blob_size;
			}
			return ERROR_SUCCESS;
		} catch (...) {
			return NTE_NO_MEMORY;
		}
	}

	SECURITY_STATUS sign_hash(NCRYPT_KEY_HANDLE key, void* padding_info, PBYTE digest, DWORD digest_size,
							  PBYTE signature, DWORD signature_size, DWORD* result_size,
							  DWORD flags) noexcept override {
		try {
			const bool sizing = signature == nullptr;
			Call call;
			call.name = sizing ? "sign_size" : "sign_output";
			call.object = key;
			call.flags = flags;
			call.input_size = digest_size;
			call.output_size = signature_size;
			call.null_padding = padding_info == nullptr;
			if (digest != nullptr) {
				call.digest.assign(digest, digest + digest_size);
			}
			calls.push_back(call);
			const SECURITY_STATUS status = next(call.name, ERROR_SUCCESS);
			if (status != ERROR_SUCCESS) {
				return status;
			}
			if (sizing) {
				if (result_size != nullptr) {
					*result_size = reported_signature_size;
				}
				return ERROR_SUCCESS;
			}
			ULONG written = 0U;
			const NTSTATUS signed_status =
				BCryptSignHash(signing_key_, nullptr, digest, digest_size, signature, signature_size, &written, 0U);
			if (signed_status != 0) {
				return NTE_FAIL;
			}
			if (invalid_signature && signature_size != 0U) {
				std::memset(signature, 0, signature_size);
			}
			if (result_size != nullptr) {
				*result_size = written_signature_size == 0U ? written : written_signature_size;
			}
			return ERROR_SUCCESS;
		} catch (...) {
			return NTE_NO_MEMORY;
		}
	}

	SECURITY_STATUS delete_key(NCRYPT_KEY_HANDLE key, DWORD flags) noexcept override {
		try {
			Call call;
			call.name = "delete";
			call.object = key;
			call.flags = flags;
			calls.push_back(call);
			const SECURITY_STATUS status = next("delete", ERROR_SUCCESS);
			if (status == ERROR_SUCCESS) {
				deleted_handles.push_back(key);
				key_exists = false;
			}
			return status;
		} catch (...) {
			return NTE_NO_MEMORY;
		}
	}

	SECURITY_STATUS free_object(NCRYPT_HANDLE object) noexcept override {
		try {
			Call call;
			call.name = "free";
			call.object = object;
			calls.push_back(call);
			const SECURITY_STATUS status = next("free", ERROR_SUCCESS);
			if (status == ERROR_SUCCESS) {
				freed_handles.push_back(object);
			}
			return status;
		} catch (...) {
			return NTE_NO_MEMORY;
		}
	}

	bool key_exists = true;
	bool finalized_by_test = false;
	bool return_handle_on_exists = false;
	bool null_provider_on_success = false;
	bool null_open_key_on_success = false;
	bool null_create_on_success = false;
	NCRYPT_PROV_HANDLE provider_property = kProviderHandle;
	DWORD provider_property_size = sizeof(NCRYPT_PROV_HANDLE);
	std::wstring algorithm_property = NCRYPT_ECDSA_P256_ALGORITHM;
	DWORD algorithm_property_size = 0U;
	DWORD usage_property = NCRYPT_ALLOW_SIGNING_FLAG;
	DWORD usage_property_size = sizeof(DWORD);
	DWORD export_property = 0U;
	DWORD export_property_size = sizeof(DWORD);
	DWORD reported_blob_size = sizeof(BCRYPT_ECCKEY_BLOB) + 64U;
	DWORD exported_blob_size = sizeof(BCRYPT_ECCKEY_BLOB) + 64U;
	DWORD reported_signature_size = 64U;
	DWORD written_signature_size = 0U;
	bool invalid_signature = false;
	std::vector<Call> calls;
	std::vector<NCRYPT_HANDLE> freed_handles;
	std::vector<NCRYPT_KEY_HANDLE> deleted_handles;
	std::vector<std::uint8_t>& mutable_public_blob() { return public_blob_; }

private:
	SECURITY_STATUS next(const std::string& call, SECURITY_STATUS fallback) noexcept {
		const auto found = scripted_.find(call);
		if (found == scripted_.end()) {
			return fallback;
		}
		std::size_t& offset = script_offsets_[call];
		if (offset >= found->second.size()) {
			return fallback;
		}
		return found->second[offset++];
	}

	BCRYPT_ALG_HANDLE algorithm_ = nullptr;
	BCRYPT_KEY_HANDLE signing_key_ = nullptr;
	std::vector<std::uint8_t> public_blob_;
	std::map<std::string, std::vector<SECURITY_STATUS>> scripted_;
	std::map<std::string, std::size_t> script_offsets_;
};

ProviderOpenRequest request_for(std::uint32_t scope = LCC_DEVICE_SCOPE_USER, const std::string& suffix = "shim") {
	ProviderOpenRequest request;
	request.backend = LCC_DEVICE_BACKEND_WINDOWS_TPM;
	request.scope = scope;
	require(license::device_identity::derive_namespace_v1("licensecc.test.windows-tpm." + suffix, "DEFAULT", scope,
														  request.device_namespace),
			"namespace derivation");
	return request;
}

std::vector<std::string> call_names(const FakeCngApi& api) {
	std::vector<std::string> result;
	result.reserve(api.calls.size());
	for (const Call& call : api.calls) {
		result.push_back(call.name);
	}
	return result;
}

void test_error_map_is_operation_aware_and_fail_closed() {
	struct Case {
		SECURITY_STATUS status;
		WindowsCngOperation operation;
		LCC_DEVICE_RESULT expected;
	};
	const Case cases[] = {
		{ERROR_SUCCESS, WindowsCngOperation::open_provider, LCC_DEVICE_OK},
		{NTE_BAD_PROVIDER, WindowsCngOperation::open_provider, LCC_DEVICE_PROVIDER_UNAVAILABLE},
		{NTE_PROVIDER_DLL_FAIL, WindowsCngOperation::open_provider, LCC_DEVICE_PROVIDER_UNAVAILABLE},
		{NTE_DEVICE_NOT_READY, WindowsCngOperation::open_key, LCC_DEVICE_HARDWARE_UNAVAILABLE},
		{NTE_DEVICE_NOT_FOUND, WindowsCngOperation::sign_digest, LCC_DEVICE_HARDWARE_UNAVAILABLE},
		{NTE_NOT_SUPPORTED, WindowsCngOperation::create_key, LCC_DEVICE_UNSUPPORTED_ALGORITHM},
		{NTE_BAD_ALGID, WindowsCngOperation::open_key, LCC_DEVICE_UNSUPPORTED_ALGORITHM},
		{NTE_PERM, WindowsCngOperation::open_key, LCC_DEVICE_ACCESS_DENIED},
		{NTE_SILENT_CONTEXT, WindowsCngOperation::sign_digest, LCC_DEVICE_ACCESS_DENIED},
		{NTE_UI_REQUIRED, WindowsCngOperation::sign_digest, LCC_DEVICE_ACCESS_DENIED},
		{NTE_NOT_FOUND, WindowsCngOperation::open_key, LCC_DEVICE_KEY_NOT_FOUND},
		{NTE_BAD_KEYSET, WindowsCngOperation::delete_key, LCC_DEVICE_KEY_NOT_FOUND},
		{NTE_BAD_KEY_STATE, WindowsCngOperation::sign_digest, LCC_DEVICE_KEY_LOST},
		{NTE_NO_KEY, WindowsCngOperation::get_property, LCC_DEVICE_KEY_LOST},
		{static_cast<SECURITY_STATUS>(HRESULT_FROM_WIN32(ERROR_BUSY)), WindowsCngOperation::open_key, LCC_DEVICE_BUSY},
		{static_cast<SECURITY_STATUS>(HRESULT_FROM_WIN32(ERROR_RETRY)), WindowsCngOperation::sign_digest,
		 LCC_DEVICE_BUSY},
		{NTE_BAD_PUBLIC_KEY, WindowsCngOperation::export_public, LCC_DEVICE_KEY_CORRUPT},
		{NTE_BAD_SIGNATURE, WindowsCngOperation::sign_digest, LCC_DEVICE_SIGN_FAILED},
		{NTE_FAIL, WindowsCngOperation::open_key, LCC_DEVICE_INTERNAL_ERROR},
		{NTE_NOT_SUPPORTED, WindowsCngOperation::delete_key, LCC_DEVICE_INTERNAL_ERROR},
	};
	for (const Case& item : cases) {
		require_equal(license::device_identity::map_windows_cng_error(item.status, item.operation), item.expected,
					  "native error mapping");
	}
}

void test_open_scope_properties_spki_and_signing() {
	for (const std::uint32_t scope : {LCC_DEVICE_SCOPE_USER, LCC_DEVICE_SCOPE_MACHINE}) {
		auto api = std::make_shared<FakeCngApi>();
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		const ProviderOpenRequest request = request_for(scope, scope == LCC_DEVICE_SCOPE_USER ? "user" : "machine");
		require(provider != nullptr, "per-provider injected factory");
		require_equal(provider->open(request), LCC_DEVICE_OK, "open existing key");

		ProviderMetadata metadata;
		require_equal(provider->metadata(metadata), LCC_DEVICE_OK, "metadata");
		require_equal(metadata.backend, static_cast<std::uint32_t>(LCC_DEVICE_BACKEND_WINDOWS_TPM), "backend");
		require_equal(metadata.scope, scope, "scope");
		require_equal(metadata.assurance, static_cast<std::uint32_t>(LCC_DEVICE_ASSURANCE_REPORTED_HARDWARE),
					  "assurance");
		require_equal(metadata.provider, std::string("windows-platform-ksp"), "provider string");
		require_equal(metadata.algorithm, std::string("ecdsa-p256-sha256"), "algorithm string");

		P256Spki spki{};
		require_equal(provider->public_spki(spki), LCC_DEVICE_OK, "public SPKI");
		require(spki == api->expected_spki(), "canonical 91-byte SPKI prefix and coordinates");

		P256Digest digest{};
		for (std::size_t index = 0U; index < digest.size(); ++index) {
			digest[index] = static_cast<std::uint8_t>(index + 1U);
		}
		P256Signature signature{};
		require_equal(provider->sign_digest(digest, signature), LCC_DEVICE_OK, "sign digest");
		require(license::device_identity::verify_p256_p1363(spki, digest, signature), "P1363 signature verifies");

		require_equal(api->nth("open_provider").text, narrow(MS_PLATFORM_CRYPTO_PROVIDER), "Platform KSP name");
		require_equal(api->nth("open_provider").flags, 0UL, "provider-open flags");
		const Call& opened = api->nth("open_key");
		require_equal(opened.text, request.device_namespace.windows_name, "exact key namespace");
		require_equal(opened.legacy_key_spec, 0UL, "legacy key spec");
		const DWORD expected_scope_flags = scope == LCC_DEVICE_SCOPE_MACHINE ? NCRYPT_MACHINE_KEY_FLAG : 0U;
		require_equal(opened.flags, expected_scope_flags | NCRYPT_SILENT_FLAG, "scope and silent open flags");

		require_equal(api->nth("get_provider").output_size, static_cast<DWORD>(sizeof(NCRYPT_PROV_HANDLE)),
					  "provider property width");
		require_equal(api->nth("get_usage").output_size, static_cast<DWORD>(sizeof(DWORD)), "usage property width");
		require_equal(api->nth("get_export").output_size, static_cast<DWORD>(sizeof(DWORD)), "export property width");
		for (const std::string& property_call : {"get_provider", "get_algorithm", "get_usage", "get_export"}) {
			require_equal(api->nth(property_call).flags, NCRYPT_SILENT_FLAG, property_call + " silent flag");
		}
		for (const std::string& export_call : {"export_size", "export_output"}) {
			const Call& call = api->nth(export_call);
			require_equal(call.text, narrow(BCRYPT_ECCPUBLIC_BLOB), "public blob type");
			require_equal(call.secondary_object, static_cast<NCRYPT_HANDLE>(0U), "no export key");
			require(call.null_parameters, "no export parameters");
			require_equal(call.flags, NCRYPT_SILENT_FLAG, "silent public export");
		}
		require_equal(api->nth("export_size").output_size, 0UL, "public export size query");
		require_equal(api->nth("export_output").output_size, static_cast<DWORD>(sizeof(BCRYPT_ECCKEY_BLOB) + 64U),
					  "exact public blob width");
		for (const std::string& sign_call : {"sign_size", "sign_output"}) {
			const Call& call = api->nth(sign_call);
			require(call.null_padding, "ECDSA padding info is NULL");
			require_equal(call.flags, NCRYPT_SILENT_FLAG, "silent signing");
			require_equal(call.input_size, 32UL, "exact digest width");
			require(std::equal(call.digest.begin(), call.digest.end(), digest.begin()),
					"caller digest reaches CNG exactly once");
		}
		require_equal(api->nth("sign_size").output_size, 0UL, "signature size query");
		require_equal(api->nth("sign_output").output_size, 64UL, "exact P1363 output width");
		require_equal(api->count("set_other"), std::size_t{0U}, "no UI/DACL property write");
		require_equal(api->count("delete"), std::size_t{0U}, "ordinary open never deletes");

		provider.reset();
		require(api->freed(kExistingKeyHandle), "existing key handle freed on close");
		require(api->freed(kProviderHandle), "provider handle freed on close");
	}
}

void test_create_order_policy_reopen_and_self_test() {
	auto api = std::make_shared<FakeCngApi>();
	api->key_exists = false;
	const ProviderOpenRequest request = request_for(LCC_DEVICE_SCOPE_MACHINE, "create");
	auto provider = license::device_identity::make_windows_tpm_provider(api);
	require_equal(provider->open(request), LCC_DEVICE_KEY_NOT_FOUND, "open-before-create missing key");
	require_equal(provider->create(request), LCC_DEVICE_OK, "create and post-create reopen");

	const std::vector<std::string> expected = {"open_provider", "open_key",	 "create_key",	"set_usage",
											   "set_export",	"finalize",	 "open_key",	"get_provider",
											   "get_algorithm", "get_usage", "get_export",	"export_size",
											   "export_output", "sign_size", "sign_output", "free"};
	require(call_names(*api) == expected, "exact create/property/finalize/reopen/validate/self-test order");

	const Call& created = api->nth("create_key");
	require_equal(created.object, static_cast<NCRYPT_HANDLE>(kProviderHandle), "create provider handle");
	require_equal(created.secondary_text, narrow(NCRYPT_ECDSA_P256_ALGORITHM), "P-256 algorithm");
	require_equal(created.text, request.device_namespace.windows_name, "create namespace");
	require_equal(created.legacy_key_spec, 0UL, "create legacy key spec");
	require_equal(created.flags, NCRYPT_MACHINE_KEY_FLAG | NCRYPT_SILENT_FLAG, "create machine/silent flags");
	require((created.flags & NCRYPT_OVERWRITE_KEY_FLAG) == 0U, "overwrite is forbidden");

	const Call& usage = api->nth("set_usage");
	const Call& export_policy = api->nth("set_export");
	require_equal(usage.object, static_cast<NCRYPT_HANDLE>(kCreatedKeyHandle), "usage set on owned key");
	require_equal(usage.input_size, static_cast<DWORD>(sizeof(DWORD)), "usage DWORD width");
	require_equal(usage.input_dword, static_cast<DWORD>(NCRYPT_ALLOW_SIGNING_FLAG), "signing-only usage");
	require_equal(usage.flags, NCRYPT_PERSIST_FLAG | NCRYPT_SILENT_FLAG, "persist+silent usage flags");
	require_equal(export_policy.input_size, static_cast<DWORD>(sizeof(DWORD)), "export DWORD width");
	require_equal(export_policy.input_dword, 0UL, "private export/archive policy is zero");
	require_equal(export_policy.flags, NCRYPT_PERSIST_FLAG | NCRYPT_SILENT_FLAG, "persist+silent export flags");
	require_equal(api->nth("finalize").flags, NCRYPT_SILENT_FLAG, "silent finalize");
	require_equal(api->nth("open_key", 1U).flags, NCRYPT_MACHINE_KEY_FLAG | NCRYPT_SILENT_FLAG,
				  "silent post-create reopen");
	require_equal(api->nth("free").object, static_cast<NCRYPT_HANDLE>(kCreatedKeyHandle),
				  "release creator handle only after self-test");
	require_equal(api->count("set_other"), std::size_t{0U}, "no UI/DACL write during creation");
	require_equal(api->count("delete"), std::size_t{0U}, "successful creation is retained");

	provider.reset();
	require(api->freed(kReopenedKeyHandle), "reopened handle freed on close");
	require(api->freed(kProviderHandle), "provider handle freed on close");
}

void test_existing_invariants_fail_closed_without_delete() {
	struct Case {
		const char* name;
		LCC_DEVICE_RESULT expected;
		void (*mutate)(FakeCngApi&);
	};
	const Case cases[] = {
		{"provider handle", LCC_DEVICE_KEY_CORRUPT,
		 [](FakeCngApi& api) { api.provider_property = static_cast<NCRYPT_PROV_HANDLE>(0x9999U); }},
		{"provider width", LCC_DEVICE_KEY_CORRUPT,
		 [](FakeCngApi& api) { api.provider_property_size = sizeof(NCRYPT_PROV_HANDLE) - 1U; }},
		{"algorithm", LCC_DEVICE_UNSUPPORTED_ALGORITHM,
		 [](FakeCngApi& api) { api.algorithm_property = BCRYPT_ECDH_P256_ALGORITHM; }},
		{"algorithm width", LCC_DEVICE_UNSUPPORTED_ALGORITHM,
		 [](FakeCngApi& api) { api.algorithm_property_size = sizeof(wchar_t); }},
		{"usage", LCC_DEVICE_KEY_CORRUPT,
		 [](FakeCngApi& api) { api.usage_property = NCRYPT_ALLOW_SIGNING_FLAG | NCRYPT_ALLOW_DECRYPT_FLAG; }},
		{"usage width", LCC_DEVICE_KEY_CORRUPT, [](FakeCngApi& api) { api.usage_property_size = sizeof(DWORD) - 1U; }},
		{"export policy", LCC_DEVICE_KEY_CORRUPT,
		 [](FakeCngApi& api) { api.export_property = NCRYPT_ALLOW_EXPORT_FLAG; }},
		{"export width", LCC_DEVICE_KEY_CORRUPT,
		 [](FakeCngApi& api) { api.export_property_size = sizeof(DWORD) - 1U; }},
		{"blob size", LCC_DEVICE_KEY_CORRUPT, [](FakeCngApi& api) { --api.reported_blob_size; }},
		{"blob written", LCC_DEVICE_KEY_CORRUPT, [](FakeCngApi& api) { --api.exported_blob_size; }},
		{"blob magic", LCC_DEVICE_KEY_CORRUPT, [](FakeCngApi& api) { api.mutable_public_blob()[0] ^= 1U; }},
		{"blob key width", LCC_DEVICE_KEY_CORRUPT, [](FakeCngApi& api) { api.mutable_public_blob()[4] = 31U; }},
		{"off-curve point", LCC_DEVICE_KEY_CORRUPT,
		 [](FakeCngApi& api) {
			 std::fill(api.mutable_public_blob().begin() + sizeof(BCRYPT_ECCKEY_BLOB), api.mutable_public_blob().end(),
					   0U);
		 }},
	};
	for (const Case& item : cases) {
		auto api = std::make_shared<FakeCngApi>();
		item.mutate(*api);
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		require_equal(provider->open(request_for()), item.expected,
					  std::string("reject invalid existing key: ") + item.name);
		provider.reset();
		require_equal(api->count("delete"), std::size_t{0U}, "never delete a pre-existing invalid key");
		require(api->freed(kExistingKeyHandle), "invalid existing key handle released");
		require(api->freed(kProviderHandle), "provider released after invalid existing key");
	}
}

void test_native_failure_edges_release_owned_handles() {
	struct OpenCase {
		const char* call;
		SECURITY_STATUS status;
		LCC_DEVICE_RESULT expected;
	};
	const OpenCase cases[] = {
		{"open_provider", NTE_BAD_PROVIDER, LCC_DEVICE_PROVIDER_UNAVAILABLE},
		{"open_key", NTE_DEVICE_NOT_READY, LCC_DEVICE_HARDWARE_UNAVAILABLE},
		{"get_provider", NTE_BAD_KEY_STATE, LCC_DEVICE_KEY_LOST},
		{"get_algorithm", NTE_NOT_SUPPORTED, LCC_DEVICE_UNSUPPORTED_ALGORITHM},
		{"get_usage", NTE_PERM, LCC_DEVICE_ACCESS_DENIED},
		{"get_export", NTE_FAIL, LCC_DEVICE_INTERNAL_ERROR},
		{"export_size", NTE_BAD_PUBLIC_KEY, LCC_DEVICE_KEY_CORRUPT},
		{"export_output", NTE_FAIL, LCC_DEVICE_INTERNAL_ERROR},
	};
	for (const OpenCase& item : cases) {
		auto api = std::make_shared<FakeCngApi>();
		api->script(item.call, {item.status});
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		require_equal(provider->open(request_for()), item.expected, std::string("native open failure: ") + item.call);
		provider.reset();
		if (std::string(item.call) != "open_provider") {
			if (std::string(item.call) != "open_key") {
				require(api->freed(kExistingKeyHandle), std::string(item.call) + " releases key");
			}
			require(api->freed(kProviderHandle), std::string(item.call) + " releases provider");
		}
		require_equal(api->count("delete"), std::size_t{0U}, "open failures never delete existing keys");
	}

	for (const OpenCase& item : {OpenCase{"sign_size", NTE_DEVICE_NOT_READY, LCC_DEVICE_HARDWARE_UNAVAILABLE},
								 OpenCase{"sign_output", NTE_FAIL, LCC_DEVICE_INTERNAL_ERROR}}) {
		auto api = std::make_shared<FakeCngApi>();
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		require_equal(provider->open(request_for()), LCC_DEVICE_OK, "open before sign failure");
		api->script(item.call, {item.status});
		P256Digest digest{};
		P256Signature signature{};
		require_equal(provider->sign_digest(digest, signature), item.expected,
					  std::string("native sign failure: ") + item.call);
		provider.reset();
		require(api->freed(kExistingKeyHandle), "sign failure handle cleanup on close");
		require_equal(api->count("delete"), std::size_t{0U}, "sign failure never deletes existing key");
	}

	for (const OpenCase& item : {OpenCase{"create_key", NTE_NOT_SUPPORTED, LCC_DEVICE_UNSUPPORTED_ALGORITHM},
								 OpenCase{"set_usage", NTE_PERM, LCC_DEVICE_ACCESS_DENIED},
								 OpenCase{"set_export", NTE_FAIL, LCC_DEVICE_INTERNAL_ERROR},
								 OpenCase{"finalize", NTE_DEVICE_NOT_READY, LCC_DEVICE_HARDWARE_UNAVAILABLE}}) {
		auto api = std::make_shared<FakeCngApi>();
		api->key_exists = false;
		api->script(item.call, {item.status});
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		const ProviderOpenRequest request = request_for(LCC_DEVICE_SCOPE_USER, item.call);
		require_equal(provider->open(request), LCC_DEVICE_KEY_NOT_FOUND, "missing before create failure");
		require_equal(provider->create(request), item.expected, std::string("native create failure: ") + item.call);
		provider.reset();
		if (std::string(item.call) != "create_key") {
			require(api->freed(kCreatedKeyHandle), std::string(item.call) + " releases unfinalized key");
		}
		require_equal(api->count("delete"), std::size_t{0U}, "unfinalized failures do not delete namespaces");
	}

	{
		auto api = std::make_shared<FakeCngApi>();
		api->null_provider_on_success = true;
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		require_equal(provider->open(request_for()), LCC_DEVICE_INTERNAL_ERROR,
					  "successful provider call must return a handle");
	}
	{
		auto api = std::make_shared<FakeCngApi>();
		api->null_open_key_on_success = true;
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		require_equal(provider->open(request_for()), LCC_DEVICE_INTERNAL_ERROR,
					  "successful open call must return a key handle");
		provider.reset();
		require(api->freed(kProviderHandle), "provider freed after null key handle");
	}
	{
		auto api = std::make_shared<FakeCngApi>();
		api->key_exists = false;
		api->null_create_on_success = true;
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		const ProviderOpenRequest request = request_for(LCC_DEVICE_SCOPE_USER, "null-create");
		require_equal(provider->open(request), LCC_DEVICE_KEY_NOT_FOUND, "initial null-create miss");
		require_equal(provider->create(request), LCC_DEVICE_INTERNAL_ERROR,
					  "successful create call must return a key handle");
	}
}

void test_post_finalize_failures_rollback_only_owned_key() {
	const char* failure_calls[] = {"get_provider", "get_algorithm", "get_usage", "get_export",
								   "export_size",  "export_output", "sign_size", "sign_output"};
	for (const char* failure_call : failure_calls) {
		auto api = std::make_shared<FakeCngApi>();
		api->key_exists = false;
		api->script(failure_call, {NTE_FAIL});
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		const ProviderOpenRequest request = request_for(LCC_DEVICE_SCOPE_USER, failure_call);
		require_equal(provider->open(request), LCC_DEVICE_KEY_NOT_FOUND, "missing before rollback case");
		require(provider->create(request) != LCC_DEVICE_OK,
				std::string("post-finalize failure is reported: ") + failure_call);
		require_equal(api->count("delete"), std::size_t{1U}, "owned finalized key rollback delete");
		require_equal(api->nth("delete").object, static_cast<NCRYPT_HANDLE>(kCreatedKeyHandle),
					  "rollback deletes creator handle only");
		require_equal(api->nth("delete").flags, NCRYPT_SILENT_FLAG, "silent rollback delete");
		require(!api->freed(kCreatedKeyHandle), "successful delete consumes creator handle");
		if (std::string(failure_call) != "get_provider") {
			require(api->freed(kReopenedKeyHandle), "failed reopened handle is released");
		} else {
			require(api->freed(kReopenedKeyHandle), "property-failed reopened handle is released");
		}
		provider.reset();
	}

	auto reopen_api = std::make_shared<FakeCngApi>();
	reopen_api->key_exists = false;
	reopen_api->script("open_key", {NTE_NOT_FOUND, NTE_DEVICE_NOT_READY});
	auto reopen_provider = license::device_identity::make_windows_tpm_provider(reopen_api);
	const ProviderOpenRequest reopen_request = request_for(LCC_DEVICE_SCOPE_USER, "reopen-failure");
	require_equal(reopen_provider->open(reopen_request), LCC_DEVICE_KEY_NOT_FOUND, "initial miss");
	require_equal(reopen_provider->create(reopen_request), LCC_DEVICE_HARDWARE_UNAVAILABLE,
				  "post-finalize reopen failure");
	require_equal(reopen_api->count("delete"), std::size_t{1U}, "reopen failure rolls back owned key");

	auto rollback_api = std::make_shared<FakeCngApi>();
	rollback_api->key_exists = false;
	rollback_api->script("get_provider", {NTE_FAIL});
	rollback_api->script("delete", {NTE_FAIL});
	auto rollback_provider = license::device_identity::make_windows_tpm_provider(rollback_api);
	const ProviderOpenRequest rollback_request = request_for(LCC_DEVICE_SCOPE_USER, "rollback-delete-failure");
	require_equal(rollback_provider->open(rollback_request), LCC_DEVICE_KEY_NOT_FOUND, "initial miss");
	require_equal(rollback_provider->create(rollback_request), LCC_DEVICE_INTERNAL_ERROR,
				  "original validation failure retained");
	require(rollback_api->freed(kCreatedKeyHandle), "failed rollback delete leaves and frees owned handle");
}

void test_nte_exists_reopens_and_preserves_race_winner() {
	for (const bool returns_handle : {false, true}) {
		auto api = std::make_shared<FakeCngApi>();
		api->key_exists = false;
		api->return_handle_on_exists = returns_handle;
		api->script("create_key", {NTE_EXISTS});
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		const ProviderOpenRequest request =
			request_for(LCC_DEVICE_SCOPE_USER, returns_handle ? "race-handle" : "race-null");
		require_equal(provider->open(request), LCC_DEVICE_KEY_NOT_FOUND, "race initial miss");
		require_equal(provider->create(request), LCC_DEVICE_OK, "race winner reopen");
		require_equal(api->count("delete"), std::size_t{0U}, "never delete NTE_EXISTS winner");
		require_equal(api->count("set_usage"), std::size_t{0U}, "never modify race winner");
		require_equal(api->count("set_export"), std::size_t{0U}, "never modify race winner export policy");
		require_equal(api->count("finalize"), std::size_t{0U}, "never finalize race winner");
		if (returns_handle) {
			require(api->freed(kCreatedKeyHandle), "release only returned unfinalized race handle");
		}
		provider.reset();
		require(api->freed(kExistingKeyHandle), "reopened winner handle released normally");
	}

	auto release_api = std::make_shared<FakeCngApi>();
	release_api->key_exists = false;
	release_api->return_handle_on_exists = true;
	release_api->script("create_key", {NTE_EXISTS});
	release_api->script("free", {NTE_FAIL});
	auto release_provider = license::device_identity::make_windows_tpm_provider(release_api);
	const ProviderOpenRequest release_request = request_for(LCC_DEVICE_SCOPE_USER, "race-free-failure");
	require_equal(release_provider->open(release_request), LCC_DEVICE_KEY_NOT_FOUND, "race free initial miss");
	require_equal(release_provider->create(release_request), LCC_DEVICE_INTERNAL_ERROR,
				  "race handle release failure is fail-closed");
	require_equal(release_api->count("open_key"), std::size_t{1U},
				  "do not reopen winner while the losing handle could not be released");
	require_equal(release_api->count("delete"), std::size_t{0U}, "never delete winner on race cleanup failure");
}

void test_creator_handle_release_failure_rolls_back() {
	auto api = std::make_shared<FakeCngApi>();
	api->key_exists = false;
	api->script("free", {NTE_FAIL, ERROR_SUCCESS});
	auto provider = license::device_identity::make_windows_tpm_provider(api);
	const ProviderOpenRequest request = request_for(LCC_DEVICE_SCOPE_USER, "creator-free-failure");
	require_equal(provider->open(request), LCC_DEVICE_KEY_NOT_FOUND, "creator-free initial miss");
	require_equal(provider->create(request), LCC_DEVICE_INTERNAL_ERROR,
				  "creator handle release failure is fail-closed");
	require(api->freed(kReopenedKeyHandle), "reopened handle released after creator free failure");
	require_equal(api->count("delete"), std::size_t{1U}, "owned key rolled back after creator free failure");
	require_equal(api->nth("delete").object, static_cast<NCRYPT_HANDLE>(kCreatedKeyHandle),
				  "rollback uses still-owned creator handle");
}

void test_signature_boundaries_and_delete_ownership() {
	for (const DWORD size : {63U, 65U}) {
		auto api = std::make_shared<FakeCngApi>();
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		require_equal(provider->open(request_for()), LCC_DEVICE_OK, "open for signature sizing");
		api->reported_signature_size = size;
		P256Digest digest{};
		P256Signature signature{};
		require_equal(provider->sign_digest(digest, signature), LCC_DEVICE_SIGN_FAILED,
					  "reject non-64-byte signature size");
		require_equal(api->count("sign_output"), std::size_t{0U}, "no output call after bad size");
	}
	{
		auto api = std::make_shared<FakeCngApi>();
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		require_equal(provider->open(request_for()), LCC_DEVICE_OK, "open for signature written width");
		api->written_signature_size = 63U;
		P256Digest digest{};
		P256Signature signature{};
		require_equal(provider->sign_digest(digest, signature), LCC_DEVICE_SIGN_FAILED,
					  "reject short signature output");
	}
	{
		auto api = std::make_shared<FakeCngApi>();
		auto provider = license::device_identity::make_windows_tpm_provider(api);
		require_equal(provider->open(request_for()), LCC_DEVICE_OK, "open for scalar range");
		api->invalid_signature = true;
		P256Digest digest{};
		P256Signature signature{};
		require_equal(provider->sign_digest(digest, signature), LCC_DEVICE_SIGN_FAILED,
					  "reject out-of-range P1363 scalars");
	}

	auto mismatch_api = std::make_shared<FakeCngApi>();
	auto mismatch_provider = license::device_identity::make_windows_tpm_provider(mismatch_api);
	const ProviderOpenRequest request = request_for(LCC_DEVICE_SCOPE_MACHINE, "delete");
	std::string expected = license::device_identity::device_key_id(mismatch_api->expected_spki());
	require_equal(expected.size(), std::size_t{71U}, "canonical expected key id");
	std::string mismatch = expected;
	mismatch.back() = mismatch.back() == '0' ? '1' : '0';
	require_equal(mismatch_provider->delete_with_expected_id(request, mismatch), LCC_DEVICE_POLICY_VIOLATION,
				  "expected-id mismatch blocks delete");
	require_equal(mismatch_api->count("delete"), std::size_t{0U}, "mismatch never reaches delete");
	require(mismatch_api->freed(kExistingKeyHandle), "mismatched delete releases open key");

	auto delete_api = std::make_shared<FakeCngApi>();
	auto delete_provider = license::device_identity::make_windows_tpm_provider(delete_api);
	const std::string delete_expected = license::device_identity::device_key_id(delete_api->expected_spki());
	require_equal(delete_provider->delete_with_expected_id(request, delete_expected), LCC_DEVICE_OK,
				  "expected-id delete");
	require_equal(delete_api->count("delete"), std::size_t{1U}, "one exact delete");
	require_equal(delete_api->nth("delete").flags, NCRYPT_SILENT_FLAG, "delete uses only silent flag");
	delete_provider.reset();
	require(!delete_api->freed(kExistingKeyHandle), "successful delete consumes the key handle");
	require(delete_api->freed(kProviderHandle), "provider handle remains separately owned");

	auto failure_api = std::make_shared<FakeCngApi>();
	failure_api->script("delete", {NTE_PERM});
	auto failure_provider = license::device_identity::make_windows_tpm_provider(failure_api);
	const std::string failure_expected = license::device_identity::device_key_id(failure_api->expected_spki());
	require_equal(failure_provider->delete_with_expected_id(request, failure_expected), LCC_DEVICE_ACCESS_DENIED,
				  "delete native failure mapping");
	require(failure_api->freed(kExistingKeyHandle), "failed delete retains then frees key handle");

	auto missing_api = std::make_shared<FakeCngApi>();
	missing_api->key_exists = false;
	auto missing_provider = license::device_identity::make_windows_tpm_provider(missing_api);
	require_equal(missing_provider->delete_with_expected_id(request, expected), LCC_DEVICE_KEY_NOT_FOUND,
				  "delete reports missing exact namespace");
	require_equal(missing_api->count("delete"), std::size_t{0U}, "missing key never calls delete");
}

void run_shim() {
	test_error_map_is_operation_aware_and_fail_closed();
	test_open_scope_properties_spki_and_signing();
	test_create_order_policy_reopen_and_self_test();
	test_existing_invariants_fail_closed_without_delete();
	test_native_failure_edges_release_owned_handles();
	test_post_finalize_failures_rollback_only_owned_key();
	test_nte_exists_reopens_and_preserves_race_winner();
	test_creator_handle_release_failure_rolls_back();
	test_signature_boundaries_and_delete_ownership();
}

template <std::size_t N>
void set_field(char (&field)[N], const std::string& value) {
	require(value.size() < N, "fixed field overflow");
	std::memcpy(field, value.c_str(), value.size() + 1U);
}

std::string uuid_v4() {
	std::array<std::uint8_t, 16> bytes{};
	require(
		BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0,
		"UUID randomness");
	bytes[6] = static_cast<std::uint8_t>((bytes[6] & 0x0fU) | 0x40U);
	bytes[8] = static_cast<std::uint8_t>((bytes[8] & 0x3fU) | 0x80U);
	constexpr char alphabet[] = "0123456789abcdef";
	std::string result;
	result.reserve(36U);
	for (std::size_t index = 0U; index < bytes.size(); ++index) {
		if (index == 4U || index == 6U || index == 8U || index == 10U) {
			result.push_back('-');
		}
		result.push_back(alphabet[bytes[index] >> 4U]);
		result.push_back(alphabet[bytes[index] & 0x0fU]);
	}
	return result;
}

void require_private_export_denied(const ProviderOpenRequest& request) {
	NCRYPT_PROV_HANDLE provider = 0U;
	require(NCryptOpenStorageProvider(&provider, MS_PLATFORM_CRYPTO_PROVIDER, 0U) == ERROR_SUCCESS,
			"real private-export provider open");
	NCRYPT_KEY_HANDLE key = 0U;
	const std::wstring key_name(request.device_namespace.windows_name.begin(),
								request.device_namespace.windows_name.end());
	const DWORD scope_flags = request.scope == LCC_DEVICE_SCOPE_MACHINE ? NCRYPT_MACHINE_KEY_FLAG : 0U;
	const SECURITY_STATUS opened =
		NCryptOpenKey(provider, &key, key_name.c_str(), 0U, scope_flags | NCRYPT_SILENT_FLAG);
	if (opened != ERROR_SUCCESS) {
		NCryptFreeObject(provider);
		throw std::runtime_error("real private-export key reopen");
	}
	DWORD size = 0U;
	const SECURITY_STATUS exported =
		NCryptExportKey(key, 0U, NCRYPT_PKCS8_PRIVATE_KEY_BLOB, nullptr, nullptr, 0U, &size, NCRYPT_SILENT_FLAG);
	NCryptFreeObject(key);
	NCryptFreeObject(provider);
	require(exported != ERROR_SUCCESS, "direct private export must be denied");
}

void fill_real_proof_input(LccDeviceProofInput& input) {
	lcc_init_device_proof_input(&input);
	input.audience = LCC_DEVICE_PROOF_AUDIENCE_VERIFY;
	input.request_timestamp = 1700000000ULL;
	set_field(input.project, "DEFAULT");
	set_field(input.feature, "EXPORT");
	set_field(input.license_fingerprint, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
	set_field(input.device_hash, "");
	set_field(input.nonce, "f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687");
}

int run_real() {
	const char* enabled = std::getenv("LCC_RUN_REAL_WINDOWS_TPM_TESTS");
	if (enabled == nullptr || std::string(enabled) != "1") {
		std::cout << "SKIP: set LCC_RUN_REAL_WINDOWS_TPM_TESTS=1 to run the destructive real TPM case\n";
		return 77;
	}

	const std::string application_id = "licensecc.test.windows-tpm." + uuid_v4();
	LccDeviceIdentityOptions options;
	lcc_init_device_identity_options(&options);
	options.backend = LCC_DEVICE_BACKEND_WINDOWS_TPM;
	options.policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
	options.scope = LCC_DEVICE_SCOPE_USER;
	options.flags = LCC_DEVICE_OPEN_CREATE_IF_MISSING;
	set_field(options.application_id, application_id);
	set_field(options.project, "DEFAULT");

	std::string key_id;
	LccDeviceIdentity* identity = nullptr;
	try {
		require_equal(lcc_device_identity_open(&options, &identity), LCC_DEVICE_OK, "real create/open");
		require(identity != nullptr, "real identity handle");
		LccDeviceIdentityMetadata metadata;
		lcc_init_device_identity_metadata(&metadata);
		require_equal(lcc_device_identity_get_metadata(identity, &metadata), LCC_DEVICE_OK, "real metadata");
		key_id = metadata.device_key_id;
		require_equal(std::string(metadata.provider), std::string("windows-platform-ksp"), "real provider");
		require_equal(std::string(metadata.algorithm), std::string("ecdsa-p256-sha256"), "real algorithm");
		LccDeviceProofInput input;
		fill_real_proof_input(input);
		LccDeviceProof proof;
		lcc_init_device_proof(&proof);
		require_equal(lcc_device_identity_build_request_proof_v1(identity, &input, &proof), LCC_DEVICE_OK,
					  "real sign after create");
		lcc_device_identity_close(identity);
		identity = nullptr;

		options.flags = 0U;
		require_equal(lcc_device_identity_open(&options, &identity), LCC_DEVICE_OK, "real reopen");
		LccDeviceIdentityMetadata reopened_metadata;
		lcc_init_device_identity_metadata(&reopened_metadata);
		require_equal(lcc_device_identity_get_metadata(identity, &reopened_metadata), LCC_DEVICE_OK,
					  "real reopened metadata");
		require_equal(std::string(reopened_metadata.device_key_id), key_id, "real stable key id");
		lcc_init_device_proof(&proof);
		require_equal(lcc_device_identity_build_request_proof_v1(identity, &input, &proof), LCC_DEVICE_OK,
					  "real sign after reopen");
		lcc_device_identity_close(identity);
		identity = nullptr;

		ProviderOpenRequest request;
		request.backend = LCC_DEVICE_BACKEND_WINDOWS_TPM;
		request.scope = LCC_DEVICE_SCOPE_USER;
		require(license::device_identity::derive_namespace_v1(application_id, "DEFAULT", request.scope,
															  request.device_namespace),
				"real namespace derivation");
		require_private_export_denied(request);
		require_equal(lcc_device_identity_delete_key(&options, key_id.c_str()), LCC_DEVICE_OK,
					  "real expected-id delete");
		key_id.clear();
		return 0;
	} catch (...) {
		lcc_device_identity_close(identity);
		if (!key_id.empty()) {
			options.flags = 0U;
			(void)lcc_device_identity_delete_key(&options, key_id.c_str());
		}
		throw;
	}
}

}  // namespace

int main(int argc, char** argv) {
	try {
		require(argc == 2, "expected --shim or --real");
		const std::string mode = argv[1];
		if (mode == "--shim") {
			run_shim();
			std::cout << "PASS: Windows Platform KSP shim contract\n";
			return 0;
		}
		if (mode == "--real") {
			return run_real();
		}
		throw std::runtime_error("unknown mode");
	} catch (const std::exception& error) {
		std::cerr << "FAIL: " << error.what() << '\n';
		return 1;
	}
}
