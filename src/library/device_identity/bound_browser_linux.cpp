#include "bound_browser.hpp"
#include "bound_http.hpp"
#include "bound_encoding.hpp"
#include <poll.h>
#include <fcntl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#include <cerrno>
#include <cstdlib>
#include <string_view>

#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif

extern char** environ;

namespace license {
namespace device_identity {
namespace {
// Resolve before fork: only absolute PATH entries, never the current directory.
std::string resolve_opener() {
	const char* path = std::getenv("PATH");
	std::string_view entries = path && *path ? path : "/usr/local/bin:/usr/bin:/bin";
	while (true) {
		const auto split = entries.find(':');
		const auto entry = entries.substr(0, split);
		if (!entry.empty() && entry.front() == '/') {
			std::string candidate(entry);
			candidate += "/xdg-open";
			if (::access(candidate.c_str(), X_OK) == 0) return candidate;
		}
		if (split == std::string_view::npos) return {};
		entries.remove_prefix(split + 1);
	}
}
int descriptor_ceiling() noexcept {
	rlimit limit{};
	return getrlimit(RLIMIT_NOFILE, &limit) == 0 && limit.rlim_cur != RLIM_INFINITY && limit.rlim_cur < 65536
			   ? static_cast<int>(limit.rlim_cur)
			   : 65536;
}
class LinuxBrowser final : public BoundBrowserLauncher {
	std::string prefix_;

public:
	explicit LinuxBrowser(const std::string& base) : prefix_(base + "#attempt_handle=") {}
	BoundBrowserStatus open(const std::string& url) noexcept override {
		try {
			if (url.size() != prefix_.size() + 43 || url.compare(0, prefix_.size(), prefix_) != 0 ||
				!bound_encoding::token(std::string_view(url).substr(prefix_.size()), 32))
				return BoundBrowserStatus::invalid_input;
			auto opener = resolve_opener();
			if (opener.empty()) return BoundBrowserStatus::unavailable;
			const int ceiling = descriptor_ceiling();
			// A desktop opener may remain attached to its browser. Detach through
			// an intermediate child: never block enrollment on browser lifetime and
			// never leave a library-owned reaper thread alive after unload.
			int channel[2];
			if (pipe2(channel, O_CLOEXEC) != 0) return BoundBrowserStatus::unavailable;
			for (auto& fd : channel) {
				if (fd >= 3) continue;
				const auto moved = fcntl(fd, F_DUPFD_CLOEXEC, 3);
				if (moved < 0) {
					::close(channel[0]);
					::close(channel[1]);
					return BoundBrowserStatus::unavailable;
				}
				::close(fd);
				fd = moved;
			}
			char* args[]{opener.data(), const_cast<char*>(url.c_str()), nullptr};
			const auto child = fork();
			if (child == 0) {
				// Only async-signal-safe operations after fork in a multithreaded app.
				::close(channel[0]);
				if (setsid() >= 0) {
					const auto detached = fork();
					if (detached > 0) _exit(0);
					if (detached == 0) {
						const int sink = ::open("/dev/null", O_RDWR | O_CLOEXEC);
						if (sink >= 0 && sink <= 2) (void)fcntl(sink, F_SETFD, 0);
						if (sink >= 0 && dup2(sink, 0) >= 0 && dup2(sink, 1) >= 0 && dup2(sink, 2) >= 0) {
							if (sink > 2) ::close(sink);
								// Host descriptors must not outlive this call inside the browser.
#ifdef SYS_close_range
							if (syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_CLOEXEC) != 0)
#endif
								for (int fd = 3; fd < ceiling; ++fd) (void)fcntl(fd, F_SETFD, FD_CLOEXEC);
							execve(opener.data(), args, environ);
						}
					}
				}
				const char failed = 1;
				(void)::write(channel[1], &failed, 1);
				_exit(127);
			}
			::close(channel[1]);
			if (child < 0) {
				::close(channel[0]);
				return BoundBrowserStatus::unavailable;
			}
			int status = 0;
			pid_t waited;
			do {
				waited = waitpid(child, &status, 0);
			} while (waited < 0 && errno == EINTR);
			// A host that ignores or reaps SIGCHLD makes waitpid fail with ECHILD; the pipe still reports exec.
			const bool reaped_elsewhere = waited < 0 && errno == ECHILD;
			pollfd ready{channel[0], POLLIN, 0};
			const int available = ::poll(&ready, 1, 3000);
			char failed = 0;
			const auto bytes = available > 0 ? ::read(channel[0], &failed, 1) : -1;
			::close(channel[0]);
			const bool child_ok =
				reaped_elsewhere || (waited == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
			// EOF means exec succeeded, not that a browser or user approved access.
			return child_ok && bytes == 0 ? BoundBrowserStatus::opened : BoundBrowserStatus::unavailable;
		} catch (...) {
			return BoundBrowserStatus::unavailable;
		}
	}
};
}  // namespace
std::unique_ptr<BoundBrowserLauncher> make_bound_browser_launcher(const std::string& base) noexcept {
	try {
		return valid_bound_portal_url(base) ? std::make_unique<LinuxBrowser>(base) : nullptr;
	} catch (...) {
		return nullptr;
	}
}
}  // namespace device_identity
}  // namespace license
