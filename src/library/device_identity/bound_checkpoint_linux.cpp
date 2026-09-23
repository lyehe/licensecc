#include "bound_checkpoint_platform.hpp"
#include "bound_directory_linux.hpp"
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <fcntl.h>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <thread>

namespace license {
namespace device_identity {
namespace {
struct File {
	int fd;
	explicit File(int value) : fd(value) {}
	~File() {
		if (fd >= 0) ::close(fd);
	}
	File(const File&) = delete;
	File& operator=(const File&) = delete;
};
constexpr const char* slots[]{"checkpoint.0", "checkpoint.1"};
constexpr const char* stage = "checkpoint.stage";
constexpr const char* lock_name = "checkpoint.lock";
class LinuxStorage final : public BoundCheckpointStorage {
	File directory_, lock_;
	std::string path_;
	unsigned wait_ms_;
	pid_t process_ = getpid();
	std::atomic<long> owner_{0};
	std::string snapshot_[2];
	bool known_[2]{}, present_[2]{};
	bool held() const { return getpid() == process_ && owner_.load() == syscall(SYS_gettid); }
	bool valid_directory() const {
		File current(open_bound_private_directory(path_));
		struct stat expected {
		}, actual{};
		return current.fd >= 0 && fstat(directory_.fd, &expected) == 0 && fstat(current.fd, &actual) == 0 &&
			   expected.st_dev == actual.st_dev && expected.st_ino == actual.st_ino;
	}
	bool valid(int fd, const char* name, std::size_t maximum) const {
		struct stat actual {
		}, named{};
		return fd >= 0 && fstat(fd, &actual) == 0 && fstatat(directory_.fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
			   S_ISREG(actual.st_mode) && actual.st_uid == geteuid() && (actual.st_mode & 0777) == 0600 &&
			   actual.st_nlink == 1 && actual.st_size >= 0 && static_cast<std::uint64_t>(actual.st_size) <= maximum &&
			   actual.st_dev == named.st_dev && actual.st_ino == named.st_ino;
	}
	BoundCheckpointIo current(unsigned slot, std::string& out, bool flush) {
		File file(openat(directory_.fd, slots[slot], O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
		if (file.fd < 0) return errno == ENOENT ? BoundCheckpointIo::missing : BoundCheckpointIo::error;
		if (!valid(file.fd, slots[slot], 8192)) return BoundCheckpointIo::error;
		std::array<char, 8193> bytes{};
		std::size_t used = 0;
		while (used < bytes.size()) {
			const auto count = ::read(file.fd, bytes.data() + used, bytes.size() - used);
			if (count < 0 && errno == EINTR) continue;
			if (count < 0) return BoundCheckpointIo::error;
			if (!count) break;
			used += static_cast<std::size_t>(count);
		}
		if (used > 8192 || !valid(file.fd, slots[slot], 8192) || (flush && fsync(file.fd) != 0))
			return BoundCheckpointIo::error;
		out.assign(bytes.data(), used);
		return BoundCheckpointIo::ok;
	}
	bool unchanged(unsigned slot, bool flush) {
		if (!known_[slot]) return false;
		std::string bytes;
		const auto read = current(slot, bytes, flush);
		return present_[slot] ? read == BoundCheckpointIo::ok && bytes == snapshot_[slot]
							  : read == BoundCheckpointIo::missing;
	}

public:
	LinuxStorage(int directory, int lock, std::string path, unsigned wait)
		: directory_(directory), lock_(lock), path_(std::move(path)), wait_ms_(wait) {}
	BoundCheckpointIo lock() noexcept override {
		try {
			if (getpid() != process_) return BoundCheckpointIo::error;
			long empty = 0;
			if (!owner_.compare_exchange_strong(empty, syscall(SYS_gettid))) return BoundCheckpointIo::busy;
			if (!valid_directory() || !valid(lock_.fd, lock_name, 0)) {
				owner_ = 0;
				return BoundCheckpointIo::error;
			}
			const auto start = std::chrono::steady_clock::now();
			while (flock(lock_.fd, LOCK_EX | LOCK_NB) != 0) {
				if (errno != EWOULDBLOCK && errno != EINTR) {
					owner_ = 0;
					return BoundCheckpointIo::error;
				}
				if (std::chrono::steady_clock::now() - start >= std::chrono::milliseconds(wait_ms_)) {
					owner_ = 0;
					return BoundCheckpointIo::busy;
				}
				std::this_thread::sleep_for(std::chrono::milliseconds(1));
			}
			if (!valid_directory() || !valid(lock_.fd, lock_name, 0)) {
				unlock();
				return BoundCheckpointIo::error;
			}
			known_[0] = known_[1] = false;
			return BoundCheckpointIo::ok;
		} catch (...) {
			unlock();
			return BoundCheckpointIo::error;
		}
	}
	void unlock() noexcept override {
		if (held()) {
			flock(lock_.fd, LOCK_UN);
			owner_ = 0;
		}
	}
	BoundCheckpointIo read(unsigned slot, std::string& out) noexcept override {
		try {
			if (slot > 1 || !held() || !valid_directory()) return BoundCheckpointIo::error;
			std::string bytes;
			const auto result = current(slot, bytes, false);
			known_[slot] = result == BoundCheckpointIo::ok || result == BoundCheckpointIo::missing;
			present_[slot] = result == BoundCheckpointIo::ok;
			if (present_[slot]) {
				snapshot_[slot] = bytes;
				out.swap(bytes);
			}
			return result;
		} catch (...) {
			return BoundCheckpointIo::error;
		}
	}
	BoundCheckpointIo confirm(unsigned slot, const std::string& bytes) noexcept override {
		try {
			std::string actual;
			return slot <= 1 && held() && valid_directory() && current(slot, actual, true) == BoundCheckpointIo::ok &&
						   actual == bytes && fsync(directory_.fd) == 0
					   ? BoundCheckpointIo::ok
					   : BoundCheckpointIo::error;
		} catch (...) {
			return BoundCheckpointIo::error;
		}
	}
	BoundCheckpointIo publish(unsigned slot, const std::string& bytes) noexcept override {
		try {
			if (slot > 1 || !held() || bytes.empty() || bytes.size() > 8192 || !valid_directory() ||
				!unchanged(1 - slot, true) || !unchanged(slot, false))
				return BoundCheckpointIo::error;
			File old(openat(directory_.fd, stage, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
			if (old.fd >= 0) {
				if (!valid(old.fd, stage, 8192) || unlinkat(directory_.fd, stage, 0) != 0)
					return BoundCheckpointIo::error;
			} else if (errno != ENOENT)
				return BoundCheckpointIo::error;
			File file(openat(directory_.fd, stage, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
			// The process umask may strip owner bits; the private mode is required, not requested.
			if (file.fd < 0 || fchmod(file.fd, 0600) != 0 || !valid(file.fd, stage, 8192))
				return BoundCheckpointIo::error;
			std::size_t offset = 0;
			while (offset < bytes.size()) {
				const auto count = ::write(file.fd, bytes.data() + offset, bytes.size() - offset);
				if (count < 0 && errno == EINTR) continue;
				if (count <= 0) return BoundCheckpointIo::error;
				offset += static_cast<std::size_t>(count);
			}
			if (fsync(file.fd) != 0 || !valid(file.fd, stage, 8192) || !valid_directory() ||
				!unchanged(1 - slot, true) || !unchanged(slot, false) ||
				renameat(directory_.fd, stage, directory_.fd, slots[slot]) != 0 || fsync(directory_.fd) != 0)
				return BoundCheckpointIo::error;
			return confirm(slot, bytes);
		} catch (...) {
			return BoundCheckpointIo::error;
		}
	}
};
}  // namespace
std::unique_ptr<BoundCheckpointStorage> make_bound_checkpoint_storage_at_root(const std::string& root,
																			  unsigned wait) noexcept {
	try {
		if (wait > 1000) return nullptr;
		File directory(open_bound_private_directory(root));
		if (directory.fd < 0) return nullptr;
		File lock(openat(directory.fd, lock_name, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600));
		if (lock.fd < 0) return nullptr;
		// The process umask may strip owner bits; the private mode is required, not requested.
		if (fchmod(lock.fd, 0600) != 0) return nullptr;
		auto result = std::make_unique<LinuxStorage>(directory.fd, lock.fd, root, wait);
		directory.fd = lock.fd = -1;
		const auto checked = result->lock();
		if (checked == BoundCheckpointIo::error) return nullptr;
		if (checked == BoundCheckpointIo::ok) result->unlock();
		return result;
	} catch (...) {
		return nullptr;
	}
}
std::unique_ptr<BoundCheckpointStorage> make_bound_checkpoint_storage(
	const BoundCheckpointNamespace& options) noexcept {
	try {
		std::string hash, root;
		return bound_checkpoint_namespace(options, hash) && bound_linux_directory("checkpoint-" + hash, root)
				   ? make_bound_checkpoint_storage_at_root(root)
				   : nullptr;
	} catch (...) {
		return nullptr;
	}
}
}  // namespace device_identity
}  // namespace license
