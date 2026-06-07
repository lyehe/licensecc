#include <paths.h>
#include <sys/stat.h>
#include <stdio.h>
#include <algorithm>
#include <cerrno>
#include <cstring>
#include <iostream>
#include <fstream>
#include <unordered_map>
#include <string>
#include <stdio.h>
#include <string.h>
#include <sstream>
#ifdef __linux__
#include <sys/random.h>
#endif
#include "../os.h"
#include "../../base/logger.h"
#include "../../base/string_utils.h"

#include <mntent.h>
#include <dirent.h>
#include <sys/utsname.h>
#ifndef NDEBUG
#include <valgrind/memcheck.h>
#endif

//#ifdef USE_DISK_MODEL
//#define PARSE_ID_FUNC parse_disk_id
//#define ID_FOLDER "/dev/disk/by-id"
//#else
#define PARSE_ID_FUNC parseUUID
#define ID_FOLDER "/dev/disk/by-uuid"
//#endif
#ifdef USE_DBUS
#include <dbus-1.0/dbus/dbus.h>
#endif

using namespace license;

/**
 * Usually uuid are hex number separated by "-". this method read up to 8 hex
 * numbers skipping - characters.
 * @param uuid uuid as read in /dev/disk/by-uuid
 * @param buffer_out unsigned char buffer[8] output buffer for result
 * @param out_size size of buffer_out
 */
static void parseUUID(const char *uuid, unsigned char *buffer_out, unsigned int out_size) {
	unsigned char cur_character;
	// keep only the characters in the hex set
	std::string hexuuid;
	hexuuid.reserve(strlen(uuid));
	for (const char *c = uuid; *c != '\0'; c++) {
		if (isxdigit(*c)) {
			hexuuid.push_back(*c);
		}
	}
	if (hexuuid.size() % 2 == 1) {
		hexuuid.push_back('0');
	}
	memset(buffer_out, 0, out_size);
	for (size_t i = 0; i < hexuuid.size() / 2; i++) {
		sscanf(&hexuuid[i * 2], "%2hhx", &cur_character);
		buffer_out[i % out_size] = buffer_out[i % out_size] ^ cur_character;
	}
}

static void parse_disk_id(const char *uuid, unsigned char *buffer_out, size_t out_size) {
	unsigned int i;
	size_t len = strlen(uuid);
	memset(buffer_out, 0, out_size);
	for (i = 0; i < len; i++) {
		buffer_out[i % out_size] = buffer_out[i % out_size] ^ uuid[i];
	}
}

/**
 * Extract an XML-style attribute from a blkid entry.
 * @param source blkid entry text.
 * @param attrName attribute name without quotes.
 * @return attribute value, or an empty/undefined substring when missing.
 */

static std::string getAttribute(const std::string &source, const std::string &attrName) {
	std::string attr_namefull = attrName + "=\"";
	std::size_t startpos = source.find(attr_namefull) + attr_namefull.size();
	std::size_t endpos = source.find("\"", startpos);
	return source.substr(startpos, endpos - startpos);
}

