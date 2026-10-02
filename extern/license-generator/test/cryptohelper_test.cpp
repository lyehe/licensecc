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
// Golden values for the 3072-bit fixture key at test/data/private_key_3072.rsa: its PKCS#1 public
// key and its RSASSA-PKCS1-v1_5 SHA-256 signature of "testString".
#define SIGNATURE \
	"IyzVW3vqXtmqj0uBe8jKjkr61DEamvIOD0wOCDlSi2RaO/soZBqQf9olxBbm7ZtOrWqJxp/llTxe" \
	"ST3RhBB5QOeD0e3nc5jnBA+hX1TH3KvU+WxcKgTAvFby52hP8MA700VQ9cdRONpI1XxqOP7HSPNh" \
	"I8h+JuCsHdeeA3ODFO1X8JQlOdoGmjxIIMuqkGFcyADPbQocikVg6XoyIfmMI5d7kG7VjnHfGb3y" \
	"N0/YObKwD2d25edSjYD5mrTnbAFTAlcOS0kI+psRVDYoRfdNn6G6wDYI7JfuwSKacUJOVQSqWJfZ" \
	"0RnQ6kxbv1BZ9z7kiPizWVbXsVAlMM76RrnLFWI1M9//x8bbP8Cn6mynBcXPQSq+UJZzjZ2a+oxG" \
	"0/8YmM9BFRNFuhE3dGtNrFaP000K3vPhJQGduZj9xypHjjcJ0gPBntQW8CUu8NQvrWBmL/87AABk" \
	"wWj2zzEgc8L8dg514kkKN80wAVmX/uw0CuvP0L6GYtcWDLCDFIdL4AWo"
#define PUBKEY \
	{ \
		48, 130, 1, 138, 2, 130, 1, 129, 0, 194, 91, 228, 139, 41, 230, 251, 246, 184, 189, 139, 32, 67, 89, 72, \
		177, 241, 216, 116, 213, 250, 84, 90, 136, 175, 222, 9, 165, 59, 47, 116, 200, 2, 176, 107, 60, 194, 149, 67, \
		88, 107, 227, 115, 214, 245, 190, 31, 99, 140, 97, 252, 135, 193, 131, 214, 218, 113, 194, 153, 173, 151, 121, 16, \
		194, 151, 174, 177, 99, 142, 178, 41, 200, 18, 183, 255, 90, 253, 158, 243, 195, 182, 64, 21, 23, 198, 64, 11, \
		109, 178, 154, 40, 7, 91, 180, 35, 175, 223, 174, 211, 101, 13, 220, 141, 12, 43, 247, 69, 176, 186, 174, 31, \
		238, 79, 57, 118, 236, 237, 72, 89, 58, 178, 3, 126, 152, 203, 143, 125, 216, 248, 122, 3, 164, 252, 35, 168, \
		109, 242, 218, 77, 200, 112, 98, 155, 125, 110, 82, 83, 125, 73, 38, 76, 65, 0, 90, 111, 47, 224, 186, 182, \
		7, 60, 228, 127, 138, 24, 164, 187, 129, 162, 60, 253, 11, 190, 58, 189, 223, 188, 20, 187, 4, 157, 123, 209, \
		163, 20, 67, 200, 144, 85, 51, 99, 251, 48, 188, 15, 241, 145, 248, 215, 104, 67, 2, 154, 98, 219, 198, 238, \
		18, 213, 153, 96, 210, 176, 72, 225, 49, 64, 131, 121, 107, 67, 163, 5, 115, 207, 120, 249, 251, 76, 42, 60, \
		128, 103, 131, 193, 206, 190, 85, 205, 169, 119, 191, 200, 162, 214, 43, 107, 249, 93, 171, 16, 72, 104, 7, 197, \
		198, 79, 35, 134, 104, 89, 83, 195, 83, 51, 30, 92, 43, 173, 53, 117, 71, 117, 4, 180, 100, 175, 132, 198, \
		123, 54, 156, 34, 245, 211, 85, 60, 240, 254, 52, 159, 157, 37, 138, 135, 50, 172, 45, 4, 172, 230, 222, 21, \
		17, 26, 149, 168, 181, 142, 167, 67, 83, 16, 138, 53, 83, 136, 180, 128, 20, 147, 186, 130, 194, 26, 239, 147, \
		22, 115, 167, 143, 217, 25, 158, 36, 76, 166, 255, 250, 242, 128, 166, 190, 14, 106, 55, 142, 244, 235, 30, 228, \
		37, 153, 163, 238, 167, 117, 158, 183, 28, 133, 28, 11, 46, 232, 119, 214, 181, 29, 29, 2, 221, 247, 110, 138, \
		205, 187, 160, 27, 254, 100, 209, 87, 141, 2, 3, 1, 0, 1 \
	}

namespace fs = boost::filesystem;
using namespace license;
using namespace std;

namespace test {

const std::string loadPrivateKey() {
	fs::path pkf = fs::path(PROJECT_TEST_SRC_DIR) / "data" / "private_key_3072.rsa";
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
}

BOOST_AUTO_TEST_CASE(test_load_and_sign) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	const std::string pk_str = loadPrivateKey();
	crypto->loadPrivateKey(pk_str);
	const std::string signature = crypto->signString("testString");
	// 3072-bit RSA signatures are 384 bytes, base64 encoded without newlines.
	BOOST_CHECK_MESSAGE(signature.size() == 512, "signature is the right size");
	BOOST_CHECK_MESSAGE(signature == SIGNATURE, "signature is repeatable");
}

BOOST_AUTO_TEST_CASE(test_generate_export_import_and_sign) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair();
	const string pk = crypto->exportPrivateKey();
	crypto->loadPrivateKey(pk);
	const string signature = crypto->signString("testString");
	// 3072-bit RSA signatures are 384 bytes, base64 encoded without newlines.
	BOOST_CHECK_MESSAGE(signature.size() == 512, "default generated signature uses RSA-3072");
}

// CryptoHelper::generateKeyPair(size_t) has no floor of its own -- only the
// generator CLI's project init and License::write_license() enforce one --
// so an explicit smaller size, such as the one Project(..., 1024) still
// relies on for fast test fixtures, must keep working at this level.
BOOST_AUTO_TEST_CASE(test_generate_with_explicit_key_size_below_the_default) {
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->generateKeyPair(1024);
	const string pk = crypto->exportPrivateKey();
	crypto->loadPrivateKey(pk);
	const string signature = crypto->signString("testString");
	BOOST_CHECK_MESSAGE(signature.size() == 172, "an explicit 1024-bit key still signs successfully");
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
