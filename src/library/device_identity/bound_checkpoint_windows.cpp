#include "bound_checkpoint_platform.hpp"
#include "bound_checkpoint_directory.hpp"
#include "bound_encoding.hpp"
#include "bound_http.hpp"
#include "p256_crypto.hpp"
#include <algorithm>
#include <array>
#include <atomic>

namespace license {
namespace device_identity {
namespace {
using checkpoint_windows::Directory;
using checkpoint_windows::Handle;
constexpr const wchar_t* slots[]{L"checkpoint.0", L"checkpoint.1"};
constexpr const wchar_t* staging = L"checkpoint.stage";
constexpr const wchar_t* lock_name = L"checkpoint.lock";
class WindowsStorage final : public BoundCheckpointStorage {
	std::unique_ptr<Directory> directory_;
	Handle lock_;
	std::atomic<DWORD> owner_{0};
	unsigned wait_ms_;
	std::string snapshot_[2];
	bool known_[2]{}, present_[2]{};
	bool held() const { return owner_.load() == GetCurrentThreadId(); }
	bool bytes(HANDLE file, const wchar_t* name, std::string& out) {
		if (!directory_->valid_file(file, name, 8192)) return false;
		LARGE_INTEGER beginning{};
		if (!SetFilePointerEx(file, beginning, nullptr, FILE_BEGIN)) return false;
		std::array<char, 8193> buffer{};
		DWORD used = 0;
		while (used < buffer.size()) {
			DWORD count = 0;
			if (!ReadFile(file, buffer.data() + used, static_cast<DWORD>(buffer.size()) - used, &count, nullptr))
				return false;
			if (!count) break;
			used += count;
		}
		LARGE_INTEGER size{};
		if (used > 8192 || !GetFileSizeEx(file, &size) || size.QuadPart != used ||
			!directory_->valid_file(file, name, 8192))
			return false;
		std::string value(buffer.data(), used);
		out.swap(value);
		return true;
	}
	BoundCheckpointIo read_current(unsigned slot, std::string& out, bool flush) {
		auto file = directory_->file(slots[slot], GENERIC_READ | (flush ? GENERIC_WRITE : 0), OPEN_EXISTING);
		if (!file)
			return GetLastError() == ERROR_FILE_NOT_FOUND ? BoundCheckpointIo::missing : BoundCheckpointIo::error;
		if (!bytes(file.value, slots[slot], out) || (flush && !FlushFileBuffers(file.value)))
			return BoundCheckpointIo::error;
		return BoundCheckpointIo::ok;
	}
	bool unchanged(unsigned slot, bool flush) {
		if (!known_[slot]) return false;
		std::string current;
		const auto result = read_current(slot, current, flush);
		return present_[slot] ? result == BoundCheckpointIo::ok && current == snapshot_[slot]
							  : result == BoundCheckpointIo::missing;
	}
	bool remove_staging() {
		auto old = directory_->file(staging, GENERIC_READ | DELETE, OPEN_EXISTING, 0);
		if (!old) return GetLastError() == ERROR_FILE_NOT_FOUND;
		if (!directory_->valid_file(old.value, staging, 8192)) return false;
		FILE_DISPOSITION_INFO disposition{TRUE};
		return SetFileInformationByHandle(old.value, FileDispositionInfo, &disposition, sizeof(disposition)) != FALSE;
	}

public:
	WindowsStorage(std::unique_ptr<Directory> directory, Handle lock, unsigned wait)
		: directory_(std::move(directory)), lock_(std::move(lock)), wait_ms_(wait) {}
	~WindowsStorage() override { lock_.reset(); }
	BoundCheckpointIo lock() noexcept override {
		try {
			DWORD empty = 0;
			if (!owner_.compare_exchange_strong(empty, GetCurrentThreadId())) return BoundCheckpointIo::busy;
			if (!lock_ || !directory_->valid_file(lock_.value, lock_name, 0)) {
				owner_ = 0;
				return BoundCheckpointIo::error;
			}
			const auto start = GetTickCount64();
			bool attempted = false;
			for (;;) {
				const auto before = GetTickCount64();
				if (before < start || ((wait_ms_ || attempted) && before - start >= wait_ms_)) {
					owner_ = 0;
					return BoundCheckpointIo::busy;
				}
				OVERLAPPED offset{};
				if (LockFileEx(lock_.value, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &offset)) {
					if (!directory_->valid()) {
						if (!UnlockFileEx(lock_.value, 0, 1, 0, &offset)) lock_.reset();
						owner_ = 0;
						return BoundCheckpointIo::error;
					}
					const auto admitted = GetTickCount64();
					if (admitted < start || (wait_ms_ && admitted - start >= wait_ms_)) {
						if (!UnlockFileEx(lock_.value, 0, 1, 0, &offset)) lock_.reset();
						owner_ = 0;
						return BoundCheckpointIo::busy;
					}
					known_[0] = known_[1] = false;
					return BoundCheckpointIo::ok;
				}
				attempted = true;
				if (GetLastError() != ERROR_LOCK_VIOLATION) {
					owner_ = 0;
					return BoundCheckpointIo::error;
				}
				const auto now = GetTickCount64();
				if (now < start || now - start >= wait_ms_) {
					owner_ = 0;
					return BoundCheckpointIo::busy;
				}
				Sleep(static_cast<DWORD>((std::min)(static_cast<ULONGLONG>(10), wait_ms_ - (now - start))));
			}
		} catch (...) {
			owner_ = 0;
			return BoundCheckpointIo::error;
		}
	}
	void unlock() noexcept override {
		if (!held()) return;
		OVERLAPPED offset{};
		if (!UnlockFileEx(lock_.value, 0, 1, 0, &offset)) lock_.reset();
		known_[0] = known_[1] = false;
		snapshot_[0].clear();
		snapshot_[1].clear();
		owner_ = 0;
	}
	BoundCheckpointIo read(unsigned slot, std::string& out) noexcept override {
		try {
			if (!held() || slot > 1) return BoundCheckpointIo::error;
			std::string value;
			const auto result = read_current(slot, value, false);
			if (result != BoundCheckpointIo::ok && result != BoundCheckpointIo::missing) return result;
			auto copy = value;
			snapshot_[slot].swap(copy);
			known_[slot] = true;
			present_[slot] = result == BoundCheckpointIo::ok;
			if (present_[slot]) out.swap(value);
			return result;
		} catch (...) {
			return BoundCheckpointIo::error;
		}
	}
	BoundCheckpointIo confirm(unsigned slot, const std::string& expected) noexcept override {
		try {
			if (!held() || slot > 1 || expected.size() > 8192 || !known_[slot] || !present_[slot] ||
				snapshot_[slot] != expected)
				return BoundCheckpointIo::error;
			return unchanged(slot, true) ? BoundCheckpointIo::ok : BoundCheckpointIo::error;
		} catch (...) {
			return BoundCheckpointIo::error;
		}
	}
	BoundCheckpointIo publish(unsigned slot, const std::string& token) noexcept override {
		try {
			if (!held() || slot > 1 || token.empty() || token.size() > 8192 || !unchanged(1 - slot, true) ||
				!unchanged(slot, false))
				return BoundCheckpointIo::error;
			if (!remove_staging()) return BoundCheckpointIo::error;
			auto stage = directory_->file(staging, GENERIC_READ | GENERIC_WRITE, CREATE_NEW, 0);
			if (!stage || !directory_->valid_file(stage.value, staging, 0)) return BoundCheckpointIo::error;
			DWORD written = 0;
			while (written < token.size()) {
				DWORD count = 0;
				if (!WriteFile(stage.value, token.data() + written, static_cast<DWORD>(token.size()) - written, &count,
							   nullptr) ||
					!count)
					return BoundCheckpointIo::error;
				written += count;
			}
			std::string staged;
			if (!bytes(stage.value, staging, staged) || staged != token || !FlushFileBuffers(stage.value))
				return BoundCheckpointIo::error;
			stage.reset();
			if (!unchanged(1 - slot, true) || !unchanged(slot, false)) return BoundCheckpointIo::error;
			const auto from = directory_->path() + L"\\" + staging, to = directory_->path() + L"\\" + slots[slot];
			if (!directory_->valid() ||
				!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
				return BoundCheckpointIo::error;
			std::string committed;
			if (read_current(slot, committed, true) != BoundCheckpointIo::ok || committed != token)
				return BoundCheckpointIo::error;
			return BoundCheckpointIo::ok;
		} catch (...) {
			return BoundCheckpointIo::error;
		}
	}
};
std::unique_ptr<BoundCheckpointStorage> make_storage(std::unique_ptr<Directory> directory, unsigned wait) {
	if (!directory || wait > 1000) return nullptr;
	auto lock =
		directory->file(lock_name, GENERIC_READ | GENERIC_WRITE, OPEN_ALWAYS, FILE_SHARE_READ | FILE_SHARE_WRITE);
	if (!lock || !directory->valid_file(lock.value, lock_name, 0)) return nullptr;
	return std::make_unique<WindowsStorage>(std::move(directory), std::move(lock), wait);
}
}  // namespace
std::unique_ptr<BoundCheckpointStorage> make_bound_checkpoint_storage(
	const BoundCheckpointNamespace& options) noexcept {
	try {
		std::string hash;
		return bound_checkpoint_namespace(options, hash) ? make_storage(Directory::production(hash), 250) : nullptr;
	} catch (...) {
		return nullptr;
	}
}
std::unique_ptr<BoundCheckpointStorage> make_bound_checkpoint_storage_at_root(const std::wstring& root,
																			  unsigned wait) noexcept {
	try {
		return make_storage(Directory::open(root), wait);
	} catch (...) {
		return nullptr;
	}
}
}  // namespace device_identity
}  // namespace license
