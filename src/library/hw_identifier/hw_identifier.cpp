/*
 * hw_identifier.cpp
 *
 *  Created on: Dec 22, 2019
 *      Author: GC
 */

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <vector>
#include "hw_identifier.hpp"
#include "../base/base64.h"

namespace license {
namespace hw_identifier {

using namespace std;

constexpr size_t HW_IDENTIFIER_ENCODED_SEPARATOR_COUNT = 2;
constexpr uint8_t HW_IDENTIFIER_ENV_SELECTED_FLAG = 0x40;
constexpr uint8_t HW_IDENTIFIER_WEAK_DISK_LABEL_FLAG = 0x01;
constexpr uint8_t HW_IDENTIFIER_WEAK_DISK_MUTABLE_FLAG = 0x02;
constexpr uint8_t HW_IDENTIFIER_WEAK_DISK_SOURCE_FLAGS =
	HW_IDENTIFIER_WEAK_DISK_LABEL_FLAG | HW_IDENTIFIER_WEAK_DISK_MUTABLE_FLAG;
constexpr uint8_t HW_IDENTIFIER_ALLOWED_CONTROL_FLAGS =
	HW_IDENTIFIER_ENV_SELECTED_FLAG | HW_IDENTIFIER_WEAK_DISK_SOURCE_FLAGS;
constexpr uint8_t HW_IDENTIFIER_MAX_SUPPORTED_STRATEGY = STRATEGY_DISK;

static vector<uint8_t> decode_identifier(const string& param) {
	if (param.empty()) {
		throw logic_error("empty identifier");
	}
	string encoded;
	encoded.reserve(param.size());
	size_t separators = 0;
	for (const unsigned char ch : param) {
		if (ch == '-') {
			++separators;
			encoded += '\n';
			continue;
		}
		if (std::isspace(ch) || std::iscntrl(ch)) {
			throw logic_error("identifier contains whitespace or control characters");
		}
		encoded += static_cast<char>(ch);
	}
	if (separators != HW_IDENTIFIER_ENCODED_SEPARATOR_COUNT) {
		throw logic_error("identifier is not in canonical format");
	}
	return unbase64(encoded);
}

HwIdentifier::HwIdentifier() {}

HwIdentifier::HwIdentifier(const std::string& param) {
	vector<uint8_t> decoded = decode_identifier(param);
	if (decoded.size() != HW_IDENTIFIER_PROPRIETARY_DATA + 1) {
		throw logic_error("wrong identifier size " + param);
	}
	if ((decoded[0] & ~HW_IDENTIFIER_ALLOWED_CONTROL_FLAGS) != 0) {
		throw logic_error("identifier contains unsupported control flags " + param);
	}
	if ((decoded[1] >> 5) > HW_IDENTIFIER_MAX_SUPPORTED_STRATEGY) {
		throw logic_error("identifier contains unsupported strategy " + param);
	}
	if ((decoded[0] & HW_IDENTIFIER_WEAK_DISK_SOURCE_FLAGS) == HW_IDENTIFIER_WEAK_DISK_SOURCE_FLAGS) {
		throw logic_error("identifier contains multiple weak disk source flags " + param);
	}
	if ((decoded[0] & HW_IDENTIFIER_WEAK_DISK_SOURCE_FLAGS) != 0 &&
		static_cast<LCC_API_HW_IDENTIFICATION_STRATEGY>(decoded[1] >> 5) != STRATEGY_DISK) {
		throw logic_error("identifier contains weak-source flag for non-disk strategy " + param);
	}
	std::copy_n(decoded.begin(), HW_IDENTIFIER_PROPRIETARY_DATA + 1, m_data.begin());
	if (print() != param) {
		throw logic_error("identifier is not canonical " + param);
	}
}

HwIdentifier::~HwIdentifier() {}

HwIdentifier::HwIdentifier(const HwIdentifier& other) : m_data(other.m_data) {}

void HwIdentifier::set_identification_strategy(LCC_API_HW_IDENTIFICATION_STRATEGY strategy) {
	if (strategy == STRATEGY_NONE || strategy == STRATEGY_DEFAULT || strategy > STRATEGY_DISK) {
		throw logic_error("Only known strategies are permitted");
	}
	uint8_t stratMov = (strategy << 5);
	m_data[1] = (m_data[1] & 0x1F) | stratMov;
}

void HwIdentifier::set_use_environment_var(bool use_env_var) {
	if (use_env_var) {
		m_data[0] = m_data[0] | 0x40;
	} else {
		m_data[0] = m_data[0] & ~0x40;
	}
}

bool HwIdentifier::uses_environment_var() const {
	return (m_data[0] & HW_IDENTIFIER_ENV_SELECTED_FLAG) != 0;
}

void HwIdentifier::set_use_weak_source(bool use_weak_source) {
	if (use_weak_source) {
		m_data[0] = (m_data[0] & ~HW_IDENTIFIER_WEAK_DISK_SOURCE_FLAGS) | HW_IDENTIFIER_WEAK_DISK_LABEL_FLAG;
	} else {
		m_data[0] = m_data[0] & ~HW_IDENTIFIER_WEAK_DISK_LABEL_FLAG;
	}
}

void HwIdentifier::set_use_weak_mutable_disk_source(bool use_weak_mutable_disk_source) {
	if (use_weak_mutable_disk_source) {
		m_data[0] = (m_data[0] & ~HW_IDENTIFIER_WEAK_DISK_SOURCE_FLAGS) | HW_IDENTIFIER_WEAK_DISK_MUTABLE_FLAG;
	} else {
		m_data[0] = m_data[0] & ~HW_IDENTIFIER_WEAK_DISK_MUTABLE_FLAG;
	}
}

bool HwIdentifier::uses_weak_source() const {
	return (m_data[0] & HW_IDENTIFIER_WEAK_DISK_SOURCE_FLAGS) != 0;
}

std::string HwIdentifier::source_strength_metadata() const {
	const bool env_selected = uses_environment_var();
	const bool weak_source = uses_weak_source();
	const LCC_API_HW_IDENTIFICATION_STRATEGY strategy = get_identification_strategy();
	if (weak_source && strategy != STRATEGY_DISK) {
		throw logic_error("weak-source metadata is only supported for disk identifiers");
	}
	switch (strategy) {
		case STRATEGY_ETHERNET:
			return env_selected ? "weak-env-selected-ethernet-mac" : "strong-ethernet-mac";
		case STRATEGY_IP_ADDRESS:
			return env_selected ? "weak-env-selected-ip-address" : "weak-ip-address";
		case STRATEGY_DISK:
			if ((m_data[0] & HW_IDENTIFIER_WEAK_DISK_LABEL_FLAG) != 0) {
				return env_selected ? "weak-env-selected-disk-label" : "weak-disk-label";
			}
			if ((m_data[0] & HW_IDENTIFIER_WEAK_DISK_MUTABLE_FLAG) != 0) {
				return env_selected ? "weak-env-selected-disk-mutable" : "weak-disk-mutable";
			}
			return env_selected ? "weak-env-selected-disk-serial-or-uuid" : "strong-disk-serial-or-uuid";
		default:
			throw logic_error("unsupported identifier strategy");
	}
}

void HwIdentifier::set_data(const std::array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>& data) {
	m_data[1] = (m_data[1] & (~0x1f)) | (data[0] & 0x1f);
	for (int i = 1; i < HW_IDENTIFIER_PROPRIETARY_DATA; i++) {
		m_data[i + 1] = data[i];
	}
}

std::string HwIdentifier::print() const {
	string result = base64(m_data.data(), m_data.size(), 5);
	std::replace(result.begin(), result.end(), '\n', '-');
	return result.substr(0, result.size() - 1);
}

LCC_API_HW_IDENTIFICATION_STRATEGY HwIdentifier::get_identification_strategy() const {
	uint8_t stratMov = m_data[1] >> 5;
	return static_cast<LCC_API_HW_IDENTIFICATION_STRATEGY>(stratMov);
}

bool HwIdentifier::data_match(const std::array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>& data) const {
	bool equals = true;
	for (int i = 0; i < HW_IDENTIFIER_PROPRIETARY_DATA && equals; i++) {
		equals = (i == 0) ? ((data[i] & 0x1f) == (m_data[i + 1] & 0x1f)) : (data[i] == m_data[i + 1]);
	}
	return equals;
}

bool operator==(const HwIdentifier& lhs, const HwIdentifier& rhs) {
	bool equals = lhs.get_identification_strategy() == rhs.get_identification_strategy();
	equals = equals && lhs.uses_weak_source() == rhs.uses_weak_source();
	for (int i = 0; i < HW_IDENTIFIER_PROPRIETARY_DATA && equals; i++) {
		equals = (i == 0) ? ((rhs.m_data[i + 1] & 0x1f) == (lhs.m_data[i + 1] & 0x1f))
						  : (lhs.m_data[i + 1] == rhs.m_data[i + 1]);
	}
	return equals;
}

}  // namespace hw_identifier
} /* namespace license */
