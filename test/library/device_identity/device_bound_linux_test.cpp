#define BOOST_TEST_MODULE device_bound_linux_test
#include <boost/test/unit_test.hpp>
#include "bound_checkpoint_platform.hpp"
#include "bound_anchor.hpp"
#include "bound_browser.hpp"
#include "bound_http.hpp"
#include "bound_peer_linux.hpp"
#include <arpa/inet.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <thread>

namespace {
bool fail_browser_exec = false;
int test_browser_exec(const char* executable, char* const args[], char* const environment[]) {
	if (std::string(executable) != "/usr/bin/xdg-open" || !args[1]) _exit(126);
	if (fail_browser_exec) return -1;
	char sleep[] = "/bin/sleep", duration[] = "2";
	char* command[]{sleep, duration, nullptr};
	return execve(sleep, command, environment);
}
}  // namespace
#define execve test_browser_exec
#define make_bound_browser_launcher make_test_linux_browser_launcher
#include "bound_browser_linux.cpp"
#undef make_bound_browser_launcher
#undef execve

using namespace license::device_identity;
namespace {
struct Directory {
	std::string path;
	Directory() {
		char root[] = "/tmp/licensecc-checkpoint-XXXXXX";
		const auto* made = mkdtemp(root);
		BOOST_REQUIRE(made);
		path = made;
	}
	~Directory() {
		std::error_code ignored;
		std::filesystem::remove_all(path, ignored);
	}
};
void observe_empty(BoundCheckpointStorage& storage) {
	std::string value = "unchanged";
	BOOST_CHECK(storage.read(0, value) == BoundCheckpointIo::missing);
	BOOST_CHECK(storage.read(1, value) == BoundCheckpointIo::missing);
	BOOST_CHECK_EQUAL(value, "unchanged");
}
}  // namespace
BOOST_AUTO_TEST_CASE(publish_preserves_other_slot_and_requires_observed_state) {
	Directory root;
	auto storage = make_bound_checkpoint_storage_at_root(root.path, 0);
	BOOST_REQUIRE(storage);
	BOOST_REQUIRE(storage->lock() == BoundCheckpointIo::ok);
	BOOST_CHECK(storage->publish(0, "first") == BoundCheckpointIo::error);
	observe_empty(*storage);
	BOOST_REQUIRE(storage->publish(0, "first") == BoundCheckpointIo::ok);
	std::string value;
	BOOST_REQUIRE(storage->read(0, value) == BoundCheckpointIo::ok);
	BOOST_CHECK_EQUAL(value, "first");
	BOOST_CHECK(storage->read(1, value) == BoundCheckpointIo::missing);
	BOOST_REQUIRE(storage->publish(1, "second") == BoundCheckpointIo::ok);
	BOOST_CHECK(storage->confirm(0, "first") == BoundCheckpointIo::ok);
	BOOST_CHECK(storage->confirm(1, "second") == BoundCheckpointIo::ok);
	BOOST_CHECK(storage->confirm(1, "wrong") == BoundCheckpointIo::error);
	storage->unlock();
	BOOST_CHECK(storage->read(0, value) == BoundCheckpointIo::error);
	struct stat info {};
	BOOST_REQUIRE(stat((root.path + "/checkpoint.0").c_str(), &info) == 0);
	BOOST_CHECK_EQUAL(info.st_mode & 0777, 0600);
}
BOOST_AUTO_TEST_CASE(independent_handles_and_fork_cannot_bypass_namespace_lock) {
	Directory root;
	auto one = make_bound_checkpoint_storage_at_root(root.path, 0);
	auto two = make_bound_checkpoint_storage_at_root(root.path, 0);
	BOOST_REQUIRE(one && two);
	BOOST_REQUIRE(one->lock() == BoundCheckpointIo::ok);
	BOOST_CHECK(two->lock() == BoundCheckpointIo::busy);
	const auto child = fork();
	BOOST_REQUIRE(child >= 0);
	if (child == 0) {
		// Inherited flock descriptions must never be treated as new ownership.
		const auto inherited = one->lock();
		auto fresh = make_bound_checkpoint_storage_at_root(root.path, 0);
		_exit(inherited == BoundCheckpointIo::error && fresh && fresh->lock() == BoundCheckpointIo::busy ? 0 : 1);
	}
	int status = 0;
	BOOST_REQUIRE(waitpid(child, &status, 0) == child);
	BOOST_CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
	one->unlock();
	BOOST_CHECK(two->lock() == BoundCheckpointIo::ok);
	two->unlock();
}
BOOST_AUTO_TEST_CASE(unsafe_files_and_relocated_directory_fail_closed) {
	Directory root;
	auto storage = make_bound_checkpoint_storage_at_root(root.path, 0);
	BOOST_REQUIRE(storage);
	BOOST_REQUIRE(storage->lock() == BoundCheckpointIo::ok);
	observe_empty(*storage);
	BOOST_REQUIRE(storage->publish(0, "first") == BoundCheckpointIo::ok);
	BOOST_REQUIRE(link((root.path + "/checkpoint.0").c_str(), (root.path + "/alias").c_str()) == 0);
	std::string value;
	BOOST_CHECK(storage->read(0, value) == BoundCheckpointIo::error);
	BOOST_REQUIRE(unlink((root.path + "/alias").c_str()) == 0);
	BOOST_REQUIRE(symlink("checkpoint.0", (root.path + "/checkpoint.1").c_str()) == 0);
	BOOST_CHECK(storage->read(1, value) == BoundCheckpointIo::error);
	BOOST_REQUIRE(unlink((root.path + "/checkpoint.1").c_str()) == 0);
	BOOST_REQUIRE(chmod((root.path + "/checkpoint.0").c_str(), 0644) == 0);
	BOOST_CHECK(storage->read(0, value) == BoundCheckpointIo::error);
	storage->unlock();
	const auto original = root.path;
	root.path += "-moved";
	BOOST_REQUIRE(rename(original.c_str(), root.path.c_str()) == 0);
	BOOST_CHECK(storage->lock() == BoundCheckpointIo::error);
	BOOST_CHECK(!make_bound_checkpoint_storage_at_root(root.path + "/../" +
													   std::filesystem::path(root.path).filename().string()));
}
BOOST_AUTO_TEST_CASE(clock_uses_boot_time_and_process_identity) {
	auto platform = make_bound_anchor_platform();
	BOOST_REQUIRE(platform);
	BoundClockSample first{}, next{};
	BOOST_REQUIRE(platform->sample(first));
	std::this_thread::sleep_for(std::chrono::milliseconds(2));
	BOOST_REQUIRE(platform->sample(next));
	BOOST_CHECK_EQUAL(next.process_id, static_cast<std::uint64_t>(getpid()));
	BOOST_CHECK(next.inclusive >= first.inclusive + 10000);
	BOOST_CHECK(next.awake_before >= first.awake_after);
	BOOST_CHECK(next.awake_after >= next.awake_before);
	BOOST_CHECK(next.inclusive >= next.awake_before);
	std::array<std::uint8_t, 32> a{}, b{};
	BOOST_REQUIRE(platform->random_operation(a) && platform->random_operation(b));
	BOOST_CHECK(a != b);
}
BOOST_AUTO_TEST_CASE(browser_and_transport_reject_untrusted_configuration_without_io) {
	BOOST_CHECK(!make_bound_browser_launcher("http://example.com/authorize"));
	auto browser = make_bound_browser_launcher("https://example.com/authorize");
	BOOST_REQUIRE(browser);
	BOOST_CHECK(browser->open("https://other.example/authorize#attempt_handle=" + std::string(43, 'A')) ==
				BoundBrowserStatus::invalid_input);
	BOOST_CHECK(!make_bound_http_transport("http://example.com"));
	auto transport = make_bound_http_transport("https://example.com");
	BOOST_REQUIRE(transport);
	BoundHttpResponse out{299, "unchanged"};
	BOOST_CHECK(transport->post(BoundWireOperation::renew, "", out) == BoundHttpStatus::internal_error);
	BOOST_CHECK_EQUAL(out.body, "unchanged");
}

