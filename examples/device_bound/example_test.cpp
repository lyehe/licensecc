#include <licensecc/device_bound.h>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
namespace example_fault {
LCC_BOUND_RESULT primary = LCC_BOUND_RETRY;
bool busy_save = false;
unsigned saves = 0;
unsigned abandons = 0;
LCC_BOUND_RESULT abandon_result = LCC_BOUND_ONLINE_REQUIRED;
uint32_t detail = LCC_BOUND_DETAIL_NONE;
LCC_BOUND_RESULT activate(LccDeviceBoundClient*, LccDeviceBoundOutcome* out) {
	out->checkpoint_result = LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED;
	out->denial_detail = detail;
	return primary;
}
LCC_BOUND_RESULT abandon(LccDeviceBoundClient*, LccDeviceBoundOutcome* out) {
	++abandons;
	out->checkpoint_result = LCC_BOUND_CHECKPOINT_UNCHANGED;
	if (abandon_result == LCC_BOUND_ONLINE_REQUIRED) primary = LCC_BOUND_OK;
	return abandon_result;
}
LCC_BOUND_RESULT renew(LccDeviceBoundClient*, LccDeviceBoundOutcome* out) {
	out->provider_result = LCC_DEVICE_SIGN_FAILED;
	out->checkpoint_result = LCC_BOUND_CHECKPOINT_NOT_ATTEMPTED;
	return primary;
}
LCC_BOUND_RESULT save(LccDeviceBoundClient*, LccDeviceBoundOutcome* out) {
	++saves;
	if (busy_save) return LCC_BOUND_BUSY;  // Contract: output untouched on outer busy.
	out->provider_result = LCC_DEVICE_OK;
	out->checkpoint_result = LCC_BOUND_CHECKPOINT_SAVED;
	return LCC_BOUND_OK;
}
}  // namespace example_fault
#define lcc_device_bound_activate example_fault::activate
#define lcc_device_bound_renew example_fault::renew
#define lcc_device_bound_save_checkpoint example_fault::save
#define lcc_device_bound_abandon_pending example_fault::abandon
#define main example_program_main
#include "windows.cpp"
#undef main
#undef lcc_device_bound_save_checkpoint
#undef lcc_device_bound_abandon_pending
#undef lcc_device_bound_renew
#undef lcc_device_bound_activate

