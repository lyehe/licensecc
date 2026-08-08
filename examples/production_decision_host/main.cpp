#include <licensecc/licensecc.h>

#include "online_callback_common.hpp"

#if defined(LCC_PRODUCTION_DECISION_HOST_USE_CURL)
#include <curl/curl.h>
#elif defined(LCC_PRODUCTION_DECISION_HOST_USE_WINHTTP)
#include <windows.h>
#include <winhttp.h>
#endif

#include <algorithm>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <limits>
#include <string>
#include <vector>

#if defined(LCC_PRODUCTION_DECISION_HOST_USE_OPENSSL_REQUEST_PROOF)
#include <openssl/bio.h>
#include <openssl/bn.h>
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#endif

#if defined(LCC_PRODUCTION_DECISION_HOST_USE_WINDOWS_REQUEST_PROOF)
#include <windows.h>
#include <bcrypt.h>
#include <ncrypt.h>
#include <wincrypt.h>
#endif

namespace {

using licensecc_online_callback_example::add_endpoint;
using licensecc_online_callback_example::canonical_request_proof_payload;
using licensecc_online_callback_example::OnlineClient;
using licensecc_online_callback_example::OnlineRequestProofFields;
using licensecc_online_callback_example::online_check;

struct ResponseBodySink {
	std::string* body = nullptr;
	size_t max_size = 64U * 1024U;
	bool too_large = false;
};

struct FloorStore {
	std::string path;
};

struct HostIntegrityState {
	bool force_failure = false;
};

struct RequestProofStore {
	std::string device_key_id;
	std::string private_key_path;
};

struct AppOptions {
	std::string license_path;
	std::string floor_store_path;
	std::vector<std::string> verifier_urls;
	std::string request_proof_device_key_id;
	std::string request_proof_private_key_path;
	bool allow_insecure_http_for_test = false;
	bool force_host_integrity_failure_for_test = false;
};

void print_usage(const char* argv0) {
	std::fprintf(stderr,
				 "usage: %s --license PATH --floor-store PATH --verifier-url URL [--verifier-url URL ...] "
				 "[--request-proof-device-key-id sha256:<64hex> --request-proof-private-key PATH] "
				 "[--allow-insecure-http-for-test] [--fail-host-integrity-for-test]\n",
				 argv0);
}

bool parse_arguments(int argc, char** argv, AppOptions* options) {
	if (options == nullptr) {
		return false;
	}
	for (int i = 1; i < argc; ++i) {
		const char* arg = argv[i];
		if (std::strcmp(arg, "--license") == 0 && i + 1 < argc) {
			options->license_path = argv[++i];
		} else if (std::strcmp(arg, "--floor-store") == 0 && i + 1 < argc) {
			options->floor_store_path = argv[++i];
		} else if (std::strcmp(arg, "--verifier-url") == 0 && i + 1 < argc) {
			options->verifier_urls.push_back(argv[++i]);
		} else if (std::strcmp(arg, "--request-proof-device-key-id") == 0 && i + 1 < argc) {
			options->request_proof_device_key_id = argv[++i];
		} else if (std::strcmp(arg, "--request-proof-private-key") == 0 && i + 1 < argc) {
			options->request_proof_private_key_path = argv[++i];
		} else if (std::strcmp(arg, "--allow-insecure-http-for-test") == 0) {
			options->allow_insecure_http_for_test = true;
		} else if (std::strcmp(arg, "--fail-host-integrity-for-test") == 0) {
			options->force_host_integrity_failure_for_test = true;
		} else {
			return false;
		}
	}
	return !options->license_path.empty() && !options->floor_store_path.empty() &&
		   !options->verifier_urls.empty();
}

bool request_proof_configured(const AppOptions& options) {
	return !options.request_proof_device_key_id.empty() && !options.request_proof_private_key_path.empty();
}

bool request_proof_partially_configured(const AppOptions& options) {
	return options.request_proof_device_key_id.empty() != options.request_proof_private_key_path.empty();
}

void write_detail(char* detail_out, size_t detail_out_size, const char* detail) {
	if (detail_out == nullptr || detail_out_size == 0) {
		return;
	}
	std::snprintf(detail_out, detail_out_size, "%s", detail == nullptr ? "host integrity failed" : detail);
}

bool host_integrity_check(void* user_data, char* detail_out, size_t detail_out_size) {
	const HostIntegrityState* state = static_cast<const HostIntegrityState*>(user_data);
	if (state != nullptr && state->force_failure) {
		write_detail(detail_out, detail_out_size, "forced host integrity failure");
		return false;
	}
#ifdef _WIN32
	if (IsDebuggerPresent()) {
		write_detail(detail_out, detail_out_size, "debugger present");
		return false;
	}
#endif
	return true;
}

std::string public_field(const char* value) {
	return value == nullptr ? std::string() : std::string(value);
}

bool floor_record_matches(const LccRevocationFloorRecord& key, const std::string& project,
						  const std::string& feature, const std::string& fingerprint) {
	return public_field(key.project) == project && public_field(key.feature) == feature &&
		   public_field(key.license_fingerprint) == fingerprint;
}

bool load_floor_file(const FloorStore& store, const LccRevocationFloorRecord& key, uint64_t* revocation_seq_out) {
	if (revocation_seq_out == nullptr || store.path.empty()) {
		return false;
	}
	*revocation_seq_out = 0;
	std::ifstream input(store.path.c_str());
	if (!input.good()) {
		return true;
	}
	std::string project;
	std::string feature;
	std::string fingerprint;
	uint64_t revocation_seq = 0;
	if (!(input >> project >> feature >> fingerprint >> revocation_seq)) {
		return false;
	}
	if (floor_record_matches(key, project, feature, fingerprint)) {
		*revocation_seq_out = revocation_seq;
	}
	return true;
}

bool replace_file(const std::string& temporary_path, const std::string& final_path) {
#ifdef _WIN32
	return MoveFileExA(temporary_path.c_str(), final_path.c_str(),
					   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
	return std::rename(temporary_path.c_str(), final_path.c_str()) == 0;
#endif
}

bool floor_load_callback(void* user_data, const LccRevocationFloorRecord* key, uint64_t* revocation_seq_out) {
	const FloorStore* store = static_cast<const FloorStore*>(user_data);
	if (store == nullptr || key == nullptr) {
		return false;
	}
	return load_floor_file(*store, *key, revocation_seq_out);
}

bool floor_store_callback(void* user_data, const LccRevocationFloorRecord* record) {
	const FloorStore* store = static_cast<const FloorStore*>(user_data);
	if (store == nullptr || record == nullptr || store->path.empty()) {
		return false;
	}
	uint64_t existing_floor = 0;
	if (!load_floor_file(*store, *record, &existing_floor)) {
		return false;
	}
	const uint64_t stored_floor = (std::max)(existing_floor, record->revocation_seq);
	const std::string temporary_path = store->path + ".tmp";
	std::ofstream output(temporary_path.c_str(), std::ios::trunc);
	if (!output.good()) {
		return false;
	}
	output << record->project << "\n" << record->feature << "\n" << record->license_fingerprint << "\n"
		   << stored_floor << "\n";
	output.close();
	if (!output.good()) {
		std::remove(temporary_path.c_str());
		return false;
	}
	if (!replace_file(temporary_path, store->path)) {
		std::remove(temporary_path.c_str());
		return false;
	}
	return true;
}

#if defined(LCC_PRODUCTION_DECISION_HOST_USE_OPENSSL_REQUEST_PROOF)
bool base64_encode(const std::vector<unsigned char>& data, std::string* out) {
	if (out == nullptr || data.empty() || data.size() > static_cast<size_t>((std::numeric_limits<int>::max)())) {
		return false;
	}
	const int encoded_size = 4 * ((static_cast<int>(data.size()) + 2) / 3);
	std::string encoded(static_cast<size_t>(encoded_size), '\0');
	const int written = EVP_EncodeBlock(reinterpret_cast<unsigned char*>(&encoded[0]), data.data(),
										static_cast<int>(data.size()));
	if (written <= 0) {
		return false;
	}
	encoded.resize(static_cast<size_t>(written));
	*out = encoded;
	return true;
}

bool ecdsa_der_to_p1363(const std::vector<unsigned char>& der_signature, std::vector<unsigned char>* out) {
	if (out == nullptr) {
		return false;
	}
	const unsigned char* cursor = der_signature.data();
	ECDSA_SIG* ecdsa_signature = d2i_ECDSA_SIG(nullptr, &cursor, static_cast<long>(der_signature.size()));
	if (ecdsa_signature == nullptr || cursor != der_signature.data() + der_signature.size()) {
		if (ecdsa_signature != nullptr) {
			ECDSA_SIG_free(ecdsa_signature);
		}
		return false;
	}
	const BIGNUM* r = nullptr;
	const BIGNUM* s = nullptr;
	ECDSA_SIG_get0(ecdsa_signature, &r, &s);
	std::vector<unsigned char> raw(64U, 0);
	const bool ok = r != nullptr && s != nullptr && BN_bn2binpad(r, raw.data(), 32) == 32 &&
					BN_bn2binpad(s, raw.data() + 32, 32) == 32;
	ECDSA_SIG_free(ecdsa_signature);
	if (!ok) {
		return false;
	}
	*out = raw;
	return true;
}

bool sign_request_proof_payload(const std::string& private_key_path, const std::string& payload,
								std::string* signature_base64_out) {
	if (signature_base64_out == nullptr) {
		return false;
	}
	BIO* key_bio = BIO_new_file(private_key_path.c_str(), "rb");
	if (key_bio == nullptr) {
		return false;
	}
	EVP_PKEY* private_key = PEM_read_bio_PrivateKey(key_bio, nullptr, nullptr, nullptr);
	BIO_free(key_bio);
	if (private_key == nullptr) {
		return false;
	}

	EVP_MD_CTX* ctx = EVP_MD_CTX_new();
	if (ctx == nullptr) {
		EVP_PKEY_free(private_key);
		return false;
	}
	bool ok = EVP_DigestSignInit(ctx, nullptr, EVP_sha256(), nullptr, private_key) == 1 &&
			  EVP_DigestSignUpdate(ctx, payload.data(), payload.size()) == 1;
	size_t der_size = 0;
	ok = ok && EVP_DigestSignFinal(ctx, nullptr, &der_size) == 1 && der_size > 0;
	std::vector<unsigned char> der_signature(der_size);
	ok = ok && EVP_DigestSignFinal(ctx, der_signature.data(), &der_size) == 1;
	EVP_MD_CTX_free(ctx);
	EVP_PKEY_free(private_key);
	if (!ok) {
		return false;
	}
	der_signature.resize(der_size);
	std::vector<unsigned char> raw_signature;
	return ecdsa_der_to_p1363(der_signature, &raw_signature) && base64_encode(raw_signature, signature_base64_out);
}
#elif defined(LCC_PRODUCTION_DECISION_HOST_USE_WINDOWS_REQUEST_PROOF)
bool read_file(const std::string& path, std::string* out) {
	if (out == nullptr) {
		return false;
	}
	std::ifstream input(path.c_str(), std::ios::binary);
	if (!input.good()) {
		return false;
	}
	input.seekg(0, std::ios::end);
	const std::ifstream::pos_type size = input.tellg();
	if (size < 0) {
		return false;
	}
	input.seekg(0, std::ios::beg);
	std::string data(static_cast<size_t>(size), '\0');
	if (!data.empty()) {
		input.read(&data[0], static_cast<std::streamsize>(data.size()));
		if (!input.good()) {
			return false;
		}
	}
	*out = data;
	return true;
}

bool pem_to_der(const std::string& pem, std::vector<unsigned char>* der) {
	if (der == nullptr || pem.empty()) {
		return false;
	}
	DWORD der_size = 0;
	if (!CryptStringToBinaryA(pem.c_str(), 0, CRYPT_STRING_BASE64HEADER, nullptr, &der_size, nullptr, nullptr) ||
		der_size == 0) {
		return false;
	}
	std::vector<unsigned char> decoded(der_size);
	if (!CryptStringToBinaryA(pem.c_str(), 0, CRYPT_STRING_BASE64HEADER, decoded.data(), &der_size, nullptr,
							  nullptr)) {
		return false;
	}
	decoded.resize(static_cast<size_t>(der_size));
	*der = decoded;
	return true;
}

bool base64_encode(const std::vector<unsigned char>& data, std::string* out) {
	if (out == nullptr || data.empty() || data.size() > static_cast<size_t>((std::numeric_limits<DWORD>::max)())) {
		return false;
	}
	DWORD encoded_size = 0;
	if (!CryptBinaryToStringA(data.data(), static_cast<DWORD>(data.size()),
							  CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &encoded_size) ||
		encoded_size == 0) {
		return false;
	}
	std::string encoded(static_cast<size_t>(encoded_size), '\0');
	if (!CryptBinaryToStringA(data.data(), static_cast<DWORD>(data.size()),
							  CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, &encoded[0], &encoded_size)) {
		return false;
	}
	encoded.resize(encoded_size > 0 && encoded[encoded_size - 1] == '\0' ? encoded_size - 1 : encoded_size);
	*out = encoded;
	return true;
}

bool sha256_digest(const std::string& payload, std::vector<unsigned char>* digest) {
	if (digest == nullptr || payload.size() > static_cast<size_t>((std::numeric_limits<ULONG>::max)())) {
		return false;
	}
	BCRYPT_ALG_HANDLE alg = nullptr;
	if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
		return false;
	}
	DWORD object_size = 0;
	DWORD result_size = 0;
	DWORD hash_size = 0;
	bool ok = BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_size),
								sizeof(object_size), &result_size, 0) == 0 &&
			  BCryptGetProperty(alg, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_size), sizeof(hash_size),
								&result_size, 0) == 0 &&
			  hash_size > 0;
	std::vector<unsigned char> object(object_size);
	std::vector<unsigned char> hash(hash_size);
	BCRYPT_HASH_HANDLE hash_handle = nullptr;
	ok = ok && BCryptCreateHash(alg, &hash_handle, object.data(), object_size, nullptr, 0, 0) == 0 &&
		 BCryptHashData(hash_handle, reinterpret_cast<PUCHAR>(const_cast<char*>(payload.data())),
						static_cast<ULONG>(payload.size()), 0) == 0 &&
		 BCryptFinishHash(hash_handle, hash.data(), hash_size, 0) == 0;
	if (hash_handle != nullptr) {
		BCryptDestroyHash(hash_handle);
	}
	BCryptCloseAlgorithmProvider(alg, 0);
	if (!ok) {
		return false;
	}
	*digest = hash;
	return true;
}

