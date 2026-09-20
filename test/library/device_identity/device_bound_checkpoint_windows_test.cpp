#define BOOST_TEST_MODULE device_bound_checkpoint_windows_test
#include "bound_checkpoint_directory.hpp"
#include "bound_checkpoint_windows.hpp"
#include "bound_session_signer.hpp"
#include "bound_http.hpp"
#include <sddl.h>
#include <aclapi.h>
#include <winioctl.h>
#include <filesystem>
#include <fstream>
#include <atomic>

namespace fault {
enum class Mode { none, write, flush, retained_flush, move_before, move_after, reread, mirror_before, mirror_after };
Mode mode = Mode::none;
unsigned moves = 0;
bool read_failed = false;
std::vector<ULONGLONG> ticks;
std::size_t tick_index = 0;
unsigned lock_calls = 0;
bool fail_first_lock = false;
ULONGLONG WINAPI tick() {
	if (ticks.empty()) return GetTickCount64();
	return ticks[(std::min)(tick_index++, ticks.size() - 1)];
}
VOID WINAPI sleep(DWORD milliseconds) {
	if (ticks.empty()) Sleep(milliseconds);
}
BOOL WINAPI lock(HANDLE file, DWORD flags, DWORD reserved, DWORD low, DWORD high, LPOVERLAPPED offset) {
	++lock_calls;
	if (fail_first_lock && lock_calls == 1) {
		SetLastError(ERROR_LOCK_VIOLATION);
		return FALSE;
	}
	return LockFileEx(file, flags, reserved, low, high, offset);
}
bool stage(HANDLE file) {
	wchar_t name[32768]{};
	const auto size = GetFinalPathNameByHandleW(file, name, 32768, FILE_NAME_NORMALIZED);
	return size && size < 32768 && std::wstring(name, size).find(L"checkpoint.stage") != std::wstring::npos;
}
BOOL WINAPI write(HANDLE file, LPCVOID data, DWORD size, LPDWORD count, LPOVERLAPPED offset) {
	if (mode == Mode::write && stage(file)) {
		*count = 0;
		SetLastError(ERROR_WRITE_FAULT);
		return FALSE;
	}
	return WriteFile(file, data, size, count, offset);
}
BOOL WINAPI flush(HANDLE file) {
	if ((mode == Mode::flush && stage(file)) || (mode == Mode::retained_flush && !stage(file))) {
		SetLastError(ERROR_WRITE_FAULT);
		return FALSE;
	}
	return FlushFileBuffers(file);
}
BOOL WINAPI move(LPCWSTR from, LPCWSTR to, DWORD flags) {
	++moves;
	if ((mode == Mode::move_before && moves == 1) || (mode == Mode::mirror_before && moves == 2)) {
		SetLastError(ERROR_WRITE_FAULT);
		return FALSE;
	}
	const auto moved = MoveFileExW(from, to, flags);
	if (moved && ((mode == Mode::move_after && moves == 1) || (mode == Mode::mirror_after && moves == 2))) {
		SetLastError(ERROR_WRITE_FAULT);
		return FALSE;
	}
	return moved;
}
BOOL WINAPI read(HANDLE file, LPVOID data, DWORD size, LPDWORD count, LPOVERLAPPED offset) {
	if (mode == Mode::reread && moves && !read_failed && !stage(file)) {
		read_failed = true;
		*count = 0;
		SetLastError(ERROR_READ_FAULT);
		return FALSE;
	}
	return ReadFile(file, data, size, count, offset);
}
}  // namespace fault
// Actual adapter and actual filesystem, with narrowly injected Win32 failures.
#define WriteFile fault::write
#define FlushFileBuffers fault::flush
#define MoveFileExW fault::move
#define ReadFile fault::read
#define GetTickCount64 fault::tick
#define Sleep fault::sleep
#define LockFileEx fault::lock
#define bound_checkpoint_namespace test_checkpoint_namespace
#define make_bound_checkpoint_storage test_checkpoint_storage
#define make_bound_checkpoint_storage_at_root test_checkpoint_storage_at_root
#include "bound_checkpoint_windows.cpp"
#undef make_bound_checkpoint_storage_at_root
#undef make_bound_checkpoint_storage
#undef bound_checkpoint_namespace
#undef ReadFile
#undef LockFileEx
#undef Sleep
#undef GetTickCount64
#undef MoveFileExW
#undef FlushFileBuffers
#undef WriteFile