FUNCTION_RETURN parse_blkid(const std::string &blkid_file_content, std::vector<DiskInfo> &diskInfos_out,
							std::unordered_map<std::string, int> &disk_by_uuid) {
	int diskNum = 0;
	for (std::size_t oldpos = 0, pos = 0; (pos = blkid_file_content.find("</device>", oldpos)) != std::string::npos;
		 oldpos = pos + 1) {
		DiskInfo diskInfo = {};
		std::string cur_dev = blkid_file_content.substr(oldpos, pos);
		diskInfo.id = diskNum++;
		std::string device = cur_dev.substr(cur_dev.find_last_of(">") + 1);
		mstrlcpy(diskInfo.device, device.c_str(), MAX_PATH);
		std::string label = getAttribute(cur_dev, "PARTLABEL");
		mstrlcpy(diskInfo.label, label.c_str(), 255);
		std::string disk_sn = getAttribute(cur_dev, "UUID");
		mstrlcpy(diskInfo.volume_id, disk_sn.c_str(), sizeof(diskInfo.volume_id));
		diskInfo.volume_id_initialized = true;
		parseUUID(disk_sn.c_str(), diskInfo.disk_sn, sizeof(diskInfo.disk_sn));
		diskInfo.identifier_source = DISK_IDENTIFIER_SOURCE_SERIAL_OR_UUID;
		std::string disk_type = getAttribute(cur_dev, "TYPE");
		mstrlcpy(diskInfo.filesystem, disk_type.c_str(), sizeof(diskInfo.filesystem));
		diskInfo.filesystem_initialized = true;
		disk_by_uuid.insert(std::pair<std::string, int>(disk_sn, diskInfo.id));
		diskInfo.label_initialized = true;
		diskInfo.sn_initialized = true;
		// unlikely that somebody put the swap on a removable disk.
		// this is a first rough guess on what can be a preferred disk for blkid devices
		// just in case /etc/fstab can't be accessed or it is not up to date.
		diskInfo.preferred = (disk_type == "swap");
		diskInfos_out.push_back(diskInfo);
	}
	return FUNCTION_RETURN::FUNC_RET_OK;
}

static bool disk_sn_has_nonzero_bytes(const DiskInfo &disk_info) {
	for (const auto byte : disk_info.disk_sn) {
		if (byte != 0) {
			return true;
		}
	}
	return false;
}

static bool disk_has_strong_identity(const DiskInfo &disk_info) {
	return disk_info.sn_initialized && disk_sn_has_nonzero_bytes(disk_info);
}

static int compare_disk_bytes(const unsigned char *lhs, const unsigned char *rhs, const size_t size) {
	const int byte_compare = std::memcmp(lhs, rhs, size);
	if (byte_compare < 0) {
		return -1;
	}
	if (byte_compare > 0) {
		return 1;
	}
	return 0;
}

static bool linux_disk_info_less(const DiskInfo &lhs, const DiskInfo &rhs) {
	if (lhs.preferred != rhs.preferred) {
		return lhs.preferred && !rhs.preferred;
	}

	const bool lhs_strong = disk_has_strong_identity(lhs);
	const bool rhs_strong = disk_has_strong_identity(rhs);
	if (lhs_strong != rhs_strong) {
		return lhs_strong;
	}

	if (lhs.volume_id_initialized != rhs.volume_id_initialized) {
		return lhs.volume_id_initialized && !rhs.volume_id_initialized;
	}

	if (lhs.label_initialized != rhs.label_initialized) {
		return lhs.label_initialized && !rhs.label_initialized;
	}

	const int device_compare = std::strcmp(lhs.device, rhs.device);
	if (device_compare != 0) {
		return device_compare < 0;
	}

	const int volume_compare = std::strcmp(lhs.volume_id, rhs.volume_id);
	if (volume_compare != 0) {
		return volume_compare < 0;
	}

	const int label_compare = std::strcmp(lhs.label, rhs.label);
	if (label_compare != 0) {
		return label_compare < 0;
	}

	const int sn_compare = compare_disk_bytes(lhs.disk_sn, rhs.disk_sn, sizeof(lhs.disk_sn));
	if (sn_compare != 0) {
		return sn_compare < 0;
	}

	return lhs.id < rhs.id;
}

void sortLinuxDiskInfos(std::vector<DiskInfo> &diskInfos) {
	std::sort(diskInfos.begin(), diskInfos.end(), linux_disk_info_less);
	for (size_t i = 0; i < diskInfos.size(); ++i) {
		diskInfos[i].id = static_cast<int>(i);
	}
}

#define BLKID_LOCATIONS {"/run/blkid/blkid.tab", "/etc/blkid.tab"};

