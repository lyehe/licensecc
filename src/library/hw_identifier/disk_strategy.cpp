/*
 * disk_strategy.cpp
 *
 *  Created on: Jan 14, 2020
 *      Author: devel
 */
#include <string.h>
#include "../os/os.h"
#include "disk_strategy.hpp"

#ifndef LCC_ALLOW_WEAK_DISK_LABEL_BINDING
#define LCC_ALLOW_WEAK_DISK_LABEL_BINDING false
#endif

using namespace std;
namespace license {
namespace hw_identifier {

static array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> generate_id_by_sn(const DiskInfo &disk_info) {
	array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> a_disk_id = {};
	size_t size = min((size_t) HW_IDENTIFIER_PROPRIETARY_DATA,
			sizeof(disk_info.disk_sn));
	memcpy(&a_disk_id[0], disk_info.disk_sn, size);

	return a_disk_id;
}

static array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> generate_id_by_label(const DiskInfo &disk_info) {
	array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> a_disk_id = {};
	strncpy((char *)&a_disk_id[0], disk_info.label, a_disk_id.size() - 1);
	return a_disk_id;
}

static bool disk_sn_has_nonzero_bytes(const DiskInfo& disk_info) {
	for (const auto byte : disk_info.disk_sn) {
		if (byte != 0) {
			return true;
		}
	}
	return false;
}

bool disk_info_has_strong_identifier(const DiskInfo& disk_info) {
	return disk_info.sn_initialized && disk_sn_has_nonzero_bytes(disk_info) &&
		   disk_info.identifier_source != DISK_IDENTIFIER_SOURCE_MUTABLE_VOLUME;
}

static bool disk_info_has_weak_mutable_identifier(const DiskInfo& disk_info) {
	return disk_info.sn_initialized && disk_sn_has_nonzero_bytes(disk_info) &&
		   disk_info.identifier_source == DISK_IDENTIFIER_SOURCE_MUTABLE_VOLUME;
}

bool disk_info_has_label_fallback_identifier(const DiskInfo& disk_info) {
	return disk_info.label_initialized && disk_info.label[0] != '\0';
}

FUNCTION_RETURN collectDiskIdentifierDataWithSource(const std::vector<DiskInfo>& disk_infos,
													vector<DiskIdentifierData> &v_disk_id,
													const bool allow_label_fallback) {
	if (disk_infos.size() == 0) {
		return FUNC_RET_NOT_AVAIL;
	}

	v_disk_id.reserve(disk_infos.size());
	for (int j = 0; j < 2; j++) {
		bool preferred = (j == 0);
		for (size_t i = 0; i < disk_infos.size(); i++) {
			if (disk_infos[i].preferred == preferred) {
				if (disk_info_has_strong_identifier(disk_infos[i])) {
					array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> a_disk_id = generate_id_by_sn(disk_infos[i]);
					v_disk_id.push_back({a_disk_id, DISK_IDENTIFIER_STRONG});
					continue;
				}
				if (allow_label_fallback && disk_info_has_weak_mutable_identifier(disk_infos[i])) {
					array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> a_disk_id = generate_id_by_sn(disk_infos[i]);
					v_disk_id.push_back({a_disk_id, DISK_IDENTIFIER_WEAK_MUTABLE_VOLUME});
					continue;
				}
				if (allow_label_fallback && disk_info_has_label_fallback_identifier(disk_infos[i])) {
					array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> l_disk_id = generate_id_by_label(disk_infos[i]);
					v_disk_id.push_back({l_disk_id, DISK_IDENTIFIER_WEAK_LABEL});
				}
			}
		}
	}
	return v_disk_id.size() > 0 ? FUNC_RET_OK : FUNC_RET_NOT_AVAIL;
}

FUNCTION_RETURN collectDiskIdentifierData(const std::vector<DiskInfo>& disk_infos,
										  vector<array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>> &v_disk_id,
										  const bool allow_label_fallback) {
	vector<DiskIdentifierData> source_data;
	const FUNCTION_RETURN result = collectDiskIdentifierDataWithSource(disk_infos, source_data, allow_label_fallback);
	if (result != FUNC_RET_OK) {
		return result;
	}
	v_disk_id.reserve(source_data.size());
	for (const DiskIdentifierData &entry : source_data) {
		v_disk_id.push_back(entry.data);
	}
	return FUNC_RET_OK;
}

static FUNCTION_RETURN generate_disk_pc_id(vector<DiskIdentifierData> &v_disk_id) {
	std::vector<DiskInfo> disk_infos;
	FUNCTION_RETURN result_diskinfos = getDiskInfos(disk_infos);
	if (result_diskinfos != FUNC_RET_OK) {
		return result_diskinfos;
	}
	return collectDiskIdentifierDataWithSource(disk_infos, v_disk_id, LCC_ALLOW_WEAK_DISK_LABEL_BINDING);
}

DiskStrategy::~DiskStrategy() {}

LCC_API_HW_IDENTIFICATION_STRATEGY DiskStrategy::identification_strategy() const {
	return LCC_API_HW_IDENTIFICATION_STRATEGY::STRATEGY_DISK;
}

std::vector<HwIdentifier> DiskStrategy::alternative_ids() const {
	vector<DiskIdentifierData> data;
	FUNCTION_RETURN result = generate_disk_pc_id(data);
	vector<HwIdentifier> identifiers;
	if (result == FUNC_RET_OK) {
		identifiers.reserve(data.size());
		for (auto &it : data) {
			HwIdentifier pc_id;
			pc_id.set_identification_strategy(identification_strategy());
			pc_id.set_data(it.data);
			if (it.source_strength == DISK_IDENTIFIER_WEAK_LABEL) {
				pc_id.set_use_weak_source(true);
			} else if (it.source_strength == DISK_IDENTIFIER_WEAK_MUTABLE_VOLUME) {
				pc_id.set_use_weak_mutable_disk_source(true);
			}
			identifiers.push_back(pc_id);
		}
	}
	return identifiers;
}

}  // namespace hw_identifier
} /* namespace license */
