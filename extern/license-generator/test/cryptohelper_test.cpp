#define BOOST_TEST_MODULE test_cryptohelper

#include <boost/test/unit_test.hpp>
#include <boost/filesystem.hpp>
#include <boost/algorithm/string.hpp>
#include <iostream>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <boost/filesystem.hpp>

#include <build_properties.h>
#include "../src/base_lib/base64.h"
#include "../src/base_lib/crypto_helper.hpp"
#include "../src/base_lib/base.h"
#define SIGNATURE                                          \
	"0pBQSdgwE6amOQJ1T+byZhJetVl86OWLHC+ICJ/IENVoNqcJF2pD" \
	"aoRuNtDEq5v/lqmQbQJg4d08VtRCen3Q3VuUrge2e7hQ3ktkkK8"  \
	"DwTtUJA+pcB540sofcdbXabF+L+vwmj5jUWsamJzp/fhg8xpQ72L54UzjcbKsGVgsc2Y="
#define PUBKEY                                                                                                         \
	{                                                                                                                  \
		48, 129, 137, 2, 129, 129, 0, 242, 27, 37, 44, 100, 25, 53, 107, 167, 151, 101, 105, 53, 119, 68, 227, 137,    \
			62, 246, 187, 227, 178, 59, 225, 20, 142, 0, 56, 55, 116, 45, 49, 162, 188, 82, 33, 155, 220, 4, 169, 49,  \
			33, 41, 65, 178, 196, 44, 191, 232, 167, 5, 94, 182, 158, 245, 5, 116, 79, 247, 201, 162, 218, 114, 209,   \
			244, 247, 215, 73, 89, 239, 242, 161, 210, 117, 236, 188, 216, 193, 212, 143, 58, 153, 6, 213, 171, 39,    \
			166, 127, 48, 234, 167, 232, 161, 212, 66, 141, 198, 93, 235, 88, 210, 38, 172, 25, 109, 107, 153, 133, 0, \
			231, 128, 203, 216, 110, 161, 24, 230, 50, 152, 74, 215, 115, 246, 146, 152, 193, 20, 209, 2, 3, 1, 0, 1   \
	}

namespace fs = boost::filesystem;
using namespace license;
using namespace std;

namespace test {

const std::string loadPrivateKey() {
	fs::path pkf = fs::path(PROJECT_TEST_SRC_DIR) / "data" / PRIVATE_KEY_FNAME;
	std::ifstream private_key_linux(pkf.string());
	BOOST_REQUIRE_MESSAGE(private_key_linux.good(), "test file found");
	const std::string pk_str((std::istreambuf_iterator<char>(private_key_linux)), std::istreambuf_iterator<char>());
	return pk_str;
}

BOOST_AUTO_TEST_CASE(test_generate_and_sign) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair();
	const string privateK = crypto->exportPrivateKey();
	const string private_key_header = "-----BEGIN RSA " "PRIVATE KEY-----";
	BOOST_CHECK_MESSAGE(boost::starts_with(privateK, private_key_header),
						"Private key is in openssl pkcs#1 format");
	const std::string signature = crypto->signString("testString");
	BOOST_CHECK_MESSAGE(signature.size() == 512, "default generated signature uses RSA-3072");
	crypto.release();
	/*
	 ofstream myfile("private_key-linux.rsa");
	 myfile << privateK;
	 myfile.close();*/
}

/**
 * Import a private key, export it again and check imported and exported are equal
 */
BOOST_AUTO_TEST_CASE(test_load_and_export_private) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	const std::string pk_str = loadPrivateKey();
	crypto->loadPrivateKey(pk_str);
	std::string pk_exported = crypto->exportPrivateKey();
	unique_ptr<CryptoHelper> exported_crypto(CryptoHelper::getInstance());
	exported_crypto->loadPrivateKey(pk_exported);
	const vector<unsigned char> original_pubkey = crypto->exportPublicKey();
	const vector<unsigned char> exported_pubkey = exported_crypto->exportPublicKey();
	BOOST_CHECK_EQUAL_COLLECTIONS(original_pubkey.begin(), original_pubkey.end(), exported_pubkey.begin(),
								  exported_pubkey.end());
	crypto.release();
}