static FUNCTION_RETURN getDiskInfos_blkid(std::vector<DiskInfo> &diskInfos,
										  std::unordered_map<std::string, int> &disk_by_uuid) {
	const char *strs[] = BLKID_LOCATIONS;
	bool can_read = false;
	std::stringstream buffer;
	for (int i = 0; i < sizeof(strs) / sizeof(const char *); i++) {
		const char *location = strs[i];
		std::ifstream t(location);
		if (t.is_open()) {
			buffer << t.rdbuf();
			can_read = true;
			break;
		}
	}
	if (!can_read) {
		return FUNCTION_RETURN::FUNC_RET_NOT_AVAIL;
	}

	return parse_blkid(buffer.str(), diskInfos, disk_by_uuid);
}

#define MAX_UNITS 40

static void read_disk_labels(std::vector<DiskInfo> &disk_infos) {
	struct stat sym_stat;
	struct dirent *dir;

	std::string label_dir("/dev/disk/by-label");
	DIR *disk_by_label = opendir(label_dir.c_str());
	if (disk_by_label == nullptr) {
		label_dir = "/dev/disk/by-partlabel";
		disk_by_label = opendir(label_dir.c_str());
	}
	if (disk_by_label != nullptr) {
		while ((dir = readdir(disk_by_label)) != nullptr) {
			if (strcmp(dir->d_name, ".") == 0 || strcmp(dir->d_name, "..") == 0) {
				continue;
			}
			std::string cur_disk_label = label_dir + "/" + dir->d_name;
			if (stat(cur_disk_label.c_str(), &sym_stat) == 0) {
				bool found = false;
				for (auto &diskInfo : disk_infos) {
					if (((int)(sym_stat.st_ino)) == diskInfo.id) {
						mstrlcpy(diskInfo.label, dir->d_name, 255);
						diskInfo.label_initialized = true;
						LOG_DEBUG("Label for disk ino %d device %s, set to %s", sym_stat.st_ino, diskInfo.device,
								  diskInfo.label);
						break;
					}
				}
			} else {
				LOG_DEBUG("Stat %s for fail:F %s", cur_disk_label.c_str(), std::strerror(errno));
			}
		}
		closedir(disk_by_label);
	} else {
		LOG_DEBUG("Open %s for reading disk labels fail: %s", label_dir.c_str(), std::strerror(errno));
	}
}

FUNCTION_RETURN getDiskInfos_dev(std::vector<DiskInfo> &disk_infos,
								 std::unordered_map<std::string, int> &disk_by_uuid) {
	struct dirent *dir = NULL;
	struct stat sym_stat;
	FUNCTION_RETURN result;
	char device_name[MAX_PATH];

	DIR *disk_by_uuid_dir = opendir(ID_FOLDER);
	if (disk_by_uuid_dir == nullptr) {
		LOG_DEBUG("Open " ID_FOLDER " fail: %s", std::strerror(errno));
	} else {
		const std::string base_dir(ID_FOLDER "/");
		while ((dir = readdir(disk_by_uuid_dir)) != nullptr && disk_infos.size() < MAX_UNITS) {
			if (::strcmp(dir->d_name, ".") == 0 || ::strcmp(dir->d_name, "..") == 0 ||
				::strncmp(dir->d_name, "usb", 3) == 0) {
				continue;
			}

			std::string cur_dir = base_dir + dir->d_name;
			if (stat(cur_dir.c_str(), &sym_stat) == 0) {
				DiskInfo tmpDiskInfo = {};
				tmpDiskInfo.id = sym_stat.st_ino;
				ssize_t len = ::readlink(cur_dir.c_str(), device_name, MAX_PATH - 1);
				if (len != -1) {
					device_name[len] = '\0';
					std::string device_name_s(device_name, len);
					auto pos = device_name_s.find_last_of("/");
					if (pos != std::string::npos) {
						device_name_s = device_name_s.substr(pos + 1);
					}
					mstrlcpy(tmpDiskInfo.device, device_name_s.c_str(), sizeof(tmpDiskInfo.device));
					mstrlcpy(tmpDiskInfo.volume_id, dir->d_name, sizeof(tmpDiskInfo.volume_id));
					PARSE_ID_FUNC(dir->d_name, tmpDiskInfo.disk_sn, sizeof(tmpDiskInfo.disk_sn));
					tmpDiskInfo.sn_initialized = true;
					tmpDiskInfo.identifier_source = DISK_IDENTIFIER_SOURCE_SERIAL_OR_UUID;
					tmpDiskInfo.volume_id_initialized = true;
					tmpDiskInfo.label_initialized = false;
					tmpDiskInfo.preferred = false;
					bool found = false;
					for (auto diskInfo : disk_infos) {
						if (tmpDiskInfo.id == diskInfo.id) {
							found = true;
							break;
						}
					}
					disk_by_uuid.insert(std::pair<std::string, int>(std::string(dir->d_name), tmpDiskInfo.id));
					if (!found) {
						LOG_DEBUG("Found disk inode %d device %s, sn %s", sym_stat.st_ino, tmpDiskInfo.device,
								  dir->d_name);
						disk_infos.push_back(tmpDiskInfo);
					}
				} else {
					LOG_DEBUG("Error %s during readlink of %s", std::strerror(errno), cur_dir.c_str());
				}
			} else {
				LOG_DEBUG("Error %s during stat of %s", std::strerror(errno), cur_dir.c_str());
			}
		}
		closedir(disk_by_uuid_dir);
	}

	result = disk_infos.size() > 0 ? FUNCTION_RETURN::FUNC_RET_OK : FUNCTION_RETURN::FUNC_RET_NOT_AVAIL;
	read_disk_labels(disk_infos);
	return result;
}

