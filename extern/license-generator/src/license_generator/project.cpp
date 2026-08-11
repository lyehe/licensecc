/*
 * Project.cpp
 *
 *  Created on: Oct 22, 2019
 *      Author: GC
 */

#include <boost/algorithm/string/replace.hpp>
#include <boost/filesystem.hpp>
#include <boost/version.hpp>
#include <cstdint>
#include <cctype>
#include <fstream>
#include <iomanip>
#include <stdexcept>
#include <algorithm>
#include <sstream>

#include "../inja/inja.hpp"
#include "../base_lib/base.h"
#include "../base_lib/crypto_helper.hpp"
#include "file_publish.hpp"
#include "project.hpp"

namespace license {
namespace fs = boost::filesystem;
using json = nlohmann::json;
using namespace inja;
using namespace std;

static const constexpr char *const TEMPLATE = "public_key.inja";

static size_t read_der_length(const vector<unsigned char> &data, size_t &offset) {
	if (offset >= data.size()) {
		throw runtime_error("Invalid RSA public key DER length");
	}
	const unsigned char first = data[offset++];
	if ((first & 0x80U) == 0) {
		return first;
	}
	const size_t length_bytes = first & 0x7fU;
	if (length_bytes == 0 || length_bytes > sizeof(size_t) || offset + length_bytes > data.size() ||
		data[offset] == 0) {
		throw runtime_error("Invalid RSA public key DER length");
	}
	size_t length = 0;
	for (size_t i = 0; i < length_bytes; ++i) {
		length = (length << 8U) | data[offset++];
	}
	if (length <= 127U) {
		throw runtime_error("Invalid RSA public key DER length");
	}
	return length;
}

static void require_der_tag(const vector<unsigned char> &data, size_t &offset, unsigned char tag) {
	if (offset >= data.size() || data[offset] != tag) {
		throw runtime_error("Unexpected RSA public key DER tag");
	}
	++offset;
}

static size_t rsa_public_key_bits(const vector<unsigned char> &public_key_der) {
	size_t offset = 0;
	require_der_tag(public_key_der, offset, 0x30U);
	const size_t sequence_len = read_der_length(public_key_der, offset);
	if (offset + sequence_len != public_key_der.size()) {
		throw runtime_error("Invalid RSA public key DER sequence length");
	}
	require_der_tag(public_key_der, offset, 0x02U);
	size_t modulus_len = read_der_length(public_key_der, offset);
	if (modulus_len == 0 || offset + modulus_len > public_key_der.size()) {
		throw runtime_error("Invalid RSA public key modulus length");
	}
	if (public_key_der[offset] == 0U) {
		if (modulus_len == 1U || (public_key_der[offset + 1U] & 0x80U) == 0U) {
			throw runtime_error("Invalid RSA public key modulus encoding");
		}
		++offset;
		--modulus_len;
	} else if ((public_key_der[offset] & 0x80U) != 0U) {
		throw runtime_error("Invalid RSA public key modulus encoding");
	}
	while (modulus_len > 0U && public_key_der[offset] == 0U) {
		++offset;
		--modulus_len;
	}
	if (modulus_len == 0U) {
		throw runtime_error("Invalid RSA public key modulus");
	}
	unsigned char first = public_key_der[offset];
	size_t first_bits = 0;
	while (first != 0U) {
		++first_bits;
		first >>= 1U;
	}
	const size_t bits = ((modulus_len - 1U) * 8U) + first_bits;
	offset += modulus_len;
	require_der_tag(public_key_der, offset, 0x02U);
	const size_t exponent_len = read_der_length(public_key_der, offset);
	if (exponent_len == 0U || offset + exponent_len != public_key_der.size() || public_key_der[offset] == 0U ||
		(public_key_der[offset] & 0x80U) != 0U) {
		throw runtime_error("Invalid RSA public key exponent");
	}
	return bits;
}

static uint32_t sha256_rotr(uint32_t value, uint32_t bits) {
	return (value >> bits) | (value << (32U - bits));
}

static string sha256_hex(const vector<unsigned char> &data) {
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
	vector<unsigned char> message(data);
	const uint64_t bit_length = static_cast<uint64_t>(message.size()) * 8U;
	message.push_back(0x80U);
	while ((message.size() % 64U) != 56U) {
		message.push_back(0U);
	}
	for (int shift = 56; shift >= 0; shift -= 8) {
		message.push_back(static_cast<unsigned char>((bit_length >> shift) & 0xffU));
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
			const uint32_t s0 = sha256_rotr(w[i - 15U], 7U) ^ sha256_rotr(w[i - 15U], 18U) ^ (w[i - 15U] >> 3U);
			const uint32_t s1 = sha256_rotr(w[i - 2U], 17U) ^ sha256_rotr(w[i - 2U], 19U) ^ (w[i - 2U] >> 10U);
			w[i] = w[i - 16U] + s0 + w[i - 7U] + s1;
		}
		uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
		for (size_t i = 0; i < 64U; ++i) {
			const uint32_t s1 = sha256_rotr(e, 6U) ^ sha256_rotr(e, 11U) ^ sha256_rotr(e, 25U);
			const uint32_t ch = (e & f) ^ ((~e) & g);
			const uint32_t temp1 = hh + s1 + ch + k[i] + w[i];
			const uint32_t s0 = sha256_rotr(a, 2U) ^ sha256_rotr(a, 13U) ^ sha256_rotr(a, 22U);
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

	ostringstream out;
	out << hex << setfill('0');
	for (const uint32_t word : h) {
		out << setw(8) << word;
	}
	return out.str();
}

static string validate_project_name(const string &name) {
	if (name.empty()) {
		throw invalid_argument("project name must not be empty.");
	}
	const unsigned char first = static_cast<unsigned char>(name[0]);
	if (!((first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') || first == '_')) {
		throw invalid_argument("project name must start with an ASCII letter or '_'.");
	}
	for (const unsigned char ch : name) {
		const bool ascii_alnum = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
								 (ch >= '0' && ch <= '9');
		if (!ascii_alnum && ch != '_' && ch != '-' && ch != '.') {
			throw invalid_argument(
				"project name may contain only ASCII letters, digits, '_', '-', and '.' for portable generated paths.");
		}
	}
	if (name.back() == '.') {
		throw invalid_argument("project name must not end with '.' because Windows strips trailing dots.");
	}
	// Windows treats these device names as special even when an extension is
	// present (for example, CON.h).  The generated project directory and
	// public header must therefore reject them on every platform, rather than
	// allowing a project that later cannot be built or deployed on Windows.
	const size_t extension_pos = name.find('.');
	string stem = name.substr(0, extension_pos);
	transform(stem.begin(), stem.end(), stem.begin(), [](const unsigned char ch) {
		return static_cast<char>(toupper(ch));
	});
	const bool reserved_base = stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL";
	const bool reserved_numbered = stem.size() == 4U &&
		((stem.compare(0, 3, "COM") == 0) || (stem.compare(0, 3, "LPT") == 0)) &&
		stem[3] >= '1' && stem[3] <= '9';
	if (reserved_base || reserved_numbered) {
		throw invalid_argument("project name must not be a reserved Windows device name.");
	}
	return name;
}

/*static FUNCTION_RETURN check_templates(const string &source_folder) {
	const fs::path templates_path(source_folder);
	if (!fs::exists(templates_path) || !fs::is_directory(templates_path)) {
		throw std::runtime_error(string("Templates directory [") + templates_path.string() +
								 "] does not exist or is not a directory");
	}
	const fs::path template_fname(templates_path / TEMPLATE);
	if (!fs::exists(template_fname) || !fs::is_regular_file(template_fname)) {
		throw std::runtime_error(string("Templates file [") + template_fname.string() + "] does not exist");
	}
	return FUNC_RET_OK;
}*/

static const string guess_templates_folder(const string &source_folder) {
	fs::path templates_path(source_folder);
	if (!fs::exists(templates_path) || !fs::is_directory(templates_path)) {
		throw std::runtime_error(string("Templates directory [") + templates_path.string() +
								 "] does not exist or is not a directory");
	}
	fs::path template_fname(templates_path / TEMPLATE);
	if (!fs::exists(template_fname) || !fs::is_regular_file(template_fname)) {
		// try to add a /templates
		templates_path = templates_path / "templates";
		fs::path template_fname2(templates_path / TEMPLATE);
		if (!fs::exists(template_fname2) || !fs::is_regular_file(template_fname2)) {
			throw std::runtime_error(string("Templates file [") + template_fname2.string() +
									 "] does not exist. tried also [" + template_fname.string() + "]");
		}
	}
	fs::path normalized =
#if BOOST_VERSION >= 108700
		templates_path.lexically_normal();
#else
		templates_path.normalize();
#endif
	return normalized.string();
}
static const fs::path publicKeyFolder(const fs::path &product_folder, const string &product_name) {
	return product_folder / "include" / "licensecc" / product_name;
}

static vector<unsigned char> public_key_bytes_from_header(const string &header) {
	const size_t define_pos = header.find("#define PUBLIC_KEY");
	if (define_pos == string::npos) {
		throw runtime_error("Generated public_key.h has no PUBLIC_KEY bytes");
	}
	const size_t open_pos = header.find('{', define_pos);
	const size_t close_pos = header.find('}', open_pos);
	if (open_pos == string::npos || close_pos == string::npos || close_pos <= open_pos) {
		throw runtime_error("Generated public_key.h has malformed PUBLIC_KEY bytes");
	}
	vector<unsigned char> bytes;
	string token;
	for (size_t i = open_pos + 1U; i < close_pos; ++i) {
		const unsigned char ch = static_cast<unsigned char>(header[i]);
		if (isdigit(ch)) {
			token.push_back(static_cast<char>(ch));
			continue;
		}
		if (!token.empty()) {
			const unsigned long value = stoul(token);
			if (value > 255UL) {
				throw runtime_error("Generated public_key.h has a PUBLIC_KEY byte outside byte range");
			}
			bytes.push_back(static_cast<unsigned char>(value));
			token.clear();
		}
		if (ch != ',' && ch != '\\' && !isspace(ch)) {
			throw runtime_error("Generated public_key.h has malformed PUBLIC_KEY bytes");
		}
	}
	if (!token.empty()) {
		const unsigned long value = stoul(token);
		if (value > 255UL) {
			throw runtime_error("Generated public_key.h has a PUBLIC_KEY byte outside byte range");
		}
		bytes.push_back(static_cast<unsigned char>(value));
	}
	if (bytes.empty()) {
		throw runtime_error("Generated public_key.h has empty PUBLIC_KEY bytes");
	}
	return bytes;
}

static string string_define_from_header(const string &header, const string &name) {
	const string marker = "#define " + name + " \"";
	const size_t start = header.find(marker);
	if (start == string::npos) {
		return "";
	}
	const size_t value_start = start + marker.size();
	const size_t value_end = header.find('"', value_start);
	return value_end == string::npos ? "" : header.substr(value_start, value_end - value_start);
}

static bool numeric_define_equals(const string &header, const string &name, size_t expected) {
	const string marker = "#define " + name + " ";
	const size_t start = header.find(marker);
	if (start == string::npos) {
		return false;
	}
	const size_t value_start = start + marker.size();
	const size_t value_end = header.find_first_of("\r\n", value_start);
	try {
		size_t consumed = 0;
		const size_t value = static_cast<size_t>(stoull(header.substr(value_start, value_end - value_start), &consumed, 10));
		return consumed == value_end - value_start && value == expected;
	} catch (const exception &) {
		return false;
	}
}

static bool public_key_header_has_current_metadata(const string &header, const vector<unsigned char> &public_key) {
	const string key_sha256 = sha256_hex(public_key);
	return numeric_define_equals(header, "PUBLIC_KEY_LEN", public_key.size()) &&
		   numeric_define_equals(header, "LCC_PUBLIC_KEY_BITS", rsa_public_key_bits(public_key)) &&
		   string_define_from_header(header, "LCC_PUBLIC_KEY_ALGORITHM") == "rsa" &&
		   string_define_from_header(header, "LCC_PUBLIC_KEY_SHA256") == key_sha256 &&
		   string_define_from_header(header, "LCC_PUBLIC_KEY_ID") == "sha256:" + key_sha256 &&
		   string_define_from_header(header, "LCC_SIGNATURE_ALGORITHM") == "rsa-pkcs1-sha256";
}

Project::Project(const std::string &name, const std::string &project_folder, const std::string &source_folder,
				 bool force_overwrite, size_t key_bits)
	: m_name(validate_project_name(name)),
	  m_project_folder(project_folder),
	  m_templates_folder(guess_templates_folder(source_folder)),
	  m_force_overwrite(force_overwrite),
	  m_key_bits(key_bits) {}

void Project::exportPublicKey(const std::string &include_folder, const std::unique_ptr<CryptoHelper> &cryptoHelper) {
	const fs::path templates_path(m_templates_folder);
	Environment env(templates_path.string() + "/", include_folder + "/");
	Template temp = env.parse_template(TEMPLATE);
	json data;
	const vector<unsigned char> pkey = cryptoHelper->exportPublicKey();
	data["public_key"] = pkey;
	data["public_key_len"] = pkey.size();
	data["public_key_algorithm"] = "rsa";
	data["public_key_bits"] = rsa_public_key_bits(pkey);
	data["public_key_sha256"] = sha256_hex(pkey);
	data["signature_algorithm"] = "rsa-pkcs1-sha256";
	data["product_name"] = m_name;
	const string rendered_header = env.render(temp, data);
	file_publish::write_file_atomically_replace(fs::path(include_folder) / PUBLIC_KEY_INC_FNAME, rendered_header);
}

FUNCTION_RETURN Project::initialize() {
	const fs::path destinationDir(fs::path(m_project_folder) / m_name);
	const fs::path include_folder(publicKeyFolder(destinationDir, m_name));
	const fs::path publicKeyFile(include_folder / PUBLIC_KEY_INC_FNAME);
	const fs::path privateKeyFile(destinationDir / PRIVATE_KEY_FNAME);
	bool keyFilesExist = false;
	if (fs::exists(destinationDir)) {
		if (!fs::is_directory(destinationDir)) {
			throw runtime_error("Project destination is not a directory [" + destinationDir.string() + "]");
		}
		keyFilesExist = fs::exists(destinationDir / PRIVATE_KEY_FNAME);
		// Refuse force before creating or repairing any adjacent artifact.  The
		// migration contract is fail-closed: an existing private key means this
		// invocation is a no-mutation error, not a partial project repair.
		if (m_force_overwrite && keyFilesExist) {
			throw logic_error("Automatic private-key rotation is disabled. Existing project keys are never overwritten; "
							"create a separately backed-up replacement project and reissue licenses.");
		}
		if (!fs::exists(include_folder)) {
			if (!fs::create_directories(include_folder)) {
				throw std::runtime_error("Cannot create public key directory [" + include_folder.string() + "]");
			}
		} else if (!fs::is_directory(include_folder)) {
			throw runtime_error("Public key destination is not a directory [" + include_folder.string() + "]");
		}
	} else if (!fs::create_directories(destinationDir) || !fs::create_directories(include_folder)) {
		throw std::runtime_error("Cannot create destination directory [" + destinationDir.string() + "]");
	}
	FUNCTION_RETURN result = FUNC_RET_OK;
	unique_ptr<CryptoHelper> cryptoHelper(CryptoHelper::getInstance());
	if (keyFilesExist) {
		cryptoHelper->loadPrivateKey_file(privateKeyFile.string());
		const vector<unsigned char> expected_public_key = cryptoHelper->exportPublicKey();
		// Verify the existing header bytes and DER before deciding whether its
		// metadata is merely stale and safe to repair.  Any malformed or
		// mismatched key material fails closed without touching either file.
		if (fs::exists(publicKeyFile)) {
			ifstream input(publicKeyFile.string().c_str(), ios::binary);
			if (!input.is_open()) {
				throw runtime_error("Cannot read generated public key header [" + publicKeyFile.string() + "]");
			}
			const string header((istreambuf_iterator<char>(input)), istreambuf_iterator<char>());
			input.close();
			if (input.fail()) {
				throw runtime_error("Cannot close generated public key header [" + publicKeyFile.string() + "]");
			}
			const vector<unsigned char> header_public_key = public_key_bytes_from_header(header);
			(void)rsa_public_key_bits(header_public_key);
			if (header_public_key != expected_public_key) {
				throw runtime_error("Existing generated public key does not match private key [" + publicKeyFile.string() + "]");
			}
			if (!public_key_header_has_current_metadata(header, expected_public_key)) {
				exportPublicKey(include_folder.string(), cryptoHelper);
			}
		} else {
			// A missing generated header can safely be recreated from the existing
			// private key without changing that key.
			exportPublicKey(include_folder.string(), cryptoHelper);
		}
	} else {
		cryptoHelper->generateKeyPair(m_key_bits);
		const std::string privateKey = cryptoHelper->exportPrivateKey();
		file_publish::write_new_file_no_replace(privateKeyFile, privateKey);
		exportPublicKey(include_folder.string(), cryptoHelper);
	}
	return result;
}

Project::~Project() {}

} /* namespace license */
