/*
 * Test on class HwIdentifier
 *
 *  Created on: Dec 26, 2019
 *      Author: devel
 */

#define BOOST_TEST_MODULE test_hw_identifier

#include <algorithm>
#include <array>
#include <boost/test/unit_test.hpp>
#include <fstream>
#include <iostream>
#include <stdio.h>
#include <cstring>
#include <stdexcept>
#include <boost/filesystem.hpp>
#include <licensecc_properties.h>
#include <licensecc_properties_test.h>

#include <licensecc/licensecc.h>
#include "../../../src/library/base/string_utils.h"
#include "../../../src/library/hw_identifier/disk_strategy.hpp"
#include "../../../src/library/hw_identifier/hw_identifier.hpp"

namespace license {
namespace test {
using namespace std;
using namespace license::hw_identifier;

static DiskInfo make_disk_info(const bool preferred, const char* label,
							   const std::array<unsigned char, 8>* disk_sn = nullptr) {
	DiskInfo disk_info = {};
	disk_info.preferred = preferred;
	if (label != nullptr) {
		license::mstrlcpy(disk_info.label, label, sizeof(disk_info.label));
		disk_info.label_initialized = true;
	}
	if (disk_sn != nullptr) {
		std::copy(disk_sn->begin(), disk_sn->end(), disk_info.disk_sn);
		disk_info.sn_initialized = true;
	}
	return disk_info;
}

/**
 * Test get and set and compare hardware identifier data
 */
BOOST_AUTO_TEST_CASE(set_and_compare_data) {
	array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> data = {0xFF, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42};
	HwIdentifier pc_id;
	pc_id.set_data(data);
	data[0] = data[0] & 0x1f;
	BOOST_CHECK_MESSAGE(pc_id.data_match(data), "Data match");
}
/**
 * Test get and set and compare hardware identifier data
 */
BOOST_AUTO_TEST_CASE(compare_wrong_data) {
	array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> data = {0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42};
	HwIdentifier pc_id;
	pc_id.set_data(data);
	data[4] = 0;
	BOOST_CHECK_MESSAGE(!pc_id.data_match(data), "Data shouldn't match");
}

/**
 * Print a hardware identifier and read it from the same string, check the data matches
 */
BOOST_AUTO_TEST_CASE(print_and_read) {
	array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> data = {0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42};
	HwIdentifier pc_id;
	pc_id.set_data(data);
	pc_id.set_identification_strategy(LCC_API_HW_IDENTIFICATION_STRATEGY::STRATEGY_ETHERNET);
	pc_id.set_use_environment_var(true);
	string pc_id_str = pc_id.print();
	cout << pc_id_str << endl;
	const HwIdentifier id2(pc_id_str);
	BOOST_CHECK_MESSAGE(id2.get_identification_strategy() == LCC_API_HW_IDENTIFICATION_STRATEGY::STRATEGY_ETHERNET,
						"Strategy decoded correctly");
	BOOST_CHECK_MESSAGE(id2.uses_environment_var(), "Environment-selected flag decoded correctly");
	BOOST_CHECK_MESSAGE(!id2.uses_weak_source(), "Strong-source flag decoded correctly");
	BOOST_CHECK_EQUAL(id2.source_strength_metadata(), "weak-env-selected-ethernet-mac");
	BOOST_CHECK_MESSAGE(id2.data_match(data), "Data deserialized correctly");
}

BOOST_AUTO_TEST_CASE(weak_disk_source_flag_round_trips_and_marks_source_strength) {
	array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> data = {0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42};
	HwIdentifier pc_id;
	pc_id.set_identification_strategy(LCC_API_HW_IDENTIFICATION_STRATEGY::STRATEGY_DISK);
	pc_id.set_data(data);
	pc_id.set_use_weak_source(true);

	const HwIdentifier decoded(pc_id.print());
	BOOST_CHECK(decoded.uses_weak_source());
	BOOST_CHECK_EQUAL(decoded.source_strength_metadata(), "weak-disk-label");
	BOOST_CHECK_MESSAGE(decoded.data_match(data), "Weak disk data deserialized correctly");
}

BOOST_AUTO_TEST_CASE(weak_mutable_disk_source_flag_round_trips_and_marks_source_strength) {
	array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> data = {0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42};
	HwIdentifier pc_id;
	pc_id.set_identification_strategy(LCC_API_HW_IDENTIFICATION_STRATEGY::STRATEGY_DISK);
	pc_id.set_data(data);
	pc_id.set_use_weak_mutable_disk_source(true);

	const HwIdentifier decoded(pc_id.print());
	BOOST_CHECK(decoded.uses_weak_source());
	BOOST_CHECK_EQUAL(decoded.source_strength_metadata(), "weak-disk-mutable");
	BOOST_CHECK_MESSAGE(decoded.data_match(data), "Weak mutable disk data deserialized correctly");
}

BOOST_AUTO_TEST_CASE(weak_source_flag_is_rejected_for_non_disk_identifiers) {
	array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA> data = {0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42};
	HwIdentifier pc_id;
	pc_id.set_identification_strategy(LCC_API_HW_IDENTIFICATION_STRATEGY::STRATEGY_ETHERNET);
	pc_id.set_data(data);
	pc_id.set_use_weak_source(true);

	BOOST_CHECK_THROW(HwIdentifier(pc_id.print()), logic_error);
}

BOOST_AUTO_TEST_CASE(disk_identifier_prefers_serial_over_label) {
	const std::array<unsigned char, 8> serial = {0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08};
	const std::vector<DiskInfo> disk_infos = {make_disk_info(true, "SYSTEM", &serial)};
	std::vector<array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>> identifiers;

	BOOST_CHECK_EQUAL(collectDiskIdentifierData(disk_infos, identifiers, false), FUNC_RET_OK);

	BOOST_REQUIRE_EQUAL(identifiers.size(), 1U);
	for (std::size_t i = 0; i < identifiers[0].size(); ++i) {
		BOOST_CHECK_EQUAL(static_cast<int>(identifiers[0][i]), static_cast<int>(serial[i]));
	}
	BOOST_CHECK_NE(static_cast<char>(identifiers[0][0]), 'S');
}

BOOST_AUTO_TEST_CASE(disk_identifier_rejects_label_only_without_weak_opt_in) {
	const std::vector<DiskInfo> disk_infos = {make_disk_info(true, "SYSTEM", nullptr)};
	std::vector<array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>> identifiers;

	BOOST_CHECK(!disk_info_has_strong_identifier(disk_infos[0]));
	BOOST_CHECK(disk_info_has_label_fallback_identifier(disk_infos[0]));
	BOOST_CHECK_EQUAL(collectDiskIdentifierData(disk_infos, identifiers, false), FUNC_RET_NOT_AVAIL);
	BOOST_CHECK(identifiers.empty());
}

BOOST_AUTO_TEST_CASE(disk_identifier_allows_label_only_with_weak_opt_in) {
	const std::vector<DiskInfo> disk_infos = {make_disk_info(true, "SYSTEM", nullptr)};
	std::vector<array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>> identifiers;
	std::vector<DiskIdentifierData> identifiers_with_source;

	BOOST_CHECK_EQUAL(collectDiskIdentifierData(disk_infos, identifiers, true), FUNC_RET_OK);
	BOOST_CHECK_EQUAL(collectDiskIdentifierDataWithSource(disk_infos, identifiers_with_source, true), FUNC_RET_OK);

	BOOST_REQUIRE_EQUAL(identifiers.size(), 1U);
	BOOST_CHECK_EQUAL(static_cast<char>(identifiers[0][0]), 'S');
	BOOST_CHECK_EQUAL(static_cast<char>(identifiers[0][1]), 'Y');
	BOOST_CHECK_EQUAL(static_cast<char>(identifiers[0][2]), 'S');
	BOOST_CHECK_EQUAL(static_cast<char>(identifiers[0][3]), 'T');
	BOOST_CHECK_EQUAL(static_cast<char>(identifiers[0][4]), 'E');
	BOOST_CHECK_EQUAL(static_cast<char>(identifiers[0][5]), 'M');
	BOOST_REQUIRE_EQUAL(identifiers_with_source.size(), 1U);
	BOOST_CHECK_EQUAL(identifiers_with_source[0].source_strength, DISK_IDENTIFIER_WEAK_LABEL);
	BOOST_CHECK_EQUAL(static_cast<char>(identifiers_with_source[0].data[0]), 'S');
}

BOOST_AUTO_TEST_CASE(disk_identifier_treats_mutable_volume_serial_as_weak_fallback) {
	const std::array<unsigned char, 8> mutable_serial = {0x01, 0x02, 0x03, 0x04, 0, 0, 0, 0};
	DiskInfo disk_info = make_disk_info(true, "SYSTEM", &mutable_serial);
	disk_info.identifier_source = DISK_IDENTIFIER_SOURCE_MUTABLE_VOLUME;
	const std::vector<DiskInfo> disk_infos = {disk_info};
	std::vector<array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>> identifiers;
	std::vector<DiskIdentifierData> identifiers_with_source;

	BOOST_CHECK(!disk_info_has_strong_identifier(disk_infos[0]));
	BOOST_CHECK_EQUAL(collectDiskIdentifierData(disk_infos, identifiers, false), FUNC_RET_NOT_AVAIL);
	BOOST_CHECK_EQUAL(collectDiskIdentifierDataWithSource(disk_infos, identifiers_with_source, true), FUNC_RET_OK);
	BOOST_REQUIRE_EQUAL(identifiers_with_source.size(), 1U);
	BOOST_CHECK_EQUAL(identifiers_with_source[0].source_strength, DISK_IDENTIFIER_WEAK_MUTABLE_VOLUME);
	BOOST_CHECK_EQUAL(static_cast<int>(identifiers_with_source[0].data[0]), 0x01);
}

BOOST_AUTO_TEST_CASE(disk_identifier_treats_zero_serial_as_missing_metadata) {
	const std::array<unsigned char, 8> zero_serial = {};
	const std::vector<DiskInfo> disk_infos = {make_disk_info(true, "SYSTEM", &zero_serial)};
	std::vector<array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>> identifiers;

	BOOST_CHECK(!disk_info_has_strong_identifier(disk_infos[0]));
	BOOST_CHECK_EQUAL(collectDiskIdentifierData(disk_infos, identifiers, false), FUNC_RET_NOT_AVAIL);
	BOOST_CHECK(identifiers.empty());

	BOOST_CHECK_EQUAL(collectDiskIdentifierData(disk_infos, identifiers, true), FUNC_RET_OK);
	BOOST_REQUIRE_EQUAL(identifiers.size(), 1U);
	BOOST_CHECK_EQUAL(static_cast<char>(identifiers[0][0]), 'S');
}

BOOST_AUTO_TEST_CASE(disk_identifier_orders_preferred_strong_ids_first) {
	const std::array<unsigned char, 8> first_serial = {0x0a, 0, 0, 0, 0, 0, 0, 0};
	const std::array<unsigned char, 8> second_serial = {0x0b, 0, 0, 0, 0, 0, 0, 0};
	const std::vector<DiskInfo> disk_infos = {
		make_disk_info(false, "DATA", &second_serial),
		make_disk_info(true, "SYSTEM", &first_serial)
	};
	std::vector<array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>> identifiers;

	BOOST_CHECK_EQUAL(collectDiskIdentifierData(disk_infos, identifiers, false), FUNC_RET_OK);

	BOOST_REQUIRE_EQUAL(identifiers.size(), 2U);
	BOOST_CHECK_EQUAL(static_cast<int>(identifiers[0][0]), 0x0a);
	BOOST_CHECK_EQUAL(static_cast<int>(identifiers[1][0]), 0x0b);
}

}  // namespace test
}  // namespace license