using namespace license::device_identity;
using checkpoint_windows::Handle;
namespace {
struct Root {
	std::wstring path;
	PSECURITY_DESCRIPTOR descriptor = nullptr;
	Root() {
		HANDLE raw = nullptr;
		BOOST_REQUIRE(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw));
		Handle token(raw);
		DWORD size = 0;
		GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
		std::vector<unsigned char> info(size);
		BOOST_REQUIRE(GetTokenInformation(token.value, TokenUser, info.data(), size, &size));
		LPWSTR sid = nullptr;
		BOOST_REQUIRE(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(info.data())->User.Sid, &sid));
		const auto sddl = std::wstring(L"O:") + sid + L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + sid + L")";
		LocalFree(sid);
		BOOST_REQUIRE(
			ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr));
		static LONG sequence = 0;
		path = std::filesystem::path(LCC_CHECKPOINT_TEST_ROOT).wstring() + L"\\case-" +
			   std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()) + L"-" +
			   std::to_wstring(InterlockedIncrement(&sequence));
		std::replace(path.begin(), path.end(), L'/', L'\\');
		SECURITY_ATTRIBUTES sa{sizeof(sa), descriptor, FALSE};
		BOOST_REQUIRE(CreateDirectoryW(path.c_str(), &sa));
	}
	~Root() {
		// Only exact names inside this test-created directory; no recursive cleanup.
		for (const auto* name : {L"checkpoint.0", L"checkpoint.1", L"checkpoint.lock", L"checkpoint.stage", L"hardlink",
								 L"input.token", L"input.spki"})
			DeleteFileW((path + L"\\" + name).c_str());
		RemoveDirectoryW((path + L"\\junction").c_str());
		RemoveDirectoryW(path.c_str());
		if (descriptor) LocalFree(descriptor);
	}
	void write(const wchar_t* name, const std::string& bytes) {
		SECURITY_ATTRIBUTES sa{sizeof(sa), descriptor, FALSE};
		Handle file(CreateFileW((path + L"\\" + name).c_str(), GENERIC_WRITE, 0, &sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
								nullptr));
		BOOST_REQUIRE(file);
		DWORD count = 0;
		BOOST_REQUIRE(WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr));
		BOOST_REQUIRE_EQUAL(count, bytes.size());
		BOOST_REQUIRE(FlushFileBuffers(file.value));
	}
};
BoundSessionContext context() {
	BoundSessionContext c;
	c.lease = {"https://issuer.test",
			   "app",
			   "CAD",
			   "DEFAULT",
			   std::string(64, 'a'),
			   std::string(22, 'A'),
			   "sha256:" + std::string(64, 'b'),
			   "",
			   1,
			   0};
	return c;
}
BoundResumeExpected expected() {
	return {"https://issuer.test", "app", "CAD", "DEFAULT", "sha256:" + std::string(64, 'b')};
}
std::unique_ptr<BoundCheckpointStore> store(const std::wstring& root, const std::vector<std::uint8_t>& spki) {
	auto io = make_bound_checkpoint_storage_at_root(root, 0);
	BOOST_REQUIRE(io);
	auto result = BoundCheckpointStore::create(std::move(io), {{spki, false}}, expected());
	BOOST_REQUIRE(result);
	return result;
}
std::string read_input(const std::wstring& root, const wchar_t* name) {
	std::ifstream file(std::filesystem::path(root) / name, std::ios::binary);
	BOOST_REQUIRE(file.good());
	return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
struct Child {
	Handle process, thread;
	Child(const std::wstring& root, const std::wstring& ready, const std::wstring& release, bool stale) {
		std::wstring executable(32768, L'\0');
		const auto size = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
		BOOST_REQUIRE(size && size < executable.size());
		executable.resize(size);
		auto command = L"\"" + executable + L"\" --run_test=child_process -- --root \"" + root + L"\" --ready " +
					   ready + L" --release " + release + (stale ? L" --stale" : L"");
		STARTUPINFOW start{};
		start.cb = sizeof(start);
		PROCESS_INFORMATION info{};
		BOOST_REQUIRE(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
									 nullptr, nullptr, &start, &info));
		process = Handle(info.hProcess);
		thread = Handle(info.hThread);
	}
	~Child() {
		if (process && WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) {
			TerminateProcess(process.value, 9);
			WaitForSingleObject(process.value, 5000);
		}
	}
};
std::wstring event_name(const wchar_t* suffix) {
	return L"Local\\licensecc-checkpoint-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
		   std::to_wstring(GetTickCount64()) + suffix;
}
}  // namespace
BOOST_AUTO_TEST_CASE(real_files_round_trip_staging_is_not_authority_and_stale_save_is_refused) {
	Root root;
	SessionTestSigner signer;
	auto owner = store(root.path, signer.spki);
	root.write(L"checkpoint.stage", "leftover");
	std::string out = "unchanged";
	BOOST_CHECK(owner->load(out) == BoundCheckpointStatus::missing);
	BOOST_CHECK_EQUAL(out, "unchanged");
	const auto old = signer.lease(context(), std::string(43, 'A'), 1),
			   newer = signer.lease(context(), std::string(42, 'B') + "A", 7);
	BOOST_CHECK(owner->save(old) == BoundCheckpointStatus::saved);
	BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::saved);
	BOOST_CHECK(owner->save(old) == BoundCheckpointStatus::stale);
	BOOST_CHECK(owner->save(newer) == BoundCheckpointStatus::unchanged);
	owner.reset();
	owner = store(root.path, signer.spki);
	BOOST_CHECK(owner->load(out) == BoundCheckpointStatus::loaded);
	BOOST_CHECK_EQUAL(out, newer);
	BOOST_CHECK(GetFileAttributesW((root.path + L"\\checkpoint.stage").c_str()) == INVALID_FILE_ATTRIBUTES);
	BOOST_CHECK(std::filesystem::file_size(std::filesystem::path(root.path) / L"checkpoint.lock") == 0);
}
BOOST_AUTO_TEST_CASE(hardlinks_oversize_and_unsafe_staging_fail_without_replacement) {
	for (unsigned mode = 0; mode < 3; ++mode) {
		Root root;
		SessionTestSigner signer;
		auto owner = store(root.path, signer.spki);
		const auto token = signer.lease(context(), std::string(43, 'A'));
		if (mode == 0) {
			BOOST_REQUIRE(owner->save(token) == BoundCheckpointStatus::saved);
			BOOST_REQUIRE(
				CreateHardLinkW((root.path + L"\\hardlink").c_str(), (root.path + L"\\checkpoint.1").c_str(), nullptr));
		} else if (mode == 1)
			root.write(L"checkpoint.1", std::string(8193, 'x'));
		else {
			root.write(L"checkpoint.stage", "do not remove");
			BOOST_REQUIRE(CreateHardLinkW((root.path + L"\\hardlink").c_str(),
										  (root.path + L"\\checkpoint.stage").c_str(), nullptr));
		}
		std::string out = "unchanged";
		if (mode != 2) BOOST_CHECK(owner->load(out) == BoundCheckpointStatus::storage_error);
		BOOST_CHECK(owner->save(token) == BoundCheckpointStatus::storage_error);
		BOOST_CHECK_EQUAL(out, "unchanged");
		if (mode == 2) BOOST_CHECK_EQUAL(read_input(root.path, L"hardlink"), "do not remove");
	}
}
BOOST_AUTO_TEST_CASE(unprotected_directory_acl_and_junction_root_are_rejected) {
	Root root;
	const auto junction = root.path + L"\\junction";
	BOOST_REQUIRE(CreateDirectoryW(junction.c_str(), nullptr));
	Handle file(CreateFileW(junction.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
							FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
	BOOST_REQUIRE(file);
	const auto target = L"\\??\\" + root.path;
	struct Mount {
		DWORD tag;
		WORD length, reserved, sub_offset, sub_length, print_offset, print_length;
	};
	std::vector<unsigned char> buffer(sizeof(Mount) + (target.size() + 1 + root.path.size() + 1) * sizeof(wchar_t));
	auto* mount = reinterpret_cast<Mount*>(buffer.data());
	mount->tag = IO_REPARSE_TAG_MOUNT_POINT;
	mount->length = static_cast<WORD>(buffer.size() - 8);
	mount->sub_length = static_cast<WORD>(target.size() * sizeof(wchar_t));
	mount->print_offset = mount->sub_length + sizeof(wchar_t);
	mount->print_length = static_cast<WORD>(root.path.size() * sizeof(wchar_t));
	std::memcpy(buffer.data() + sizeof(Mount), target.c_str(), (target.size() + 1) * sizeof(wchar_t));
	DWORD returned = 0;
	std::memcpy(buffer.data() + sizeof(Mount) + mount->print_offset, root.path.c_str(),
				(root.path.size() + 1) * sizeof(wchar_t));
	const auto created = DeviceIoControl(file.value, FSCTL_SET_REPARSE_POINT, buffer.data(),
										 static_cast<DWORD>(buffer.size()), nullptr, 0, &returned, nullptr);
	BOOST_REQUIRE_MESSAGE(created, "junction creation failed: " << GetLastError());
	file.reset();
	BOOST_CHECK(!make_bound_checkpoint_storage_at_root(junction));
	SECURITY_ATTRIBUTES sa{sizeof(sa), root.descriptor, FALSE};
	const auto nested = root.path + L"\\nested";
	BOOST_REQUIRE(CreateDirectoryW(nested.c_str(), &sa));
	BOOST_CHECK(!make_bound_checkpoint_storage_at_root(junction + L"\\nested"));
	BOOST_REQUIRE(RemoveDirectoryW(nested.c_str()));
	BOOST_REQUIRE_EQUAL(SetNamedSecurityInfoW(root.path.data(), SE_FILE_OBJECT,
											  UNPROTECTED_DACL_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
											  nullptr, nullptr, nullptr, nullptr),
						ERROR_SUCCESS);
	BOOST_CHECK(!make_bound_checkpoint_storage_at_root(root.path));
	BOOST_CHECK(!make_bound_checkpoint_storage_at_root(root.path + L"\\\\"));
}
BOOST_AUTO_TEST_CASE(child_process) {
	const auto& suite = boost::unit_test::framework::master_test_suite();
	std::wstring root, ready_name, release_name;
	bool stale = false;
	for (int i = 1; i < suite.argc; ++i) {
		const std::string arg = suite.argv[i];
		if ((arg == "--root" || arg == "--ready" || arg == "--release") && i + 1 < suite.argc) {
			const auto value = std::filesystem::path(suite.argv[++i]).wstring();
			if (arg == "--root")
				root = value;
			else if (arg == "--ready")
				ready_name = value;
			else
				release_name = value;
		} else if (arg == "--stale")
			stale = true;
	}
	if (root.empty()) return;
	Handle ready(OpenEventW(EVENT_MODIFY_STATE, FALSE, ready_name.c_str())),
		release(OpenEventW(SYNCHRONIZE, FALSE, release_name.c_str()));
	BOOST_REQUIRE(ready);
	BOOST_REQUIRE(release);
	if (stale) {
		const auto token = read_input(root, L"input.token"), key = read_input(root, L"input.spki");
		auto owner = store(root, {key.begin(), key.end()});
		BOOST_REQUIRE(SetEvent(ready.value));
		BOOST_REQUIRE_EQUAL(WaitForSingleObject(release.value, 10000), WAIT_OBJECT_0);
		BOOST_CHECK(owner->save(token) == BoundCheckpointStatus::stale);
	} else {
		auto io = make_bound_checkpoint_storage_at_root(root, 0);
		BOOST_REQUIRE(io);
		BOOST_REQUIRE(io->lock() == BoundCheckpointIo::ok);
		BOOST_REQUIRE(SetEvent(ready.value));
		WaitForSingleObject(release.value, INFINITE);
		io->unlock();
	}
}
BOOST_AUTO_TEST_CASE(directory_handles_pin_root_and_ancestor_without_a_lock_file) {
	Root root;
	SECURITY_ATTRIBUTES sa{sizeof(sa), root.descriptor, FALSE};
	const auto nested = root.path + L"\\nested", renamed = root.path + L"-renamed";
	BOOST_REQUIRE(CreateDirectoryW(nested.c_str(), &sa));
	auto directory = checkpoint_windows::Directory::open(nested);
	BOOST_REQUIRE(directory);
	BOOST_CHECK(!MoveFileExW(nested.c_str(), (root.path + L"\\moved").c_str(), 0));
	BOOST_CHECK(!MoveFileExW(root.path.c_str(), renamed.c_str(), 0));
	directory.reset();
	BOOST_REQUIRE(MoveFileExW(root.path.c_str(), renamed.c_str(), 0));
	BOOST_REQUIRE(MoveFileExW(renamed.c_str(), root.path.c_str(), 0));
	BOOST_REQUIRE(MoveFileExW(nested.c_str(), (root.path + L"\\moved").c_str(), 0));
	BOOST_REQUIRE(RemoveDirectoryW((root.path + L"\\moved").c_str()));
}
BOOST_AUTO_TEST_CASE(lock_deadlines_reject_late_retry_and_release_late_acquisition) {
	for (unsigned scenario = 0; scenario < 3; ++scenario) {
		Root root;
		auto io = test_checkpoint_storage_at_root(root.path, scenario == 2 ? 0 : 10);
		BOOST_REQUIRE(io);
		fault::tick_index = 0;
		fault::lock_calls = 0;
		fault::fail_first_lock = scenario == 0;
		fault::ticks =
			scenario == 0 ? std::vector<ULONGLONG>{100, 100, 101, 110} : std::vector<ULONGLONG>{100, 100, 110};
		const auto result = io->lock();
		const auto calls = fault::lock_calls;
		fault::ticks.clear();
		fault::fail_first_lock = false;
		BOOST_CHECK_EQUAL(calls, 1);
		BOOST_CHECK(result == (scenario == 2 ? BoundCheckpointIo::ok : BoundCheckpointIo::busy));
		if (result == BoundCheckpointIo::ok) io->unlock();
		// Keep the first owner alive: another real OS handle must acquire the lock.
		auto other = make_bound_checkpoint_storage_at_root(root.path, 0);
		BOOST_REQUIRE(other);
		BOOST_REQUIRE(other->lock() == BoundCheckpointIo::ok);
		other->unlock();
	}
}
BOOST_AUTO_TEST_CASE(relaxed_root_acl_blocks_existing_owner_without_storage_mutation) {
	Root root;
	SessionTestSigner signer;
	auto owner = store(root.path, signer.spki);
	const auto token = signer.lease(context(), std::string(43, 'A'));
	BOOST_REQUIRE(owner->save(token) == BoundCheckpointStatus::saved);
	root.write(L"checkpoint.stage", "preserve staging");
	auto io = make_bound_checkpoint_storage_at_root(root.path, 0);
	BOOST_REQUIRE(io);
	BOOST_REQUIRE(io->lock() == BoundCheckpointIo::ok);
	std::string out;
	BOOST_REQUIRE(io->read(0, out) == BoundCheckpointIo::ok);
	BOOST_REQUIRE(io->read(1, out) == BoundCheckpointIo::ok);
	BOOST_REQUIRE_EQUAL(SetNamedSecurityInfoW(root.path.data(), SE_FILE_OBJECT,
											  UNPROTECTED_DACL_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
											  nullptr, nullptr, nullptr, nullptr),
						ERROR_SUCCESS);
	out = "unchanged";
	BOOST_CHECK(io->read(0, out) == BoundCheckpointIo::error);
	BOOST_CHECK(io->confirm(0, token) == BoundCheckpointIo::error);
	BOOST_CHECK(io->publish(0, token) == BoundCheckpointIo::error);
	io->unlock();
	BOOST_CHECK(io->lock() == BoundCheckpointIo::error);
	BOOST_CHECK(owner->load(out) == BoundCheckpointStatus::storage_error);
	BOOST_CHECK(owner->save(token) == BoundCheckpointStatus::storage_error);
	BOOST_CHECK_EQUAL(out, "unchanged");
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.0"), token);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.1"), token);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.stage"), "preserve staging");
}
BOOST_AUTO_TEST_CASE(independent_process_stale_writer_and_lock_owner_termination) {
	for (bool stale : {false, true}) {
		Root root;
		SessionTestSigner signer;
		const auto old = signer.lease(context(), std::string(43, 'A'), 1);
		root.write(L"input.token", old);
		root.write(L"input.spki", std::string(signer.spki.begin(), signer.spki.end()));
		auto owner = store(root.path, signer.spki);
		BOOST_REQUIRE(owner->save(old) == BoundCheckpointStatus::saved);
		const auto ready_name = event_name(L"-ready"), release_name = event_name(L"-release");
		Handle ready(CreateEventW(nullptr, TRUE, FALSE, ready_name.c_str())),
			release(CreateEventW(nullptr, TRUE, FALSE, release_name.c_str()));
		BOOST_REQUIRE(ready);
		BOOST_REQUIRE(release);
		Child child(root.path, ready_name, release_name, stale);
		BOOST_REQUIRE_EQUAL(WaitForSingleObject(ready.value, 10000), WAIT_OBJECT_0);
		if (stale) {
			const auto newer = signer.lease(context(), std::string(42, 'B') + "A", 7);
			BOOST_REQUIRE(owner->save(newer) == BoundCheckpointStatus::saved);
			BOOST_REQUIRE(SetEvent(release.value));
			BOOST_REQUIRE_EQUAL(WaitForSingleObject(child.process.value, 10000), WAIT_OBJECT_0);
			DWORD exit = 1;
			BOOST_REQUIRE(GetExitCodeProcess(child.process.value, &exit));
			BOOST_CHECK_EQUAL(exit, 0);
			std::string out;
			BOOST_CHECK(owner->load(out) == BoundCheckpointStatus::loaded);
			BOOST_CHECK_EQUAL(out, newer);
		} else {
			std::string out = "unchanged";
			BOOST_CHECK(owner->load(out) == BoundCheckpointStatus::busy);
			BOOST_CHECK_EQUAL(out, "unchanged");
			BOOST_REQUIRE(TerminateProcess(child.process.value, 0));
			BOOST_REQUIRE_EQUAL(WaitForSingleObject(child.process.value, 5000), WAIT_OBJECT_0);
			const auto start = GetTickCount64();
			BoundCheckpointStatus result;
			do {
				result = owner->load(out);
				if (result == BoundCheckpointStatus::busy) Sleep(10);
			} while (result == BoundCheckpointStatus::busy && GetTickCount64() - start < 5000);
			BOOST_CHECK(result == BoundCheckpointStatus::loaded);
			BOOST_CHECK_EQUAL(out, old);
		}
	}
}
BOOST_AUTO_TEST_CASE(namespace_is_framed_and_rejects_invalid_configuration) {
	BoundCheckpointNamespace a{"vendor.app", "https://backend.test", "issuer", "audience", "proof", "CAD", "DEFAULT"};
	std::string first, second;
	BOOST_REQUIRE(bound_checkpoint_namespace(a, first));
	BOOST_CHECK_EQUAL(first.size(), 64);
	a.issuer = "issu";
	a.lease_audience = "eraudience";
	BOOST_REQUIRE(bound_checkpoint_namespace(a, second));
	BOOST_CHECK(first != second);
	a.endpoint_origin = "http://backend.test";
	second = "unchanged";
	BOOST_CHECK(!bound_checkpoint_namespace(a, second));
	BOOST_CHECK_EQUAL(second, "unchanged");
}
BOOST_AUTO_TEST_CASE(actual_files_preserve_winner_across_write_flush_rename_and_mirror_failures) {
	for (auto mode :
		 {fault::Mode::write, fault::Mode::flush, fault::Mode::retained_flush, fault::Mode::move_before,
		  fault::Mode::move_after, fault::Mode::reread, fault::Mode::mirror_before, fault::Mode::mirror_after}) {
		Root root;
		SessionTestSigner signer;
		auto io = test_checkpoint_storage_at_root(root.path, 0);
		BOOST_REQUIRE(io);
		auto owner = BoundCheckpointStore::create(std::move(io), {{signer.spki, false}}, expected());
		BOOST_REQUIRE(owner);
		const auto old = signer.lease(context(), std::string(43, 'A'), 1),
				   newer = signer.lease(context(), std::string(42, 'B') + "A", 7);
		fault::mode = fault::Mode::none;
		BOOST_REQUIRE(owner->save(old) == BoundCheckpointStatus::saved);
		fault::mode = mode;
		fault::moves = 0;
		fault::read_failed = false;
		const auto result = owner->save(newer);
		fault::mode = fault::Mode::none;  // Restore before assertions/cleanup.
		const bool before = mode == fault::Mode::write || mode == fault::Mode::flush ||
							mode == fault::Mode::retained_flush || mode == fault::Mode::move_before;
		BOOST_CHECK(result == (before								? BoundCheckpointStatus::storage_error
							   : mode == fault::Mode::mirror_before ? BoundCheckpointStatus::mirror_pending
																	: BoundCheckpointStatus::commit_unknown));
		const auto zero = read_input(root.path, L"checkpoint.0"), one = read_input(root.path, L"checkpoint.1");
		BOOST_CHECK(zero == old || zero == newer);
		BOOST_CHECK(one == old || one == newer);
		if (before) {
			BOOST_CHECK_EQUAL(zero, old);
			BOOST_CHECK_EQUAL(one, old);
		} else
			BOOST_CHECK_EQUAL(one, newer);
		std::string out;
		BOOST_CHECK(owner->load(out) == BoundCheckpointStatus::loaded);
		BOOST_CHECK_EQUAL(out, before ? old : newer);
		const auto retried = owner->save(newer);
		BOOST_CHECK(retried == BoundCheckpointStatus::saved || retried == BoundCheckpointStatus::unchanged);
		BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.0"), newer);
		BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.1"), newer);
	}
}
BOOST_AUTO_TEST_CASE(existing_slot_confirmation_requires_successful_flush) {
	Root root;
	SessionTestSigner signer;
	auto io = test_checkpoint_storage_at_root(root.path, 0);
	BOOST_REQUIRE(io);
	auto owner = BoundCheckpointStore::create(std::move(io), {{signer.spki, false}}, expected());
	BOOST_REQUIRE(owner);
	const auto token = signer.lease(context(), std::string(43, 'A'));
	BOOST_REQUIRE(owner->save(token) == BoundCheckpointStatus::saved);
	root.write(L"checkpoint.stage", "preserve staging");
	fault::mode = fault::Mode::retained_flush;
	fault::moves = 0;
	const auto result = owner->save(token);
	fault::mode = fault::Mode::none;
	BOOST_CHECK(result == BoundCheckpointStatus::commit_unknown);
	BOOST_CHECK_EQUAL(fault::moves, 0);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.0"), token);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.1"), token);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.stage"), "preserve staging");
	BOOST_CHECK(owner->save(token) == BoundCheckpointStatus::unchanged);
}

