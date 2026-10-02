/*
 * verifier.cpp
 *
 *  Created on: Nov 16, 2019
 *      Author: GC
 */

#include <openssl/decoder.h>
#include <openssl/evp.h>
#include <stdlib.h>
#include <errno.h>

//#ifdef _WIN32
//#include <windows.h>
//#endif

#include <cstdint>
#include <vector>

#include <public_key.h>

#include "../signature_verifier.hpp"
#include "../../base/logger.h"

namespace license {
namespace os {

static void free_resources(EVP_PKEY* pkey, EVP_MD_CTX* mdctx) {
	if (pkey) {
		EVP_PKEY_free(pkey);
	}
	if (mdctx) {
		EVP_MD_CTX_free(mdctx);
	}
}

// True when the bytes are exactly one PKCS#1 RSAPublicKey DER: a SEQUENCE of two positive, minimally
// encoded INTEGERs with nothing after it. This is the shape the Windows CNG verifier parses.
static bool is_pkcs1_rsa_public_key_der(const std::vector<uint8_t>& der) {
	size_t offset = 0;
	size_t sequence_length = 0;
	size_t value_start = 0;
	size_t value_length = 0;
	return !der.empty() && der[offset++] == 0x30U && signature_read_der_length(der, offset, sequence_length) &&
		   sequence_length == der.size() - offset &&
		   signature_read_der_integer_value(der, offset, value_start, value_length) &&
		   signature_read_der_integer_value(der, offset, value_start, value_length) && offset == der.size();
}

// Decodes a PKCS#1 RSAPublicKey DER, the only public-key encoding the verifier accepts, through the
// OpenSSL 3 decoder: DER input, the RSA type-specific structure and the public key only. OpenSSL
// 3.0's decoder also takes a SubjectPublicKeyInfo for that structure, so the shape is checked first,
// and, like the Windows CNG verifier, no bytes may be left after the key.
static EVP_PKEY* decode_pkcs1_rsa_public_key(const std::vector<uint8_t>& public_key_der) {
	if (!is_pkcs1_rsa_public_key_der(public_key_der)) {
		return NULL;
	}
	EVP_PKEY* pkey = NULL;
	OSSL_DECODER_CTX* decoder =
		OSSL_DECODER_CTX_new_for_pkey(&pkey, "DER", "type-specific", "RSA", EVP_PKEY_PUBLIC_KEY, NULL, NULL);
	if (decoder == NULL) {
		return NULL;
	}
	const unsigned char* data = public_key_der.data();
	size_t remaining = public_key_der.size();
	const int decoded = OSSL_DECODER_from_data(decoder, &data, &remaining);
	OSSL_DECODER_CTX_free(decoder);
	if (decoded != 1 || pkey == NULL || remaining != 0) {
		EVP_PKEY_free(pkey);
		return NULL;
	}
	return pkey;
}

static FUNCTION_RETURN verify_signature_bytes(const std::vector<uint8_t>& payload,
											  const std::vector<uint8_t>& signature,
											  const std::vector<uint8_t>& public_key_der) {
	EVP_MD_CTX* mdctx = NULL;
	if (public_key_der.empty()) {
		LOG_ERROR("No public key selected");
		return FUNC_RET_ERROR;
	}
	int func_ret = 0;

	EVP_PKEY* pkey = decode_pkcs1_rsa_public_key(public_key_der);
	if (pkey == NULL) {
		LOG_ERROR("Error reading public key");
		return FUNC_RET_ERROR;
	}

	/* Create the Message Digest Context */
	if (!(mdctx = EVP_MD_CTX_new())) {
		free_resources(pkey, mdctx);
		LOG_ERROR("Error creating context");
		return FUNC_RET_ERROR;
	}
	if (1 != EVP_DigestVerifyInit(mdctx, NULL, EVP_sha256(), NULL, pkey)) {
		LOG_ERROR("Error initializing digest");
		free_resources(pkey, mdctx);
		return FUNC_RET_ERROR;
	}

	func_ret = EVP_DigestVerifyUpdate(mdctx, (const void*)payload.data(), payload.size());
	if (1 != func_ret) {
		LOG_ERROR("Error verifying digest %d", func_ret);
		free_resources(pkey, mdctx);
		return FUNC_RET_ERROR;
	}
	FUNCTION_RETURN result;
	func_ret = EVP_DigestVerifyFinal(mdctx, signature.data(), signature.size());
	if (1 != func_ret) {
		LOG_ERROR("Error verifying digest %d", func_ret);
	}
	result = (1 == func_ret ? FUNC_RET_OK : FUNC_RET_ERROR);

	free_resources(pkey, mdctx);
	return result;
}

FUNCTION_RETURN verify_signature(const SignatureVerificationRequest& request) {
	if (!signature_request_allowed(request)) {
		LOG_ERROR("Signature request rejected by policy");
		return FUNC_RET_ERROR;
	}
	std::vector<uint8_t> selected_public_key_der;
	if (!signature_select_public_key_der(request, selected_public_key_der)) {
		LOG_ERROR("No matching public key for signature request");
		return FUNC_RET_ERROR;
	}
	return verify_signature_bytes(request.payload, request.signature, selected_public_key_der);
}
}  // namespace os
} /* namespace license */
