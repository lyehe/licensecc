#include "bound_http.hpp"
#include "bound_encoding.hpp"
#include <curl/curl.h>
#include <pthread.h>
#include <signal.h>

namespace license {
namespace device_identity {
namespace {
constexpr std::size_t limit = 16384;
// Keep TLS-generated SIGPIPE local to this call without changing the host's
// process-wide signal disposition or consuming a previously pending signal.
class PipeGuard {
	sigset_t previous_{}, blocked_{};
	bool active_ = false, pending_ = false;

public:
	PipeGuard() {
		sigemptyset(&blocked_);
		sigaddset(&blocked_, SIGPIPE);
		active_ = pthread_sigmask(SIG_BLOCK, &blocked_, &previous_) == 0;
		if (active_) {
			sigset_t pending{};
			pending_ = sigpending(&pending) != 0 || sigismember(&pending, SIGPIPE) == 1;
		}
	}
	~PipeGuard() {
		if (!active_) return;
		if (!pending_ && sigismember(&previous_, SIGPIPE) != 1) {
			timespec timeout{};
			(void)sigtimedwait(&blocked_, nullptr, &timeout);
		}
		pthread_sigmask(SIG_SETMASK, &previous_, nullptr);
	}
	bool active() const noexcept { return active_; }
};
struct Response {
	BoundHttpResponse value;
	std::size_t header_bytes = 0;
	std::uint64_t length = 0;
	bool type = false, has_length = false, chunked = false, invalid = false;
	static std::size_t body(char* data, std::size_t size, std::size_t count, void* context) noexcept {
		auto& self = *static_cast<Response*>(context);
		try {
			if (size && count > limit / size) {
				self.invalid = true;
				return 0;
			}
			const auto bytes = size * count;
			if (bytes > limit - self.value.body.size()) {
				self.invalid = true;
				return 0;
			}
			self.value.body.append(data, bytes);
			return bytes;
		} catch (...) {
			return 0;
		}
	}
	static std::size_t header(char* data, std::size_t size, std::size_t count, void* context) noexcept {
		auto& self = *static_cast<Response*>(context);
		try {
			if (size && count > limit / size) {
				self.invalid = true;
				return 0;
			}
			const auto bytes = size * count;
			if (bytes > limit - self.header_bytes) {
				self.invalid = true;
				return 0;
			}
			self.header_bytes += bytes;
			std::string line(data, bytes);
			if (line.compare(0, 5, "HTTP/") == 0) {
				self.type = self.has_length = self.chunked = false;
				return bytes;
			}
			if (line == "\r\n") return bytes;
			if (line.size() < 2 || line.substr(line.size() - 2) != "\r\n") {
				self.invalid = true;
				return 0;
			}
			line.resize(line.size() - 2);
			for (auto& c : line)
				if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
			const auto colon = line.find(':');
			if (colon == std::string::npos || colon == 0 || line.front() == ' ' || line.front() == '\t') {
				self.invalid = true;
				return 0;
			}
			const auto name = line.substr(0, colon);
			auto value = line.substr(colon + 1);
			const auto first = value.find_first_not_of(" \t"), last = value.find_last_not_of(" \t");
			value = first == std::string::npos ? "" : value.substr(first, last - first + 1);
			if (name == "content-type") {
				if (self.type || (value != "application/json" && value != "application/json; charset=utf-8"))
					self.invalid = true;
				self.type = true;
			} else if (name == "content-length") {
				if (self.has_length || self.chunked || !bound_encoding::safe_integer(value, self.length) ||
					self.length > limit)
					self.invalid = true;
				self.has_length = true;
			} else if (name == "transfer-encoding") {
				if (self.chunked || self.has_length || value != "chunked") self.invalid = true;
				self.chunked = true;
			} else if (name == "content-encoding")
				self.invalid = true;
			return self.invalid ? 0 : bytes;
		} catch (...) {
			return 0;
		}
	}
};
class LinuxTransport final : public BoundHttpTransport {
	std::string origin_;

public:
	explicit LinuxTransport(std::string origin) : origin_(std::move(origin)) {}
	BoundHttpStatus post(BoundWireOperation operation, std::string_view body,
						 BoundHttpResponse& out) noexcept override {
		try {
			const char* path = nullptr;
			switch (operation) {
				case BoundWireOperation::authorize:
					path = "/v2/device-authorizations";
					break;
				case BoundWireOperation::exchange:
					path = "/v2/device-authorizations/exchange";
					break;
				case BoundWireOperation::renew:
					path = "/v2/device-leases/renew";
					break;
				case BoundWireOperation::renew_challenge:
				case BoundWireOperation::enrollment_challenge:
					path = "/v2/device-challenges";
					break;
			}
			if (!path || body.empty() || body.size() > limit) return BoundHttpStatus::internal_error;
			PipeGuard signals;
			if (!signals.active()) return BoundHttpStatus::unavailable;
			std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> handle(curl_easy_init(), curl_easy_cleanup);
			if (!handle) return BoundHttpStatus::unavailable;
			curl_slist* raw = nullptr;
			for (const auto* header : {"Content-Type: application/json", "Accept: application/json",
									   "Accept-Encoding: identity", "Expect:"}) {
				auto* next = curl_slist_append(raw, header);
				if (!next) {
					curl_slist_free_all(raw);
					return BoundHttpStatus::internal_error;
				}
				raw = next;
			}
			std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)> headers(raw, curl_slist_free_all);
			Response response;
			const auto url = origin_ + path;
			const auto set = [&](CURLoption key, auto value) {
				return curl_easy_setopt(handle.get(), key, value) == CURLE_OK;
			};
			if (!set(CURLOPT_URL, url.c_str()) || !set(CURLOPT_PROTOCOLS_STR, "https") ||

				!set(CURLOPT_FOLLOWLOCATION, 0L) || !set(CURLOPT_SSL_VERIFYPEER, 1L) ||
				!set(CURLOPT_SSL_VERIFYHOST, 2L) ||
				!set(CURLOPT_SSLVERSION, static_cast<long>(CURL_SSLVERSION_TLSv1_2)) || !set(CURLOPT_NOSIGNAL, 1L) ||
				!set(CURLOPT_TIMEOUT_MS, 30000L) || !set(CURLOPT_CONNECTTIMEOUT_MS, 10000L) ||
				!set(CURLOPT_HTTPAUTH, static_cast<long>(CURLAUTH_NONE)) ||
				!set(CURLOPT_PROXYAUTH, static_cast<long>(CURLAUTH_NONE)) ||
				!set(CURLOPT_NETRC, static_cast<long>(CURL_NETRC_IGNORED)) || !set(CURLOPT_HTTPHEADER, headers.get()) ||
				!set(CURLOPT_POSTFIELDS, body.data()) ||
				!set(CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(body.size())) ||
				!set(CURLOPT_WRITEFUNCTION, &Response::body) || !set(CURLOPT_WRITEDATA, &response) ||
				!set(CURLOPT_HEADERFUNCTION, &Response::header) || !set(CURLOPT_HEADERDATA, &response))
				return BoundHttpStatus::unavailable;
			const auto status = curl_easy_perform(handle.get());
			if (response.invalid) return BoundHttpStatus::invalid_response;
			if (status != CURLE_OK) return BoundHttpStatus::unavailable;
			long code = 0;
			if (curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &code) != CURLE_OK || code < 200 ||
				code >= 600 || (code >= 300 && code < 400) || !response.type || response.value.body.empty() ||
				(response.has_length && response.length != response.value.body.size()))
				return BoundHttpStatus::invalid_response;
			response.value.status = static_cast<unsigned>(code);
			out = std::move(response.value);
			return BoundHttpStatus::complete;
		} catch (...) {
			return BoundHttpStatus::internal_error;
		}
	}
};
}  // namespace
std::unique_ptr<BoundHttpTransport> make_bound_http_transport(const std::string& origin) noexcept {
	try {
		// Initialization is thread-safe since curl 7.84 on supported Linux builds.
		// Keep the process-wide reference alive; cleanup could affect other users.
		static const auto initialized = curl_global_init(CURL_GLOBAL_DEFAULT);
		BoundHttpOrigin parsed;
		if (initialized != CURLE_OK || !parse_bound_http_origin(origin, parsed)) return nullptr;
		const auto* version = curl_version_info(CURLVERSION_NOW);
		const int required = CURL_VERSION_THREADSAFE | CURL_VERSION_ASYNCHDNS | CURL_VERSION_SSL;
		if (!version || (version->features & required) != required) return nullptr;
		return std::make_unique<LinuxTransport>(origin);
	} catch (...) {
		return nullptr;
	}
}
}  // namespace device_identity
}  // namespace license