/**
 * Try to determine removable devices: as a first guess removable devices doesn't have
 * an entry in /etc/fstab
 *
 * @param diskInfos disk records to update.
 * @param disk_by_uuid map from UUID to disk record id.
 * @param fstab_source source field from an /etc/fstab entry.
 */
bool markLinuxPreferredDiskForFstabSource(std::vector<DiskInfo> &diskInfos,
										  std::unordered_map<std::string, int> &disk_by_uuid,
										  const std::string &fstab_source) {
	if (fstab_source.compare(0, 5, "UUID=") == 0) {
		const std::string uuid = fstab_source.substr(5);
		auto it = disk_by_uuid.find(uuid);
		if (it == disk_by_uuid.end()) {
			LOG_DEBUG("fstab device %s found, but no corresponding diskInfo", fstab_source.c_str());
			return false;
		}
		for (auto &disk_info : diskInfos) {
			if (it->second == disk_info.id) {
				disk_info.preferred = true;
				LOG_DEBUG("Disk %d device %s set as preferred", disk_info.id, disk_info.device);
				return true;
			}
		}
		return false;
	}

	if (fstab_source.compare(0, 6, "LABEL=") == 0) {
		const std::string label = fstab_source.substr(6);
		for (auto &disk_info : diskInfos) {
			if (label == disk_info.label) {
				disk_info.preferred = true;
				LOG_DEBUG("Disk %d device %s set as preferred", disk_info.id, disk_info.device);
				return true;
			}
		}
		return false;
	}

	std::string device_name_s(fstab_source);
	auto pos = device_name_s.find_last_of("/");
	if (pos != std::string::npos) {
		device_name_s = device_name_s.substr(pos + 1);
	}

	for (auto &disk_info : diskInfos) {
		if (device_name_s == disk_info.device) {
			disk_info.preferred = true;
			LOG_DEBUG("Disk %d device %s set as preferred", disk_info.id, disk_info.device);
			return true;
		}
	}
	return false;
}

