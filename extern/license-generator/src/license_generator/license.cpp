/*
 * License.cpp
 *
 *  Created on: Nov 10, 2019
 *      Author: GC
 */
#define SI_SUPPORT_IOSTREAMS

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdint>
#include <iomanip>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <unordered_set>
#include <vector>
#include <boost/filesystem.hpp>
#include <boost/algorithm/string.hpp>
#include <boost/version.hpp>

#include "../ini/SimpleIni.h"
#include "../base_lib/base64.h"
#include "../base_lib/crypto_helper.hpp"
#include "../base_lib/base.h"
#include "../base_lib/v201_canonical_payload.hpp"
#include "file_publish.hpp"
#include "license.hpp"

namespace license {
using namespace std;
namespace fs = boost::filesystem;

static const unordered_set<string> NO_OUTPUT_PARAM = {
	PARAM_BASE64,		  PARAM_LICENSE_OUTPUT, PARAM_FEATURE_NAMES,
	PARAM_PROJECT_FOLDER, PARAM_PRIMARY_KEY,	PARAM_MAGIC_NUMBER,
	PARAM_LICENSE_FORMAT_VERSION, PARAM_TARGET_LICENSE_FORMAT_MAX,
};

static const unordered_set<string> LICENSE_OUTPUT_PARAM = {
	PARAM_BEGIN_DATE,	   PARAM_CLIENT_SIGNATURE, PARAM_EXPIRY_DATE,
	PARAM_VERSION_FROM, PARAM_VERSION_TO,		PARAM_EXTRA_DATA,
};

struct ProjectPublicMetadata {
	string key_id;
	string public_key_sha256;
	string signature_algorithm;
	size_t public_key_len = 0;
	size_t public_key_bits = 0;
	vector<unsigned char> public_key_der;
};

constexpr size_t CLIENT_SIGNATURE_DECODED_SIZE = 8;
constexpr uint8_t CLIENT_SIGNATURE_ENV_SELECTED_FLAG = 0x40;
constexpr uint8_t CLIENT_SIGNATURE_WEAK_DISK_LABEL_FLAG = 0x01;
constexpr uint8_t CLIENT_SIGNATURE_WEAK_DISK_MUTABLE_FLAG = 0x02;
constexpr uint8_t CLIENT_SIGNATURE_WEAK_DISK_SOURCE_FLAGS =
	CLIENT_SIGNATURE_WEAK_DISK_LABEL_FLAG | CLIENT_SIGNATURE_WEAK_DISK_MUTABLE_FLAG;
constexpr uint8_t CLIENT_SIGNATURE_ISSUED_FLAG = 0x80;
constexpr uint8_t CLIENT_SIGNATURE_ALLOWED_CONTROL_FLAGS =
	CLIENT_SIGNATURE_ENV_SELECTED_FLAG | CLIENT_SIGNATURE_WEAK_DISK_SOURCE_FLAGS;
constexpr uint8_t CLIENT_SIGNATURE_ETHERNET_STRATEGY = 0;
constexpr uint8_t CLIENT_SIGNATURE_IP_STRATEGY = 1;
constexpr uint8_t CLIENT_SIGNATURE_DISK_STRATEGY = 2;
constexpr uint8_t MAX_SUPPORTED_HW_STRATEGY = 2;

struct ClientSignatureInfo {
	uint8_t strategy = 0;
	bool env_selected = false;
	bool weak_disk_label = false;
	bool weak_disk_mutable = false;
	string source_strength;
};

static string canonical_client_signature(const vector<uint8_t> &decoded) {
	string canonical = base64(decoded.data(), decoded.size(), 5);
	std::replace(canonical.begin(), canonical.end(), '\n', '-');
	if (!canonical.empty() && canonical.back() == '-') {
		canonical.pop_back();
	}
	return canonical;
}

static vector<uint8_t> decode_client_signature(const string &client_signature) {
	string encoded;
	encoded.reserve(client_signature.size());
	size_t separators = 0;
	for (const unsigned char ch : client_signature) {
		if (ch == '-') {
			++separators;
			encoded += '\n';
			continue;
		}
		if (std::isspace(ch) || std::iscntrl(ch)) {
			throw invalid_argument("client-signature must not contain whitespace or control characters");
		}
		encoded += static_cast<char>(ch);
	}
	if (separators != 2) {
		throw invalid_argument("client-signature must use the canonical XXXX-XXXX-XXXX format");
	}
	return unbase64(encoded);
}

static string client_signature_source_strength(const uint8_t strategy, const bool env_selected,
											   const bool weak_disk_label, const bool weak_disk_mutable) {
	if ((weak_disk_label || weak_disk_mutable) && strategy != CLIENT_SIGNATURE_DISK_STRATEGY) {
		throw invalid_argument("client-signature weak-source flag is only valid for disk identifiers");
	}
	if (weak_disk_label && weak_disk_mutable) {
		throw invalid_argument("client-signature contains multiple weak disk source flags");
	}
	if (strategy == CLIENT_SIGNATURE_ETHERNET_STRATEGY) {
		return env_selected ? "weak-env-selected-ethernet-mac" : "strong-ethernet-mac";
	}
	if (strategy == CLIENT_SIGNATURE_IP_STRATEGY) {
		return env_selected ? "weak-env-selected-ip-address" : "weak-ip-address";
	}
	if (strategy == CLIENT_SIGNATURE_DISK_STRATEGY) {
		if (weak_disk_label) {
			return env_selected ? "weak-env-selected-disk-label" : "weak-disk-label";
		}
		if (weak_disk_mutable) {
			return env_selected ? "weak-env-selected-disk-mutable" : "weak-disk-mutable";
		}
		return env_selected ? "weak-env-selected-disk-serial-or-uuid" : "strong-disk-serial-or-uuid";
	}
	throw invalid_argument("client-signature uses an unsupported hardware identification strategy");
}

static ClientSignatureInfo validate_client_signature(const string &client_signature, bool allow_ip_binding,
													 bool allow_env_selected_binding,
													 bool allow_weak_disk_label_binding) {
	if (client_signature.empty()) {
		throw invalid_argument("client-signature must not be empty");
	}
	vector<uint8_t> decoded = decode_client_signature(client_signature);
	if (decoded.size() != CLIENT_SIGNATURE_DECODED_SIZE) {
		throw invalid_argument("client-signature has invalid decoded size");
	}
	if (canonical_client_signature(decoded) != client_signature) {
		throw invalid_argument("client-signature is not in canonical form");
	}
	const uint8_t strategy = decoded[1] >> 5;
	if (strategy > MAX_SUPPORTED_HW_STRATEGY) {
		throw invalid_argument("client-signature uses an unsupported hardware identification strategy");
	}
	const bool weak_disk_label = (decoded[0] & CLIENT_SIGNATURE_WEAK_DISK_LABEL_FLAG) != 0;
	const bool weak_disk_mutable = (decoded[0] & CLIENT_SIGNATURE_WEAK_DISK_MUTABLE_FLAG) != 0;
	if (weak_disk_label && weak_disk_mutable) {
		throw invalid_argument("client-signature contains multiple weak disk source flags");
	}
	if ((weak_disk_label || weak_disk_mutable) && strategy != CLIENT_SIGNATURE_DISK_STRATEGY) {
		throw invalid_argument("client-signature weak-source flag is only valid for disk identifiers");
	}
	if (strategy == CLIENT_SIGNATURE_IP_STRATEGY && !allow_ip_binding) {
		throw invalid_argument("client-signature uses IP binding; pass --allow-ip-binding to issue this weak binding");
	}
	if ((decoded[0] & CLIENT_SIGNATURE_ENV_SELECTED_FLAG) != 0) {
		if (!allow_env_selected_binding) {
			throw invalid_argument("client-signature was generated from an environment-selected strategy; pass "
								   "--allow-env-selected-binding to issue this weak binding");
		}
	}
	if ((decoded[0] & CLIENT_SIGNATURE_ISSUED_FLAG) != 0) {
		throw invalid_argument("client-signature contains an unsupported issued-license flag");
	}
	if ((decoded[0] & ~CLIENT_SIGNATURE_ALLOWED_CONTROL_FLAGS) != 0) {
		throw invalid_argument("client-signature contains unsupported control flags");
	}
	if ((weak_disk_label || weak_disk_mutable) && !allow_weak_disk_label_binding) {
		throw invalid_argument(
			"client-signature uses weak disk fallback; pass --allow-weak-disk-label-binding to issue this weak binding");
	}
	ClientSignatureInfo info;
	info.strategy = static_cast<uint8_t>(strategy);
	info.env_selected = (decoded[0] & CLIENT_SIGNATURE_ENV_SELECTED_FLAG) != 0;
	info.weak_disk_label = weak_disk_label;
	info.weak_disk_mutable = weak_disk_mutable;
	info.source_strength =
		client_signature_source_strength(info.strategy, info.env_selected, info.weak_disk_label,
										 info.weak_disk_mutable);
	return info;
}

static const string normalize_date(const std::string &sDate) {
	auto parse_digits = [&sDate](const size_t offset, const size_t count, unsigned int &out) {
		out = 0;
		if (offset + count > sDate.size()) {
			return false;
		}
		for (size_t i = offset; i < offset + count; ++i) {
			const unsigned char ch = static_cast<unsigned char>(sDate[i]);
			if (!isdigit(ch)) {
				return false;
			}
			out = out * 10 + static_cast<unsigned int>(sDate[i] - '0');
		}
		return true;
	};

	unsigned int year = 0;
	unsigned int month = 0;
	unsigned int day = 0;
	bool found = false;
	if (sDate.size() == 8) {
		found = parse_digits(0, 4, year) && parse_digits(4, 2, month) && parse_digits(6, 2, day);
	} else if (sDate.size() == 10 && (sDate[4] == '-' || sDate[4] == '/') && sDate[7] == sDate[4]) {
		found = parse_digits(0, 4, year) && parse_digits(5, 2, month) && parse_digits(8, 2, day);
	}
	if (!found) {
		throw invalid_argument("Date [" + sDate + "] did not match a known format. try YYYY-MM-DD");
	}
	const bool leap_year = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
	const unsigned int days_in_month[] = {0,  31, leap_year ? 29U : 28U, 31, 30, 31, 30,
										  31, 31, 30,				 31, 30, 31};
	if (year == 0 || month == 0 || month > 12 || day == 0 || day > days_in_month[month]) {
		throw invalid_argument("Date [" + sDate + "] is not a valid calendar date");
	}
	ostringstream oss;
	oss << setfill('0') << std::setw(4) << year << "-" << std::setw(2) << month << "-" << std::setw(2) << day;
	return oss.str();
}

// Preserve the historical v200 normalization. Strict calendar/date syntax is
// part of v201 canonical payload validation, not a silent v200 migration.
static const string normalize_legacy_date(const std::string &sDate) {
	static const string formats[] = {"%4u-%2u-%2u", "%4u/%2u/%2u", "%4u%2u%2u"};
	if (sDate.size() < 8U) {
		throw invalid_argument("Date string too small for known formats");
	}
	unsigned int year = 0U;
	unsigned int month = 0U;
	unsigned int day = 0U;
	bool found = false;
	for (const string &format : formats) {
		if (sscanf(sDate.c_str(), format.c_str(), &year, &month, &day) == 3) {
			found = true;
			break;
		}
	}
	if (!found) {
		throw invalid_argument("Date [" + sDate + "] did not match a known format. try YYYY-MM-DD");
	}
	ostringstream oss;
	oss << year << "-" << setfill('0') << setw(2) << month << "-" << setfill('0') << setw(2) << day;
	return oss.str();
}

static bool is_valid_feature_char(const unsigned char ch) {
	return isalnum(ch) || ch == '_' || ch == '-' || ch == '.';
}

static vector<string> normalized_feature_names(const string &feature_names) {
	vector<string> features;
	boost::algorithm::split(features, feature_names, boost::is_any_of(","));
	unordered_set<string> seen;
	for (string &feature : features) {
		if (feature.empty()) {
			throw invalid_argument("feature-names must not contain empty entries");
		}
		for (const unsigned char ch : feature) {
			if (!is_valid_feature_char(ch)) {
				throw invalid_argument("feature-names entries may contain only ASCII letters, digits, '_', '-' and '.'");
			}
		}
		feature = boost::to_upper_copy(feature);
		if (!seen.insert(feature).second) {
			throw invalid_argument("feature-names must not contain duplicate entries");
		}
	}
	return features;
}

static vector<string> legacy_feature_names(const string &feature_names) {
	vector<string> features;
	boost::algorithm::split(features, boost::to_upper_copy(feature_names), boost::is_any_of(","));
	return features;
}

static void validate_extra_data(const string &extra_data) {
	if (extra_data.empty()) {
		throw invalid_argument("extra-data must not be empty");
	}
	if (extra_data.size() > LCC_API_PROPRIETARY_DATA_SIZE) {
		throw invalid_argument("extra-data must not exceed the runtime proprietary-data buffer size");
	}
	if (isspace(static_cast<unsigned char>(extra_data.front())) ||
		isspace(static_cast<unsigned char>(extra_data.back()))) {
		throw invalid_argument("extra-data must not start or end with whitespace");
	}
	for (const unsigned char ch : extra_data) {
		if (iscntrl(ch)) {
			throw invalid_argument("extra-data must not contain control characters");
		}
	}
}

static bool parse_version_limit(const string &version, vector<unsigned int> &out) {
	if (version.empty() || version.front() == '.' || version.back() == '.') {
		return false;
	}
	string segment;
	stringstream ss(version);
	while (getline(ss, segment, '.')) {
		if (segment.empty() || segment.size() > 4 || out.size() >= 3) {
			return false;
		}
		unsigned int value = 0;
		for (const char ch : segment) {
			if (!isdigit(static_cast<unsigned char>(ch))) {
				return false;
			}
			value = value * 10 + static_cast<unsigned int>(ch - '0');
		}
		out.push_back(value);
	}
	return !out.empty();
}

static int compare_versions(const vector<unsigned int> &lhs, const vector<unsigned int> &rhs) {
	const size_t max_size = max(lhs.size(), rhs.size());
	for (size_t i = 0; i < max_size; ++i) {
		const unsigned int l = i < lhs.size() ? lhs[i] : 0;
		const unsigned int r = i < rhs.size() ? rhs[i] : 0;
		if (l < r) {
			return -1;
		}
		if (l > r) {
			return 1;
		}
	}
	return 0;
}

static map<string, string> normalized_output_parameters(const map<string, string> &raw_values, bool v201,
											 bool allow_ip_binding, bool allow_env_selected_binding,
											 bool allow_weak_disk_label_binding) {
	map<string, string> values(raw_values);
	const auto begin = values.find(PARAM_BEGIN_DATE);
	if (begin != values.end()) {
		begin->second = v201 ? normalize_date(begin->second) : normalize_legacy_date(begin->second);
	}
	const auto expiry = values.find(PARAM_EXPIRY_DATE);
	if (expiry != values.end()) {
		expiry->second = v201 ? normalize_date(expiry->second) : normalize_legacy_date(expiry->second);
	}
	if (!v201) {
		return values;
	}
	if (begin != values.end() && expiry != values.end() && begin->second > expiry->second) {
		throw invalid_argument(string(PARAM_BEGIN_DATE) + " must not be greater than " + PARAM_EXPIRY_DATE);
	}
	const auto client_signature = values.find(PARAM_CLIENT_SIGNATURE);
	if (client_signature != values.end()) {
		validate_client_signature(client_signature->second, allow_ip_binding, allow_env_selected_binding,
							  allow_weak_disk_label_binding);
	}
	const auto extra_data = values.find(PARAM_EXTRA_DATA);
	if (extra_data != values.end()) {
		validate_extra_data(extra_data->second);
	}
	vector<unsigned int> begin_version;
	vector<unsigned int> end_version;
	const auto version_from = values.find(PARAM_VERSION_FROM);
	if (version_from != values.end() && !parse_version_limit(version_from->second, begin_version)) {
		throw invalid_argument(string(PARAM_VERSION_FROM) +
						   " must be one to three numeric components of at most four digits each");
	}
	const auto version_to = values.find(PARAM_VERSION_TO);
	if (version_to != values.end() && !parse_version_limit(version_to->second, end_version)) {
		throw invalid_argument(string(PARAM_VERSION_TO) + " must be one to three numeric components of at most four digits each");
	}
	if (!begin_version.empty() && !end_version.empty() && compare_versions(begin_version, end_version) > 0) {
		throw invalid_argument(string(PARAM_VERSION_FROM) + " must not be greater than " + PARAM_VERSION_TO);
	}
	return values;
}

static const string normalize_project_path(const string &project_path) {
	const fs::path rproject_path(project_path);
	if (!fs::exists(rproject_path) || !fs::is_directory(rproject_path)) {
		throw logic_error("Path " + project_path + " doesn't exist or is not a directory.");
	}
	fs::path normalized;
	const string rproject_path_str = rproject_path.string();
	if (rproject_path.string() == ".") {
		normalized = fs::current_path();
		// sometimes is_relative fails under wine: a linux path is taken for a relative path.
		normalized = fs::canonical(fs::current_path() / rproject_path);
	} else {
		normalized = fs::canonical(rproject_path);
	}
	return normalized.string();
}

static void create_license_path(const string &license_file_name) {
	const fs::path license_name(license_file_name);
	fs::path parentPath = license_name.parent_path();
	if (!parentPath.empty()) {
		if (!fs::exists(parentPath)) {
			if (!fs::create_directories(parentPath)) {
				throw runtime_error("Cannot create licenses directory [" + parentPath.string() + "]");
			}
		} else if (fs::is_regular_file(parentPath)) {
			throw runtime_error("trying to create folder [" + parentPath.string() +
								"] but there is a file with the same name. ");
		}
	}
}

static string string_define_from_header(const string &header, const string &define_name) {
	const string marker = "#define " + define_name + " \"";
	const size_t pos = header.find(marker);
	if (pos == string::npos) {
		return "";
	}
	const size_t value_start = pos + marker.size();
	const size_t value_end = header.find('"', value_start);
	if (value_end == string::npos) {
		return "";
	}
	return header.substr(value_start, value_end - value_start);
}

static size_t numeric_define_from_header(const string &header, const string &define_name) {
	const string marker = "#define " + define_name + " ";
	const size_t pos = header.find(marker);
	if (pos == string::npos) {
		throw runtime_error("v201 license issuance requires current public_key.h metadata: missing " + define_name);
	}
	const size_t value_start = pos + marker.size();
	const size_t value_end = header.find_first_of("\r\n", value_start);
	const string value = header.substr(value_start, value_end - value_start);
	size_t consumed = 0;
	size_t parsed = 0;
	try {
		parsed = static_cast<size_t>(stoull(value, &consumed, 10));
	} catch (const exception &) {
		throw runtime_error("v201 license issuance requires numeric public_key.h metadata: " + define_name);
	}
	if (consumed != value.size()) {
		throw runtime_error("v201 license issuance requires numeric public_key.h metadata: " + define_name);
	}
	return parsed;
}

static vector<unsigned char> public_key_bytes_from_header(const string &header) {
	const size_t define_pos = header.find("#define PUBLIC_KEY");
	if (define_pos == string::npos) {
		throw runtime_error("v201 license issuance requires generated PUBLIC_KEY bytes");
	}
	const size_t open_pos = header.find('{', define_pos);
	const size_t close_pos = header.find('}', open_pos);
	if (open_pos == string::npos || close_pos == string::npos || close_pos <= open_pos) {
		throw runtime_error("v201 license issuance found malformed generated PUBLIC_KEY bytes");
	}
	vector<unsigned char> bytes;
	string token;
	for (size_t i = open_pos + 1; i < close_pos; ++i) {
		const unsigned char ch = static_cast<unsigned char>(header[i]);
		if (isdigit(ch)) {
			token.push_back(static_cast<char>(ch));
			continue;
		}
		if (!token.empty()) {
			const unsigned long value = stoul(token);
			if (value > 255UL) {
				throw runtime_error("v201 license issuance found PUBLIC_KEY byte outside byte range");
			}
			bytes.push_back(static_cast<unsigned char>(value));
			token.clear();
		}
		if (ch != ',' && ch != '\\' && !isspace(ch)) {
			throw runtime_error("v201 license issuance found malformed generated PUBLIC_KEY bytes");
		}
	}
	if (!token.empty()) {
		const unsigned long value = stoul(token);
		if (value > 255UL) {
			throw runtime_error("v201 license issuance found PUBLIC_KEY byte outside byte range");
		}
		bytes.push_back(static_cast<unsigned char>(value));
	}
	if (bytes.empty()) {
		throw runtime_error("v201 license issuance found empty generated PUBLIC_KEY bytes");
	}
	return bytes;
}

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
		if (modulus_len == 1 || (public_key_der[offset + 1] & 0x80U) == 0) {
			throw runtime_error("Invalid RSA public key modulus encoding");
		}
		++offset;
		--modulus_len;
	} else if ((public_key_der[offset] & 0x80U) != 0) {
		throw runtime_error("Invalid RSA public key modulus encoding");
	}
	while (modulus_len > 0 && public_key_der[offset] == 0U) {
		++offset;
		--modulus_len;
	}
	if (modulus_len == 0) {
		throw runtime_error("Invalid RSA public key modulus");
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

static ProjectPublicMetadata read_project_public_metadata(const string &project_folder) {
	const fs::path project_path(project_folder);
	const string project_name = project_path.filename().string();
	const fs::path public_key_header = project_path / "include" / "licensecc" / project_name / PUBLIC_KEY_INC_FNAME;
	if (!fs::exists(public_key_header)) {
		throw runtime_error("v201 license issuance requires generated public key metadata: " +
							public_key_header.string());
	}
	ifstream input(public_key_header.string().c_str(), ios::binary);
	if (!input.is_open()) {
		throw runtime_error("Cannot read generated public key metadata [" + public_key_header.string() + "]");
	}
	const string header((istreambuf_iterator<char>(input)), istreambuf_iterator<char>());
	ProjectPublicMetadata metadata;
	metadata.key_id = string_define_from_header(header, "LCC_PUBLIC_KEY_ID");
	metadata.public_key_sha256 = string_define_from_header(header, "LCC_PUBLIC_KEY_SHA256");
	metadata.signature_algorithm = string_define_from_header(header, "LCC_SIGNATURE_ALGORITHM");
	metadata.public_key_len = numeric_define_from_header(header, "PUBLIC_KEY_LEN");
	metadata.public_key_bits = numeric_define_from_header(header, "LCC_PUBLIC_KEY_BITS");
	metadata.public_key_der = public_key_bytes_from_header(header);
	if (metadata.key_id.empty() || metadata.public_key_sha256.empty() || metadata.signature_algorithm.empty()) {
		throw runtime_error("v201 license issuance requires current public_key.h metadata. Regenerate project keys.");
	}
	if (metadata.signature_algorithm != LCC_SIGNATURE_ALGORITHM_RSA_PKCS1_SHA256) {
		throw runtime_error("Unsupported generated signature algorithm for v201 license issuance: " +
							metadata.signature_algorithm);
	}
	if (metadata.public_key_len != metadata.public_key_der.size()) {
		throw runtime_error("v201 license issuance public_key.h metadata mismatch: PUBLIC_KEY_LEN");
	}
	if (metadata.public_key_bits != rsa_public_key_bits(metadata.public_key_der)) {
		throw runtime_error("v201 license issuance public_key.h metadata mismatch: LCC_PUBLIC_KEY_BITS");
	}
	const string public_key_sha256 = sha256_hex(metadata.public_key_der);
	if (metadata.public_key_sha256 != public_key_sha256 || metadata.key_id != "sha256:" + public_key_sha256) {
		throw runtime_error("v201 license issuance public_key.h metadata mismatch: key ID");
	}
	return metadata;
}

static void validate_project_public_metadata_matches_private_key(const ProjectPublicMetadata &metadata,
																 const CryptoHelper &crypto) {
	if (metadata.public_key_der != crypto.exportPublicKey()) {
		throw runtime_error("v201 license issuance private key does not match generated public_key.h");
	}
}

static fs::path normalized_path(fs::path path) {
#if BOOST_VERSION >= 108700
	return path.lexically_normal();
#else
	path.normalize();
	return path;
#endif
}

static fs::path absolute_normalized_path(const fs::path &path) {
	return normalized_path(fs::absolute(path));
}

static string comparable_path_key(fs::path path) {
	path = absolute_normalized_path(path);
	path.make_preferred();
	string value = path.string();
#ifdef _WIN32
	transform(value.begin(), value.end(), value.begin(), [](const unsigned char ch) {
		return static_cast<char>(tolower(ch));
	});
#endif
	return value;
}

static bool path_is_under(const fs::path &child, const fs::path &parent) {
	string child_key = comparable_path_key(child);
	string parent_key = comparable_path_key(parent);
	if (child_key == parent_key) {
		return true;
	}
	if (!parent_key.empty() && parent_key.back() != fs::path::preferred_separator) {
		parent_key += fs::path::preferred_separator;
	}
	return child_key.size() > parent_key.size() && child_key.compare(0, parent_key.size(), parent_key) == 0;
}

static void validate_output_target(const string &license_file_name, const string &project_folder,
									const string &active_private_key_file) {
	const fs::path target = absolute_normalized_path(license_file_name);
	const fs::path project_root = absolute_normalized_path(project_folder);
	const fs::path active_private_key = absolute_normalized_path(active_private_key_file);
	const string filename = target.filename().string();

	// A caller may supply --primary-key outside the project folder.  Reject both
	// lexical spellings and existing filesystem aliases before the output is
	// opened, parsed, signed, or atomically published.
	if (file_publish::output_target_matches_input_file(target, active_private_key)) {
		throw runtime_error("Refusing to write a license over active private key [" + target.string() +
							"]. Choose an --" PARAM_LICENSE_OUTPUT + " different from --" PARAM_PRIMARY_KEY + ".");
	}
	if (filename == PRIVATE_KEY_FNAME ||
		file_publish::output_target_matches_input_file(target, project_root / PRIVATE_KEY_FNAME)) {
		throw runtime_error("Refusing to write a license over private key [" + target.string() + "]");
	}
	if (filename == PUBLIC_KEY_INC_FNAME) {
		throw runtime_error("Refusing to write a license over public key header [" + target.string() + "]");
	}
	if (filename == "licensecc_properties.h" || filename == "build_properties.h") {
		throw runtime_error("Refusing to write a license over project metadata [" + target.string() + "]");
	}
	if (path_is_under(target, project_root / "include")) {
		throw runtime_error("Refusing to write a license inside generated project metadata [" + target.string() + "]");
	}
}

static void write_file_atomically(const string &license_file_name, const string &contents) {
	const fs::path destination = absolute_normalized_path(license_file_name);
	if (fs::exists(destination) && fs::is_directory(destination)) {
		throw runtime_error("Can not create file [" + license_file_name + "].");
	}
	file_publish::write_file_atomically_replace(destination, contents);
}

static string read_file_contents(const string &file_name) {
	ifstream input(file_name.c_str(), ios::binary);
	if (!input.is_open()) {
		throw runtime_error("Existing output file [" + file_name + "] cannot be opened.");
	}
	return string((istreambuf_iterator<char>(input)), istreambuf_iterator<char>());
}

static string decode_existing_base64_license(const string &license_file_name, const string &encoded_license) {
	vector<uint8_t> decoded = unbase64(encoded_license);
	if (decoded.empty()) {
		throw runtime_error("Existing output file [" + license_file_name + "] is not valid base64 license data.");
	}
	return string(reinterpret_cast<const char *>(decoded.data()), decoded.size());
}

static const unordered_set<string> &existing_license_param_v200() {
	static const unordered_set<string> params = {
		LICENSE_VERSION,	   LICENSE_SIGNATURE, PARAM_BEGIN_DATE, PARAM_CLIENT_SIGNATURE,
		PARAM_EXPIRY_DATE, PARAM_VERSION_FROM, PARAM_VERSION_TO,	  PARAM_EXTRA_DATA,
	};
	return params;
}

static const unordered_set<string> &existing_license_param_v201() {
	static const unordered_set<string> params = {
		LICENSE_VERSION,	  LICENSE_CANONICAL_VERSION,	 LICENSE_SIGNATURE_VERSION,
		LICENSE_SIGNATURE_ALGORITHM, LICENSE_KEY_ID,			 LICENSE_SIGNATURE,
		PARAM_BEGIN_DATE,	  PARAM_CLIENT_SIGNATURE,		 PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH,
		PARAM_EXPIRY_DATE,	  PARAM_VERSION_FROM,			 PARAM_VERSION_TO,
		PARAM_EXTRA_DATA,
	};
	return params;
}

static void validate_existing_license_file(CSimpleIniA &ini, const string &license_file_name) {
	CSimpleIniA::TNamesDepend sections;
	ini.GetAllSections(sections);
	if (sections.empty()) {
		throw runtime_error("Existing output file [" + license_file_name + "] is not a license file.");
	}
	for (const auto &section : sections) {
		const string section_name(section.pItem);
		const vector<string> normalized_sections = normalized_feature_names(section_name);
		if (normalized_sections.size() != 1 || normalized_sections.front() != section_name) {
			throw runtime_error("Existing output file [" + license_file_name +
								"] contains a non-canonical license section [" + section_name + "].");
		}

		CSimpleIniA::TNamesDepend keys;
		ini.GetAllKeys(section.pItem, keys);
		const char *license_version = ini.GetValue(section.pItem, LICENSE_VERSION);
		const char *signature = ini.GetValue(section.pItem, LICENSE_SIGNATURE);
		const string version = license_version == nullptr ? string() : string(license_version);
		const unordered_set<string> *allowed_params = nullptr;
		if (version == to_string(LICENSE_FILE_VERSION_V200)) {
			allowed_params = &existing_license_param_v200();
		} else if (version == to_string(LICENSE_FILE_VERSION_V201)) {
			allowed_params = &existing_license_param_v201();
		} else {
			throw runtime_error("Existing output file [" + license_file_name + "] contains a non-license section [" +
								string(section.pItem) + "].");
		}
		for (const auto &key : keys) {
			const string key_name(key.pItem);
			if (allowed_params->find(key_name) == allowed_params->end()) {
				throw runtime_error("Existing output file [" + license_file_name +
									"] contains a non-canonical license key [" + key_name + "].");
			}
		}

		if (signature == nullptr || string(signature).empty()) {
			throw runtime_error("Existing output file [" + license_file_name + "] contains a non-license section [" +
								string(section.pItem) + "].");
		}
	}
}

static const string print_for_sign(const string &feature_name, const CSimpleIniA::TKeyVal *section) {
	stringstream buf;
	buf << boost::to_upper_copy(feature_name);
	for (auto it = section->begin(); it != section->end(); it++) {
		string key(it->first.pItem);
		if (key != LICENSE_SIGNATURE) {
			buf << boost::algorithm::trim_copy(key) << boost::algorithm::trim_copy(string(it->second));
		}
	}
	return buf.str();
}

static void add_v201_field(vector<v201::CanonicalField> &fields, const string &key, const char *value) {
	if (value != nullptr && string(value).size() > 0) {
		fields.push_back({key, value});
	}
}

static vector<v201::CanonicalField> v201_fields_for_section(const string &project_name, const string &feature_name,
															const CSimpleIniA &ini, const char *section_name) {
	vector<v201::CanonicalField> fields;
	add_v201_field(fields, LICENSE_VERSION, ini.GetValue(section_name, LICENSE_VERSION, nullptr));
	add_v201_field(fields, LICENSE_CANONICAL_VERSION, ini.GetValue(section_name, LICENSE_CANONICAL_VERSION, nullptr));
	add_v201_field(fields, LICENSE_SIGNATURE_VERSION, ini.GetValue(section_name, LICENSE_SIGNATURE_VERSION, nullptr));
	add_v201_field(fields, LICENSE_SIGNATURE_ALGORITHM, ini.GetValue(section_name, LICENSE_SIGNATURE_ALGORITHM, nullptr));
	add_v201_field(fields, LICENSE_KEY_ID, ini.GetValue(section_name, LICENSE_KEY_ID, nullptr));
	fields.push_back({"project", project_name});
	fields.push_back({"feature", boost::to_upper_copy(feature_name)});
	add_v201_field(fields, PARAM_BEGIN_DATE, ini.GetValue(section_name, PARAM_BEGIN_DATE, nullptr));
	add_v201_field(fields, PARAM_EXPIRY_DATE, ini.GetValue(section_name, PARAM_EXPIRY_DATE, nullptr));
	add_v201_field(fields, PARAM_VERSION_FROM, ini.GetValue(section_name, PARAM_VERSION_FROM, nullptr));
	add_v201_field(fields, PARAM_VERSION_TO, ini.GetValue(section_name, PARAM_VERSION_TO, nullptr));
	add_v201_field(fields, PARAM_CLIENT_SIGNATURE, ini.GetValue(section_name, PARAM_CLIENT_SIGNATURE, nullptr));
	add_v201_field(fields, PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH,
				   ini.GetValue(section_name, PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH, nullptr));
	add_v201_field(fields, PARAM_EXTRA_DATA, ini.GetValue(section_name, PARAM_EXTRA_DATA, nullptr));
	return fields;
}

static string v201_payload_for_section(const string &project_name, const string &feature_name,
									   const CSimpleIniA &ini, const char *section_name) {
	const v201::CanonicalPayloadResult canonical =
		v201::build_canonical_payload(v201_fields_for_section(project_name, feature_name, ini, section_name));
	if (!canonical.ok) {
		throw runtime_error("Cannot build v201 canonical payload: " + canonical.error);
	}
	return string(canonical.bytes.begin(), canonical.bytes.end());
}

static void validate_existing_license_signatures(CSimpleIniA &ini, const CryptoHelper &crypto,
												 const string &license_file_name, const string &project_name) {
	CSimpleIniA::TNamesDepend sections;
	ini.GetAllSections(sections);
	for (const auto &section : sections) {
		const char *signature = ini.GetValue(section.pItem, LICENSE_SIGNATURE);
		const char *license_version = ini.GetValue(section.pItem, LICENSE_VERSION);
		const string version = license_version == nullptr ? string() : string(license_version);
		string license_for_sign;
		if (version == to_string(LICENSE_FILE_VERSION_V201)) {
			license_for_sign = v201_payload_for_section(project_name, section.pItem, ini, section.pItem);
		} else {
			const CSimpleIniA::TKeyVal *section_values = ini.GetSection(section.pItem);
			license_for_sign = print_for_sign(section.pItem, section_values);
		}
		const string expected_signature = crypto.signString(license_for_sign);
		if (signature == nullptr || expected_signature != string(signature)) {
			throw runtime_error("Existing output file [" + license_file_name +
								"] contains an invalid signature in section [" + string(section.pItem) + "].");
		}
	}
}

License::License(const std::string *licenseName, const std::string &project_folder, bool base64)
	: m_license_file_version(LICENSE_FILE_VERSION),
	  m_target_license_format_max(LICENSE_FILE_VERSION_V200),
	  m_base64(base64),
	  m_license_fname(licenseName),
	  m_project_folder(normalize_project_path(project_folder)) {
	fs::path proj_folder(m_project_folder);
	// default feature = project name
	m_feature_names = proj_folder.filename().string();
	m_private_key = (proj_folder / PRIVATE_KEY_FNAME).string();
}

void License::write_license() {
	CSimpleIniA ini;
	bool existing_license_loaded = false;
	const fs::path project_path(m_project_folder);
	const string project_name = project_path.filename().string();
	const bool v201 = m_license_file_version == LICENSE_FILE_VERSION_V201;
	if (m_license_file_version > m_target_license_format_max) {
		throw invalid_argument(string("license-version ") + to_string(m_license_file_version) + " requires --" +
							   PARAM_TARGET_LICENSE_FORMAT_MAX + "=" + to_string(m_license_file_version) +
							   " or newer");
	}
	if (m_license_fname != nullptr) {
		validate_output_target(*m_license_fname, m_project_folder, m_private_key);
		const fs::path output_path(*m_license_fname);
		if (fs::exists(output_path)) {
			if (fs::is_directory(output_path)) {
				throw runtime_error("Can not create file [" + *m_license_fname + "].");
			}
			const string previous_license = read_file_contents(*m_license_fname);
			const string previous_ini =
				m_base64 ? decode_existing_base64_license(*m_license_fname, previous_license) : previous_license;
			SI_Error error = ini.LoadData(previous_ini);
			if (error != SI_Error::SI_OK) {
				throw runtime_error(
					"License file existing, but there were errors in loading it. Is it a license file?");
			}
			// v200 historically loaded and appended arbitrary existing INI
			// sections.  Its serialized/signature quirks are a deployed format
			// contract, so strict schema validation is deliberately a v201-only
			// safety invariant.  v201 never inherits an unreviewed legacy file.
			if (v201) {
				validate_existing_license_file(ini, *m_license_fname);
			}
			existing_license_loaded = true;
		}
	}

	const vector<string> feature_v = v201 ? normalized_feature_names(m_feature_names) : legacy_feature_names(m_feature_names);
	const map<string, string> output_values =
		normalized_output_parameters(values_map, v201, m_allow_ip_binding, m_allow_env_selected_binding,
									 m_allow_weak_disk_label_binding);
	unique_ptr<CryptoHelper> crypto(CryptoHelper::getInstance());
	crypto->loadPrivateKey_file(m_private_key);
	// v200 remains available for established legacy projects.  v201 is the
	// hardened issuance format, so it refuses weak keys before any output is
	// changed and directs operators to the explicit migration workflow.
	const size_t issuance_key_bits = rsa_public_key_bits(crypto->exportPublicKey());
	if (issuance_key_bits < 3072) {
		if (m_license_file_version == LICENSE_FILE_VERSION_V201) {
			throw runtime_error("v201 license issuance refuses the existing " + to_string(issuance_key_bits) +
							"-bit project key. It will not be rotated automatically; run `lccgen project migrate-weak-key "
							"--project-folder <project>` for the explicit backup-and-reissue procedure.");
		}
		cerr << "WARNING: issuing legacy v200 output with a " << issuance_key_bits
			 << "-bit project key for compatibility. The licensecc runtime rejects keys below 3072 bits, so this "
				"license will NOT verify in production."
			 << endl;
	}
	if (existing_license_loaded && v201) {
		validate_existing_license_signatures(ini, *crypto, *m_license_fname, project_name);
	}
	ProjectPublicMetadata public_metadata;
	if (m_license_file_version == LICENSE_FILE_VERSION_V201) {
		public_metadata = read_project_public_metadata(m_project_folder);
		validate_project_public_metadata_matches_private_key(public_metadata, *crypto);
	}

	for (const string feature : feature_v) {
		ini.SetLongValue(feature.c_str(), LICENSE_VERSION, m_license_file_version);
		if (m_license_file_version == LICENSE_FILE_VERSION_V201) {
			ini.SetValue(feature.c_str(), LICENSE_CANONICAL_VERSION, "1");
			ini.SetValue(feature.c_str(), LICENSE_SIGNATURE_VERSION, "1");
			ini.SetValue(feature.c_str(), LICENSE_SIGNATURE_ALGORITHM, public_metadata.signature_algorithm.c_str());
			ini.SetValue(feature.c_str(), LICENSE_KEY_ID, public_metadata.key_id.c_str());
		}
		for (const auto &it : output_values) {
			ini.SetValue(feature.c_str(), it.first.c_str(), it.second.c_str());
		}
		if (m_license_file_version == LICENSE_FILE_VERSION_V201) {
			const char *client_signature = ini.GetValue(feature.c_str(), PARAM_CLIENT_SIGNATURE, nullptr);
			if (client_signature != nullptr && string(client_signature).size() > 0) {
				const ClientSignatureInfo client_signature_info =
					validate_client_signature(client_signature, m_allow_ip_binding, m_allow_env_selected_binding,
											  m_allow_weak_disk_label_binding);
				ini.SetValue(feature.c_str(), PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH,
							 client_signature_info.source_strength.c_str());
			} else {
				ini.Delete(feature.c_str(), PARAM_CLIENT_SIGNATURE_SOURCE_STRENGTH);
			}
		}
		const string license_for_sign =
			m_license_file_version == LICENSE_FILE_VERSION_V201
				? v201_payload_for_section(project_name, feature, ini, feature.c_str())
				: print_for_sign(feature, ini.GetSection(feature.c_str()));
		const string signature = crypto->signString(license_for_sign);
		ini.SetValue(feature.c_str(), LICENSE_SIGNATURE, signature.c_str());
	}

	ostringstream serialized_license;
	if (ini.Save(serialized_license, true) != SI_Error::SI_OK) {
		throw runtime_error("Could not serialize license data.");
	}
	const string serialized_output = serialized_license.str();
	const string output = m_base64 ? base64(serialized_output.data(), serialized_output.size(), 0) : serialized_output;
	if (m_license_fname == nullptr) {
		cout << output;
	} else {
		if (!existing_license_loaded) {
			create_license_path(*m_license_fname);
		}
		write_file_atomically(*m_license_fname, output);
	}
}

void License::set_license_file_version(const std::string &license_version) {
	if (license_version == to_string(LICENSE_FILE_VERSION_V200)) {
		m_license_file_version = LICENSE_FILE_VERSION_V200;
		return;
	}
	if (license_version == to_string(LICENSE_FILE_VERSION_V201)) {
		m_license_file_version = LICENSE_FILE_VERSION_V201;
		return;
	}
	throw invalid_argument("license-version must be 200 or 201");
}

void License::set_target_license_format_max(const std::string &license_version) {
	if (license_version == to_string(LICENSE_FILE_VERSION_V200)) {
		m_target_license_format_max = LICENSE_FILE_VERSION_V200;
		return;
	}
	if (license_version == to_string(LICENSE_FILE_VERSION_V201)) {
		m_target_license_format_max = LICENSE_FILE_VERSION_V201;
		return;
	}
	throw invalid_argument("target-license-format-max must be 200 or 201");
}

void License::set_allow_weak_disk_label_binding(bool allow_weak_disk_label_binding) {
	m_allow_weak_disk_label_binding = allow_weak_disk_label_binding;
}

// TODO, split this code in multiple classes
void License::add_parameter(const std::string &param_name, const std::string &param_value) {
	if (LICENSE_OUTPUT_PARAM.find(param_name) != LICENSE_OUTPUT_PARAM.end()) {
		// Defer canonical/input validation until the final format is known. The
		// command-line parser's option iteration order is not a format contract,
		// and v200 must retain its established input behavior.
		if ((param_name == PARAM_VERSION_FROM || param_name == PARAM_VERSION_TO) && param_value == "0") {
			values_map.erase(param_name);
		} else {
			values_map[param_name] = param_value;
		}
	} else if (NO_OUTPUT_PARAM.find(param_name) == NO_OUTPUT_PARAM.end()) {
		throw invalid_argument(param_name + " not recognized");
	} else if (PARAM_FEATURE_NAMES == param_name) {
		if (param_value.find('[') != string::npos || param_value.find(']') != string::npos ||
			param_value.find('/') != string::npos || param_value.find('\\') != string::npos) {
			throw invalid_argument("feature name should not contain any of '[ ] / \\' characters.");
		}
		m_feature_names = param_value;
	} else if (PARAM_PRIMARY_KEY == param_name) {
		if (!fs::exists(param_value)) {
			cerr << "Primary key " << param_value << " not found." << endl;
			throw logic_error("Primary key [" + param_value + "] not found");
		}
		m_private_key = param_value;
	} else if (PARAM_LICENSE_FORMAT_VERSION == param_name) {
		set_license_file_version(param_value);
	} else if (PARAM_TARGET_LICENSE_FORMAT_MAX == param_name) {
		set_target_license_format_max(param_value);
	} else if (PARAM_LICENSE_OUTPUT == param_name || PARAM_PROJECT_FOLDER == param_name) {
		// just ignore
	} else {
		throw logic_error(param_name + " not recognized");
	}
}

void License::set_allow_ip_binding(bool allow_ip_binding) { m_allow_ip_binding = allow_ip_binding; }

void License::set_allow_env_selected_binding(bool allow_env_selected_binding) {
	m_allow_env_selected_binding = allow_env_selected_binding;
}
} /* namespace license */