BOOST_AUTO_TEST_CASE(browser_launcher_does_not_wait_for_browser_lifetime_and_reports_exec_failure) {
	auto browser = make_test_linux_browser_launcher("https://example.com/authorize");
	BOOST_REQUIRE(browser);
	const auto url = "https://example.com/authorize#attempt_handle=" + std::string(43, 'A');
	const auto start = std::chrono::steady_clock::now();
	BOOST_CHECK(browser->open(url) == BoundBrowserStatus::opened);
	BOOST_CHECK(std::chrono::steady_clock::now() - start < std::chrono::seconds(1));
	fail_browser_exec = true;
	BOOST_CHECK(browser->open(url) == BoundBrowserStatus::unavailable);
	fail_browser_exec = false;
}

namespace {
sockaddr_storage ipv4(const char* text, unsigned short port) {
	sockaddr_storage value{};
	auto& address = reinterpret_cast<sockaddr_in&>(value);
	address.sin_family = AF_INET;
	address.sin_port = htons(port);
	BOOST_REQUIRE(inet_pton(AF_INET, text, &address.sin_addr) == 1);
	return value;
}
sockaddr_storage ipv6(const char* text, unsigned short port) {
	sockaddr_storage value{};
	auto& address = reinterpret_cast<sockaddr_in6&>(value);
	address.sin6_family = AF_INET6;
	address.sin6_port = htons(port);
	BOOST_REQUIRE(inet_pton(AF_INET6, text, &address.sin6_addr) == 1);
	return value;
}
// Format exactly like the kernel: raw 32-bit words printed as native integers.
std::string endpoint(const sockaddr_storage& value) {
	char text[64];
	if (value.ss_family == AF_INET) {
		const auto& a = reinterpret_cast<const sockaddr_in&>(value);
		std::snprintf(text, sizeof(text), "%08X:%04X", a.sin_addr.s_addr, ntohs(a.sin_port));
	} else {
		const auto& a = reinterpret_cast<const sockaddr_in6&>(value);
		std::uint32_t w[4];
		std::memcpy(w, &a.sin6_addr, sizeof(w));
		std::snprintf(text, sizeof(text), "%08X%08X%08X%08X:%04X", w[0], w[1], w[2], w[3], ntohs(a.sin6_port));
	}
	return text;
}
std::string table(const Directory& root, const std::string& rows) {
	const auto path = root.path + "/tcp";
	std::ofstream(path)
		<< "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
		<< rows;
	return path;
}
std::string row(const sockaddr_storage& local, const sockaddr_storage& remote, unsigned uid) {
	return "   0: " + endpoint(local) + " " + endpoint(remote) + " 01 00000000:00000000 00:00000000 00000000 " +
		   std::to_string(uid) + "        0 12345 1 0000000000000000 20 4 30 10 -1\n";
}
}  // namespace

BOOST_AUTO_TEST_CASE(loopback_peer_must_belong_to_the_same_user) {
	Directory root;
	const auto peer = ipv4("127.0.0.1", 40000), local = ipv4("127.0.0.1", 45678);
	const auto me = geteuid();
	BOOST_CHECK(
		bound_loopback_peer_owned(table(root, row(local, peer, me) + row(peer, local, me)).c_str(), peer, local, me));
	BOOST_CHECK(!bound_loopback_peer_owned(table(root, row(local, peer, me) + row(peer, local, me + 1)).c_str(), peer,
										   local, me));
	BOOST_CHECK(!bound_loopback_peer_owned(table(root, row(local, peer, me)).c_str(), peer, local, me));
	BOOST_CHECK(!bound_loopback_peer_owned((root.path + "/missing").c_str(), peer, local, me));
	const auto peer6 = ipv6("::1", 40001), local6 = ipv6("::1", 45679);
	BOOST_CHECK(bound_loopback_peer_owned(table(root, row(peer6, local6, me)).c_str(), peer6, local6, me));
	BOOST_CHECK(!bound_loopback_peer_owned(table(root, row(peer6, local6, me + 1)).c_str(), peer6, local6, me));
}
