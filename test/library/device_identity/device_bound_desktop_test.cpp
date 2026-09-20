#define BOOST_TEST_MODULE device_bound_desktop_test
#include "bound_loopback_fixture.hpp"
#include "bound_enrollment_fixture.hpp"
#include "bound_desktop.hpp"

namespace {
struct BrowserState {
	unsigned calls = 0;
	bool destroyed = false;
	BoundBrowserStatus result = BoundBrowserStatus::opened;
	std::vector<std::string> urls;
	std::function<void()> hook;
};
class Browser final : public BoundBrowserLauncher {
	std::shared_ptr<BrowserState> state_;

public:
	explicit Browser(std::shared_ptr<BrowserState> state) : state_(std::move(state)) {}
	~Browser() { state_->destroyed = true; }
	BoundBrowserStatus open(const std::string& url) noexcept override {
		try {
			++state_->calls;
			state_->urls.push_back(url);
			if (state_->hook) state_->hook();
			return state_->result;
		} catch (...) {
			return BoundBrowserStatus::unavailable;
		}
	}
};
struct Desktop : Fixture {
	std::shared_ptr<BrowserState> browser = std::make_shared<BrowserState>();
	std::uint64_t ticks = 1000;
	std::function<void()> listener_clock_hook;
	std::string uri;
	std::unique_ptr<BoundDesktopEnrollment> owner;
	Desktop() {
		auto listener = BoundLoopbackListener::create("/callback", false, [this] {
			if (listener_clock_hook) listener_clock_hook();
			return ticks;
		});
		BOOST_REQUIRE(listener);
		uri = listener->redirect_uri();
		owner =
			BoundDesktopEnrollment::create(std::move(flow), std::move(listener), std::make_unique<Browser>(browser));
		BOOST_REQUIRE(owner);
	}
	BoundEnrollmentView prepare() {
		BoundEnrollmentView view;
		BOOST_REQUIRE(owner->prepare(view).status == BoundEnrollmentStatus::ready);
		return view;
	}
	void receive() {
		LocalSocket socket(AF_INET);
		connect_local(socket, uri, false);
		const auto wire = callback_request(uri, registration.fields.at("state").text);
		BOOST_REQUIRE_EQUAL(send(socket.value, wire.data(), static_cast<int>(wire.size()), 0),
							static_cast<int>(wire.size()));
		const auto start = GetTickCount64();
		BoundLoopbackStatus status = BoundLoopbackStatus::waiting;
		while (status == BoundLoopbackStatus::waiting && GetTickCount64() - start < 2000) status = owner->poll(10);
		BOOST_REQUIRE(status == BoundLoopbackStatus::received);
	}
};
}  // namespace
BOOST_AUTO_TEST_CASE(prepared_view_mutation_cannot_retarget_launch_and_retry_reuses_attempt) {
	Desktop f;
	auto view = f.prepare();
	const auto original = view.authorization_url;
	view.authorization_url = "https://hostile.test/";
	view.comparison_code = "wrong";
	f.browser->result = BoundBrowserStatus::unavailable;
	BOOST_CHECK(f.owner->launch() == BoundBrowserStatus::unavailable);
	f.browser->result = BoundBrowserStatus::opened;
	BOOST_CHECK(f.owner->launch() == BoundBrowserStatus::opened);
	BOOST_CHECK(f.owner->launch() == BoundBrowserStatus::opened);
	BOOST_REQUIRE_EQUAL(f.browser->urls.size(), 2);
	BOOST_CHECK_EQUAL(f.browser->urls[0], original);
	BOOST_CHECK_EQUAL(f.browser->urls[1], original);
	BOOST_CHECK_EQUAL(f.registrations, 1);
}
BOOST_AUTO_TEST_CASE(delayed_prepare_and_delayed_registration_preserve_listener_deadline) {
	for (bool during_request : {false, true}) {
		Desktop f;
		auto normal = f.call;
		if (during_request)
			f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
				auto result = normal(op, body, out);
				f.ticks += 300000;
				return result;
			};
		else
			f.ticks += 300000;
		BoundEnrollmentView out{"unchanged", "unchanged", 7};
		BOOST_CHECK(f.owner->prepare(out).status == BoundEnrollmentStatus::expired);
		BOOST_CHECK_EQUAL(out.authorization_url, "unchanged");
		BOOST_CHECK_EQUAL(out.expires_at, 7);
		BOOST_CHECK_EQUAL(f.registrations, during_request ? 1u : 0u);
		BOOST_CHECK(f.browser->destroyed);
		BOOST_CHECK_EQUAL(f.browser->calls, 0);
		BOOST_CHECK(f.owner->poll(0) == BoundLoopbackStatus::closed);
	}
}
BOOST_AUTO_TEST_CASE(registration_retry_does_not_replace_listener_or_reset_either_deadline) {
	Desktop f;
	auto normal = f.call;
	std::string first;
	f.call = [&](BoundWireOperation, std::string_view body, BoundHttpResponse&) {
		first = std::string(body);
		return BoundHttpStatus::unavailable;
	};
	BoundEnrollmentView out;
	BOOST_CHECK(f.owner->prepare(out).status == BoundEnrollmentStatus::retry);
	f.ticks += 299999;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& response) {
		BOOST_CHECK_EQUAL(std::string(body), first);
		return normal(op, body, response);
	};
	f.prepare();
	++f.ticks;
	BOOST_CHECK(f.owner->launch() == BoundBrowserStatus::expired);
	BOOST_CHECK_EQUAL(f.browser->calls, 0);
}
BOOST_AUTO_TEST_CASE(prepare_rechecks_flow_after_registration_before_publishing_view) {
	Desktop f;
	auto normal = f.call;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& response) {
		auto result = normal(op, body, response);
		f.listener_clock_hook = [&] { f.clock->ticks += 300 * second; };
		return result;
	};
	BoundEnrollmentView out{"unchanged", "unchanged", 7};
	BOOST_CHECK(f.owner->prepare(out).status == BoundEnrollmentStatus::expired);
	BOOST_CHECK_EQUAL(out.authorization_url, "unchanged");
	BOOST_CHECK_EQUAL(out.expires_at, 7);
	BOOST_CHECK(f.browser->destroyed);
	BOOST_CHECK_EQUAL(f.browser->calls, 0);
	BOOST_CHECK(f.owner->poll(0) == BoundLoopbackStatus::closed);
}
BOOST_AUTO_TEST_CASE(shell_submission_is_rechecked_against_both_original_deadlines) {
	for (bool listener_clock : {false, true}) {
		Desktop f;
		f.prepare();
		f.browser->hook = [&] {
			if (listener_clock)
				f.ticks += 300000;
			else
				f.clock->ticks += 300 * second;
		};
		BOOST_CHECK(f.owner->launch() == BoundBrowserStatus::expired);
		BOOST_CHECK_EQUAL(f.browser->calls, 1);
		BOOST_CHECK(f.browser->destroyed);
		BOOST_CHECK(f.owner->poll(0) == BoundLoopbackStatus::closed);
		BOOST_CHECK(f.owner->activate().status == BoundRenewStatus::rejected);
	}
}
BOOST_AUTO_TEST_CASE(callback_before_launch_closes_browser_route_and_bootstraps_once) {
	Desktop f;
	f.complete_exchange = true;
	f.prepare();
	f.receive();
	BOOST_CHECK(f.owner->launch() == BoundBrowserStatus::invalid_input);
	BOOST_CHECK_EQUAL(f.browser->calls, 0);
	BOOST_CHECK(f.owner->activate().status == BoundRenewStatus::accepted);
	auto client = f.owner->take_client();
	BOOST_REQUIRE(client);
	BOOST_CHECK(client->authorize_operation().status == BoundSessionStatus::ok);
	BOOST_CHECK(!f.owner->take_client());
	BOOST_CHECK(f.owner->cancel().status == BoundEnrollmentStatus::invalid_input);
}
BOOST_AUTO_TEST_CASE(lost_exchange_recovers_after_browser_deadline_without_new_operation) {
	Desktop f;
	f.complete_exchange = true;
	f.prepare();
	f.receive();
	auto normal = f.call;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		auto result = normal(op, body, out);
		return op == BoundWireOperation::exchange ? BoundHttpStatus::unavailable : result;
	};
	BOOST_CHECK(f.owner->activate().status == BoundRenewStatus::retry);
	f.ticks += 301000;
	f.clock->ticks += 301 * second;
	f.call = normal;
	BOOST_CHECK(f.owner->activate().status == BoundRenewStatus::accepted);
	BOOST_REQUIRE_EQUAL(f.operation_ids.size(), 4);
	for (const auto& operation : f.operation_ids) BOOST_CHECK_EQUAL(operation, f.operation_ids[0]);
	auto client = f.owner->take_client();
	BOOST_REQUIRE(client);
	BOOST_CHECK(client->authorize_operation().status == BoundSessionStatus::ok);
}
BOOST_AUTO_TEST_CASE(verified_online_only_and_denied_clients_survive_terminal_handoff) {
	for (bool deny : {false, true}) {
		Desktop f;
		f.complete_exchange = true;
		f.fail_possession = true;
		f.prepare();
		f.receive();
		std::string checkpoint = "unchanged";
		BOOST_CHECK(!f.owner->export_resume_statement(checkpoint));
		BOOST_CHECK_EQUAL(checkpoint, "unchanged");
		BOOST_CHECK(f.owner->activate().status == BoundRenewStatus::session_error);
		BOOST_REQUIRE(f.owner->export_resume_statement(checkpoint));
		BoundResumeStatement statement;
		BOOST_REQUIRE(verify_bound_resume_statement(checkpoint, {{f.signer.spki, false}},
													{"https://issuer.test/", "CAD-client", "CAD", "DEFAULT", f.key},
													statement));
		BOOST_CHECK_EQUAL(statement.revision_floor, 1);
		if (deny) {
			auto normal = f.call;
			f.provider_busy = false;
			f.call = [normal](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
				if (op == BoundWireOperation::enrollment_challenge) return normal(op, body, out);
				out = {404, "{\"ok\":false,\"code\":\"binding_unavailable\",\"request_id\":\"trace\"}"};
				return BoundHttpStatus::complete;
			};
			BOOST_CHECK(f.owner->activate().status == BoundRenewStatus::denied);
		} else
			BOOST_CHECK(f.owner->abandon_exchange().status == BoundRenewStatus::renewal_required);
		std::string terminal;
		BOOST_REQUIRE(f.owner->export_resume_statement(terminal));
		BOOST_CHECK_EQUAL(terminal, checkpoint);
		auto client = f.owner->take_client();
		BOOST_REQUIRE(client);
		BOOST_CHECK(!f.owner->export_resume_statement(terminal));
		BOOST_REQUIRE(client->export_resume_statement(terminal));
		BOOST_CHECK_EQUAL(terminal, checkpoint);
		BOOST_CHECK(client->phase() == BoundSessionPhase::renewal);
		BOOST_CHECK(client->authorize_operation().status ==
					(deny ? BoundSessionStatus::denied : BoundSessionStatus::online_required));
		BOOST_CHECK(!f.owner->take_client());
	}
}
BOOST_AUTO_TEST_CASE(cancel_during_registration_or_shell_is_busy_then_closes_both_owners) {
	for (bool launching : {false, true}) {
		Desktop f;
		std::promise<void> entered, release;
		auto released = release.get_future().share();
		auto normal = f.call;
		if (launching) {
			f.prepare();
			f.browser->hook = [&] {
				entered.set_value();
				released.wait();
			};
		} else
			f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
				auto result = normal(op, body, out);
				entered.set_value();
				released.wait();
				return result;
			};
		auto operation = std::async(std::launch::async, [&] {
			if (launching) return f.owner->launch() == BoundBrowserStatus::opened;
			BoundEnrollmentView out;
			return f.owner->prepare(out).status == BoundEnrollmentStatus::ready;
		});
		entered.get_future().wait();
		const auto cancellation = f.owner->cancel();
		release.set_value();
		const bool completed = operation.get();
		BOOST_CHECK(cancellation.status == BoundEnrollmentStatus::busy);
		BOOST_CHECK(completed);
		BOOST_CHECK(f.owner->cancel().status == BoundEnrollmentStatus::cancelled);
		BOOST_CHECK(f.owner->cancel().status == BoundEnrollmentStatus::cancelled);
		BOOST_CHECK(f.browser->destroyed);
		BOOST_CHECK(f.owner->poll(0) == BoundLoopbackStatus::closed);
		BOOST_CHECK(f.owner->activate().status == BoundRenewStatus::rejected);
	}
}
