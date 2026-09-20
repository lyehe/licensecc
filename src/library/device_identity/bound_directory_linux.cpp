#include "bound_directory_linux.hpp"
#include <fcntl.h>
#include <pwd.h>
#include <sys/stat.h>
#include <unistd.h>
#include <array>
#include <cerrno>

namespace license {
namespace device_identity {
int open_bound_private_directory(const std::string& path) noexcept {
	if (path.empty() || path.front() != '/' || path.back() == '/') return -1;
	int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (fd < 0) return -1;
	try {
		for (std::size_t start = 1; start < path.size();) {
			const auto end = path.find('/', start);
			const auto part = path.substr(start, end == std::string::npos ? end : end - start);
			if (part.empty() || part == "." || part == ".." || part.find('\0') != std::string::npos) {
				close(fd);
				return -1;
			}
			const int next = openat(fd, part.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
			close(fd);
			fd = next;
			if (fd < 0) return -1;
			struct stat status {};
			if (fstat(fd, &status) != 0 || (status.st_uid != 0 && status.st_uid != geteuid()) ||
				((status.st_mode & 0022) && !(status.st_uid == 0 && (status.st_mode & S_ISVTX)))) {
				close(fd);
				return -1;
			}
			if (end == std::string::npos) {
				if (status.st_uid != geteuid() || (status.st_mode & 0777) != 0700) {
					close(fd);
					return -1;
				}
				return fd;
			}
			start = end + 1;
		}
	} catch (...) {
	}
	close(fd);
	return -1;
}
bool bound_linux_directory(const std::string& leaf, std::string& out) noexcept {
	try {
		if (getuid() != geteuid() || getgid() != getegid() || leaf.empty()) return false;
		for (const auto c : leaf)
			if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
		std::array<char, 16384> buffer{};
		passwd entry{}, *result = nullptr;
		if (getpwuid_r(geteuid(), &entry, buffer.data(), buffer.size(), &result) != 0 || !result || !entry.pw_dir)
			return false;
		const std::string base = std::string(entry.pw_dir) + "/.licensecc";
		if (mkdir(base.c_str(), 0700) != 0 && errno != EEXIST) return false;
		const int parent = open_bound_private_directory(base);
		if (parent < 0) return false;
		const bool created = mkdirat(parent, leaf.c_str(), 0700) == 0;
		const bool exists = created || errno == EEXIST;
		const bool durable = !created || fsync(parent) == 0;
		close(parent);
		if (!exists || !durable) return false;
		const auto path = base + "/" + leaf;
		const int checked = open_bound_private_directory(path);
		if (checked < 0) return false;
		close(checked);
		out = path;
		return true;
	} catch (...) {
		return false;
	}
}
}  // namespace device_identity
}  // namespace license
