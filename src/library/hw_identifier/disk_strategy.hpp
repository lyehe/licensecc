/*
 * disk_strategy.hpp
 *
 *  Created on: Jan 14, 2020
 *      Author: devel
 */

#ifndef SRC_LIBRARY_PC_IDENTIFIER_DISK_STRATEGY_HPP_
#define SRC_LIBRARY_PC_IDENTIFIER_DISK_STRATEGY_HPP_

#include "identification_strategy.hpp"
#include "../os/os.h"

namespace license {
namespace hw_identifier {

enum DiskIdentifierSourceStrength {
	DISK_IDENTIFIER_STRONG = 0,
	DISK_IDENTIFIER_WEAK_LABEL = 1,
	DISK_IDENTIFIER_WEAK_MUTABLE_VOLUME = 2
};

struct DiskIdentifierData {
	DiskIdentifierData() : data(), source_strength(DISK_IDENTIFIER_STRONG) {}
	DiskIdentifierData(const std::array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>& data,
					   DiskIdentifierSourceStrength source_strength)
		: data(data), source_strength(source_strength) {}
	std::array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> data;
	DiskIdentifierSourceStrength source_strength;
};

bool disk_info_has_strong_identifier(const DiskInfo& disk_info);
bool disk_info_has_label_fallback_identifier(const DiskInfo& disk_info);
FUNCTION_RETURN collectDiskIdentifierDataWithSource(const std::vector<DiskInfo>& disk_infos,
													std::vector<DiskIdentifierData>& v_disk_id,
													bool allow_label_fallback);
FUNCTION_RETURN collectDiskIdentifierData(const std::vector<DiskInfo>& disk_infos,
										  std::vector<std::array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>>& v_disk_id,
										  bool allow_label_fallback);

class DiskStrategy : public IdentificationStrategy {
public:
	inline DiskStrategy(){};
	virtual ~DiskStrategy();
	virtual LCC_API_HW_IDENTIFICATION_STRATEGY identification_strategy() const;
	virtual std::vector<HwIdentifier> alternative_ids() const;
};

}  // namespace hw_identifier
} /* namespace license */

#endif /* SRC_LIBRARY_PC_IDENTIFIER_DISK_STRATEGY_HPP_ */
