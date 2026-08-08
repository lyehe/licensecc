/*
 * dmi_info.cpp
 *
 *  Created on: Apr 24, 2020
 *      Author: devel
 */

#include <cstddef>

#include "smbios.hpp"
#include "../../base/string_utils.h"
#include "../dmi_info.hpp"

namespace license {
namespace os {

using namespace smbios;

namespace {
// A formatted SMBIOS field [offset, offset+size) is safe to read only when it lies
// within the structure's firmware-declared length AND within the parsed buffer. The
// parser admits a structure on its 4-byte header, so extended typed-struct fields
// must be re-validated here before they are read.
inline bool dmi_field_in_bounds(const header *h, std::size_t offset, std::size_t size, const byte_t *buffer_end) {
	const byte_t *base = reinterpret_cast<const byte_t *>(h);
	return offset + size <= h->length && base + h->length <= buffer_end;
}
}  // namespace

//#pragma pack()
struct RawSMBIOSData {
	BYTE Used20CallingMethod;
	BYTE SMBIOSMajorVersion;
	BYTE SMBIOSMinorVersion;
	BYTE DmiRevision;
	DWORD Length;
	//BYTE SMBIOSTableData[1];
};

bool readSMBIOS(std::vector<uint8_t> &buffer) {
	const DWORD tableSignature = ('R' << 24) | ('S' << 16) | ('M' << 8) | 'B';
	bool can_read = false;
	uint32_t size = GetSystemFirmwareTable(tableSignature, 0, NULL, 0);
	if (size > 0) {
		buffer.resize(size);
		if (GetSystemFirmwareTable(tableSignature, 0, buffer.data(), size)
				> 0) {
			can_read = true;
		}
	}
	return can_read;
}

DmiInfo::DmiInfo() {
	std::vector<uint8_t> raw_smbios_data;
	if (readSMBIOS(raw_smbios_data) && raw_smbios_data.size() > sizeof(RawSMBIOSData)) {
		smbios::parser smbios_parser;
		RawSMBIOSData *rawData = reinterpret_cast<RawSMBIOSData *>(raw_smbios_data.data());
		size_t length = static_cast<size_t>(rawData->Length);
		// the table data follows the fixed header; never read past what was actually returned
		const size_t available = raw_smbios_data.size() - sizeof(RawSMBIOSData);
		if (length > available) {
			length = available;
		}
		uint8_t* buff= raw_smbios_data.data() + sizeof(RawSMBIOSData);
		smbios_parser.feed(buff, length);

		for (auto &header : smbios_parser.headers) {
			string_array_t strings;
			parser::extract_strings(header, strings, smbios_parser.buffer_end());

			const byte_t *const buffer_end = smbios_parser.buffer_end();
			switch (header->type) {
				case types::baseboard_info: {
					auto *const x = reinterpret_cast<baseboard_info *>(header);
					if (dmi_field_in_bounds(header, offsetof(baseboard_info, manufacturer_name),
											sizeof(x->manufacturer_name), buffer_end) &&
						x->manufacturer_name > 0 && x->manufacturer_name < strings.size()) {
						m_sys_vendor = strings[x->manufacturer_name];
					}
				} break;

				case types::bios_info: {
					auto *const x = reinterpret_cast<bios_info *>(header);
					if (dmi_field_in_bounds(header, offsetof(bios_info, vendor), sizeof(x->vendor), buffer_end) &&
						x->vendor > 0 && x->vendor < strings.size()) {
						m_bios_vendor = strings[x->vendor];
					}
				} break;

				case types::processor_info: {
					auto *const x = reinterpret_cast<proc_info *>(header);
					if (dmi_field_in_bounds(header, offsetof(proc_info, manufacturer), sizeof(x->manufacturer),
											buffer_end) &&
						x->manufacturer > 0 && x->manufacturer < strings.size()) {
						m_cpu_manufacturer = strings[x->manufacturer];
					}
					if (dmi_field_in_bounds(header, offsetof(proc_info, cores), sizeof(x->cores), buffer_end)) {
						m_cpu_cores = static_cast<unsigned int>(x->cores);
					}
				} break;

				case types::system_info: {
					auto *const x = reinterpret_cast<system_info *>(header);
					if (dmi_field_in_bounds(header, offsetof(system_info, manufacturer), sizeof(x->manufacturer),
											buffer_end) &&
						dmi_field_in_bounds(header, offsetof(system_info, product_name), sizeof(x->product_name),
											buffer_end) &&
						x->manufacturer > 0 && x->manufacturer < strings.size() && x->product_name > 0 &&
						x->product_name < strings.size()) {
						m_bios_description =
							std::string(strings[x->manufacturer]) + std::string(strings[x->product_name]);
					}
				} break;
				default:;
			}
		}
		//smbios_parser.clear();
	}
	else {

	}
}
}
} /* namespace license */
