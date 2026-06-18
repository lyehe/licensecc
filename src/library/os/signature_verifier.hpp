/*
 * verifier.hpp
 *
 *  Created on: Nov 16, 2019
 *      Author: GC
 */

#ifndef SRC_LIBRARY_OS_VERIFIER_HPP_
#define SRC_LIBRARY_OS_VERIFIER_HPP_

#include <cstdint>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>
#include "../base/base.h"

#ifdef LCC_PROJECT_PUBLIC_KEY_HEADER
#include LCC_PROJECT_PUBLIC_KEY_HEADER
#else
#include <public_key.h>
#endif

namespace license {
namespace os {

static const char* const LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256 = "rsa-pkcs1-sha256";
static const char* const LCC_SIGNATURE_KEY_ID_LEGACY_V200 = "legacy-v200-public-key";
static const unsigned int LCC_ONLINE_ASSERTION_SIGNATURE_VERSION = 9001;

inline uint32_t signature_sha256_rotr(uint32_t value, uint32_t bits) {
	return (value >> bits) | (value << (32U - bits));
}

inline std::string signature_sha256_hex(const std::vector<uint8_t>& data) {
	static const uint32_t k[64] = {
		0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U,
		0xab1c5ed5U, 0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU,
		0x9bdc06a7U, 0xc19bf174U, 0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU,
		0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU, 0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
		0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU,
		0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U, 0xa2bfe8a1U, 0xa81a664bU,
		0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U, 0x19a4c116U,
		0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
		0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U,
		0xc67178f2U};
	uint32_t h[8] = {0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
					 0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U};
	std::vector<uint8_t> message(data);
	const uint64_t bit_length = static_cast<uint64_t>(message.size()) * 8U;
	message.push_back(0x80U);
	while ((message.size() % 64U) != 56U) {
		message.push_back(0U);
	}
	for (int shift = 56; shift >= 0; shift -= 8) {
		message.push_back(static_cast<uint8_t>((bit_length >> shift) & 0xffU));
	}

	for (size_t offset = 0; offset < message.size(); offset += 64U) {
		uint32_t w[64] = {};
		for (size_t i = 0; i < 16U; ++i) {
			const size_t j = offset + (i * 4U);
			w[i] = (static_cast<uint32_t>(message[j]) << 24U) |
				   (static_cast<uint32_t>(message[j + 1U]) << 16U) |
				   (static_cast<uint32_t>(message[j + 2U]) << 8U) |
				   static_cast<uint32_t>(message[j + 3U]);
		}
		for (size_t i = 16U; i < 64U; ++i) {
			const uint32_t s0 = signature_sha256_rotr(w[i - 15U], 7U) ^
								signature_sha256_rotr(w[i - 15U], 18U) ^ (w[i - 15U] >> 3U);
			const uint32_t s1 = signature_sha256_rotr(w[i - 2U], 17U) ^
								signature_sha256_rotr(w[i - 2U], 19U) ^ (w[i - 2U] >> 10U);
			w[i] = w[i - 16U] + s0 + w[i - 7U] + s1;
		}
		uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
		for (size_t i = 0; i < 64U; ++i) {
			const uint32_t s1 = signature_sha256_rotr(e, 6U) ^ signature_sha256_rotr(e, 11U) ^
								signature_sha256_rotr(e, 25U);
			const uint32_t ch = (e & f) ^ ((~e) & g);
			const uint32_t temp1 = hh + s1 + ch + k[i] + w[i];
			const uint32_t s0 = signature_sha256_rotr(a, 2U) ^ signature_sha256_rotr(a, 13U) ^
								signature_sha256_rotr(a, 22U);
			const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
			const uint32_t temp2 = s0 + maj;
			hh = g;
			g = f;
			f = e;
			e = d + temp1;
			d = c;
			c = b;
			b = a;
			a = temp1 + temp2;
		}
		h[0] += a;
		h[1] += b;
		h[2] += c;
		h[3] += d;
		h[4] += e;
		h[5] += f;
		h[6] += g;
		h[7] += hh;
	}

	std::ostringstream out;
	out << std::hex << std::setfill('0');
	for (const uint32_t word : h) {
		out << std::setw(8) << word;
	}
	return out.str();
}

inline std::string public_key_id_from_der(const std::vector<uint8_t>& public_key_der) {
	return std::string("sha256:") + signature_sha256_hex(public_key_der);
}

inline std::string embedded_public_key_id() {
#ifdef LCC_PUBLIC_KEY_ID
	return LCC_PUBLIC_KEY_ID;
#else
	return LCC_SIGNATURE_KEY_ID_LEGACY_V200;
#endif
}

struct SignaturePublicKey {
	std::string key_id;
	std::vector<uint8_t> public_key_der;
	unsigned int bits;