static void set_preferred_disks(std::vector<DiskInfo> &diskInfos, std::unordered_map<std::string, int> &disk_by_uuid) {
	FILE *fstabFile = setmntent("/etc/fstab", "r");
	if (fstabFile == nullptr) {
		LOG_DEBUG("/etc/fstab not accessible");
		return;
	}
	struct mntent *ent;
	while (nullptr != (ent = getmntent(fstabFile))) {
		LOG_DEBUG("found fstab entry %s ", ent->mnt_fsname);
		markLinuxPreferredDiskForFstabSource(diskInfos, disk_by_uuid, ent->mnt_fsname);
	}
	endmntent(fstabFile);
	return;
}

/**
 * First try to read disk_infos from /dev/disk/by-uuid folder, if fails try to use
 * blkid cache to see what's in there, then try to exclude removable disks
 * looking at /etc/fstab
 * @param diskInfos vector used to output the disk informations
 * @return FUNC_RET_OK when disk information is available, otherwise an error code.
 */
FUNCTION_RETURN getDiskInfos(std::vector<DiskInfo> &diskInfos) {
	std::unordered_map<std::string, int> disk_by_uuid;

	FUNCTION_RETURN result = getDiskInfos_dev(diskInfos, disk_by_uuid);

	if (result != FUNCTION_RETURN::FUNC_RET_OK) {
		result = getDiskInfos_blkid(diskInfos, disk_by_uuid);
	}
	if (result == FUNCTION_RETURN::FUNC_RET_OK) {
		set_preferred_disks(diskInfos, disk_by_uuid);
		sortLinuxDiskInfos(diskInfos);
	}
	return result;
}

FUNCTION_RETURN getMachineName(unsigned char identifier[6]) {
	static struct utsname u;

	if (uname(&u) < 0) {
		return FUNC_RET_ERROR;
	}
	memcpy(identifier, u.nodename, 6);
	return FUNC_RET_OK;
}

FUNCTION_RETURN getSecureRandomBytes(unsigned char* buffer, size_t size) {
	if (size == 0) {
		return FUNC_RET_OK;
	}
	if (buffer == nullptr) {
		return FUNC_RET_ERROR;
	}
#ifdef __linux__
	size_t offset = 0;
	while (offset < size) {
		const ssize_t read_count = getrandom(buffer + offset, size - offset, 0);
		if (read_count < 0) {
			if (errno == EINTR) {
				continue;
			}
			break;
		}
		if (read_count == 0) {
			break;
		}
		offset += static_cast<size_t>(read_count);
	}
	if (offset == size) {
		return FUNC_RET_OK;
	}
#endif
	std::ifstream urandom("/dev/urandom", std::ios::binary);
	if (!urandom.is_open()) {
		return FUNC_RET_ERROR;
	}
	urandom.read(reinterpret_cast<char*>(buffer), static_cast<std::streamsize>(size));
	return urandom.gcount() == static_cast<std::streamsize>(size) ? FUNC_RET_OK : FUNC_RET_ERROR;
}

FUNCTION_RETURN getOsSpecificIdentifier(unsigned char identifier[6]) {
#if USE_DBUS
	char *dbus_id = dbus_get_local_machine_id();
	if (dbus_id == NULL) {
		return FUNC_RET_ERROR;
	}
	memcpy(identifier, dbus_id, 6);
	dbus_free(dbus_id);
	return FUNC_RET_OK;
#else
	return FUNC_RET_NOT_AVAIL;
#endif
}

FUNCTION_RETURN getModuleName(char buffer[MAX_PATH]) {
	FUNCTION_RETURN result;
	char path[MAX_PATH] = {0};
	char proc_path[MAX_PATH], pidStr[64];
	pid_t pid = getpid();
	sprintf(pidStr, "%d", pid);
	strcpy(proc_path, "/proc/");
	strcat(proc_path, pidStr);
	strcat(proc_path, "/exe");

	int ch = readlink(proc_path, path, MAX_PATH - 1);
	if (ch > MAX_PATH || ch < 0) {
		result = FUNC_RET_ERROR;
	} else {
		mstrlcpy(buffer, path, ch + 1);
		result = FUNC_RET_OK;
	}
	return result;
}