BOOST_AUTO_TEST_CASE(test_load_and_export_public_key) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	const vector<unsigned char> expected_pubkey(PUBKEY);
	const std::string pk_str = loadPrivateKey();
	crypto->loadPrivateKey(pk_str);
	vector<unsigned char> pk_exported = crypto->exportPublicKey();

	/*
	 for (auto it : pk_exported) {
	 cout << ((int)it) << ",";
	 }
	 ofstream myfile("public_key.rsa");
	 for (auto it : pk_exported) {
	 myfile << it;
	 }
	 myfile.close();*/
	BOOST_CHECK_MESSAGE(expected_pubkey.size() == pk_exported.size(), "exported key and expected are the same size");
	BOOST_CHECK_MESSAGE(std::equal(expected_pubkey.begin(), expected_pubkey.end(), pk_exported.begin()),
						"exported key and expected have the same content");
	crypto.release();
}

BOOST_AUTO_TEST_CASE(test_load_and_sign) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	const std::string pk_str = loadPrivateKey();
	crypto->loadPrivateKey(pk_str);
	const std::string signature = crypto->signString("testString");
	BOOST_CHECK_MESSAGE(signature.size() == 172, "signature is the right size");
	BOOST_CHECK_MESSAGE(signature == SIGNATURE, "signature is repeatable");
	crypto.release();
}

BOOST_AUTO_TEST_CASE(test_generate_export_import_and_sign) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair();
	const string pk = crypto->exportPrivateKey();
	crypto->loadPrivateKey(pk);
	const string signature = crypto->signString("testString");
	// 3072-bit RSA signatures are 384 bytes, base64 encoded without newlines.
	BOOST_CHECK_MESSAGE(signature.size() == 512, "default generated signature uses RSA-3072");
	crypto.release();
}

BOOST_AUTO_TEST_CASE(test_generate_legacy_rsa1024_requires_explicit_size) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair(1024);
	const string pk = crypto->exportPrivateKey();
	crypto->loadPrivateKey(pk);
	const string signature = crypto->signString("testString");
	BOOST_CHECK_MESSAGE(signature.size() == 172, "explicit legacy RSA-1024 signature is still supported");
	crypto.release();
}

BOOST_AUTO_TEST_CASE(test_load_private_key_error_does_not_leak_key_material) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	const string invalid_private_key =
		"-----BEGIN RSA " "PRIVATE KEY-----\n"
		"not-a-valid-private-key\n"
		"-----END RSA " "PRIVATE KEY-----\n";

	try {
		crypto->loadPrivateKey(invalid_private_key);
		BOOST_FAIL("Invalid private key should not load");
	} catch (const std::exception &ex) {
		const string error_message = ex.what();
		BOOST_CHECK_MESSAGE(!error_message.empty(), "Error should identify private key loading failure");
		BOOST_CHECK_EQUAL(error_message.find(invalid_private_key), string::npos);
		BOOST_CHECK_EQUAL(error_message.find("not-a-valid-private-key"), string::npos);
	}
}

BOOST_AUTO_TEST_CASE(test_base64_rejects_invalid_input) {
	BOOST_CHECK(unbase64("").empty());
	BOOST_CHECK(unbase64("A").empty());
	BOOST_CHECK(unbase64("AA").empty());
	BOOST_CHECK(unbase64("AAA").empty());
	BOOST_CHECK(unbase64("!!!!").empty());
	BOOST_CHECK(unbase64("AA=A").empty());
	BOOST_CHECK(unbase64("AAAA====").empty());
	BOOST_CHECK(unbase64("AAAA-").empty());
	BOOST_CHECK(unbase64("AAAA ").empty());
	BOOST_CHECK(unbase64("AAAA\t").empty());

	const string high_bit_input = string("AAA") + static_cast<char>(0x80);
	BOOST_CHECK(unbase64(high_bit_input).empty());

	const string embedded_nul_input(string("AA", 2) + string(1, '\0') + string("A", 1));
	BOOST_CHECK(unbase64(embedded_nul_input).empty());
}