bool sign_digest_with_pkcs8(const std::vector<unsigned char>& pkcs8_der, const std::vector<unsigned char>& digest,
							std::vector<unsigned char>* signature_out) {
	if (signature_out == nullptr || pkcs8_der.empty() || digest.empty() ||
		pkcs8_der.size() > static_cast<size_t>((std::numeric_limits<DWORD>::max)()) ||
		digest.size() > static_cast<size_t>((std::numeric_limits<DWORD>::max)())) {
		return false;
	}
	NCRYPT_PROV_HANDLE provider = 0;
	if (NCryptOpenStorageProvider(&provider, MS_KEY_STORAGE_PROVIDER, 0) != ERROR_SUCCESS) {
		return false;
	}
	NCRYPT_KEY_HANDLE key = 0;
	SECURITY_STATUS status = NCryptImportKey(provider, 0, NCRYPT_PKCS8_PRIVATE_KEY_BLOB, nullptr, &key,
											 const_cast<PBYTE>(pkcs8_der.data()), static_cast<DWORD>(pkcs8_der.size()),
											 NCRYPT_SILENT_FLAG);
	if (status != ERROR_SUCCESS) {
		NCryptFreeObject(provider);
		return false;
	}
	DWORD signature_size = 0;
	status = NCryptSignHash(key, nullptr, const_cast<PBYTE>(digest.data()), static_cast<DWORD>(digest.size()), nullptr,
							0, &signature_size, NCRYPT_SILENT_FLAG);
	std::vector<unsigned char> signature(signature_size);
	if (status == ERROR_SUCCESS && signature_size == 64) {
		status = NCryptSignHash(key, nullptr, const_cast<PBYTE>(digest.data()), static_cast<DWORD>(digest.size()),
								signature.data(), signature_size, &signature_size, NCRYPT_SILENT_FLAG);
	}
	NCryptFreeObject(key);
	NCryptFreeObject(provider);
	if (status != ERROR_SUCCESS || signature_size != 64) {
		return false;
	}
	signature.resize(signature_size);
	*signature_out = signature;
	return true;
}

