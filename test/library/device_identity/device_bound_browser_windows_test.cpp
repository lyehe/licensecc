#define BOOST_TEST_MODULE device_bound_browser_windows_test
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <objbase.h>
#include <thread>
#include <boost/test/unit_test.hpp>
#include "bound_browser.hpp"
#include "bound_http.hpp"
#include "bound_encoding.hpp"
#include "p256_crypto.hpp"

namespace shim {
struct State {
	HRESULT initialized = S_OK;
	BOOL submitted = TRUE;
	HANDLE process = nullptr;
	unsigned initializes = 0, uninitializes = 0, executes = 0, closes = 0;
	DWORD thread = 0, apartment = 0, mask = 0;
	bool fixed_fields = false;
	bool real_com = false;
	HRESULT apartment_result = E_FAIL;
	APTTYPE actual_apartment = APTTYPE_CURRENT;
	std::wstring url;
} state;
HRESULT WINAPI initialize(LPVOID, DWORD mode) {
	++state.initializes;
	state.thread = GetCurrentThreadId();
	state.apartment = mode;
	return state.real_com ? CoInitializeEx(nullptr, mode) : state.initialized;
}
void WINAPI uninitialize() {
	++state.uninitializes;
	if (state.real_com) CoUninitialize();
}
BOOL WINAPI execute(SHELLEXECUTEINFOW* info) {
	++state.executes;
	state.mask = info->fMask;
	state.url = info->lpFile;
	if (state.real_com) {
		APTTYPEQUALIFIER qualifier;
		state.apartment_result = CoGetApartmentType(&state.actual_apartment, &qualifier);
	}
	state.fixed_fields = info->cbSize == sizeof(*info) && std::wstring(info->lpVerb) == L"open" &&
						 !info->lpParameters && !info->lpDirectory && !info->hwnd && !info->lpClass &&
						 !info->lpIDList && info->nShow == SW_SHOWNORMAL;
	info->hProcess = state.process;
	return state.submitted;
}
BOOL WINAPI close(HANDLE process) {
	if (process == state.process) ++state.closes;
	return TRUE;
}
}  // namespace shim
// Exercise the actual production adapter with only OS side effects replaced.
#define CoInitializeEx shim::initialize
#define CoUninitialize shim::uninitialize
#define ShellExecuteExW shim::execute
#define CloseHandle shim::close
#define make_bound_browser_launcher make_test_bound_browser_launcher
#include "bound_browser_windows.cpp"
#undef make_bound_browser_launcher
#undef CloseHandle
#undef ShellExecuteExW
#undef CoUninitialize
#undef CoInitializeEx
using namespace license::device_identity;
namespace {
const std::string base = "https://portal.test/authorize", url = base + "#attempt_handle=" + std::string(43, 'A');
}
BOOST_AUTO_TEST_CASE(shell_submission_uses_pinned_url_fixed_fields_and_separate_sta) {
	shim::state = {};
	auto browser = make_test_bound_browser_launcher(base);
	BOOST_REQUIRE(browser);
	const auto caller = GetCurrentThreadId();
	BOOST_CHECK(browser->open(url) == BoundBrowserStatus::opened);
	BOOST_CHECK(shim::state.thread != caller);
	BOOST_CHECK(shim::state.fixed_fields);
	BOOST_CHECK_EQUAL(shim::state.apartment, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
	BOOST_CHECK_EQUAL(shim::state.mask, SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOCLOSEPROCESS);
	BOOST_CHECK(shim::state.url == std::wstring(url.begin(), url.end()));
	BOOST_CHECK_EQUAL(shim::state.uninitializes, 1);
	BOOST_CHECK_EQUAL(shim::state.closes, 0);
}
BOOST_AUTO_TEST_CASE(com_and_shell_failure_balance_only_owned_resources) {
	auto browser = make_test_bound_browser_launcher(base);
	BOOST_REQUIRE(browser);
	shim::state = {};
	shim::state.initialized = E_FAIL;
	BOOST_CHECK(browser->open(url) == BoundBrowserStatus::unavailable);
	BOOST_CHECK_EQUAL(shim::state.executes, 0);
	BOOST_CHECK_EQUAL(shim::state.uninitializes, 0);
	for (BOOL submitted : {FALSE, TRUE}) {
		shim::state = {};
		shim::state.initialized = S_FALSE;
		shim::state.submitted = submitted;
		shim::state.process = reinterpret_cast<HANDLE>(1234);
		BOOST_CHECK(browser->open(url) == (submitted ? BoundBrowserStatus::opened : BoundBrowserStatus::unavailable));
		BOOST_CHECK_EQUAL(shim::state.closes, 1);
		BOOST_CHECK_EQUAL(shim::state.uninitializes, 1);
	}
}
BOOST_AUTO_TEST_CASE(destination_aliases_and_invalid_fragments_never_reach_the_shell) {
	auto browser = make_test_bound_browser_launcher(base);
	BOOST_REQUIRE(browser);
	const std::vector<std::string> invalid{url + "=",
										   url + "&other=1",
										   base + "?attempt_handle=" + std::string(43, 'A'),
										   "https://other.test/authorize#attempt_handle=" + std::string(43, 'A'),
										   "https://portal.test/other#attempt_handle=" + std::string(43, 'A'),
										   "file:///C:/Windows/System32/cmd.exe",
										   base + "#attempt_handle=" + std::string(42, 'A') + "B"};
	for (const auto& destination : invalid) {
		shim::state = {};
		BOOST_CHECK(browser->open(destination) == BoundBrowserStatus::invalid_input);
		BOOST_CHECK_EQUAL(shim::state.initializes, 0);
		BOOST_CHECK_EQUAL(shim::state.executes, 0);
	}
	for (const auto& invalid_base : {"http://portal.test/authorize", "https://portal.test/authorize?x=1",
									 "https://portal.test/../authorize", "https://portal.test/%61uthorize"})
		BOOST_CHECK(!make_test_bound_browser_launcher(invalid_base));
}
BOOST_AUTO_TEST_CASE(real_com_launcher_owns_sta_and_preserves_mta_caller) {
	shim::state = {};
	shim::state.real_com = true;
	HRESULT initialized = E_FAIL, observed = E_FAIL;
	APTTYPE caller_apartment = APTTYPE_CURRENT;
	DWORD caller_id = 0;
	BoundBrowserStatus result = BoundBrowserStatus::unavailable;
	std::thread caller([&] {
		initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
		if (FAILED(initialized)) return;
		struct Apartment {
			~Apartment() { CoUninitialize(); }
		} apartment;
		caller_id = GetCurrentThreadId();
		auto browser = make_test_bound_browser_launcher(base);
		if (browser) result = browser->open(url);
		APTTYPEQUALIFIER qualifier;
		observed = CoGetApartmentType(&caller_apartment, &qualifier);
	});
	caller.join();
	BOOST_REQUIRE(SUCCEEDED(initialized));
	BOOST_CHECK(result == BoundBrowserStatus::opened);
	BOOST_CHECK_EQUAL(shim::state.apartment_result, S_OK);
	BOOST_CHECK(shim::state.actual_apartment == APTTYPE_STA || shim::state.actual_apartment == APTTYPE_MAINSTA);
	BOOST_CHECK(shim::state.thread != caller_id);
	BOOST_CHECK_EQUAL(shim::state.initializes, 1);
	BOOST_CHECK_EQUAL(shim::state.uninitializes, 1);
	BOOST_CHECK_EQUAL(observed, S_OK);
	BOOST_CHECK(caller_apartment == APTTYPE_MTA);
}
