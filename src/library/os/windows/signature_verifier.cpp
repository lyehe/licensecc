/*
 * verifier.cpp
 *
 *  Created on: Nov 16, 2019
 *      Author: devel
 */

#include "../os.h"
#include <stdio.h>
#include <sstream>
#include <iostream>
#include <fstream>
#include <vector>
#include <algorithm>
#include <climits>
#include <bcrypt.h>
#include <wincrypt.h>
#include <iphlpapi.h>
#include <windows.h>
//#pragma comment(lib, "bcrypt.lib")

#include <public_key.h>
#include "../../base/logger.h"
#include "../../base/base64.h"
#include "../signature_verifier.hpp"

namespace license {
namespace os {
using namespace std;
#define NT_SUCCESS(Status) (((NTSTATUS)(Status)) >= 0)

static const void formatError(DWORD status, const char *description) {
	char msgBuffer[256];
	FormatMessage(FORMAT_MESSAGE_FROM_SYSTEM, NULL, status, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT), &msgBuffer[0],
				  sizeof(msgBuffer) - 1, nullptr);
	LOG_DEBUG("error %s : %s %h", description, msgBuffer, status);
}

static BCRYPT_ALG_HANDLE openHashProvider() {
	DWORD status;
	BCRYPT_ALG_HANDLE hHashAlg = nullptr;
	if (!NT_SUCCESS(status = BCryptOpenAlgorithmProvider(&hHashAlg, BCRYPT_SHA256_ALGORITHM, NULL, 0))) {
		throw logic_error("Error opening hash provider");
	}
	return hHashAlg;
}

static DWORD hashData(BCRYPT_HASH_HANDLE& hHash, const vector<uint8_t>& data, PBYTE pbHash, DWORD hashDataLenght) {
	DWORD status;
	if (NT_SUCCESS(status = BCryptHashData(hHash, (BYTE*)data.data(), (ULONG)data.size(), 0))) {
		status = BCryptFinishHash(hHash, pbHash, hashDataLenght, 0);
	}
	return status;
}

static FUNCTION_RETURN read_length(uint8_t*& ptr, const uint8_t* end, size_t& out_length) {
	if (ptr >= end) {
		return FUNC_RET_ERROR;
	}
	uint8_t len = *ptr++;
	size_t result = 0;
	if ((len & 0x80) > 0) {
		const size_t blen = len & 0x7F;
		if (blen == 0 || blen > sizeof(size_t) || static_cast<size_t>(end - ptr) < blen || *ptr == 0) {
			return FUNC_RET_ERROR;
		}
		for (size_t i = 0; i < blen; i++) {
			result = (result << 8) | static_cast<size_t>(*(ptr++));
		}
		if (result <= 127) {
			return FUNC_RET_ERROR;
		}
	} else {
		result = len;
	}
	out_length = result;
	return FUNC_RET_OK;
}

static FUNCTION_RETURN read_sequence(uint8_t*& ptr, const uint8_t* end) {
	if (ptr >= end || *ptr++ != 0x30) {
		return FUNC_RET_ERROR;
	}
	size_t seq_length;
	if (read_length(ptr, end, seq_length) != FUNC_RET_OK) {
		return FUNC_RET_ERROR;
	}
	return seq_length == static_cast<size_t>(end - ptr) ? FUNC_RET_OK : FUNC_RET_ERROR;
}

static FUNCTION_RETURN read_integer(uint8_t*& ptr, const uint8_t* end, vector<uint8_t>& out) {
	if (ptr >= end || *ptr++ != 0x02) {
		return FUNC_RET_ERROR;
	}
	size_t length;
	if (read_length(ptr, end, length) != FUNC_RET_OK) {
		return FUNC_RET_ERROR;
	}
	if (length == 0 || length > static_cast<size_t>(end - ptr)) {
		return FUNC_RET_ERROR;
	}
	const uint8_t* value = ptr;
	if (value[0] == 0) {
		if (length == 1 || (value[1] & 0x80) == 0) {
			return FUNC_RET_ERROR;
		}
		ptr++;
		length--;
	} else if ((value[0] & 0x80) != 0) {
		return FUNC_RET_ERROR;
	}
	if (length == 0) {
		return FUNC_RET_ERROR;
	}
	out.assign(ptr, ptr + length);
	ptr += length;
	return FUNC_RET_OK;
}

static FUNCTION_RETURN readPublicKey(const BCRYPT_ALG_HANDLE sig_alg, BCRYPT_KEY_HANDLE* hKey,
									 const vector<uint8_t>& public_key_der) {
	FUNCTION_RETURN result = FUNC_RET_ERROR;
	DWORD status;
	if (public_key_der.empty()) {
		return FUNC_RET_ERROR;
	}
	const vector<uint8_t>& selected_public_key_der = public_key_der;
	uint8_t* pub_key_idx = const_cast<uint8_t*>(selected_public_key_der.data());
	const uint8_t* pub_key_end = pub_key_idx + selected_public_key_der.size();
	vector<uint8_t> modulus;
	vector<uint8_t> exponent;
	if (read_sequence(pub_key_idx, pub_key_end) != FUNC_RET_OK ||
		read_integer(pub_key_idx, pub_key_end, modulus) != FUNC_RET_OK ||
		read_integer(pub_key_idx, pub_key_end, exponent) != FUNC_RET_OK || pub_key_idx != pub_key_end) {
		LOG_DEBUG("Error parsing public key");
		return FUNC_RET_ERROR;
	}
	if (modulus.empty() || exponent.empty() || modulus.size() > ULONG_MAX || exponent.size() > ULONG_MAX) {
		return FUNC_RET_ERROR;
	}
	vector<uint8_t> pubk(sizeof(BCRYPT_RSAKEY_BLOB) + exponent.size() + modulus.size());
	BCRYPT_RSAKEY_BLOB* header = reinterpret_cast<BCRYPT_RSAKEY_BLOB*>(pubk.data());
	header->Magic = BCRYPT_RSAPUBLIC_MAGIC;
	header->BitLength = static_cast<ULONG>(modulus.size() * 8);
	header->cbPublicExp = static_cast<ULONG>(exponent.size());
	header->cbModulus = static_cast<ULONG>(modulus.size());
	header->cbPrime1 = 0;
	header->cbPrime2 = 0;
	uint8_t* cursor = pubk.data() + sizeof(BCRYPT_RSAKEY_BLOB);
	copy(exponent.begin(), exponent.end(), cursor);
	cursor += exponent.size();
	copy(modulus.begin(), modulus.end(), cursor);
	if (NT_SUCCESS(status = BCryptImportKeyPair(sig_alg, nullptr, BCRYPT_RSAPUBLIC_BLOB, hKey, (PUCHAR)pubk.data(),
												static_cast<ULONG>(pubk.size()), 0))) {
		result = FUNC_RET_OK;
	} else {
#ifndef NDEBUG
		formatError(status, "error importing public key");
#endif
	}
	return result;
}

static FUNCTION_RETURN verifyHash(const PBYTE pbHash, const DWORD hashDataLenght, const vector<uint8_t>& signatureBlob,
								  const vector<uint8_t>& public_key_der) {
	BCRYPT_KEY_HANDLE phKey = nullptr;
	DWORD status;
	FUNCTION_RETURN result = FUNC_RET_ERROR;
	PBYTE pbSignature = nullptr;
	BCRYPT_ALG_HANDLE hSignAlg = nullptr;

	DWORD dwSigLen = (DWORD) signatureBlob.size();
	if (dwSigLen == 0) {
		return FUNC_RET_ERROR;
	}
	BYTE* sigBlob = const_cast<BYTE*>(signatureBlob.data());

	if (NT_SUCCESS(status = BCryptOpenAlgorithmProvider(&hSignAlg, BCRYPT_RSA_ALGORITHM, NULL, 0))) {
		if ((result = readPublicKey(hSignAlg, &phKey, public_key_der)) == FUNC_RET_OK) {
			BCRYPT_PKCS1_PADDING_INFO paddingInfo;
			ZeroMemory(&paddingInfo, sizeof(paddingInfo));
			paddingInfo.pszAlgId = BCRYPT_SHA256_ALGORITHM;
			if (NT_SUCCESS(status = BCryptVerifySignature(phKey, &paddingInfo, pbHash, hashDataLenght, sigBlob,
														  dwSigLen, BCRYPT_PAD_PKCS1))) {
				result = FUNC_RET_OK;
			} else {
				result = FUNC_RET_ERROR;
#ifndef NDEBUG
				formatError(status, "error verifying signature");
#endif
			}
		} else {
			LOG_DEBUG("Error reading public key");
		}
	}
	else {
		result = FUNC_RET_NOT_AVAIL;
#ifndef NDEBUG
		formatError(status, "error opening RSA provider");
#endif
	}

	if (phKey != nullptr) {
		BCryptDestroyKey(phKey);
	}
	if (hSignAlg != nullptr) {
		BCryptCloseAlgorithmProvider(hSignAlg, 0);
	}
	//if (sigBlob) {
	//	free(sigBlob);
	//}
	return result;
}

static FUNCTION_RETURN verify_signature_bytes(const vector<uint8_t>& payload, const vector<uint8_t>& signature,
											  const vector<uint8_t>& public_key_der) {
	BCRYPT_HASH_HANDLE hHash = nullptr;
	PBYTE pbHashObject = nullptr, pbHashData = nullptr;

	FUNCTION_RETURN result = FUNC_RET_ERROR;
	const HANDLE hProcessHeap = GetProcessHeap();
	// BCRYPT_ALG_HANDLE sig_alg = openSignatureProvider();

	BCRYPT_ALG_HANDLE hash_alg = openHashProvider();
	DWORD status;

	// calculate the size of the buffer to hold the hash object
	DWORD cbData = 0, cbHashObject = 0;
	// and the size to keep the hashed data
	DWORD cbHashDataLenght = 0;
	if (NT_SUCCESS(status = BCryptGetProperty(hash_alg, BCRYPT_OBJECT_LENGTH, (PBYTE)&cbHashObject, sizeof(DWORD),
											  &cbData, 0)) &&
		NT_SUCCESS(status = BCryptGetProperty(hash_alg, BCRYPT_HASH_LENGTH, (PBYTE)&cbHashDataLenght, sizeof(DWORD),
											  &cbData, 0))) {
		// allocate the hash object on the heap
		pbHashObject = (PBYTE)HeapAlloc(hProcessHeap, 0, cbHashObject);
		pbHashData = (PBYTE)HeapAlloc(hProcessHeap, 0, cbHashDataLenght);
		if (NULL != pbHashObject && nullptr != pbHashData) {
			if (NT_SUCCESS(status = BCryptCreateHash(hash_alg, &hHash, pbHashObject, cbHashObject, NULL, 0, 0))) {
				if (NT_SUCCESS(status = hashData(hHash, payload, pbHashData, cbHashDataLenght))) {
					result = verifyHash(pbHashData, cbHashDataLenght, signature, public_key_der);
				} else {
					result = FUNC_RET_NOT_AVAIL;
#ifndef NDEBUG
					formatError(status, "error hashing data");
#endif
				}
			} else {
				result = FUNC_RET_NOT_AVAIL;
#ifndef NDEBUG
				formatError(status, "error creating hash");
#endif
			}
		} else {
			result = FUNC_RET_BUFFER_TOO_SMALL;
			LOG_DEBUG("Error allocating memory");
		}
	} else {
		result = FUNC_RET_NOT_AVAIL;
#ifndef NDEBUG
		formatError(status, "**** Error returned by BCryptGetProperty");
#endif
	}

	if (hHash) {
		BCryptDestroyHash(hHash);
	}
	if (pbHashObject) {
		HeapFree(hProcessHeap, 0, pbHashObject);
	}
	if (pbHashData) {
		HeapFree(hProcessHeap, 0, pbHashData);
	}
	if (hash_alg != nullptr) {
		BCryptCloseAlgorithmProvider(hash_alg, 0);
	}
	return result;
}

FUNCTION_RETURN verify_signature(const SignatureVerificationRequest& request) {
	if (!signature_request_allowed(request)) {
		LOG_DEBUG("Signature request rejected by policy");
		return FUNC_RET_ERROR;
	}
	vector<uint8_t> selected_public_key_der;
	if (!signature_select_public_key_der(request, selected_public_key_der)) {
		LOG_DEBUG("No matching public key for signature request");
		return FUNC_RET_ERROR;
	}
	return verify_signature_bytes(request.payload, request.signature, selected_public_key_der);
}

FUNCTION_RETURN verify_signature(const std::string& stringToVerify, const std::string& signatureB64) {
	const vector<uint8_t> signature = unbase64(signatureB64);
	if (signature.empty()) {
		LOG_DEBUG("Error decoding signature");
		return FUNC_RET_ERROR;
	}
	SignatureVerificationRequest request;
	request.payload.assign(stringToVerify.begin(), stringToVerify.end());
	request.signature = signature;
	request.declared_algorithm = LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256;
	request.key_id = embedded_public_key_id();
	request.license_version = 200;
	request.policy = legacy_v200_signature_policy();
	return verify_signature(request);
}
}  // namespace os
} /* namespace license */