bool sign_request_proof_payload(const std::string& private_key_path, const std::string& payload,
								std::string* signature_base64_out) {
	std::string pem;
	std::vector<unsigned char> pkcs8_der;
	std::vector<unsigned char> digest;
	std::vector<unsigned char> signature;
	return signature_base64_out != nullptr && read_file(private_key_path, &pem) && pem_to_der(pem, &pkcs8_der) &&
		   sha256_digest(payload, &digest) && sign_digest_with_pkcs8(pkcs8_der, digest, &signature) &&
		   base64_encode(signature, signature_base64_out);
}
#endif

#if defined(LCC_PRODUCTION_DECISION_HOST_USE_OPENSSL_REQUEST_PROOF) || \
	defined(LCC_PRODUCTION_DECISION_HOST_USE_WINDOWS_REQUEST_PROOF)
bool request_proof_callback(void* user_data, const LccOnlineRequest& request, OnlineRequestProofFields* proof_out) {
	const RequestProofStore* store = static_cast<const RequestProofStore*>(user_data);
	if (store == nullptr || proof_out == nullptr || store->device_key_id.empty() || store->private_key_path.empty()) {
		return false;
	}
	OnlineRequestProofFields proof;
	proof.device_key_id = store->device_key_id;
	proof.request_timestamp = static_cast<uint64_t>(std::time(nullptr));
	const std::string payload = canonical_request_proof_payload(request, proof);
	if (!sign_request_proof_payload(store->private_key_path, payload, &proof.signature)) {
		std::fprintf(stderr, "request proof signing failed\n");
		return false;
	}
	*proof_out = proof;
	return true;
}
#endif