	SignaturePublicKey() : bits(0) {}
	SignaturePublicKey(const std::string& key_id_value, const std::vector<uint8_t>& public_key_der_value,
					   unsigned int bits_value)
		: key_id(key_id_value), public_key_der(public_key_der_value), bits(bits_value) {}
};

inline unsigned int embedded_public_key_bits() {
#ifdef LCC_PUBLIC_KEY_BITS
	return LCC_PUBLIC_KEY_BITS;
#else
	return 0;
#endif
}

inline std::vector<uint8_t> embedded_public_key_der() {
	const uint8_t public_key[] = PUBLIC_KEY;
	return std::vector<uint8_t>(public_key, public_key + sizeof(public_key));
}

inline std::vector<SignaturePublicKey> embedded_public_key_ring() {
	std::vector<SignaturePublicKey> keys;
	keys.push_back(SignaturePublicKey(embedded_public_key_id(), embedded_public_key_der(), embedded_public_key_bits()));
#ifdef LCC_ADDITIONAL_PUBLIC_KEY_RECORDS
	const SignaturePublicKey additional_public_keys[] = {LCC_ADDITIONAL_PUBLIC_KEY_RECORDS};
	const size_t additional_count = sizeof(additional_public_keys) / sizeof(additional_public_keys[0]);
	for (size_t i = 0; i < additional_count; ++i) {
		keys.push_back(additional_public_keys[i]);
	}
#endif
	return keys;
}

inline void append_embedded_retired_key_ids(std::vector<std::string>& retired_key_ids) {
#ifdef LCC_RETIRED_PUBLIC_KEY_IDS
	const char* const retired_ids[] = {LCC_RETIRED_PUBLIC_KEY_IDS};
	const size_t retired_count = sizeof(retired_ids) / sizeof(retired_ids[0]);
	for (size_t i = 0; i < retired_count; ++i) {
		retired_key_ids.push_back(retired_ids[i]);
	}
#endif
}

inline std::vector<SignaturePublicKey> online_assertion_public_key_ring() {
#ifdef LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS
	std::vector<SignaturePublicKey> keys;
	const SignaturePublicKey online_public_keys[] = {LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS};
	const size_t online_count = sizeof(online_public_keys) / sizeof(online_public_keys[0]);
	for (size_t i = 0; i < online_count; ++i) {
		keys.push_back(online_public_keys[i]);
	}
	return keys;
#else
	return std::vector<SignaturePublicKey>();
#endif
}

inline void append_online_assertion_retired_key_ids(std::vector<std::string>& retired_key_ids) {
#ifdef LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS
	const char* const retired_ids[] = {LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS};
	const size_t retired_count = sizeof(retired_ids) / sizeof(retired_ids[0]);
	for (size_t i = 0; i < retired_count; ++i) {
		retired_key_ids.push_back(retired_ids[i]);
	}
#endif
}

inline std::vector<SignaturePublicKey> config_attestation_public_key_ring() {
#ifdef LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS
	std::vector<SignaturePublicKey> keys;
	const SignaturePublicKey config_public_keys[] = {LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS};
	const size_t config_count = sizeof(config_public_keys) / sizeof(config_public_keys[0]);
	for (size_t i = 0; i < config_count; ++i) {
		keys.push_back(config_public_keys[i]);
	}
	return keys;
#else
	return std::vector<SignaturePublicKey>();
#endif
}

inline void append_config_attestation_retired_key_ids(std::vector<std::string>& retired_key_ids) {
#ifdef LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS
	const char* const retired_ids[] = {LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS};
	const size_t retired_count = sizeof(retired_ids) / sizeof(retired_ids[0]);
	for (size_t i = 0; i < retired_count; ++i) {
		retired_key_ids.push_back(retired_ids[i]);
	}
#endif
}

struct SignatureVerificationPolicy {
	unsigned int license_version = 0;
	std::vector<std::string> allowed_algorithms;
	std::vector<std::string> allowed_key_ids;
	std::vector<std::string> retired_key_ids;
	std::vector<SignaturePublicKey> public_keys;
	bool allow_external_public_key_der = false;
	unsigned int min_public_key_bits = 0;
};

struct SignatureVerificationRequest {
	std::vector<uint8_t> payload;
	std::vector<uint8_t> signature;
	std::vector<uint8_t> public_key_der;
	std::string declared_algorithm;
	std::string key_id;
	unsigned int license_version = 0;
	SignatureVerificationPolicy policy;
};

inline SignatureVerificationPolicy legacy_v200_signature_policy() {
	SignatureVerificationPolicy policy;
	policy.license_version = 200;
	policy.allowed_algorithms.push_back(LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256);
	policy.public_keys = embedded_public_key_ring();
	for (const SignaturePublicKey& public_key : policy.public_keys) {
		policy.allowed_key_ids.push_back(public_key.key_id);
	}
	append_embedded_retired_key_ids(policy.retired_key_ids);
	return policy;
}

inline SignatureVerificationPolicy current_v201_signature_policy() {
	SignatureVerificationPolicy policy;
	policy.license_version = 201;
	policy.allowed_algorithms.push_back(LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256);
	policy.public_keys = embedded_public_key_ring();
	for (const SignaturePublicKey& public_key : policy.public_keys) {
		policy.allowed_key_ids.push_back(public_key.key_id);
	}
	append_embedded_retired_key_ids(policy.retired_key_ids);
	policy.min_public_key_bits = 3072;
	return policy;
}

inline SignatureVerificationPolicy online_assertion_signature_policy() {
	SignatureVerificationPolicy policy;
	policy.license_version = LCC_ONLINE_ASSERTION_SIGNATURE_VERSION;
	policy.allowed_algorithms.push_back(LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256);
	policy.public_keys = online_assertion_public_key_ring();
	for (const SignaturePublicKey& public_key : policy.public_keys) {
		policy.allowed_key_ids.push_back(public_key.key_id);
	}
	append_online_assertion_retired_key_ids(policy.retired_key_ids);
	policy.min_public_key_bits = 3072;
	return policy;
}

inline bool signature_contains_duplicate_strings(const std::vector<std::string>& values) {
	for (size_t i = 0; i < values.size(); ++i) {
		for (size_t j = i + 1; j < values.size(); ++j) {
			if (values[i] == values[j]) {
				return true;
			}
		}
	}
	return false;
}

inline bool signature_contains_duplicate_public_key_ids(const std::vector<SignaturePublicKey>& values) {
	for (size_t i = 0; i < values.size(); ++i) {
		for (size_t j = i + 1; j < values.size(); ++j) {
			if (values[i].key_id == values[j].key_id) {
				return true;
			}
		}
	}
	return false;
}

inline bool signature_list_contains(const std::vector<std::string>& values, const std::string& needle) {
	for (const std::string& value : values) {
		if (value == needle) {
			return true;
		}
	}
	return false;
}

inline bool signature_read_der_length(const std::vector<uint8_t>& der, size_t& offset, size_t& out_length) {
	if (offset >= der.size()) {
		return false;
	}
	const uint8_t first = der[offset++];
	if ((first & 0x80U) == 0) {
		out_length = first;
		return true;
	}
	const size_t length_bytes = first & 0x7fU;
	if (length_bytes == 0 || length_bytes > sizeof(size_t) || length_bytes > der.size() - offset ||
		der[offset] == 0) {
		return false;
	}
	size_t result = 0;
	for (size_t i = 0; i < length_bytes; ++i) {
		result = (result << 8U) | static_cast<size_t>(der[offset++]);
	}
	if (result <= 127U) {
		return false;
	}
	out_length = result;
	return true;
}

inline bool signature_read_der_integer_value(const std::vector<uint8_t>& der, size_t& offset, size_t& value_start,
											 size_t& value_length) {
	if (offset >= der.size() || der[offset++] != 0x02U) {
		return false;
	}
	size_t encoded_length = 0;
	if (!signature_read_der_length(der, offset, encoded_length) || encoded_length == 0 ||
		encoded_length > der.size() - offset) {
		return false;
	}
	value_start = offset;
	value_length = encoded_length;
	if (der[value_start] == 0U) {
		if (value_length == 1 || (der[value_start + 1] & 0x80U) == 0) {
			return false;
		}
		++value_start;
		--value_length;
	} else if ((der[value_start] & 0x80U) != 0) {
		return false;
	}
	offset += encoded_length;
	return value_length > 0;
}

inline unsigned int signature_bit_length_from_big_endian(const std::vector<uint8_t>& der, size_t value_start,
														 size_t value_length) {
	while (value_length > 0 && der[value_start] == 0U) {
		++value_start;
		--value_length;
	}
	if (value_length == 0) {
		return 0;
	}
	unsigned int high_bits = 0;
	uint8_t high = der[value_start];
	while (high != 0U) {
		++high_bits;
		high >>= 1U;
	}
	return static_cast<unsigned int>((value_length - 1U) * 8U + high_bits);
}

inline unsigned int rsa_public_key_bits_from_pkcs1_der(const std::vector<uint8_t>& public_key_der) {
	size_t offset = 0;
	if (offset >= public_key_der.size() || public_key_der[offset++] != 0x30U) {
		return 0;
	}
	size_t sequence_length = 0;
	if (!signature_read_der_length(public_key_der, offset, sequence_length) ||
		sequence_length != public_key_der.size() - offset) {
		return 0;
	}
	size_t modulus_start = 0;
	size_t modulus_length = 0;
	size_t exponent_start = 0;
	size_t exponent_length = 0;
	if (!signature_read_der_integer_value(public_key_der, offset, modulus_start, modulus_length) ||
		!signature_read_der_integer_value(public_key_der, offset, exponent_start, exponent_length) ||
		offset != public_key_der.size()) {
		return 0;
	}
	(void)exponent_start;
	(void)exponent_length;
	return signature_bit_length_from_big_endian(public_key_der, modulus_start, modulus_length);
}

inline bool signature_public_key_record_allowed(const SignaturePublicKey& public_key,
												unsigned int min_public_key_bits) {
	if (public_key.key_id.empty() || public_key.public_key_der.empty()) {
		return false;
	}
	if (public_key.key_id != public_key_id_from_der(public_key.public_key_der)) {
		return false;
	}
	const unsigned int derived_bits = rsa_public_key_bits_from_pkcs1_der(public_key.public_key_der);
	if (derived_bits == 0) {
		return false;
	}
	if (public_key.bits != 0 && public_key.bits != derived_bits) {
		return false;
	}
	return min_public_key_bits == 0 || derived_bits >= min_public_key_bits;
}

inline bool signature_public_key_ring_allowed(const SignatureVerificationPolicy& policy) {
	if (signature_contains_duplicate_public_key_ids(policy.public_keys)) {
		return false;
	}
	for (const SignaturePublicKey& public_key : policy.public_keys) {
		if (!signature_public_key_record_allowed(public_key, policy.min_public_key_bits)) {
			return false;
		}
	}
	return true;
}

inline bool signature_select_public_key_der(const SignatureVerificationRequest& request,
											std::vector<uint8_t>& selected_public_key_der) {
	if (!request.public_key_der.empty()) {
		selected_public_key_der = request.public_key_der;
		return true;
	}
	for (const SignaturePublicKey& public_key : request.policy.public_keys) {
		if (public_key.key_id == request.key_id) {
			selected_public_key_der = public_key.public_key_der;
			return !selected_public_key_der.empty();
		}
	}
	return false;
}

inline bool signature_request_allowed(const SignatureVerificationRequest& request) {
	if (request.license_version != request.policy.license_version || request.signature.empty()) {
		return false;
	}
	if (signature_contains_duplicate_strings(request.policy.allowed_algorithms) ||
		signature_contains_duplicate_strings(request.policy.allowed_key_ids) ||
		signature_contains_duplicate_strings(request.policy.retired_key_ids) ||
		!signature_public_key_ring_allowed(request.policy)) {
		return false;
	}
	if (request.declared_algorithm != LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256) {
		return false;
	}
	bool algorithm_allowed = false;
	for (const std::string& algorithm : request.policy.allowed_algorithms) {
		if (request.declared_algorithm == algorithm) {
			algorithm_allowed = true;
			break;
		}
	}
	if (!algorithm_allowed) {
		return false;
	}
	if (signature_list_contains(request.policy.retired_key_ids, request.key_id)) {
		return false;
	}
	bool key_allowed = false;
	for (const std::string& key_id : request.policy.allowed_key_ids) {
		if (request.key_id == key_id) {
			key_allowed = true;
			break;
		}
	}
	if (!key_allowed) {
		return false;
	}
	if (!request.public_key_der.empty()) {
		if (!request.policy.allow_external_public_key_der) {
			return false;
		}
		if (request.key_id != public_key_id_from_der(request.public_key_der)) {
			return false;
		}
	}
	std::vector<uint8_t> selected_public_key_der;
	if (!signature_select_public_key_der(request, selected_public_key_der)) {
		return false;
	}
	if (request.policy.min_public_key_bits > 0) {
		const unsigned int public_key_bits = rsa_public_key_bits_from_pkcs1_der(selected_public_key_der);
		if (public_key_bits < request.policy.min_public_key_bits) {
			return false;
		}
	}
	return true;
}

FUNCTION_RETURN verify_signature(const SignatureVerificationRequest& request);
FUNCTION_RETURN verify_signature(const std::string& stringToVerify, const std::string& signatureB64);
}
} /* namespace license */

#endif /* SRC_LIBRARY_OS_VERIFIER_HPP_ */
