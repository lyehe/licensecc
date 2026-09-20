#include <licensecc/device_bound.h>
#include <sstream>
#include <stdexcept>
namespace example_fault {
LCC_BOUND_RESULT primary = LCC_BOUND_RETRY;
bool busy_save = false;
unsigned saves = 0;
unsigned abandons = 0;
LCC_BOUND_RESULT abandon_result = LCC_BOUND_ONLINE_REQUIRED;
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
#define lcc_device_bound_renew example_fault::renew
#define lcc_device_bound_save_checkpoint example_fault::save
#define lcc_device_bound_abandon_pending example_fault::abandon
#define main example_program_main
#include "windows.cpp"
#undef main
#undef lcc_device_bound_save_checkpoint
#undef lcc_device_bound_abandon_pending
#undef lcc_device_bound_renew

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
		const std::string hex = LCC_BOUND_LABEL_HEX;
		require(std::strlen(configured.device_label) * 2 == hex.size());
		for (std::size_t i = 0; i < hex.size(); i += 2)
			require(static_cast<unsigned char>(configured.device_label[i / 2]) ==
					std::stoul(hex.substr(i, 2), nullptr, 16));
		std::cout << "Example quit, persistence, provider-result and UTF-8 checks passed.\n";
		return 0;
	} catch (const std::exception& e) {
		std::cerr << e.what() << '\n';
		return 1;
	}
}