#if defined(LCC_PRODUCTION_DECISION_HOST_USE_CURL)
size_t write_body(char* ptr, size_t size, size_t nmemb, void* user_data) {
	ResponseBodySink* sink = static_cast<ResponseBodySink*>(user_data);
	const size_t bytes = size * nmemb;
	if (sink == nullptr || sink->body == nullptr) {
		return 0;
	}
	if (bytes > sink->max_size || sink->body->size() > sink->max_size - bytes) {
		sink->too_large = true;
		return 0;
	}
	sink->body->append(ptr, bytes);
	return bytes;
}

LCC_ONLINE_CALLBACK_STATUS post_verify(void*, const std::string& endpoint, const LccOnlineRequest& request,
									   const std::string& body, std::string* response_body) {
	if (response_body == nullptr) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	CURL* curl = curl_easy_init();
	if (curl == nullptr) {
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}

	const std::string url = endpoint + "/v1/verify";
	ResponseBodySink sink;
	sink.body = response_body;
	struct curl_slist* headers = nullptr;
	headers = curl_slist_append(headers, "Content-Type: application/json");

	curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
	curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
	curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
	curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
	curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_body);
	curl_easy_setopt(curl, CURLOPT_WRITEDATA, &sink);
	curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(request.timeout_ms));
	curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

	const CURLcode curl_result = curl_easy_perform(curl);
	long http_status = 0;
	curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_status);
	curl_slist_free_all(headers);
	curl_easy_cleanup(curl);

	if (curl_result == CURLE_OPERATION_TIMEDOUT) {
		return LCC_ONLINE_CB_TIMEOUT;
	}
	if (sink.too_large) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	if (curl_result != CURLE_OK || http_status >= 500) {
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}
	return http_status == 200 ? LCC_ONLINE_CB_OK : LCC_ONLINE_CB_MALFORMED_RESPONSE;
}
#elif defined(LCC_PRODUCTION_DECISION_HOST_USE_WINHTTP)
std::wstring utf8_to_wide(const std::string& value) {
	if (value.empty()) {
		return std::wstring();
	}
	const int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), nullptr, 0);
	if (size <= 0) {
		return std::wstring();
	}
	std::wstring out(static_cast<size_t>(size), L'\0');
	MultiByteToWideChar(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), &out[0], size);
	return out;
}