namespace {
struct Console {
	std::istringstream input;
	std::ostringstream output;
	std::streambuf *old_in, *old_out, *old_err;
	explicit Console(const char* text)
		: input(text),
		  old_in(std::cin.rdbuf(input.rdbuf())),
		  old_out(std::cout.rdbuf(output.rdbuf())),
		  old_err(std::cerr.rdbuf(output.rdbuf())) {}
	~Console() {
		std::cin.rdbuf(old_in);
		std::cout.rdbuf(old_out);
		std::cerr.rdbuf(old_err);
		std::cin.clear();
	}
};
void require(bool value) {
	if (!value) throw std::runtime_error("example recovery assertion failed");
}
}  // namespace
int main() {
	try {
		// No handle is dereferenced by these isolated retry-flow stubs.
		auto* client = reinterpret_cast<LccDeviceBoundClient*>(static_cast<uintptr_t>(1));
		{
			Console console("quit\n");
			example_fault::primary = LCC_BOUND_CONFLICT;
			require(update(client, false) == LCC_BOUND_CANCELLED);
			require(example_fault::abandons == 0);
		}
		{
			Console console("");
			example_fault::primary = LCC_BOUND_CONFLICT;
			require(update(client, false) == LCC_BOUND_CANCELLED);
		}
		{
			Console console("restart\n");
			example_fault::primary = LCC_BOUND_CONFLICT;
			require(update(client, false) == LCC_BOUND_OK);
			require(example_fault::abandons == 1);
		}
		{
			Console console("restart\n");
			example_fault::primary = LCC_BOUND_CONFLICT;
			example_fault::abandon_result = LCC_BOUND_BUSY;
			require(update(client, false) == LCC_BOUND_BUSY);
			require(example_fault::primary == LCC_BOUND_CONFLICT);
			require(example_fault::abandons == 2);
		}
		const std::string device_limit =
			"All device slots for this license are in use. Disconnect a device in the customer portal (Devices), then "
			"try again.";
		const std::string unresolved = "Issuance is unresolved (result 7).";
		{
			Console console("quit\n");
			example_fault::primary = LCC_BOUND_CONFLICT;
			example_fault::detail = LCC_BOUND_DETAIL_DEVICE_LIMIT;
			require(update(client, true) == LCC_BOUND_CANCELLED);
			require(console.output.str().find(device_limit) != std::string::npos);
			require(console.output.str().find(unresolved) == std::string::npos);
			require(example_fault::abandons == 2);
		}
		{
			Console console("quit\n");
			example_fault::detail = LCC_BOUND_DETAIL_NONE;
			require(update(client, true) == LCC_BOUND_CANCELLED);
			require(console.output.str().find(device_limit) == std::string::npos);
			require(console.output.str().find(unresolved) != std::string::npos);
		}
		{
			Console console("quit\n");
			LccDeviceBoundOutcome detail;
			lcc_init_device_bound_outcome(&detail);
			detail.provider_result = LCC_DEVICE_SIGN_FAILED;
			detail.checkpoint_result = LCC_BOUND_CHECKPOINT_COMMIT_UNKNOWN;
			example_fault::busy_save = true;
			example_fault::saves = 0;
			require(!persistence(client, detail));
			require(example_fault::saves == 3);
			require(detail.checkpoint_result == LCC_BOUND_CHECKPOINT_COMMIT_UNKNOWN);
			require(detail.provider_result == LCC_DEVICE_SIGN_FAILED);
		}
		{
			Console console("");
			LccDeviceBoundOutcome detail;
			lcc_init_device_bound_outcome(&detail);
			detail.provider_result = LCC_DEVICE_SIGN_FAILED;
			detail.checkpoint_result = LCC_BOUND_CHECKPOINT_IO_ERROR;
			example_fault::busy_save = false;
			require(persistence(client, detail));
			require(detail.provider_result == LCC_DEVICE_SIGN_FAILED);
			require(detail.checkpoint_result == LCC_BOUND_CHECKPOINT_SAVED);
		}
		const auto configured = options();
		require(configured.trust_key_count ==
				sizeof(configuration::signing_keys) / sizeof(configuration::signing_keys[0]));
		for (uint32_t i = 0; i < configured.trust_key_count; ++i) {
			require(configured.trust_keys[i].retired == 0);
			require(configured.trust_keys[i].spki_size == configuration::signing_keys[i].size);
			require(std::memcmp(configured.trust_keys[i].spki, configuration::signing_keys[i].bytes,
								configured.trust_keys[i].spki_size) == 0);
		}
		// A configure-time LCC_BOUND_DEVICE_LABEL is used byte for byte (UTF-8 included). Without one,
		// each run labels the device with this computer's name, so installations differ.
		const std::string hex = LCC_BOUND_LABEL_HEX;
		std::string pinned;
		for (std::size_t i = 0; i < hex.size(); i += 2)
			pinned.push_back(static_cast<char>(std::stoul(hex.substr(i, 2), nullptr, 16)));
		require(example_configuration::device_label_configured == !pinned.empty());
		if (!pinned.empty()) {
			require(configured.device_label == pinned);
		} else {
			require(!example_device_label::computer_name().empty());
			require(configured.device_label == example_device_label::computer_name());
		}
		require(example_device_label::preferred("Pinned", "build-host") == "Pinned");
		require(example_device_label::preferred("", "build-host") == "build-host");
		require(example_device_label::preferred("", "") == "Computer");
		require(example_device_label::preferred("", std::string(sizeof(configured.device_label), 'a')) == "Computer");

		// The native client refuses a label that breaks the device-label rule before it provisions
		// or sends anything; the example then retries once with "Computer".
		for (const char* refused : {"4F2A-0C12-B7E4", "PC\x07"}) {
			auto labelled = options();
			std::strcpy(labelled.device_label, refused);
			LccDeviceBoundOutcome outcome;
			lcc_init_device_bound_outcome(&outcome);
			LccDeviceBoundClient* handle = nullptr;
			require(lcc_device_bound_open_enrollment(&labelled, &handle, &outcome) == LCC_BOUND_INVALID_ARGUMENT &&
					!handle);
		}
		std::vector<std::string> offered;
		const auto open_unless_computer = [&](LccDeviceBoundOptions& attempt) {
			offered.emplace_back(attempt.device_label);
			return offered.back() == "Computer" ? LCC_BOUND_OK : LCC_BOUND_INVALID_ARGUMENT;
		};
		auto labelled = options();
		std::strcpy(labelled.device_label, "4F2A-0C12-B7E4");
		require(example_device_label::open_with_fallback(labelled, false, open_unless_computer) == LCC_BOUND_OK);
		require(offered == std::vector<std::string>({"4F2A-0C12-B7E4", "Computer"}));
		offered.clear();
		std::strcpy(labelled.device_label, "4F2A-0C12-B7E4");
		require(example_device_label::open_with_fallback(labelled, true, open_unless_computer) ==
				LCC_BOUND_INVALID_ARGUMENT);
		require(offered.size() == 1);  // A configure-time label is never replaced.
		offered.clear();
		std::strcpy(labelled.device_label, "build-host");
		const auto busy = [&](LccDeviceBoundOptions& attempt) {
			offered.emplace_back(attempt.device_label);
			return LCC_BOUND_BUSY;
		};
		require(example_device_label::open_with_fallback(labelled, false, busy) == LCC_BOUND_BUSY);
		require(offered.size() == 1);  // Only a refused label is retried.
		std::cout << "Example quit, persistence, provider-result, UTF-8 and device-label checks passed.\n";
		return 0;
	} catch (const std::exception& e) {
		std::cerr << e.what() << '\n';
		return 1;
	}
}
