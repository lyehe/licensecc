#ifndef LICENSECC_BOUND_LOOPBACK_FIXTURE_HPP_
#define LICENSECC_BOUND_LOOPBACK_FIXTURE_HPP_
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <chrono>
using SOCKET = int;
constexpr int INVALID_SOCKET = -1;
inline int closesocket(int fd) { return close(fd); }
inline unsigned long long GetTickCount64() {
	return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
		.count();
}
#endif
#include "bound_loopback.hpp"
#include <boost/test/unit_test.hpp>
using namespace license::device_identity;
namespace {
struct LocalSocket {
	SOCKET value = INVALID_SOCKET;
	explicit LocalSocket(int family) {
#ifdef _WIN32
		value =
			WSASocketW(family, SOCK_STREAM, IPPROTO_TCP, nullptr, 0, WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT);
#else
		value = socket(family, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
#endif
		BOOST_REQUIRE(value != INVALID_SOCKET);
	}
	~LocalSocket() {
		if (value != INVALID_SOCKET) closesocket(value);
	}
};
sockaddr_storage local_address(const std::string& uri, bool ipv6) {
	sockaddr_storage result{};
	const auto slash = uri.find('/', 7);
	const auto colon = uri.rfind(':', slash);
	const auto port = static_cast<u_short>(std::stoul(uri.substr(colon + 1, slash - colon - 1)));
	if (ipv6) {
		auto& a = *reinterpret_cast<sockaddr_in6*>(&result);
		a.sin6_family = AF_INET6;
		a.sin6_addr = in6addr_loopback;
		a.sin6_port = htons(port);
	} else {
		auto& a = *reinterpret_cast<sockaddr_in*>(&result);
		a.sin_family = AF_INET;
		a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
		a.sin_port = htons(port);
	}
	return result;
}
void connect_local(LocalSocket& socket, const std::string& uri, bool ipv6) {
	auto address = local_address(uri, ipv6);
	BOOST_REQUIRE_EQUAL(
		connect(socket.value, reinterpret_cast<sockaddr*>(&address), ipv6 ? sizeof(sockaddr_in6) : sizeof(sockaddr_in)),
		0);
#ifdef _WIN32
	DWORD timeout = 2000;
#else
	timeval timeout{2, 0};
#endif
	BOOST_REQUIRE_EQUAL(
		setsockopt(socket.value, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout)), 0);
}
std::string callback_request(const std::string& uri, const std::string& state) {
	const auto slash = uri.find('/', 7);
	return "GET " + uri.substr(slash) + "?code=" + std::string(43, 'A') + "&state=" + state +
		   " HTTP/1.1\r\nHost: " + uri.substr(7, slash - 7) + "\r\n\r\n";
}
BoundLoopbackStatus pump(BoundLoopbackListener& listener, BoundEnrollmentFlow& flow) {
	const auto start = GetTickCount64();
	while (GetTickCount64() - start < 2000) {
		const auto status = listener.poll(flow, 10);
		if (status != BoundLoopbackStatus::waiting) return status;
	}
	return BoundLoopbackStatus::failed;
}
}  // namespace
#endif