LCC_ONLINE_CALLBACK_STATUS post_verify(void*, const std::string& endpoint, const LccOnlineRequest& request,
									   const std::string& body, std::string* response_body) {
	if (response_body == nullptr) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	const std::wstring url = utf8_to_wide(endpoint + "/v1/verify");
	if (url.empty()) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}
	URL_COMPONENTS parts = {};
	parts.dwStructSize = sizeof(parts);
	parts.dwSchemeLength = static_cast<DWORD>(-1);
	parts.dwHostNameLength = static_cast<DWORD>(-1);
	parts.dwUrlPathLength = static_cast<DWORD>(-1);
	parts.dwExtraInfoLength = static_cast<DWORD>(-1);
	if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts)) {
		return LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}

	const std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
	std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
	if (parts.dwExtraInfoLength > 0) {
		path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
	}
	const bool secure = parts.nScheme == INTERNET_SCHEME_HTTPS;

	HINTERNET session = WinHttpOpen(L"licensecc-production-decision-host/1.0",
									WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
									WINHTTP_NO_PROXY_BYPASS, 0);
	if (session == nullptr) {
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}
	const DWORD timeout = request.timeout_ms == 0 ? LCC_ONLINE_DEFAULT_TIMEOUT_MS : request.timeout_ms;
	WinHttpSetTimeouts(session, static_cast<int>(timeout), static_cast<int>(timeout), static_cast<int>(timeout),
					   static_cast<int>(timeout));

	HINTERNET connection = WinHttpConnect(session, host.c_str(), parts.nPort, 0);
	if (connection == nullptr) {
		WinHttpCloseHandle(session);
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}

	HINTERNET http_request = WinHttpOpenRequest(connection, L"POST", path.c_str(), nullptr, WINHTTP_NO_REFERER,
												WINHTTP_DEFAULT_ACCEPT_TYPES, secure ? WINHTTP_FLAG_SECURE : 0);
	if (http_request == nullptr) {
		WinHttpCloseHandle(connection);
		WinHttpCloseHandle(session);
		return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}

	const wchar_t headers[] = L"Content-Type: application/json\r\n";
	const BOOL sent =
		WinHttpSendRequest(http_request, headers, static_cast<DWORD>(wcslen(headers)), const_cast<char*>(body.data()),
						   static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0);
	if (!sent || !WinHttpReceiveResponse(http_request, nullptr)) {
		const DWORD error = GetLastError();
		WinHttpCloseHandle(http_request);
		WinHttpCloseHandle(connection);
		WinHttpCloseHandle(session);
		return error == ERROR_WINHTTP_TIMEOUT ? LCC_ONLINE_CB_TIMEOUT : LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
	}

	DWORD status = 0;
	DWORD status_size = sizeof(status);
	WinHttpQueryHeaders(http_request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
						WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX);
	if (status != 200) {
		WinHttpCloseHandle(http_request);
		WinHttpCloseHandle(connection);
		WinHttpCloseHandle(session);
		return status >= 500 ? LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE : LCC_ONLINE_CB_MALFORMED_RESPONSE;
	}

	response_body->clear();
	for (;;) {
		DWORD available = 0;
		if (!WinHttpQueryDataAvailable(http_request, &available)) {
			WinHttpCloseHandle(http_request);
			WinHttpCloseHandle(connection);
			WinHttpCloseHandle(session);
			return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
		}
		if (available == 0) {
			break;
		}
		std::vector<char> buffer(static_cast<size_t>(available));
		DWORD read = 0;
		if (!WinHttpReadData(http_request, buffer.data(), available, &read)) {
			WinHttpCloseHandle(http_request);
			WinHttpCloseHandle(connection);
			WinHttpCloseHandle(session);
			return LCC_ONLINE_CB_TRANSPORT_UNAVAILABLE;
		}
		if (read > 64U * 1024U || response_body->size() > 64U * 1024U - read) {
			WinHttpCloseHandle(http_request);
			WinHttpCloseHandle(connection);
			WinHttpCloseHandle(session);
			return LCC_ONLINE_CB_MALFORMED_RESPONSE;
		}
		response_body->append(buffer.data(), read);
	}

	WinHttpCloseHandle(http_request);
	WinHttpCloseHandle(connection);
	WinHttpCloseHandle(session);
	return LCC_ONLINE_CB_OK;
}
#endif

