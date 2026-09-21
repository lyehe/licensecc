#include "bound_browser.hpp"
#include "bound_http.hpp"
#include "bound_encoding.hpp"
#include <poll.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <cerrno>

extern char** environ;

namespace license {
namespace device_identity {
namespace {
class LinuxBrowser final : public BoundBrowserLauncher {
	std::string prefix_;

public:
	explicit LinuxBrowser(const std::string& base) : prefix_(base + "#attempt_handle=") {}
	BoundBrowserStatus open(const std::string& url) noexcept override {
		try {
			if (url.size() != prefix_.size() + 43 || url.compare(0, prefix_.size(), prefix_) != 0 ||
				!bound_encoding::token(std::string_view(url).substr(prefix_.size()), 32))
				return BoundBrowserStatus::invalid_input;
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
			char executable[] = "/usr/bin/xdg-open";
			char* args[]{executable, const_cast<char*>(url.c_str()), nullptr};
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
							execve(executable, args, environ);
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
			pollfd ready{channel[0], POLLIN, 0};
			const int available = ::poll(&ready, 1, 1000);
			char failed = 0;
			const auto bytes = available > 0 ? ::read(channel[0], &failed, 1) : -1;
			::close(channel[0]);
			// EOF means exec succeeded, not that a browser or user approved access.
			return waited == child && WIFEXITED(status) && WEXITSTATUS(status) == 0 && bytes == 0
					   ? BoundBrowserStatus::opened
					   : BoundBrowserStatus::unavailable;
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
