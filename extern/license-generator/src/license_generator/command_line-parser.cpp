/*
 * command_line-parser.cpp
 *
 *  Created on: Oct 20, 2019
 *      Author: Gabriele Contini
 */

#include <stddef.h>
#include <stdlib.h>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <map>
#include <memory>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <boost/lexical_cast.hpp>
#include <boost/optional.hpp>
#include <boost/optional/optional_io.hpp>
#include <boost/program_options.hpp>
#include <boost/program_options/config.hpp>
#include <boost/algorithm/string.hpp>
#include <boost/filesystem.hpp>
#include <build_properties.h>

#include "../base_lib/base64.h"
#include "command_line-parser.hpp"
#include "file_publish.hpp"
#include "license.hpp"
#include "project.hpp"

namespace license {
namespace po = boost::program_options;
namespace fs = boost::filesystem;
using namespace std;

static void printHelpHeader(const char *prog_name) {
	cout << endl;
	cout << fs::path(prog_name).filename().string() << " Version " << PROJECT_VERSION << ". Usage:" << endl;
}

static void printBasicHelp(const char *prog_name) {
	printHelpHeader(prog_name);
	cout << fs::path(prog_name).filename().string() << " [command] [options]" << endl;
	cout << " available commands: \"project init\", \"project validate-keypair\", \"project migrate-weak-key\", \"project list\", \"license issue\", \"license list\""
		 << endl;
	cout << " to see specific command options type: " << prog_name << " [command] --help" << endl << endl;
}

static const char *PARAM_PROJECT_KEY_BITS = "key-bits";

CommandLineParser::CommandLineParser() {}

CommandLineParser::~CommandLineParser() {}

static string read_text_file(const string &path) {
	ifstream input(path.c_str(), ios::binary);
	if (!input.is_open()) {
		throw runtime_error("cannot read file: " + path);
	}
	return string((istreambuf_iterator<char>(input)), istreambuf_iterator<char>());
}

static string public_key_string_define(const string &header, const string &define_name) {
	const regex line_regex("^[ \t]*#define[ \t]+" + define_name + "[ \t]+\"([^\"]*)\"[ \t\r]*$");
	istringstream input(header);
	string line;
	while (getline(input, line)) {
		smatch match;
		if (regex_match(line, match, line_regex)) {
			return match[1].str();
		}
	}
	return "";
}

static string public_key_numeric_define(const string &header, const string &define_name) {
	const regex line_regex("^[ \t]*#define[ \t]+" + define_name + "[ \t]+([^ \t\r]+)[ \t\r]*$");
	istringstream input(header);
	string line;
	while (getline(input, line)) {
		smatch match;
		if (regex_match(line, match, line_regex)) {
			return match[1].str();
		}
	}
	return "";
}

static size_t parse_public_key_size_define(const string &header, const string &define_name) {
	const string value = public_key_numeric_define(header, define_name);
	if (value.empty()) {
		throw runtime_error("generated public key metadata is missing " + define_name);
	}
	size_t consumed = 0;
	size_t parsed = 0;
	try {
		parsed = static_cast<size_t>(stoull(value, &consumed, 10));
	} catch (const exception &) {
		throw runtime_error("generated public key metadata is not numeric: " + define_name);
	}
	if (consumed != value.size()) {
		throw runtime_error("generated public key metadata is not numeric: " + define_name);
	}
	return parsed;
}

static string require_public_key_string_define(const string &header, const string &define_name) {
	const string value = public_key_string_define(header, define_name);
	if (value.empty()) {
		throw runtime_error("generated public key metadata is missing " + define_name);
	}
	return value;
}

static vector<unsigned char> public_key_bytes_from_header(const string &header) {
	const size_t define_pos = header.find("#define PUBLIC_KEY");
	if (define_pos == string::npos) {
		throw runtime_error("generated public key bytes are missing");
	}
	const size_t open_pos = header.find('{', define_pos);
	const size_t close_pos = header.find('}', open_pos);
	if (open_pos == string::npos || close_pos == string::npos || close_pos <= open_pos) {
		throw runtime_error("generated public key bytes are malformed");
	}
	const string body = header.substr(open_pos + 1, close_pos - open_pos - 1);
	vector<unsigned char> bytes;
	regex byte_regex("[0-9]+");
	size_t last = 0;
	for (sregex_iterator it(body.begin(), body.end(), byte_regex), end; it != end; ++it) {
		for (size_t i = last; i < static_cast<size_t>(it->position()); ++i) {
			const char ch = body[i];
			if (ch != ',' && ch != '\\' && !isspace(static_cast<unsigned char>(ch))) {
				throw runtime_error("generated public key bytes are malformed");
			}
		}
		const string token = it->str();
		size_t consumed = 0;
		unsigned long value = 0;
		try {
			value = stoul(token, &consumed, 10);
		} catch (const exception &) {
			throw runtime_error("generated public key bytes are malformed");
		}
		if (consumed != token.size() || value > 255UL) {
			throw runtime_error("generated public key bytes are outside byte range");
		}
		bytes.push_back(static_cast<unsigned char>(value));
		last = static_cast<size_t>(it->position() + it->length());
	}
	for (size_t i = last; i < body.size(); ++i) {
		const char ch = body[i];
		if (ch != ',' && ch != '\\' && !isspace(static_cast<unsigned char>(ch))) {
			throw runtime_error("generated public key bytes are malformed");
		}
	}
	if (bytes.empty()) {
		throw runtime_error("generated public key bytes are empty");
	}
	return bytes;
}

static size_t read_der_length(const vector<unsigned char> &data, size_t &offset) {
	if (offset >= data.size()) {
		throw runtime_error("invalid RSA public key DER length");
	}
	const unsigned char first = data[offset++];
	if ((first & 0x80U) == 0) {
		return first;
	}
	const size_t length_bytes = first & 0x7fU;
	if (length_bytes == 0 || length_bytes > sizeof(size_t) || offset + length_bytes > data.size() ||
		data[offset] == 0) {
		throw runtime_error("invalid RSA public key DER length");
	}
	size_t length = 0;
	for (size_t i = 0; i < length_bytes; ++i) {
		length = (length << 8U) | data[offset++];
	}
	if (length <= 127U) {
		throw runtime_error("invalid RSA public key DER length");
	}
	return length;
}

static void require_der_tag(const vector<unsigned char> &data, size_t &offset, unsigned char tag) {
	if (offset >= data.size() || data[offset] != tag) {
		throw runtime_error("unexpected RSA public key DER tag");
	}
	++offset;
}

static size_t rsa_public_key_bits(const vector<unsigned char> &public_key_der) {
	size_t offset = 0;
	require_der_tag(public_key_der, offset, 0x30U);
	const size_t sequence_len = read_der_length(public_key_der, offset);
	if (offset + sequence_len != public_key_der.size()) {
		throw runtime_error("invalid RSA public key DER sequence length");
	}
	require_der_tag(public_key_der, offset, 0x02U);
	size_t modulus_len = read_der_length(public_key_der, offset);
	if (modulus_len == 0 || offset + modulus_len > public_key_der.size()) {
		throw runtime_error("invalid RSA public key modulus length");
	}
	if (public_key_der[offset] == 0U) {
		if (modulus_len == 1 || (public_key_der[offset + 1] & 0x80U) == 0) {
			throw runtime_error("invalid RSA public key modulus encoding");
		}
		++offset;
		--modulus_len;
	} else if ((public_key_der[offset] & 0x80U) != 0) {
		throw runtime_error("invalid RSA public key modulus encoding");
	}
	while (modulus_len > 0 && public_key_der[offset] == 0U) {
		++offset;
		--modulus_len;
	}
	if (modulus_len == 0) {
		throw runtime_error("invalid RSA public key modulus");
	}
	unsigned char first = public_key_der[offset];
	size_t first_bits = 0;
	while (first != 0U) {
		++first_bits;
		first >>= 1U;
	}
	return ((modulus_len - 1U) * 8U) + first_bits;
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

static void validate_project_keypair(const string &private_key_file, const string &public_key_header_file) {
	const string header = read_text_file(public_key_header_file);
	const vector<unsigned char> header_public_key = public_key_bytes_from_header(header);

	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->loadPrivateKey_file(private_key_file);
	const vector<unsigned char> private_public_key = crypto->exportPublicKey();
	if (header_public_key != private_public_key) {
		throw runtime_error("private key does not match generated public key bytes");
	}

	const size_t public_key_len = parse_public_key_size_define(header, "PUBLIC_KEY_LEN");
	if (public_key_len != header_public_key.size() || public_key_len != private_public_key.size()) {
		throw runtime_error("generated public key metadata mismatch: PUBLIC_KEY_LEN");
	}

	const string public_key_sha256 = sha256_hex(private_public_key);
	if (require_public_key_string_define(header, "LCC_PUBLIC_KEY_SHA256") != public_key_sha256) {
		throw runtime_error("generated public key metadata mismatch: LCC_PUBLIC_KEY_SHA256");
	}
	if (require_public_key_string_define(header, "LCC_PUBLIC_KEY_ID") != "sha256:" + public_key_sha256) {
		throw runtime_error("generated public key metadata mismatch: LCC_PUBLIC_KEY_ID");
	}
	if (require_public_key_string_define(header, "LCC_PUBLIC_KEY_ALGORITHM") != "rsa") {
		throw runtime_error("generated public key metadata mismatch: LCC_PUBLIC_KEY_ALGORITHM");
	}
	if (require_public_key_string_define(header, "LCC_SIGNATURE_ALGORITHM") != LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256) {
		throw runtime_error("generated public key metadata mismatch: LCC_SIGNATURE_ALGORITHM");
	}

	const size_t public_key_bits = parse_public_key_size_define(header, "LCC_PUBLIC_KEY_BITS");
	if (public_key_bits != rsa_public_key_bits(private_public_key)) {
		throw runtime_error("generated public key metadata mismatch: LCC_PUBLIC_KEY_BITS");
	}
	if (public_key_bits < 3072) {
		cerr << "WARNING: this project key is " << public_key_bits
			 << " bits. The licensecc runtime rejects keys below 3072 bits (v200 and v201), so licenses signed with "
				"it will NOT verify in production."
			 << endl;
	}
}

static size_t parse_project_key_bits(const string &value) {
	if (value == "2048") {
		return 2048;
	}
	if (value == "3072") {
		return 3072;
	}
	if (value == "4096") {
		return 4096;
	}
	if (value == "1024") {
		throw runtime_error("--key-bits 1024 is legacy-only; use --legacy-rsa1024");
	}
	throw runtime_error("--key-bits must be one of 2048, 3072, or 4096");
}

static size_t project_init_key_bits(const po::variables_map &vm, bool legacy_rsa1024, bool allow_insecure_key_size) {
	size_t key_bits;
	if (legacy_rsa1024) {
		if (vm.find(PARAM_PROJECT_KEY_BITS) != vm.end()) {
			throw runtime_error("--legacy-rsa1024 cannot be combined with --key-bits");
		}
		key_bits = 1024;
	} else if (vm.find(PARAM_PROJECT_KEY_BITS) == vm.end()) {
		return 3072;
	} else {
		key_bits = parse_project_key_bits(vm[PARAM_PROJECT_KEY_BITS].as<string>());
	}
	// The licensecc runtime enforces a 3072-bit RSA floor on both the v200 (default) and v201
	// license formats, so a project key below 3072 bits produces licenses that never verify.
	// Refuse to generate such a key unless the caller explicitly opts in for compatibility tests.
	if (key_bits < 3072) {
		if (!allow_insecure_key_size) {
			throw runtime_error(
				"refusing to generate a " + to_string(key_bits) +
				"-bit RSA project key: the licensecc runtime rejects keys below 3072 bits for both the v200 and v201 "
				"license formats, so licenses signed with this key would never verify. Use 3072 or larger, or pass "
				"--allow-insecure-key-size for compatibility tests that intentionally exercise weak keys.");
		}
		cerr << "WARNING: generating a " << key_bits
			 << "-bit RSA project key. The licensecc runtime rejects keys below 3072 bits (v200 and v201), so licenses "
				"signed with this key will NOT verify in production. Intended only for compatibility tests."
			 << endl;
	}
	return key_bits;
}

static bool rerunBoostPO(const po::parsed_options &parsed, const po::options_description &project_desc,
						 po::variables_map &vm, const char **argv, const std::string &command_for_logging,
						 const po::options_description &global, bool &should_execute) {
	// Collect all the unrecognized options from the first pass. This will include the
	// (positional) command name, so we need to erase that.
	// Parse again...
	should_execute = false;
	try {
		std::vector<std::string> opts = po::collect_unrecognized(parsed.options, po::include_positional);
		if (!opts.empty()) {
			opts.erase(opts.begin());
		}
		po::store(po::command_line_parser(opts).options(project_desc).run(), vm);
		if (vm.find("help") == vm.end()) {
			po::notify(vm);
			should_execute = true;
		} else {
			printHelpHeader(argv[0]);
			cout << argv[0] << " " << command_for_logging << " [options]" << endl;
			global.print(cout);
			project_desc.print(cout);
		}
		return true;
	} catch (std::exception &e) {
		printHelpHeader(argv[0]);
		cout << argv[0] << " " << command_for_logging << " [options]" << endl;
		global.print(cout);
		project_desc.print(cout);
		std::cerr << "Error: " << e.what() << endl;
		return false;
	}
}

static int initializeProject(const po::parsed_options &parsed, po::variables_map &vm, const char **argv,
							 const po::options_description &global) {
	po::options_description project_desc("project init options");
	std::string project_name;
	std::string project_folder;
	std::string templates_folder;
	bool legacy_rsa1024 = false;
	bool allow_insecure_key_size = false;
	project_desc.add_options()  //
		("project-name,n", po::value<std::string>(&project_name)->required(), "New project name (required).")  //
		("projects-folder,p", po::value<std::string>(&project_folder)->default_value("."),  //
		 "path to where all the projects configurations are stored.")  //
		("templates,t", po::value<std::string>(&templates_folder)->default_value("."),
		 "path to the templates folder.")  //
		(PARAM_PROJECT_KEY_BITS, po::value<std::string>(),
		 "Generate a new RSA project key with explicit modulus bits. Allowed values: 2048, 3072, 4096. Default: 3072. "
		 "Values below 3072 are rejected by the licensecc runtime and require --allow-insecure-key-size.")  //
		("legacy-rsa1024", po::bool_switch(&legacy_rsa1024),
		 "Generate a legacy RSA-1024 project key. Rejected by the licensecc runtime (v200 and v201); requires "
		 "--allow-insecure-key-size and is intended only for compatibility tests or existing v200 migrations.")  //
		("allow-insecure-key-size", po::bool_switch(&allow_insecure_key_size),
		 "Allow generating an RSA project key below 3072 bits. Such keys are rejected by the licensecc runtime (v200 "
		 "and v201) and are intended only for compatibility tests. Disabled by default.")  //
		("help", "Print this help.");  //
	bool should_execute = false;
	if (!rerunBoostPO(parsed, project_desc, vm, argv, "project init", global, should_execute)) {
		return 1;
	}
	if (should_execute) {
		// cout << templates_folder.is_initialized() << endl;
		const size_t key_bits = project_init_key_bits(vm, legacy_rsa1024, allow_insecure_key_size);
		Project project(project_name, project_folder, templates_folder, false, key_bits);
		project.initialize();
	}
	return 0;
}

static int validateProjectKeyPair(const po::parsed_options &parsed, po::variables_map &vm, const char **argv,
								  const po::options_description &global) {
	po::options_description project_desc("project validate-keypair options");
	string private_key_file;
	string public_key_file;
	project_desc.add_options()  //
		("private-key", po::value<string>(&private_key_file)->required(), "Private signing key file.")  //
		("public-key", po::value<string>(&public_key_file)->required(), "Generated public_key.h file.")  //
		("help", "Print this help.");  //
	bool should_execute = false;
	if (!rerunBoostPO(parsed, project_desc, vm, argv, "project validate-keypair", global, should_execute)) {
		return 1;
	}
	if (should_execute) {
		try {
			validate_project_keypair(private_key_file, public_key_file);
			cout << "Project key-pair validation OK" << endl;
		} catch (const exception &ex) {
			cerr << "Project key-pair validation error: " << ex.what() << endl;
			return 1;
		}
	}
	return 0;
}

static int migrateWeakProjectKey(const po::parsed_options &parsed, po::variables_map &vm, const char **argv,
								 const po::options_description &global) {
	po::options_description project_desc("project migrate-weak-key options");
	string project_folder;
	project_desc.add_options()  //
		(PARAM_PROJECT_FOLDER ",p", po::value<string>(&project_folder)->required(),
		 "Existing project folder containing private_key.rsa. This command never modifies it.")  //
		("help", "Print this help.");
	bool should_execute = false;
	if (!rerunBoostPO(parsed, project_desc, vm, argv, "project migrate-weak-key", global, should_execute)) {
		return 1;
	}
	if (!should_execute) {
		return 0;
	}
	const fs::path project_path(project_folder);
	if (!fs::exists(project_path) || !fs::is_directory(project_path)) {
		cerr << "Weak-key migration error: project folder does not exist or is not a directory [" << project_path.string()
			 << "]" << endl;
		return 1;
	}
	const fs::path private_key = project_path / PRIVATE_KEY_FNAME;
	if (!fs::exists(private_key) || !fs::is_regular_file(private_key)) {
		cerr << "Weak-key migration error: private key does not exist or is not a regular file [" << private_key.string()
			 << "]" << endl;
		return 1;
	}
	try {
		unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
		crypto->loadPrivateKey_file(private_key.string());
		const size_t key_bits = rsa_public_key_bits(crypto->exportPublicKey());
		if (key_bits >= 3072) {
			cout << "Project key is " << key_bits << " bits; no weak-key migration is required. No files were changed."
				 << endl;
			return 0;
		}
		const fs::path parent = project_path.parent_path().empty() ? fs::current_path() : project_path.parent_path();
		cerr << "Refusing automatic rotation of the existing " << key_bits << "-bit private key. No files were changed."
			 << endl;
		cerr << "Manual migration (backup-aware and restorable):" << endl;
		cerr << "  1. Back up the complete project folder, including `" << private_key.string()
			 << "`, before changing deployment." << endl;
		cerr << "  2. Create a NEW project folder (do not reuse this one):" << endl;
		cerr << "     lccgen project init --project-name <new-project-name> --projects-folder \""
			 << parent.string() << "\" --templates <templates-folder> --key-bits 3072" << endl;
		cerr << "  3. Deploy the new public_key.h, retain the old key only for legacy verification as needed, and reissue "
				"all v201 licenses with the new project." << endl;
		return 1;
	} catch (const exception &ex) {
		cerr << "Weak-key migration error: " << ex.what() << endl;
		return 1;
	}
}

static int issueLicense(const po::parsed_options &parsed, po::variables_map &vm, const char **argv,
						const po::options_description &global) {
	po::options_description license_desc("license issue options");
	string license_name;
	string *license_name_ptr = nullptr;
	string project_folder;
	// string output;
	unsigned int magic_num = 0;
	bool base64 = false;
	bool allow_ip_binding = false;
	bool allow_env_selected_binding = false;
	bool allow_weak_disk_label_binding = false;
	license_desc.add_options()  //
		(PARAM_BASE64 ",b", po::bool_switch(&base64),
		 "Encode license as base64 for inclusion in environment variables.")  //
		(PARAM_BEGIN_DATE, po::value<string>(),
		 "Specify the start of the validity for this license. "
		 " Format YYYYMMDD. If not specified defaults to today")  //
		(PARAM_EXPIRY_DATE ",e", po::value<string>(),
		 "Specify the expire date for this license. "
		 " Format YYYYMMDD. If not specified the license won't expire")  //
		(PARAM_CLIENT_SIGNATURE ",s", po::value<string>(),
		 "The signature of the hardware that requires the license. It should be in the format XXXX-XXXX-XXXX."
		 " If not specified the license won't be linked to a specific hardware (eg. demo license).")  //
		("allow-ip-binding", po::bool_switch(&allow_ip_binding),
		 "Allow issuing a hardware-bound license for an IP-address identifier. This binding is weak and disabled by "
		 "default.")  //
		("allow-env-selected-binding", po::bool_switch(&allow_env_selected_binding),
		 "Allow issuing a hardware-bound license for an identifier produced by IDENTIFICATION_STRATEGY. This binding "
		 "is support-oriented and disabled by default.")  //
		("allow-weak-disk-label-binding", po::bool_switch(&allow_weak_disk_label_binding),
		 "Allow issuing a hardware-bound license for a disk identifier produced from mutable disk fallback data. "
		 "This binding is weak and disabled by default.")  //
		(PARAM_LICENSE_OUTPUT ",o", po::value<string>(&license_name),
		 "License output file name. May contain / that will be interpreded as subfolders.")  //
		(PARAM_FEATURE_NAMES ",f", po::value<boost::optional<std::string>>(),
		 "Feature names: comma separate list of project features to enable. if not specified will be taken as project "
		 "name.")  //
		(PARAM_PRIMARY_KEY, po::value<string>(), "Primary key location, in case it is not in default folder")  //
		(PARAM_LICENSE_FORMAT_VERSION, po::value<string>()->default_value(to_string(LICENSE_FILE_VERSION)),
		 "License file format version to emit. 200 is the default compatible format; 201 requires an explicit "
		 "--target-license-format-max=201 compatibility signal.")  //
		(PARAM_TARGET_LICENSE_FORMAT_MAX, po::value<string>()->default_value(to_string(LICENSE_FILE_VERSION_V200)),
		 "Maximum license file format supported by the target runtime. Keep 200 for legacy runtimes; pass 201 only "
		 "when the deployed runtime verifies v201 licenses.")  //
		(PARAM_PROJECT_FOLDER ",p", po::value<string>(&project_folder)->default_value("."),
		 "path to where project configurations and licenses are stored.")  //
		(PARAM_VERSION_FROM, po::value<string>()->default_value("0", "All Versions"),
		 "Specify the first version of the software this license apply to.")  //
		(PARAM_VERSION_TO, po::value<string>()->default_value("0", "All Versions"),  //
		 "Specify the last version of the software this license apply to.")  //
		(PARAM_CUSTOM_LIMIT, po::value<string>(),
		 "Signed host-defined execution policy. Requires license-version 201 and a runtime evaluator.")  //
		(PARAM_EXTRA_DATA ",x", po::value<string>(), "Specify extra data to be included into the license")  //
		("help,h", "Print this help.");  //
	bool should_execute = false;
	if (!rerunBoostPO(parsed, license_desc, vm, argv, "license issue", global, should_execute)) {
		return 1;
	}
	if (should_execute) {
		if (!license_name.empty()) {
			license_name_ptr = &license_name;
		}
		try {
			License license(license_name_ptr, project_folder, base64);
			license.set_allow_ip_binding(allow_ip_binding);
			license.set_allow_env_selected_binding(allow_env_selected_binding);
			license.set_allow_weak_disk_label_binding(allow_weak_disk_label_binding);
			for (const auto &it : vm) {
				auto &value = it.second.value();
				if (it.first != "command" && it.first != "subargs" && it.first != "base64" &&
					it.first != "allow-ip-binding" && it.first != "allow-env-selected-binding" &&
					it.first != "allow-weak-disk-label-binding") {
					if (auto v = boost::any_cast<std::string>(&value)) {
						license.add_parameter(it.first, *v);
					} else if (auto v = boost::any_cast<boost::optional<std::string>>(value)) {
						license.add_parameter(it.first, *v);
					} else {
						throw invalid_argument(it.first + " has an unrecognized value type");
					}
				}
			}
			license.write_license();
			if (license_name_ptr != nullptr) {
				cout << "License written " << endl;
			}
		} catch (exception &ex) {
			cerr << "License issue error: " << ex.what() << endl;
			return 1;
		}
	}
	return 0;
}

/** method used in tests for have a quick signature of a piece of data */

static int test_sign(const po::parsed_options &parsed, po::variables_map &vm, const char **argv,
					 const po::options_description &global) {
	po::options_description license_desc("test sign options");
	string private_key_file;
	string data;
	string outputFile;
	license_desc.add_options()  //
		("data,d", po::value<string>(&data)->required(), "Data to be signed")  //
		(PARAM_PRIMARY_KEY ",p", po::value<string>(&private_key_file)->required(), "Primary key location")  //
		("output,o", po::value<string>(&outputFile)->required(), "file where to write output")  //
		("help,h", "Print this help.");
	bool should_execute = false;
	if (!rerunBoostPO(parsed, license_desc, vm, argv, "test sign", global, should_execute)) {
		return 1;
	}
	if (should_execute) {
		if (outputFile != "cout" &&
			file_publish::output_target_matches_input_file(fs::path(outputFile), fs::path(private_key_file))) {
			throw runtime_error("Refusing to write a test signature over active private key [" + outputFile +
							"]. Choose an --output different from --" PARAM_PRIMARY_KEY + ".");
		}
		unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
		crypto->loadPrivateKey_file(private_key_file);
		string signedData(crypto->signString(data));
		if (outputFile != "cout") {
			file_publish::write_file_atomically_replace(fs::path(outputFile), signedData);
		} else {
			cout << signedData << endl;
		}
	}
	return 0;
}

int CommandLineParser::parseCommandLine(int argc, const char **argv) {
	if (argc == 1) {
		printBasicHelp(argv[0]);
		return 1;
	}
	int result = 0;
	po::options_description global("Global options");
	global.add_options()("verbose,v", "Turn on verbose output");
	po::options_description hidden("Hidden options");
	hidden.add_options()("command", po::value<std::vector<std::string>>(),
						 "command to execute: project init, project validate-keypair, project migrate-weak-key, project list, license issue")(
		"subargs", po::value<std::vector<std::string>>(), "Arguments for command, use option --help to see");

	po::positional_options_description pos;
	pos.add("command", 2).add("subargs", -1);

	po::variables_map vm;

	po::parsed_options parsed =
		po::command_line_parser(argc, argv).options(global).options(hidden).positional(pos).allow_unregistered().run();
	po::store(parsed, vm);
	std::vector<std::string> cmds = vm["command"].as<std::vector<std::string>>();
	if (cmds.size() == 0 || cmds.size() == 1) {
		printBasicHelp(argv[0]);
		return 1;
	}
	bool verbose = vm.count("verbose") > 0;
	try {
		if (cmds[0] == "project") {
			if (cmds[1].substr(0, 4) == "init") {
				result = initializeProject(parsed, vm, argv, global);
			} else if (cmds[1] == "validate-keypair") {
				result = validateProjectKeyPair(parsed, vm, argv, global);
			} else if (cmds[1] == "migrate-weak-key") {
				result = migrateWeakProjectKey(parsed, vm, argv, global);
			} else if (cmds[1] == "list") {
				po::options_description project_desc("project " + cmds[1] + " options");
				boost::optional<string> project_folder;
				project_desc.add_options()  //
					("projects-folder,p", po::value<boost::optional<string>>(&project_folder),
					 "path to where project configurations are stored.")  //
					("help", "Print this help.");  //

			} else {
				std::cerr << endl << "command " << cmds[0] << " " << cmds[1] << " not recognized.";
				printBasicHelp(argv[0]);
				result = 1;
			}
		} else if (cmds[0] == "license") {
			if (cmds[1] == "issue") {
				result = issueLicense(parsed, vm, argv, global);
			} else {
				printBasicHelp(argv[0]);
				result = 1;
			}
		} else if (cmds[0] == "test") {
			po::options_description license_desc("test " + cmds[1] + " options");
			if (cmds[1] == "sign") {
				result = test_sign(parsed, vm, argv, global);
			} else {
				result = 1;
			}
		} else {
			printBasicHelp(argv[0]);
			result = 1;
		}
	} catch (const std::exception &e) {
		printBasicHelp(argv[0]);
		cout << endl << "Parameter error: " << e.what() << endl;
		result = 1;
	}
	return result;
}

} /* namespace license */
