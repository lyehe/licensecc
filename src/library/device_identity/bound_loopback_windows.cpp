#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <mswsock.h>
#include <windows.h>
#include "bound_loopback.hpp"
#include "bound_callback.hpp"
#include "bound_encoding.hpp"
#include <algorithm>

namespace license {
namespace device_identity {
namespace {
constexpr ULONGLONG admission_ms = 300000, connection_ms = 5000;
void close_socket(SOCKET& socket) noexcept {
	if (socket != INVALID_SOCKET) {
		closesocket(socket);
		socket = INVALID_SOCKET;
	}
}
bool noninheritable(SOCKET socket) {
	DWORD flags = 0;
	return GetHandleInformation(reinterpret_cast<HANDLE>(socket), &flags) && !(flags & HANDLE_FLAG_INHERIT);
}
SOCKET new_socket(int family) {
	SOCKET socket =
		WSASocketW(family, SOCK_STREAM, IPPROTO_TCP, nullptr, 0, WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT);
	if (socket != INVALID_SOCKET && !noninheritable(socket)) close_socket(socket);
	return socket;
}
bool loopback_address(const sockaddr_storage& address, int family) {
	if (address.ss_family != family) return false;
	if (family == AF_INET)
		return reinterpret_cast<const sockaddr_in*>(&address)->sin_addr.s_addr == htonl(INADDR_LOOPBACK);
	return IN6_IS_ADDR_LOOPBACK(&reinterpret_cast<const sockaddr_in6*>(&address)->sin6_addr) != 0;
}
unsigned remaining(ULONGLONG start, ULONGLONG duration, unsigned requested) {
	const auto elapsed = GetTickCount64() - start;
	return elapsed >= duration ? 0 : static_cast<unsigned>(std::min<ULONGLONG>(requested, duration - elapsed));
}
void send_response(SOCKET socket, bool received) noexcept {
	try {
		const auto& response = bound_callback_http_response(received);
		const auto start = GetTickCount64();
		std::size_t offset = 0;
		while (offset < response.size() && remaining(start, 200, 200)) {
			const int sent = send(socket, response.data() + offset, static_cast<int>(response.size() - offset), 0);
			if (sent > 0) {
				offset += static_cast<unsigned>(sent);
				continue;
			}
			if (sent == 0 || WSAGetLastError() != WSAEWOULDBLOCK) break;
			fd_set set;
			FD_ZERO(&set);
			FD_SET(socket, &set);
			timeval timeout{0, static_cast<long>(remaining(start, 200, 20) * 1000)};
			if (select(0, nullptr, &set, nullptr, &timeout) == SOCKET_ERROR) break;
		}
		shutdown(socket, SD_SEND);
	} catch (...) { /* Response delivery never rolls back callback receipt. */
	}
}
}  // namespace
struct BoundLoopbackListener::Impl {
	struct Connection {
		SOCKET socket = INVALID_SOCKET;
		SensitiveArray<8192> request;
		std::size_t used = 0;
		bool complete = false;
		ULONGLONG accepted = 0;
		void clear() noexcept {
			close_socket(socket);
			request.clear();
			used = 0;
			complete = false;
		}
	};
	std::array<Connection, 4> connections;
	bool wsa = false, pending = false, pending_io = false;
	int family = AF_INET;
	SOCKET listener = INVALID_SOCKET, peer = INVALID_SOCKET;
	HANDLE event = nullptr;
	OVERLAPPED accept_operation{};
	LPFN_ACCEPTEX accept_ex = nullptr;
	std::array<unsigned char, 2 * (sizeof(sockaddr_storage) + 16)> addresses{};
	ULONGLONG started = 0;
	Clock clock;
	ULONGLONG observed = 0;
	bool clock_invalid = false;
	ULONGLONG now() {
		const auto value = clock();
		if (value < observed) clock_invalid = true;
		observed = value;
		return value;
	}
	unsigned remaining(ULONGLONG start, ULONGLONG duration, unsigned requested) {
		const auto current = now();
		if (clock_invalid || current < start || current - start >= duration) return 0;
		return static_cast<unsigned>(std::min<ULONGLONG>(requested, duration - (current - start)));
	}
	Connection* vacant() noexcept {
		for (auto& connection : connections)
			if (connection.socket == INVALID_SOCKET) return &connection;
		return nullptr;
	}
	~Impl() {
		stop();
		if (event) CloseHandle(event);
		if (wsa) WSACleanup();
	}
	void stop() noexcept {
		if (pending && pending_io) {
			// OVERLAPPED and address storage must survive cancellation. Wait
			// for the local OS completion, never for peer request data.
			if (!CancelIoEx(reinterpret_cast<HANDLE>(listener), &accept_operation)) close_socket(peer);
			if (WaitForSingleObject(event, INFINITE) != WAIT_OBJECT_0) {
				// Closing the accept socket forces completion. Keep storage
				// owned even if the OS event observation itself fails.
				close_socket(peer);
				while (!HasOverlappedIoCompleted(&accept_operation)) Sleep(1);
			}
		}
		pending = false;
		pending_io = false;
		close_socket(peer);
		close_socket(listener);
		for (auto& connection : connections) connection.clear();
	}
	void drop_peer() noexcept { close_socket(peer); }
	bool start_accept() {
		peer = new_socket(family);
		if (peer == INVALID_SOCKET) return false;
		if (!ResetEvent(event)) {
			drop_peer();
			return false;
		}
		accept_operation = {};
		accept_operation.hEvent = event;
		DWORD bytes = 0;
		const BOOL done = accept_ex(listener, peer, addresses.data(), 0, sizeof(sockaddr_storage) + 16,
									sizeof(sockaddr_storage) + 16, &bytes, &accept_operation);
		if (!done && WSAGetLastError() != ERROR_IO_PENDING) {
			drop_peer();
			return false;
		}
		pending_io = !done;
		pending = true;
		return true;
	}
	bool finish_accept() {
		DWORD bytes = 0, flags = 0;
		if (!WSAGetOverlappedResult(listener, &accept_operation, &bytes, FALSE, &flags)) {
			if (WSAGetLastError() == WSA_IO_INCOMPLETE) return false;
			pending = false;
			drop_peer();
			return false;
		}
		pending = false;
		if (setsockopt(peer, SOL_SOCKET, SO_UPDATE_ACCEPT_CONTEXT, reinterpret_cast<const char*>(&listener),
					   sizeof(listener)) != 0 ||
			!noninheritable(peer)) {
			drop_peer();
			return false;
		}
		sockaddr_storage address{};
		int length = sizeof(address);
		u_long nonblocking = 1;
		if (getpeername(peer, reinterpret_cast<sockaddr*>(&address), &length) != 0 ||
			!loopback_address(address, family) || ioctlsocket(peer, FIONBIO, &nonblocking) != 0) {
			drop_peer();
			return false;
		}
		auto* connection = vacant();
		if (!connection) {
			drop_peer();
			return false;
		}
		connection->socket = peer;
		peer = INVALID_SOCKET;
		connection->accepted = now();
		return true;
	}
};
BoundLoopbackListener::BoundLoopbackListener() = default;
BoundLoopbackListener::~BoundLoopbackListener() = default;
std::unique_ptr<BoundLoopbackListener> BoundLoopbackListener::create(const std::string& path, bool ipv6,
																	 Clock clock) noexcept {
	try {
		if (!bound_encoding::uri_path(path)) return nullptr;
		// Allocate fixed pages before any callback can change flow state.
		bound_callback_http_response(true);
		bound_callback_http_response(false);
		auto result = std::unique_ptr<BoundLoopbackListener>(new BoundLoopbackListener);
		result->impl_ = std::make_unique<Impl>();
		auto& state = *result->impl_;
		state.clock = clock ? std::move(clock) : Clock([] { return GetTickCount64(); });
		WSADATA data{};
		if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return nullptr;
		state.wsa = true;
		if (data.wVersion != MAKEWORD(2, 2)) return nullptr;
		state.family = ipv6 ? AF_INET6 : AF_INET;
		state.listener = new_socket(state.family);
		if (state.listener == INVALID_SOCKET) return nullptr;
		BOOL exclusive = TRUE;
		if (setsockopt(state.listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive),
					   sizeof(exclusive)) != 0)
			return nullptr;
		sockaddr_storage address{};
		int length = ipv6 ? sizeof(sockaddr_in6) : sizeof(sockaddr_in);
		if (ipv6) {
			DWORD only = 1;
			if (setsockopt(state.listener, IPPROTO_IPV6, IPV6_V6ONLY, reinterpret_cast<const char*>(&only),
						   sizeof(only)) != 0)
				return nullptr;
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
			!loopback_address(address, state.family))
			return nullptr;
		const unsigned port = ntohs(ipv6 ? reinterpret_cast<sockaddr_in6*>(&address)->sin6_port
										 : reinterpret_cast<sockaddr_in*>(&address)->sin_port);
		result->redirect_uri_ = std::string(ipv6 ? "http://[::1]:" : "http://127.0.0.1:") + std::to_string(port) + path;
		if (!bound_encoding::loopback_uri(result->redirect_uri_) || listen(state.listener, 4) != 0) return nullptr;
		GUID id = WSAID_ACCEPTEX;
		DWORD bytes = 0;
		if (WSAIoctl(state.listener, SIO_GET_EXTENSION_FUNCTION_POINTER, &id, sizeof(id), &state.accept_ex,
					 sizeof(state.accept_ex), &bytes, nullptr, nullptr) != 0)
			return nullptr;
		state.event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
		if (!state.event) return nullptr;
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
		if (impl_->listener == INVALID_SOCKET) return BoundLoopbackStatus::closed;
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
		if (state.listener == INVALID_SOCKET) return BoundLoopbackStatus::closed;
		if (wait_ms > 1000) return BoundLoopbackStatus::failed;
		if (!state.remaining(state.started, admission_ms, 1)) {
			state.stop();
			return BoundLoopbackStatus::expired;
		}
		bool rejected = false;
		for (auto& connection : state.connections)
			if (connection.socket != INVALID_SOCKET && !state.remaining(connection.accepted, connection_ms, 1)) {
				connection.clear();
				rejected = true;
			}
		if (!state.pending && state.vacant() && !state.start_accept()) {
			state.stop();
			return BoundLoopbackStatus::failed;
		}
		bool any = false;
		for (const auto& connection : state.connections) any |= connection.socket != INVALID_SOCKET;
		// An idle preconnection occupies only one bounded slot. Wait at most a
		// short slice when sockets exist so a pending accept is also serviced.
		if (state.pending) {
			const auto waited =
				state.pending_io
					? WaitForSingleObject(state.event, any ? 0 : state.remaining(state.started, admission_ms, wait_ms))
					: WAIT_OBJECT_0;
			if (waited == WAIT_OBJECT_0) {
				if (!state.finish_accept()) rejected = true;
			} else if (waited != WAIT_TIMEOUT) {
				state.stop();
				return BoundLoopbackStatus::failed;
			}
		}
		fd_set read_set;
		FD_ZERO(&read_set);
		unsigned slice = std::min(wait_ms, 25u);
		for (const auto& connection : state.connections)
			if (connection.socket != INVALID_SOCKET) {
				FD_SET(connection.socket, &read_set);
				slice = std::min(slice, state.remaining(connection.accepted, connection_ms, slice));
			}
		slice = std::min(slice, state.remaining(state.started, admission_ms, slice));
		timeval timeout{0, static_cast<long>(slice * 1000)};
		if (read_set.fd_count && select(0, &read_set, nullptr, nullptr, &timeout) == SOCKET_ERROR) {
			state.stop();
			return BoundLoopbackStatus::failed;
		}
		for (auto& connection : state.connections) {
			if (connection.socket == INVALID_SOCKET ||
				(!connection.complete && !FD_ISSET(connection.socket, &read_set)))
				continue;
			if (!connection.complete) {
				const int count =
					recv(connection.socket, reinterpret_cast<char*>(connection.request.value.data()) + connection.used,
						 static_cast<int>(connection.request.value.size() - connection.used), 0);
				if (count <= 0) {
					if (count < 0 && WSAGetLastError() == WSAEWOULDBLOCK) continue;
					connection.clear();
					rejected = true;
					continue;
				}
				connection.used += static_cast<unsigned>(count);
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
				uri.value.reserve(origin.size() + target.size());
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
				const auto outcome = flow.receive_callback(
					std::string_view(reinterpret_cast<const char*>(uri.value.data()), uri.value.size()));
				if (outcome.status == BoundEnrollmentStatus::busy) continue;
				received = outcome.status == BoundEnrollmentStatus::callback_received;
				expired = outcome.status == BoundEnrollmentStatus::expired;
			}
			// A completed callback remains committed even if the peer resets
			// before receiving the fixed response. No request data is echoed.
			send_response(connection.socket, received);
			connection.clear();
			if (received) {
				state.stop();
				return BoundLoopbackStatus::received;
			}
			if (expired) {
				state.stop();
				return BoundLoopbackStatus::expired;
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
