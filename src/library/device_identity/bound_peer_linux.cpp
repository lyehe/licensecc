#include "bound_peer_linux.hpp"
#include <netinet/in.h>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace license {
namespace device_identity {
namespace {
bool same(const sockaddr_storage& address, const unsigned (&words)[4], unsigned port) noexcept {
	if (address.ss_family == AF_INET) {
		const auto& value = reinterpret_cast<const sockaddr_in&>(address);
		return value.sin_addr.s_addr == words[0] && ntohs(value.sin_port) == port;
	}
	if (address.ss_family != AF_INET6) return false;
	const auto& value = reinterpret_cast<const sockaddr_in6&>(address);
	std::uint32_t expected[4];
	std::memcpy(expected, &value.sin6_addr, sizeof(expected));
	return expected[0] == words[0] && expected[1] == words[1] && expected[2] == words[2] && expected[3] == words[3] &&
		   ntohs(value.sin6_port) == port;
}
}  // namespace
bool bound_loopback_peer_owned(const char* table, const sockaddr_storage& peer, const sockaddr_storage& local,
							   uid_t owner) noexcept {
	if (peer.ss_family != local.ss_family) return false;
	std::FILE* file = std::fopen(table, "re");
	if (!file) return false;
	char line[512];
	bool owned = false;
	if (std::fgets(line, sizeof(line), file)) {
		while (std::fgets(line, sizeof(line), file)) {
			unsigned source[4]{}, target[4]{}, source_port = 0, target_port = 0, uid = 0;
			const bool parsed =
				peer.ss_family == AF_INET
					? std::sscanf(line, " %*u: %8X:%4X %8X:%4X %*X %*X:%*X %*X:%*X %*X %u", &source[0], &source_port,
								  &target[0], &target_port, &uid) == 5
					: std::sscanf(line, " %*u: %8X%8X%8X%8X:%4X %8X%8X%8X%8X:%4X %*X %*X:%*X %*X:%*X %*X %u",
								  &source[0], &source[1], &source[2], &source[3], &source_port, &target[0], &target[1],
								  &target[2], &target[3], &target_port, &uid) == 11;
			// The connecting socket's local endpoint is our peer; its remote endpoint is our listener side.
			if (parsed && same(peer, source, source_port) && same(local, target, target_port)) {
				owned = uid == owner;
				break;
			}
		}
	}
	std::fclose(file);
	return owned;
}
}  // namespace device_identity
}  // namespace license
