#define BOOST_TEST_MODULE test_windows_disk_info

#include <array>
#include <boost/test/unit_test.hpp>
#include <string>
#include <vector>

#include "../../../src/library/os/os.h"
#include "../../../src/library/hw_identifier/disk_strategy.hpp"

namespace license {
namespace test {

BOOST_AUTO_TEST_CASE(append_windows_disk_info_uses_stable_fields_and_order) {
	std::vector<DiskInfo> disk_infos;
	appendWindowsDiskInfo(disk_infos, "D:\\", "DataVolume", "NTFS", 0x01020304UL,
						  "\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\",
						  "\\Device\\HarddiskVolume7");
	appendWindowsDiskInfo(disk_infos, "C:\\", "SystemVolume", "ReFS", 0x05060708UL,
						  "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\",
						  "\\Device\\HarddiskVolume3");

	BOOST_REQUIRE_EQUAL(disk_infos.size(), 2U);
	BOOST_CHECK_EQUAL(std::string(disk_infos[0].drive_root), "D:\\");
	BOOST_CHECK(disk_infos[0].drive_root_initialized);
	BOOST_CHECK_EQUAL(std::string(disk_infos[0].device), "\\Device\\HarddiskVolume7");
	BOOST_CHECK_EQUAL(std::string(disk_infos[0].label), "DataVolume");
	BOOST_CHECK(disk_infos[0].label_initialized);
	BOOST_CHECK_EQUAL(std::string(disk_infos[0].filesystem), "NTFS");
	BOOST_CHECK(disk_infos[0].filesystem_initialized);
	BOOST_CHECK_EQUAL(std::string(disk_infos[0].volume_id),
					  "\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\");
	BOOST_CHECK(disk_infos[0].volume_id_initialized);
	BOOST_CHECK(disk_infos[0].sn_initialized);
	BOOST_CHECK_EQUAL(disk_infos[0].identifier_source, DISK_IDENTIFIER_SOURCE_SERIAL_OR_UUID);
	BOOST_CHECK(!disk_infos[0].preferred);
	BOOST_CHECK_EQUAL(std::string(disk_infos[1].drive_root), "C:\\");
	BOOST_CHECK_EQUAL(std::string(disk_infos[1].device), "\\Device\\HarddiskVolume3");
	BOOST_CHECK_EQUAL(std::string(disk_infos[1].label), "SystemVolume");
	BOOST_CHECK_EQUAL(std::string(disk_infos[1].filesystem), "ReFS");
	BOOST_CHECK_EQUAL(std::string(disk_infos[1].volume_id),
					  "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\");
	BOOST_CHECK(disk_infos[1].preferred);

	sortWindowsDiskInfos(disk_infos);

	BOOST_CHECK_EQUAL(std::string(disk_infos[0].drive_root), "C:\\");
	BOOST_CHECK_EQUAL(std::string(disk_infos[0].device), "\\Device\\HarddiskVolume3");
	BOOST_CHECK_EQUAL(disk_infos[0].id, 0);
	BOOST_CHECK_EQUAL(std::string(disk_infos[1].drive_root), "D:\\");
	BOOST_CHECK_EQUAL(std::string(disk_infos[1].device), "\\Device\\HarddiskVolume7");
	BOOST_CHECK_EQUAL(disk_infos[1].id, 1);
}

BOOST_AUTO_TEST_CASE(windows_volume_serial_without_guid_is_weak_disk_fallback) {
	std::vector<DiskInfo> disk_infos;
	appendWindowsDiskInfo(disk_infos, "E:\\", "MutableVolume", "NTFS", 0x01020304UL, nullptr,
						  "\\Device\\HarddiskVolume9");

	BOOST_REQUIRE_EQUAL(disk_infos.size(), 1U);
	BOOST_CHECK(disk_infos[0].sn_initialized);
	BOOST_CHECK_EQUAL(disk_infos[0].identifier_source, DISK_IDENTIFIER_SOURCE_MUTABLE_VOLUME);

	std::vector<std::array<uint8_t, HW_IDENTIFIER_PROPRIETARY_DATA>> identifiers;
	std::vector<hw_identifier::DiskIdentifierData> identifiers_with_source;
	BOOST_CHECK_EQUAL(hw_identifier::collectDiskIdentifierData(disk_infos, identifiers, false), FUNC_RET_NOT_AVAIL);
	BOOST_CHECK_EQUAL(hw_identifier::collectDiskIdentifierDataWithSource(disk_infos, identifiers_with_source, true),
					  FUNC_RET_OK);
	BOOST_REQUIRE_EQUAL(identifiers_with_source.size(), 1U);
	BOOST_CHECK_EQUAL(identifiers_with_source[0].source_strength,
					  hw_identifier::DISK_IDENTIFIER_WEAK_MUTABLE_VOLUME);
}

}  // namespace test
}  // namespace license