BOOST_AUTO_TEST_CASE(test_base64_rejects_noncanonical_pad_bits) {
	BOOST_CHECK(unbase64("QR==").empty());
	BOOST_CHECK(unbase64("QUF=").empty());
}

BOOST_AUTO_TEST_CASE(test_base64_decodes_padded_input) {
	const vector<uint8_t> one_byte = unbase64("QQ==");
	BOOST_REQUIRE_EQUAL(one_byte.size(), 1);
	BOOST_CHECK_EQUAL(one_byte[0], static_cast<uint8_t>('A'));

	const vector<uint8_t> one_byte_with_line_endings = unbase64("Q\r\nQ==");
	BOOST_REQUIRE_EQUAL(one_byte_with_line_endings.size(), 1);
	BOOST_CHECK_EQUAL(one_byte_with_line_endings[0], static_cast<uint8_t>('A'));

	const vector<uint8_t> one_byte_with_outer_line_endings = unbase64("\r\nQQ==\r\n");
	BOOST_REQUIRE_EQUAL(one_byte_with_outer_line_endings.size(), 1);
	BOOST_CHECK_EQUAL(one_byte_with_outer_line_endings[0], static_cast<uint8_t>('A'));

	const vector<uint8_t> two_bytes = unbase64("QUE=");
	BOOST_REQUIRE_EQUAL(two_bytes.size(), 2);
	BOOST_CHECK_EQUAL(two_bytes[0], static_cast<uint8_t>('A'));
	BOOST_CHECK_EQUAL(two_bytes[1], static_cast<uint8_t>('A'));
}

BOOST_AUTO_TEST_CASE(test_canonical_base64_policy_matches_decoder) {
	BOOST_CHECK(is_canonical_base64("QQ=="));
	BOOST_CHECK(is_canonical_base64("Q\r\nQ=="));
	BOOST_CHECK(!is_canonical_base64("Q\r\nQ==", false));
	BOOST_CHECK(!is_canonical_base64(""));
	BOOST_CHECK(!is_canonical_base64("QR=="));
	BOOST_CHECK(!is_canonical_base64("QUF="));
	BOOST_CHECK(!is_canonical_base64("AAAA "));
}

BOOST_AUTO_TEST_CASE(test_base64_round_trip_large_binary_input) {
	vector<uint8_t> data(1024 * 1024);
	for (size_t i = 0; i < data.size(); ++i) {
		data[i] = static_cast<uint8_t>((i * 131U + 17U) & 0xffU);
	}
	const string encoded = base64(data.data(), data.size(), 0);
	BOOST_CHECK(is_canonical_base64(encoded, false));
	const vector<uint8_t> decoded = unbase64(encoded);
	BOOST_CHECK_EQUAL_COLLECTIONS(data.begin(), data.end(), decoded.begin(), decoded.end());
}

BOOST_AUTO_TEST_CASE(test_base64_encodes_short_inputs) {
	const vector<uint8_t> empty;
	BOOST_CHECK_EQUAL(base64(empty.data(), empty.size()), "");
	BOOST_CHECK_EQUAL(base64(empty.data(), empty.size(), 5), "");

	const vector<uint8_t> one_byte = {0x00};
	BOOST_CHECK_EQUAL(base64(one_byte.data(), one_byte.size()), "AA==\n");
	BOOST_CHECK_EQUAL(base64(one_byte.data(), one_byte.size(), 0), "AA==");
	BOOST_CHECK_EQUAL(base64(one_byte.data(), one_byte.size(), 5), "AA==\n");

	const vector<uint8_t> two_bytes = {0x00, 0xff};
	BOOST_CHECK_EQUAL(base64(two_bytes.data(), two_bytes.size()), "AP8=\n");
	BOOST_CHECK_EQUAL(base64(two_bytes.data(), two_bytes.size(), 0), "AP8=");
	BOOST_CHECK_EQUAL(base64(two_bytes.data(), two_bytes.size(), 5), "AP8=\n");
}
}  // namespace test