void print_decision(LCC_EVENT_TYPE result, const LicenseInfo& info, const LccLicenseDecision& decision) {
	char message[LCC_API_ERROR_BUFFER_SIZE];
	print_error(message, &info);
	std::printf("decision=%s event=%s\n", decision.decision == LCC_LICENSE_DECISION_ALLOW ? "allow" : "deny",
				lcc_strerror(result));
	std::printf("online_verified=%s revocation_floor_loaded=%s revocation_floor_stored=%s tamper_enforced=%s\n",
				decision.online_verified ? "true" : "false",
				decision.revocation_floor_loaded ? "true" : "false",
				decision.revocation_floor_stored ? "true" : "false",
				decision.tamper_enforced ? "true" : "false");
	std::printf("revocation_seq=%llu\n", static_cast<unsigned long long>(decision.revocation_floor.revocation_seq));
	std::printf("%s\n", message);
}

}  // namespace

int main(int argc, char** argv) {
	AppOptions app_options;
	if (!parse_arguments(argc, argv, &app_options)) {
		print_usage(argv[0]);
		return 2;
	}
	if (request_proof_partially_configured(app_options)) {
		std::fprintf(stderr, "request proof requires both --request-proof-device-key-id and --request-proof-private-key\n");
		return 2;
	}

#if defined(LCC_PRODUCTION_DECISION_HOST_USE_CURL)
	curl_global_init(CURL_GLOBAL_DEFAULT);
#endif

#if !defined(LCC_PRODUCTION_DECISION_HOST_USE_OPENSSL_REQUEST_PROOF)
	if (request_proof_configured(app_options)) {
		std::fprintf(stderr, "request proof flags require an example build with OpenSSL Crypto or Windows CNG support\n");
#if defined(LCC_PRODUCTION_DECISION_HOST_USE_CURL)
		curl_global_cleanup();
#endif
		return 2;
	}
#endif

	LicenseLocation location;
	lcc_init_license_location(&location, LICENSE_PATH);
	if (!lcc_set_license_path(&location, app_options.license_path.c_str())) {
		std::fprintf(stderr, "license path is too long\n");
#if defined(LCC_PRODUCTION_DECISION_HOST_USE_CURL)
		curl_global_cleanup();
#endif
		return 2;
	}

	CallerInformations caller;
	lcc_init_caller_informations(&caller);

	OnlineClient online_client;
	online_client.post_verify_body = post_verify;
	online_client.allow_insecure_http_for_test = app_options.allow_insecure_http_for_test;
#if defined(LCC_PRODUCTION_DECISION_HOST_USE_OPENSSL_REQUEST_PROOF)
	RequestProofStore request_proof_store;
	if (request_proof_configured(app_options)) {
		request_proof_store.device_key_id = app_options.request_proof_device_key_id;
		request_proof_store.private_key_path = app_options.request_proof_private_key_path;
		online_client.request_proof_provider = request_proof_callback;
		online_client.request_proof_user_data = &request_proof_store;
	}
#endif
	for (size_t i = 0; i < app_options.verifier_urls.size(); ++i) {
		if (!add_endpoint(&online_client, app_options.verifier_urls[i].c_str())) {
			std::fprintf(stderr, "invalid verifier URL: %s\n", app_options.verifier_urls[i].c_str());
#if defined(LCC_PRODUCTION_DECISION_HOST_USE_CURL)
			curl_global_cleanup();
#endif
			return 2;
		}
	}

	FloorStore floor_store;
	floor_store.path = app_options.floor_store_path;
	HostIntegrityState host_state;
	host_state.force_failure = app_options.force_host_integrity_failure_for_test;

	LccLicenseDecisionOptions decision_options;
	lcc_init_license_decision_options(&decision_options);
	decision_options.online_check = online_check;
	decision_options.online_user_data = &online_client;
	decision_options.host_integrity_check = host_integrity_check;
	decision_options.host_integrity_user_data = &host_state;
	decision_options.revocation_floor_load = floor_load_callback;
	decision_options.revocation_floor_store = floor_store_callback;
	decision_options.revocation_floor_user_data = &floor_store;

	LicenseInfo info;
	LccLicenseDecision decision;
	const LCC_EVENT_TYPE result =
		lcc_acquire_license_decision(&caller, &location, &info, &decision, &decision_options);
	print_decision(result, info, decision);

#if defined(LCC_PRODUCTION_DECISION_HOST_USE_CURL)
	curl_global_cleanup();
#endif
	return result == LICENSE_OK ? 0 : 1;
}
