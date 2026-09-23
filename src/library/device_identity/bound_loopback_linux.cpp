#include "bound_loopback.hpp"
#include "bound_callback.hpp"
#include "bound_encoding.hpp"
#include "bound_peer_linux.hpp"
#include <sys/socket.h>
#include <netinet/in.h>
#include <poll.h>
#include <unistd.h>
#include <time.h>
#include <algorithm>
#include <cerrno>

namespace license {
namespace device_identity {
namespace {
constexpr std::uint64_t admission_ms = 300000, connection_ms = 5000;
std::uint64_t boot_ms() {
	timespec value{};
	if (clock_gettime(CLOCK_BOOTTIME, &value) != 0 || value.tv_sec < 0) throw 0;
	return static_cast<std::uint64_t>(value.tv_sec) * 1000 + value.tv_nsec / 1000000;
}
void close_socket(int& socket) noexcept {
	if (socket >= 0) {
		::close(socket);
		socket = -1;
	}
}
bool loopback_address(const sockaddr_storage& address, int family) {
	if (address.ss_family != family) return false;
	if (family == AF_INET)
		return reinterpret_cast<const sockaddr_in*>(&address)->sin_addr.s_addr == htonl(INADDR_LOOPBACK);
	return IN6_IS_ADDR_LOOPBACK(&reinterpret_cast<const sockaddr_in6*>(&address)->sin6_addr);
}
void send_response(int socket, bool received) noexcept {
	try {
		const auto& response = bound_callback_http_response(received);
		const auto start = boot_ms();
		std::size_t offset = 0;
		while (offset < response.size() && boot_ms() - start < 200) {
			const auto count = send(socket, response.data() + offset, response.size() - offset, MSG_NOSIGNAL);
			if (count > 0) {
				offset += static_cast<std::size_t>(count);
				continue;
			}
			if (count == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) break;
			pollfd descriptor{socket, POLLOUT, 0};
			if (::poll(&descriptor, 1, 20) < 0 && errno != EINTR) break;
		}
		shutdown(socket, SHUT_WR);
	} catch (...) {
	}
}
}  // namespace
struct BoundLoopbackListener::Impl {
	struct Connection {
		int socket = -1;
		SensitiveArray<8192> request;
		std::size_t used = 0;
		bool complete = false;
		std::uint64_t accepted = 0;
		void clear() noexcept {
			close_socket(socket);
			request.clear();
			used = 0;
			complete = false;
		}
	};
	std::array<Connection, 4> connections;
	int family = AF_INET, listener = -1;
	std::uint64_t started = 0, observed = 0;
	bool clock_invalid = false;
	Clock clock;
	std::uint64_t now() {
		const auto value = clock();
		if (value < observed) clock_invalid = true;
		observed = value;
		return value;
	}
	unsigned remaining(std::uint64_t start, std::uint64_t duration, unsigned requested) {
		const auto current = now();
		if (clock_invalid || current < start || current - start >= duration) return 0;
		return static_cast<unsigned>(std::min<std::uint64_t>(requested, duration - (current - start)));
	}
	Connection* vacant() noexcept {
		for (auto& connection : connections)
			if (connection.socket < 0) return &connection;
		return nullptr;
	}
	~Impl() { stop(); }
	void stop() noexcept {
		close_socket(listener);
		for (auto& connection : connections) connection.clear();
	}
};
BoundLoopbackListener::BoundLoopbackListener() = default;
BoundLoopbackListener::~BoundLoopbackListener() = default;
std::unique_ptr<BoundLoopbackListener> BoundLoopbackListener::create(const std::string& path, bool ipv6,
																	 Clock clock) noexcept {
	try {
		if (!bound_encoding::uri_path(path)) return nullptr;
		bound_callback_http_response(true);
		bound_callback_http_response(false);
		auto result = std::unique_ptr<BoundLoopbackListener>(new BoundLoopbackListener);
		result->impl_ = std::make_unique<Impl>();
		auto& state = *result->impl_;
		state.clock = clock ? std::move(clock) : Clock(boot_ms);
		state.family = ipv6 ? AF_INET6 : AF_INET;
		state.listener = socket(state.family, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, IPPROTO_TCP);
		if (state.listener < 0) return nullptr;
		sockaddr_storage address{};
		socklen_t length = ipv6 ? sizeof(sockaddr_in6) : sizeof(sockaddr_in);
		if (ipv6) {
			int only = 1;
			if (setsockopt(state.listener, IPPROTO_IPV6, IPV6_V6ONLY, &only, sizeof(only)) != 0) return nullptr;
			auto& local = *reinterpret_cast<sockaddr_in6*>(&address);
			local.sin6_family = AF_INET6;
			local.sin6_addr = in6addr_loopback;
		} else {
			auto& local = *reinterpret_cast<sockaddr_in*>(&address);
			local.sin_family = AF_INET;
			local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
		}
		if (bind(state.listener, reinterpret_cast<sockaddr*>(&address), length) != 0 ||
			getsockname(state.listener, reinterpret_cast<sockaddr*>(&address), &length) != 0 ||
			!loopback_address(address, state.family) || listen(state.listener, 4) != 0)
			return nullptr;
		const auto port = ntohs(ipv6 ? reinterpret_cast<sockaddr_in6*>(&address)->sin6_port
									 : reinterpret_cast<sockaddr_in*>(&address)->sin_port);
		result->redirect_uri_ = std::string(ipv6 ? "http://[::1]:" : "http://127.0.0.1:") + std::to_string(port) + path;
		if (!bound_encoding::loopback_uri(result->redirect_uri_)) return nullptr;
		state.started = state.now();
		return result;
	} catch (...) {
		return nullptr;
	}
}
BoundLoopbackStatus BoundLoopbackListener::close() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return BoundLoopbackStatus::busy;
		impl_->stop();
		return BoundLoopbackStatus::closed;
	} catch (...) {
		return BoundLoopbackStatus::failed;
	}
}
BoundLoopbackStatus BoundLoopbackListener::check() noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return BoundLoopbackStatus::busy;
		if (impl_->listener < 0) return BoundLoopbackStatus::closed;
		if (!impl_->remaining(impl_->started, admission_ms, 1)) {
			impl_->stop();
			return BoundLoopbackStatus::expired;
		}
		return BoundLoopbackStatus::waiting;
	} catch (...) {
		return BoundLoopbackStatus::failed;
	}
}
BoundLoopbackStatus BoundLoopbackListener::poll(BoundEnrollmentFlow& flow, unsigned wait_ms) noexcept {
	try {
		std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
		if (!lock.owns_lock()) return BoundLoopbackStatus::busy;
		auto& state = *impl_;
		if (state.listener < 0) return BoundLoopbackStatus::closed;
		if (wait_ms > 1000) return BoundLoopbackStatus::failed;
		if (!state.remaining(state.started, admission_ms, 1)) {
			state.stop();
			return BoundLoopbackStatus::expired;
		}
		bool rejected = false;
		for (auto& connection : state.connections) {
			if (connection.socket >= 0 && !state.remaining(connection.accepted, connection_ms, 1)) {
				connection.clear();
				rejected = true;
			}
		}
		std::array<pollfd, 5> descriptors{};
		descriptors[0] = {state.vacant() ? state.listener : -1, POLLIN, 0};
		unsigned slice = state.remaining(state.started, admission_ms, wait_ms);
		for (std::size_t i = 0; i < state.connections.size(); ++i) {
			auto& connection = state.connections[i];
			descriptors[i + 1] = {connection.socket, POLLIN, 0};
			if (connection.socket >= 0) {
				slice = std::min(slice, state.remaining(connection.accepted, connection_ms, slice));
				if (connection.complete) slice = 0;
			}
		}
		if (::poll(descriptors.data(), descriptors.size(), static_cast<int>(slice)) < 0 && errno != EINTR) {
			state.stop();
			return BoundLoopbackStatus::failed;
		}
		if (descriptors[0].revents & POLLIN) {
			sockaddr_storage address{};
			socklen_t length = sizeof(address);
			const int peer =
				accept4(state.listener, reinterpret_cast<sockaddr*>(&address), &length, SOCK_NONBLOCK | SOCK_CLOEXEC);
			if (peer >= 0) {
				auto* connection = state.vacant();
				sockaddr_storage local{};
				socklen_t local_length = sizeof(local);
				// Loopback ports are shared by every local user: accept only this user's sockets.
				if (!connection || !loopback_address(address, state.family) ||
					getsockname(peer, reinterpret_cast<sockaddr*>(&local), &local_length) != 0 ||
					!bound_loopback_peer_owned(state.family == AF_INET ? "/proc/self/net/tcp" : "/proc/self/net/tcp6",
											   address, local, geteuid())) {
					::close(peer);
					rejected = true;
				} else {
					connection->socket = peer;
					connection->accepted = state.now();
				}
			} else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
				state.stop();
				return BoundLoopbackStatus::failed;
			}
		}
		for (std::size_t i = 0; i < state.connections.size(); ++i) {
			auto& connection = state.connections[i];
			if (connection.socket < 0 ||
				(!connection.complete && !(descriptors[i + 1].revents & (POLLIN | POLLHUP | POLLERR))))
				continue;
			if (!connection.complete) {
				const auto count = recv(connection.socket, connection.request.value.data() + connection.used,
										connection.request.value.size() - connection.used, 0);
				if (count <= 0) {
					if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) continue;
					connection.clear();
					rejected = true;
					continue;
				}
				connection.used += static_cast<std::size_t>(count);
			}
			std::string_view target;
			const auto parsed = parse_bound_callback_http(
				std::string_view(reinterpret_cast<const char*>(connection.request.value.data()), connection.used),
				redirect_uri_, target);
			if (parsed == BoundCallbackParse::incomplete) continue;
			bool received = false, expired = false;
			if (parsed == BoundCallbackParse::complete) {
				connection.complete = true;
				const auto origin = redirect_uri_.substr(0, redirect_uri_.find('/', 7));
				SensitiveVector uri;
				uri.value.insert(uri.value.end(), origin.begin(), origin.end());
				uri.value.insert(uri.value.end(), target.begin(), target.end());
				if (!state.remaining(state.started, admission_ms, 1)) {
					state.stop();
					return BoundLoopbackStatus::expired;
				}
				if (!state.remaining(connection.accepted, connection_ms, 1)) {
					connection.clear();
					rejected = true;
					continue;
				}
				const auto result = flow.receive_callback(
					std::string_view(reinterpret_cast<const char*>(uri.value.data()), uri.value.size()));
				if (result.status == BoundEnrollmentStatus::busy) continue;
				received = result.status == BoundEnrollmentStatus::callback_received;
				expired = result.status == BoundEnrollmentStatus::expired;
			}
			send_response(connection.socket, received);
			connection.clear();
			if (received || expired) {
				state.stop();
				return received ? BoundLoopbackStatus::received : BoundLoopbackStatus::expired;
			}
			rejected = true;
		}
		if (!state.remaining(state.started, admission_ms, 1)) {
			state.stop();
			return BoundLoopbackStatus::expired;
		}
		return rejected ? BoundLoopbackStatus::rejected : BoundLoopbackStatus::waiting;
	} catch (...) {
		return BoundLoopbackStatus::failed;
	}
}
}  // namespace device_identity
}  // namespace license
