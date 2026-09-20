#ifndef LICENSECC_TEST_BOUND_SESSION_SIGNER_HPP_
#define LICENSECC_TEST_BOUND_SESSION_SIGNER_HPP_
#include "bound_encoding.hpp"
#include "bound_session.hpp"
#include <boost/test/unit_test.hpp>
#include <cstring>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <bcrypt.h>
#else
#include <openssl/evp.h>
#include <openssl/rsa.h>
#include <openssl/x509.h>
#endif

// Ephemeral test-only RSA signer. No private key is serialized or retained.
class SessionTestSigner {
	using Bytes = std::vector<std::uint8_t>;
#ifdef _WIN32
	BCRYPT_KEY_HANDLE key_ = nullptr;
	static Bytes tlv(std::uint8_t tag, const Bytes& data) {
		Bytes out{tag};
		if (data.size() < 128)
			out.push_back(static_cast<std::uint8_t>(data.size()));
		else if (data.size() < 256) {
			out.push_back(0x81);
			out.push_back(static_cast<std::uint8_t>(data.size()));
		} else {
			out.push_back(0x82);
			out.push_back(static_cast<std::uint8_t>(data.size() >> 8));
			out.push_back(static_cast<std::uint8_t>(data.size()));
		}
		out.insert(out.end(), data.begin(), data.end());
		return out;
	}
	static Bytes integer(Bytes data) {
		if (data.front() & 0x80) data.insert(data.begin(), 0);
		return tlv(2, data);
	}
#else
	EVP_PKEY* key_ = nullptr;
#endif
public:
	Bytes spki;
	SessionTestSigner() {
#ifdef _WIN32
		BCRYPT_ALG_HANDLE algorithm = nullptr;
		BOOST_REQUIRE_EQUAL(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_RSA_ALGORITHM, nullptr, 0), 0);
		const auto generated = BCryptGenerateKeyPair(algorithm, &key_, 3072, 0);
		BCryptCloseAlgorithmProvider(algorithm, 0);
		BOOST_REQUIRE_EQUAL(generated, 0);
		BOOST_REQUIRE_EQUAL(BCryptFinalizeKeyPair(key_, 0), 0);
		ULONG count = 0;
		BOOST_REQUIRE_EQUAL(BCryptExportKey(key_, nullptr, BCRYPT_RSAPUBLIC_BLOB, nullptr, 0, &count, 0), 0);
		Bytes blob(count);
		BOOST_REQUIRE_EQUAL(BCryptExportKey(key_, nullptr, BCRYPT_RSAPUBLIC_BLOB, blob.data(), count, &count, 0), 0);
		BCRYPT_RSAKEY_BLOB header;
		std::memcpy(&header, blob.data(), sizeof(header));
		const auto start = blob.begin() + sizeof(header);
		auto rsa = integer(Bytes(start + header.cbPublicExp, start + header.cbPublicExp + header.cbModulus));
		auto exponent = integer(Bytes(start, start + header.cbPublicExp));
		rsa.insert(rsa.end(), exponent.begin(), exponent.end());
		rsa = tlv(0x30, rsa);
		rsa.insert(rsa.begin(), 0);
		const auto bits = tlv(3, rsa);
		Bytes body{0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00};
		body.insert(body.end(), bits.begin(), bits.end());
		spki = tlv(0x30, body);
#else
		std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> context(EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, nullptr),
																			EVP_PKEY_CTX_free);
		BOOST_REQUIRE(context);
		BOOST_REQUIRE_GT(EVP_PKEY_keygen_init(context.get()), 0);
		BOOST_REQUIRE_GT(EVP_PKEY_CTX_set_rsa_keygen_bits(context.get(), 3072), 0);
		BOOST_REQUIRE_GT(EVP_PKEY_keygen(context.get(), &key_), 0);
		const int size = i2d_PUBKEY(key_, nullptr);
		BOOST_REQUIRE_GT(size, 0);
		spki.resize(static_cast<std::size_t>(size));
		auto* output = spki.data();
		BOOST_REQUIRE_EQUAL(i2d_PUBKEY(key_, &output), size);
#endif
	}
	~SessionTestSigner() {
#ifdef _WIN32
		if (key_) BCryptDestroyKey(key_);
#else
		EVP_PKEY_free(key_);
#endif
	}
	SessionTestSigner(const SessionTestSigner&) = delete;
	SessionTestSigner& operator=(const SessionTestSigner&) = delete;
	std::string sign(const std::string& payload) {
		using namespace license::device_identity;
		const auto message = std::string("lccdl1.") + payload;
		P256Digest digest;
		BOOST_REQUIRE(sha256(reinterpret_cast<const std::uint8_t*>(message.data()), message.size(), digest));
		Bytes signature(384);
#ifdef _WIN32
		BCRYPT_PKCS1_PADDING_INFO padding{BCRYPT_SHA256_ALGORITHM};
		ULONG written = 0;
		BOOST_REQUIRE_EQUAL(BCryptSignHash(key_, &padding, digest.data(), static_cast<ULONG>(digest.size()),
										   signature.data(), 384, &written, BCRYPT_PAD_PKCS1),
							0);
		BOOST_REQUIRE_EQUAL(written, 384U);
#else
		std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> context(EVP_PKEY_CTX_new(key_, nullptr),
																			EVP_PKEY_CTX_free);
		BOOST_REQUIRE(context);
		BOOST_REQUIRE_GT(EVP_PKEY_sign_init(context.get()), 0);
		BOOST_REQUIRE_GT(EVP_PKEY_CTX_set_rsa_padding(context.get(), RSA_PKCS1_PADDING), 0);
		BOOST_REQUIRE_GT(EVP_PKEY_CTX_set_signature_md(context.get(), EVP_sha256()), 0);
		std::size_t size = signature.size();
		BOOST_REQUIRE_GT(EVP_PKEY_sign(context.get(), signature.data(), &size, digest.data(), digest.size()), 0);
		BOOST_REQUIRE_EQUAL(size, 384U);
#endif
		return "lccdl1." + bound_encoding::base64url(payload) + "." +
			   bound_encoding::base64url(std::string(signature.begin(), signature.end()));
	}
	std::string lease(const license::device_identity::BoundSessionContext& context, const std::string& operation,
					  std::uint64_t revision = 1, std::uint64_t duration = 86400) {
		using namespace license::device_identity;
		P256Digest hash;
		BOOST_REQUIRE(sha256(spki.data(), spki.size(), hash));
		const auto& e = context.lease;
		std::string payload = "version=1\n";
		const auto text = [&](const char* field, const std::string& value) {
			payload += std::string(field) + '=' + bound_encoding::base64url(value) + '\n';
		};
		const auto number = [&](const char* field, std::uint64_t value) {
			payload += std::string(field) + '=' + std::to_string(value) + '\n';
		};
		text("purpose", "device-lease");
		text("key-id", "sha256:" + lowercase_hex(hash.data(), hash.size()));
		text("issuer", e.issuer);
		text("audience", e.audience);
		text("project", e.project);
		text("feature", e.feature);
		text("license-fingerprint", e.license_fingerprint);
		text("binding-id", e.binding_id);
		text("device-key-id", e.device_key_id);
		number("generation", e.generation);
		number("revocation-seq", revision);
		text("lease-id", std::string(22, 'A'));
		text("operation-id", operation);
		number("issued-at", 2000000000);
		number("renew-after", 2000000000 + duration / 2);
		number("expires-at", 2000000000 + duration);
		return sign(payload);
	}
};
#endif