BOOST_AUTO_TEST_CASE(signer_rotation_requires_overlap_until_both_real_checkpoint_slots_migrate) {
	Root root;
	SessionTestSigner old_signer, new_signer;
	const auto open = [&](std::vector<BoundLeaseTrustKey> trust) {
		auto io = test_checkpoint_storage_at_root(root.path, 0);
		BOOST_REQUIRE(io);
		auto owner = BoundCheckpointStore::create(std::move(io), std::move(trust), expected());
		BOOST_REQUIRE(owner);
		return owner;
	};
	const auto old = old_signer.lease(context(), std::string(43, 'A'), 1);
	const auto same_time = new_signer.lease(context(), std::string(42, 'B') + "A", 1);
	ParsedBoundLease parsed;
	BOOST_REQUIRE(decode_bound_lease(same_time, parsed));
	std::string payload(parsed.payload.begin(), parsed.payload.end());
	for (const auto* field : {"issued-at", "renew-after", "expires-at"}) {
		const auto start = payload.find(std::string(field) + '=') + std::strlen(field) + 1;
		const auto length = payload.find('\n', start) - start;
		payload.replace(start, length, std::to_string(std::stoull(payload.substr(start, length)) + 1));
	}
	const auto newer = new_signer.sign(payload);
	auto initial = open({{old_signer.spki, false}});
	BOOST_REQUIRE(initial->save(old) == BoundCheckpointStatus::saved);
	initial.reset();
	auto overlap = open({{old_signer.spki, false}, {new_signer.spki, false}});
	BOOST_CHECK(overlap->save(same_time) == BoundCheckpointStatus::conflict);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.0"), old);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.1"), old);
	fault::mode = fault::Mode::mirror_before;
	fault::moves = 0;
	const auto interrupted = overlap->save(newer);
	fault::mode = fault::Mode::none;
	BOOST_REQUIRE(interrupted == BoundCheckpointStatus::mirror_pending);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.0"), old);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.1"), newer);
	overlap.reset();
	std::string out = "unchanged";
	for (const auto& trust : std::vector<std::vector<BoundLeaseTrustKey>>{
			 {{new_signer.spki, false}}, {{old_signer.spki, true}, {new_signer.spki, false}}}) {
		auto premature = open(trust);
		BOOST_CHECK(premature->load(out) == BoundCheckpointStatus::invalid_stored);
		BOOST_CHECK_EQUAL(out, "unchanged");
		BOOST_CHECK(premature->save(newer) == BoundCheckpointStatus::invalid_stored);
		BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.0"), old);
		BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.1"), newer);
	}
	overlap = open({{old_signer.spki, false}, {new_signer.spki, false}});
	BOOST_REQUIRE(overlap->load(out) == BoundCheckpointStatus::loaded);
	BOOST_CHECK_EQUAL(out, newer);
	BOOST_REQUIRE(overlap->save(newer) == BoundCheckpointStatus::saved);
	overlap.reset();
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.0"), newer);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.1"), newer);
	auto migrated = open({{new_signer.spki, false}});
	BOOST_REQUIRE(migrated->load(out) == BoundCheckpointStatus::loaded);
	BOOST_CHECK_EQUAL(out, newer);
	BOOST_CHECK(migrated->save(old) == BoundCheckpointStatus::invalid_candidate);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.0"), newer);
	BOOST_CHECK_EQUAL(read_input(root.path, L"checkpoint.1"), newer);
}
