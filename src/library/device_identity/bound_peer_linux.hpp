#ifndef LICENSECC_BOUND_PEER_LINUX_HPP_
#define LICENSECC_BOUND_PEER_LINUX_HPP_
#include <sys/socket.h>
#include <sys/types.h>

namespace license {
namespace device_identity {
// True only when `table` (a /proc/net/tcp or tcp6 file) lists a socket whose
// local endpoint is `peer`, whose remote endpoint is `local`, owned by `owner`.
// Missing, unreadable or unmatched tables fail closed.
bool bound_loopback_peer_owned(const char* table, const sockaddr_storage& peer, const sockaddr_storage& local,
							   uid_t owner) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
