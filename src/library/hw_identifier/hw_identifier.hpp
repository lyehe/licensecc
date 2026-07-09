/*
 * hw_identifier.h
 *
 *  Created on: Dec 22, 2019
 *      Author: GC
 */

#ifndef SRC_LIBRARY_PC_IDENTIFIER_PC_IDENTIFIER_HPP_
#define SRC_LIBRARY_PC_IDENTIFIER_PC_IDENTIFIER_HPP_

#include <array>
#include <cstdint>
#include <iostream>
#include <string>

#include <licensecc_properties.h>
#include "../../../include/licensecc/datatypes.h"
#include "../os/execution_environment.hpp"
#include "../os/cpu_info.hpp"

namespace license {
namespace hw_identifier {

#define HW_IDENTIFIER_PROPRIETARY_DATA 7

/**
 * Wire-format of the 8-byte m_data buffer (m_data[0] .. m_data[7]).
 * This byte layout is a compatibility contract with every issued license: it is
 * what print() base64-encodes and what the string constructor decodes.
 *
 * m_data[0]:
 *   bit 6      = ENV_VAR_FLAG: environment variable was used to generate the pc_id.
 *   bits 7,5-0 = unused / reserved.
 * m_data[1]:
 *   bits 7-6-5 = identification strategy (LCC_API_HW_IDENTIFICATION_STRATEGY),
 *                stored as strategy << STRATEGY_SHIFT.
 *   bits 4-0   = low 5 bits of proprietary data byte 0 (DATA1_PAYLOAD_MASK).
 * m_data[2-7]: proprietary strategy data bytes 1-6 verbatim.
 */

class HwIdentifier {
private:
	// Strategy occupies the top 3 bits of m_data[1]; the low 5 bits carry payload.
	static constexpr uint8_t STRATEGY_SHIFT = 5;
	static constexpr uint8_t DATA1_PAYLOAD_MASK = 0x1F;
	// Environment-variable flag lives in m_data[0].
	static constexpr uint8_t ENV_VAR_FLAG = 0x40;

	std::array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA + 1> m_data = {};
	friend bool operator==(const HwIdentifier &lhs, const HwIdentifier &rhs);

public:
	HwIdentifier();
	HwIdentifier(const std::string &param);
	virtual ~HwIdentifier();
	HwIdentifier(const HwIdentifier &other);
	void set_identification_strategy(LCC_API_HW_IDENTIFICATION_STRATEGY strategy);
	LCC_API_HW_IDENTIFICATION_STRATEGY get_identification_strategy() const;
	void set_use_environment_var(bool use_env_var);
	void set_data(const std::array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> &data);
	bool data_match(const std::array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> &data) const;
	std::string print() const;
	friend std::ostream &operator<<(std::ostream &output, const HwIdentifier &d) {
		output << d.print();
		return output;
	};
};


}  // namespace hw_identifier
} /* namespace license */

#endif /* SRC_LIBRARY_PC_IDENTIFIER_PC_IDENTIFIER_HPP_ */
