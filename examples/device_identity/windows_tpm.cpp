#include <licensecc/device_identity.h>

#include <cstring>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>

namespace {

template <std::size_t N>
bool set_field(char (&field)[N], const std::string& value) {
	if (value.size() >= N) {
		return false;
	}
	std::memcpy(field, value.c_str(), value.size() + 1U);
	return true;
}

}  // namespace

int main(int argc, char** argv) {
	if (argc < 3) {
		std::cerr << "usage: licensecc_windows_tpm <application-id> <project> [--machine] [--create]\n";
		return 2;
	}

	LccDeviceIdentityOptions options;
	lcc_init_device_identity_options(&options);
	options.backend = LCC_DEVICE_BACKEND_WINDOWS_TPM;
	options.policy = LCC_DEVICE_POLICY_HARDWARE_REQUIRED;
	for (int index = 3; index < argc; ++index) {
		const std::string argument = argv[index];
		if (argument == "--machine") {
			options.scope = LCC_DEVICE_SCOPE_MACHINE;
		} else if (argument == "--create") {
			options.flags |= LCC_DEVICE_OPEN_CREATE_IF_MISSING;
		} else {
			std::cerr << "unknown argument: " << argument << '\n';
			return 2;
		}
	}
	if (!set_field(options.application_id, argv[1]) || !set_field(options.project, argv[2])) {
		std::cerr << "application id or project exceeds the public ABI bound\n";
		return 2;
	}

	LccDeviceIdentity* identity = nullptr;
	const LCC_DEVICE_RESULT opened = lcc_device_identity_open(&options, &identity);
	if (opened != LCC_DEVICE_OK) {
		std::cerr << "device identity open failed: " << lcc_device_strerror(opened) << '\n';
		return 1;
	}

	LccDeviceIdentityMetadata metadata;
	lcc_init_device_identity_metadata(&metadata);
	const LCC_DEVICE_RESULT metadata_result = lcc_device_identity_get_metadata(identity, &metadata);
	std::size_t spki_size = 0U;
	const LCC_DEVICE_RESULT sized = lcc_device_identity_get_public_spki(identity, nullptr, &spki_size);
	std::vector<unsigned char> spki(spki_size);
	const LCC_DEVICE_RESULT exported = sized == LCC_DEVICE_BUFFER_TOO_SMALL
										   ? lcc_device_identity_get_public_spki(identity, spki.data(), &spki_size)
										   : sized;
	lcc_device_identity_close(identity);
	if (metadata_result != LCC_DEVICE_OK || exported != LCC_DEVICE_OK) {
		std::cerr << "device identity inspection failed\n";
		return 1;
	}

	std::cout << "reported provider: " << metadata.provider << '\n'
			  << "algorithm: " << metadata.algorithm << '\n'
			  << "device key id: " << metadata.device_key_id << '\n'
			  << "public SPKI: ";
	for (const unsigned char byte : spki) {
		std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned int>(byte);
	}
	std::cout << '\n';
	return 0;
}
