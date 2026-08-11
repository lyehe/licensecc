#define BOOST_TEST_MODULE test_rsa_interop

#include <boost/test/unit_test.hpp>

#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "../src/base_lib/base64.h"
#include "../src/base_lib/crypto_helper.hpp"

#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>

namespace {

static size_t read_der_length(const std::vector<unsigned char>& data, size_t& offset) {
	if (offset >= data.size()) {
		throw std::runtime_error("truncated DER length");
	}
	const unsigned char first = data[offset++];
	if ((first & 0x80U) == 0U) {
		return first;
	}
	const size_t count = first & 0x7fU;
	if (count == 0U || count > sizeof(size_t) || offset + count > data.size() || data[offset] == 0U) {
		throw std::runtime_error("invalid DER length");
	}
	size_t length = 0U;
	for (size_t i = 0U; i < count; ++i) {
		length = (length << 8U) | data[offset++];
	}
	if (length <= 127U) {
		throw std::runtime_error("noncanonical DER length");
	}
	return length;
}

static std::vector<unsigned char> read_positive_integer(const std::vector<unsigned char>& data, size_t& offset) {
	if (offset >= data.size() || data[offset++] != 0x02U) {
		throw std::runtime_error("expected DER INTEGER");
	}
	const size_t length = read_der_length(data, offset);
	if (length == 0U || offset + length > data.size()) {
		throw std::runtime_error("truncated DER INTEGER");
	}
	if (data[offset] == 0U) {
		if (length == 1U || (data[offset + 1U] & 0x80U) == 0U) {
			throw std::runtime_error("noncanonical DER INTEGER");
		}
		++offset;
		const size_t positive_length = length - 1U;
		std::vector<unsigned char> value(data.begin() + offset, data.begin() + offset + positive_length);
		offset += positive_length;
		return value;
	}
	if ((data[offset] & 0x80U) != 0U) {
		throw std::runtime_error("negative DER INTEGER");
	}
	std::vector<unsigned char> value(data.begin() + offset, data.begin() + offset + length);
	offset += length;
	return value;
}

static bool verify_with_independent_cng_import(const std::vector<unsigned char>& der, const std::string& payload,
											const std::string& signature_base64) {
	size_t offset = 0U;
	if (der.empty() || der[offset++] != 0x30U) {
		throw std::runtime_error("expected RSA public-key DER SEQUENCE");
	}
	const size_t sequence_length = read_der_length(der, offset);
	if (offset + sequence_length != der.size()) {
		throw std::runtime_error("invalid RSA public-key DER SEQUENCE");
	}
	const std::vector<unsigned char> modulus = read_positive_integer(der, offset);
	const std::vector<unsigned char> exponent = read_positive_integer(der, offset);
	if (offset != der.size() || modulus.empty() || exponent.empty()) {
		throw std::runtime_error("invalid RSA public-key DER fields");
	}

	BCRYPT_RSAKEY_BLOB header{};
	header.Magic = BCRYPT_RSAPUBLIC_MAGIC;
	header.BitLength = static_cast<ULONG>(modulus.size() * 8U);
	header.cbPublicExp = static_cast<ULONG>(exponent.size());
	header.cbModulus = static_cast<ULONG>(modulus.size());
	std::vector<unsigned char> blob(sizeof(header) + exponent.size() + modulus.size());
	std::memcpy(blob.data(), &header, sizeof(header));
	std::memcpy(blob.data() + sizeof(header), exponent.data(), exponent.size());
	std::memcpy(blob.data() + sizeof(header) + exponent.size(), modulus.data(), modulus.size());

	BCRYPT_ALG_HANDLE rsa_algorithm = nullptr;
	BCRYPT_KEY_HANDLE public_key = nullptr;
	BCRYPT_ALG_HANDLE sha_algorithm = nullptr;
	BCRYPT_HASH_HANDLE hash = nullptr;
	bool verified = false;
	try {
		if (BCryptOpenAlgorithmProvider(&rsa_algorithm, BCRYPT_RSA_ALGORITHM, nullptr, 0) < 0 ||
			BCryptImportKeyPair(rsa_algorithm, nullptr, BCRYPT_RSAPUBLIC_BLOB, &public_key, blob.data(),
								 static_cast<ULONG>(blob.size()), 0) < 0 ||
			BCryptOpenAlgorithmProvider(&sha_algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) {
			throw std::runtime_error("CNG public-key import failed");
		}
		DWORD object_length = 0U;
		DWORD result_length = 0U;
		DWORD hash_length = 0U;
		if (BCryptGetProperty(sha_algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_length),
							 sizeof(object_length), &result_length, 0) < 0 ||
			BCryptGetProperty(sha_algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_length), sizeof(hash_length),
							 &result_length, 0) < 0) {
			throw std::runtime_error("CNG hash setup failed");
		}
		std::vector<unsigned char> hash_object(object_length);
		std::vector<unsigned char> digest(hash_length);
		if (BCryptCreateHash(sha_algorithm, &hash, hash_object.data(), static_cast<ULONG>(hash_object.size()), nullptr, 0,
						  0) < 0 ||
			BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(payload.data())),
						   static_cast<ULONG>(payload.size()), 0) < 0 ||
			BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
			throw std::runtime_error("CNG SHA-256 operation failed");
		}
		const std::vector<uint8_t> signature = license::unbase64(signature_base64);
		if (signature.empty()) {
			throw std::runtime_error("generator returned invalid base64 signature");
		}
		BCRYPT_PKCS1_PADDING_INFO padding{};
		padding.pszAlgId = BCRYPT_SHA256_ALGORITHM;
		verified = BCryptVerifySignature(public_key, &padding, digest.data(), static_cast<ULONG>(digest.size()),
								  const_cast<PUCHAR>(reinterpret_cast<const UCHAR*>(signature.data())),
								  static_cast<ULONG>(signature.size()), BCRYPT_PAD_PKCS1) >= 0;
	} catch (...) {
		if (hash != nullptr) BCryptDestroyHash(hash);
		if (sha_algorithm != nullptr) BCryptCloseAlgorithmProvider(sha_algorithm, 0);
		if (public_key != nullptr) BCryptDestroyKey(public_key);
		if (rsa_algorithm != nullptr) BCryptCloseAlgorithmProvider(rsa_algorithm, 0);
		throw;
	}
	if (hash != nullptr) BCryptDestroyHash(hash);
	if (sha_algorithm != nullptr) BCryptCloseAlgorithmProvider(sha_algorithm, 0);
	if (public_key != nullptr) BCryptDestroyKey(public_key);
	if (rsa_algorithm != nullptr) BCryptCloseAlgorithmProvider(rsa_algorithm, 0);
	return verified;
}

}  // namespace

BOOST_AUTO_TEST_CASE(rsa_3072_and_4096_der_and_signature_interoperate_with_cng_public_import) {
	const std::string payload("licensecc generator RSA interoperability payload");
	for (const size_t bits : {static_cast<size_t>(3072), static_cast<size_t>(4096)}) {
		std::unique_ptr<license::CryptoHelper> crypto(license::CryptoHelper::getInstance());
		crypto->generateKeyPair(bits);
		const std::vector<unsigned char> der = crypto->exportPublicKey();
		BOOST_CHECK_MESSAGE(verify_with_independent_cng_import(der, payload, crypto->signString(payload)),
						"RSA-" + std::to_string(bits) + " DER/signature interoperates with a fresh CNG public-key import");
	}
}
#else
BOOST_AUTO_TEST_CASE(rsa_3072_and_4096_der_and_signature_interoperate_with_cng_public_import) {
	BOOST_TEST_MESSAGE("Windows CNG interoperability is exercised on Windows; run this test on an OpenSSL host separately.");
}
#endif
