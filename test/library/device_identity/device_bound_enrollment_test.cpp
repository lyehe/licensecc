#define BOOST_TEST_MODULE device_bound_enrollment_test
#ifdef _WIN32
#include "bound_loopback_fixture.hpp"
#endif
#include "bound_enrollment_fixture.hpp"

BOOST_AUTO_TEST_CASE(registration_is_pinned_and_callbacks_cannot_replace_code) {
	Fixture f;
	f.begin();
	f.begin();
	BOOST_CHECK_EQUAL(f.registrations, 1);
	BOOST_CHECK_EQUAL(f.registration.fields.count("code_verifier"), 0);
	BOOST_CHECK_EQUAL(f.registration.fields.at("code_challenge_method").text, "S256");
	BOOST_CHECK(f.flow->receive_callback(f.callback() + "&extra=1").status == BoundEnrollmentStatus::invalid_input);
	BOOST_CHECK(f.flow->receive_callback(redirect + "?code=" + std::string(43, 'A') + "&state=" + std::string(43, 'A'))
					.status == BoundEnrollmentStatus::invalid_input);
	f.receive();
	f.receive();
	BOOST_CHECK(f.flow->receive_callback(f.callback(bound_encoding::base64url(std::string(32, 'B')))).status ==
				BoundEnrollmentStatus::invalid_input);
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::retry);
}
BOOST_AUTO_TEST_CASE(untrusted_registration_metadata_is_not_published) {
	for (bool wrong_url : {false, true}) {
		Fixture f;
		BoundEnrollmentView view{"sentinel", "untouched", 7};
		if (wrong_url)
			f.response_url = "https://other.test/authorize";
		else
			f.comparison_override = "0000-0000-0000";
		BOOST_CHECK(f.flow->begin(redirect, view).status == BoundEnrollmentStatus::invalid_response);
		BOOST_CHECK_EQUAL(view.authorization_url, "sentinel");
		BOOST_CHECK_EQUAL(view.expires_at, 7);
		f.response_url = portal;
		f.comparison_override.clear();
		f.begin();
	}
}
BOOST_AUTO_TEST_CASE(rng_failure_cannot_create_recovery_window) {
	for (unsigned failed : {1u, 2u}) {
		Fixture f;
		f.clock->fail_draw = failed;
		BoundEnrollmentView view;
		BOOST_CHECK(f.flow->begin(redirect, view).status == BoundEnrollmentStatus::failed);
		BOOST_CHECK_EQUAL(f.registrations, 0);
	}
	Fixture f;
	f.begin();
	f.receive();
	f.clock->fail_draw = 3;
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::session_error);
	BOOST_CHECK_EQUAL(f.challenges, 0);
	BOOST_CHECK(f.flow->abandon_exchange().status == BoundRenewStatus::rejected);
	f.clock->ticks += 300 * second;
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::enrollment_required);
	BOOST_CHECK_EQUAL(f.challenges, 0);
}
BOOST_AUTO_TEST_CASE(pending_exchange_preserves_operation_but_expires_at_48_hours) {
	Fixture f;
	f.begin();
	f.receive();
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::retry);
	f.clock->ticks += 301 * second;
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::retry);
	BOOST_REQUIRE_EQUAL(f.operation_ids.size(), 2);
	BOOST_CHECK_EQUAL(f.operation_ids[0], f.operation_ids[1]);
	f.clock->ticks += (48 * 3600 - 301) * second;
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::enrollment_required);
	BOOST_CHECK_EQUAL(f.challenges, 2);
	BOOST_CHECK(!f.flow->take_client());
}
BOOST_AUTO_TEST_CASE(deadline_is_exclusive_before_callback_and_first_exchange) {
	for (bool delivered : {false, true}) {
		Fixture f;
		f.begin();
		if (delivered) f.receive();
		f.clock->ticks += 300 * second;
		if (delivered)
			BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::enrollment_required);
		else
			BOOST_CHECK(f.flow->receive_callback(f.callback()).status == BoundEnrollmentStatus::expired);
		BOOST_CHECK_EQUAL(f.challenges, 0);
	}
}
BOOST_AUTO_TEST_CASE(synchronous_registration_serializes_cancel_and_retry) {
	Fixture f;
	auto normal = f.call;
	std::promise<void> entered, release;
	auto released = release.get_future().share();
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		entered.set_value();
		released.wait();
		return normal(op, body, out);
	};
	auto running = std::async(std::launch::async, [&] {
		BoundEnrollmentView view;
		return f.flow->begin(redirect, view);
	});
	entered.get_future().wait();
	const auto cancelled = f.flow->cancel();
	BoundEnrollmentView view;
	const auto retry = f.flow->begin(redirect, view);
	auto client = f.flow->take_client();
	release.set_value();
	const auto done = running.get();
	BOOST_CHECK(cancelled.status == BoundEnrollmentStatus::busy);
	BOOST_CHECK(retry.status == BoundEnrollmentStatus::busy);
	BOOST_CHECK(!client);
	BOOST_CHECK(done.status == BoundEnrollmentStatus::ready);
	BOOST_CHECK(f.flow->cancel().status == BoundEnrollmentStatus::cancelled);
	BOOST_CHECK(f.flow->receive_callback(f.callback()).status == BoundEnrollmentStatus::invalid_input);
}
BOOST_AUTO_TEST_CASE(signed_bootstrap_checks_pkce_and_transfers_once) {
	Fixture f;
	f.complete_exchange = true;
	f.begin();
	f.receive();
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::accepted);
	auto client = f.flow->take_client();
	BOOST_REQUIRE(client);
	BOOST_CHECK(client->authorize_operation().status == BoundSessionStatus::ok);
	BOOST_CHECK(!f.flow->take_client());
}
BOOST_AUTO_TEST_CASE(lost_bootstrap_anchor_requires_new_enrollment_without_reissuing) {
	Fixture f;
	f.complete_exchange = true;
	f.lose_clock = true;
	f.begin();
	f.receive();
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::enrollment_required);
	const auto sent = f.challenges;
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::rejected);
	BOOST_CHECK_EQUAL(f.challenges, sent);
	BOOST_CHECK(!f.flow->take_client());
}
BOOST_AUTO_TEST_CASE(delayed_retry_erases_expired_recovery_before_returning) {
	Fixture f;
	f.begin();
	f.receive();
	auto normal = f.call;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		f.clock->ticks += 48 * 3600 * second;
		return normal(op, body, out);
	};
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::enrollment_required);
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::rejected);
}
BOOST_AUTO_TEST_CASE(delayed_registration_cannot_reset_the_admission_deadline) {
	Fixture f;
	auto normal = f.call;
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		auto status = normal(op, body, out);
		f.clock->ticks += 300 * second;
		return status;
	};
	BoundEnrollmentView view{"untouched", "untouched", 7};
	BOOST_CHECK(f.flow->begin(redirect, view).status == BoundEnrollmentStatus::expired);
	BOOST_CHECK_EQUAL(view.authorization_url, "untouched");
	BOOST_CHECK_EQUAL(view.expires_at, 7);
}
BOOST_AUTO_TEST_CASE(registration_retry_preserves_request_and_original_deadline) {
	Fixture f;
	auto normal = f.call;
	std::string first;
	f.call = [&](BoundWireOperation, std::string_view body, BoundHttpResponse&) {
		if (first.empty())
			first = std::string(body);
		else
			BOOST_CHECK_EQUAL(first, std::string(body));
		return BoundHttpStatus::unavailable;
	};
	BoundEnrollmentView view;
	BOOST_CHECK(f.flow->begin(redirect, view).status == BoundEnrollmentStatus::retry);
	f.clock->ticks += 299 * second;
	BOOST_CHECK(f.flow->begin(redirect, view).status == BoundEnrollmentStatus::retry);
	f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
		BOOST_CHECK_EQUAL(first, std::string(body));
		return normal(op, body, out);
	};
	f.begin();
	f.clock->ticks += second;
	BOOST_CHECK(f.flow->receive_callback(f.callback()).status == BoundEnrollmentStatus::expired);
}
BOOST_AUTO_TEST_CASE(callback_aliases_are_rejected_without_destroying_valid_delivery) {
	Fixture f;
	f.begin();
	const auto state = f.registration.fields.at("state").text;
	const auto code = std::string(43, 'A');
	const std::vector<std::string> invalid{redirect + "?code=" + code + "&code=" + code,
										   redirect + "?state=" + state + "&state=" + state,
										   redirect + "?code=%41" + code.substr(1) + "&state=" + state,
										   f.callback() + "#fragment",
										   "http://127.0.0.1:49153/callback?code=" + code + "&state=" + state,
										   redirect + "/other?code=" + code + "&state=" + state};
	for (const auto& uri : invalid)
		BOOST_CHECK(f.flow->receive_callback(uri).status == BoundEnrollmentStatus::invalid_input);
	BOOST_CHECK(f.flow->receive_callback(redirect + "?state=" + state + "&code=" + code).status ==
				BoundEnrollmentStatus::callback_received);
	f.receive();
}
BOOST_AUTO_TEST_CASE(verified_binding_survives_possession_failure_and_explicit_abandonment) {
	Fixture f;
	f.complete_exchange = true;
	f.fail_possession = true;
	f.begin();
	f.receive();
	std::string checkpoint = "unchanged";
	BOOST_CHECK(!f.flow->export_resume_statement(checkpoint));
	BOOST_CHECK_EQUAL(checkpoint, "unchanged");
	BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::session_error);
	BOOST_REQUIRE(f.flow->export_resume_statement(checkpoint));
	BoundResumeStatement statement;
	BOOST_REQUIRE(verify_bound_resume_statement(checkpoint, {{f.signer.spki, false}},
												{"https://issuer.test/", "CAD-client", "CAD", "DEFAULT", f.key},
												statement));
	BOOST_CHECK(!f.flow->take_client());
	BOOST_CHECK(f.flow->abandon_exchange().status == BoundRenewStatus::renewal_required);
	auto client = f.flow->take_client();
	BOOST_REQUIRE(client);
	std::string after = "unchanged";
	BOOST_CHECK(!f.flow->export_resume_statement(after));
	BOOST_CHECK_EQUAL(after, "unchanged");
	BOOST_REQUIRE(client->export_resume_statement(after));
	BOOST_CHECK_EQUAL(after, checkpoint);
	BOOST_CHECK(client->phase() == BoundSessionPhase::renewal);
	BOOST_CHECK(client->authorize_operation().status == BoundSessionStatus::online_required);
	BOOST_CHECK(!f.flow->take_client());
}
#ifdef _WIN32
BOOST_AUTO_TEST_CASE(windows_loopback_exclusivity_state_validation_and_real_callback) {
	for (bool ipv6 : {false, true}) {
		Fixture f;
		auto listener = BoundLoopbackListener::create("/callback", ipv6);
		BOOST_REQUIRE(listener);
		const auto uri = listener->redirect_uri();
		LocalSocket competing(ipv6 ? AF_INET6 : AF_INET);
		auto address = local_address(uri, ipv6);
		BOOL reuse = TRUE;
		BOOST_REQUIRE_EQUAL(
			setsockopt(competing.value, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse)),
			0);
		BOOST_CHECK_EQUAL(bind(competing.value, reinterpret_cast<sockaddr*>(&address),
							   ipv6 ? sizeof(sockaddr_in6) : sizeof(sockaddr_in)),
						  SOCKET_ERROR);
		BoundEnrollmentView view;
		BOOST_REQUIRE(f.flow->begin(uri, view).status == BoundEnrollmentStatus::ready);
		LocalSocket invalid(ipv6 ? AF_INET6 : AF_INET);
		connect_local(invalid, uri, ipv6);
		auto wire = callback_request(uri, std::string(43, 'A'));
		BOOST_REQUIRE_EQUAL(send(invalid.value, wire.data(), static_cast<int>(wire.size()), 0),
							static_cast<int>(wire.size()));
		BOOST_CHECK(pump(*listener, *f.flow) == BoundLoopbackStatus::rejected);
		char response[2048];
		int received = recv(invalid.value, response, sizeof(response), 0);
		BOOST_REQUIRE(received > 0);
		BOOST_CHECK(std::string(response, received).find("400 Bad Request") != std::string::npos);
		LocalSocket valid(ipv6 ? AF_INET6 : AF_INET);
		connect_local(valid, uri, ipv6);
		wire = callback_request(uri, f.registration.fields.at("state").text);
		BOOST_REQUIRE_EQUAL(send(valid.value, wire.data(), static_cast<int>(wire.size()), 0),
							static_cast<int>(wire.size()));
		BOOST_CHECK(pump(*listener, *f.flow) == BoundLoopbackStatus::received);
		received = recv(valid.value, response, sizeof(response), 0);
		BOOST_REQUIRE(received > 0);
		BOOST_CHECK(std::string(response, received).find("200 OK") != std::string::npos);
		BOOST_CHECK(listener->poll(*f.flow, 0) == BoundLoopbackStatus::closed);
		BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::retry);
	}
}
BOOST_AUTO_TEST_CASE(windows_idle_preconnection_does_not_block_valid_callback) {
	Fixture f;
	auto listener = BoundLoopbackListener::create("/callback");
	BOOST_REQUIRE(listener);
	const auto uri = listener->redirect_uri();
	BoundEnrollmentView view;
	BOOST_REQUIRE(f.flow->begin(uri, view).status == BoundEnrollmentStatus::ready);
	LocalSocket idle(AF_INET);
	connect_local(idle, uri, false);
	BOOST_CHECK(listener->poll(*f.flow, 10) == BoundLoopbackStatus::waiting);
	LocalSocket valid(AF_INET);
	connect_local(valid, uri, false);
	const auto wire = callback_request(uri, f.registration.fields.at("state").text);
	BOOST_REQUIRE_EQUAL(send(valid.value, wire.data(), static_cast<int>(wire.size()), 0),
						static_cast<int>(wire.size()));
	BOOST_CHECK(pump(*listener, *f.flow) == BoundLoopbackStatus::received);
}
BOOST_AUTO_TEST_CASE(windows_listener_close_cancels_pending_accept_and_is_idempotent) {
	Fixture f;
	auto listener = BoundLoopbackListener::create("/callback");
	BOOST_REQUIRE(listener);
	BOOST_CHECK(listener->poll(*f.flow, 0) == BoundLoopbackStatus::waiting);
	BOOST_CHECK(listener->close() == BoundLoopbackStatus::closed);
	BOOST_CHECK(listener->close() == BoundLoopbackStatus::closed);
	BOOST_CHECK(listener->poll(*f.flow, 0) == BoundLoopbackStatus::closed);
}
BOOST_AUTO_TEST_CASE(windows_fragmented_callback_cancels_other_pending_accept) {
	Fixture f;
	auto listener = BoundLoopbackListener::create("/callback");
	BOOST_REQUIRE(listener);
	const auto uri = listener->redirect_uri();
	BoundEnrollmentView view;
	BOOST_REQUIRE(f.flow->begin(uri, view).status == BoundEnrollmentStatus::ready);
	LocalSocket client(AF_INET);
	connect_local(client, uri, false);
	const auto wire = callback_request(uri, f.registration.fields.at("state").text);
	const auto half = static_cast<int>(wire.size() / 2);
	BOOST_REQUIRE_EQUAL(send(client.value, wire.data(), half, 0), half);
	BOOST_CHECK(listener->poll(*f.flow, 10) == BoundLoopbackStatus::waiting);
	BOOST_CHECK(listener->poll(*f.flow, 0) == BoundLoopbackStatus::waiting);
	BOOST_REQUIRE_EQUAL(send(client.value, wire.data() + half, static_cast<int>(wire.size()) - half, 0),
						static_cast<int>(wire.size()) - half);
	BOOST_CHECK(pump(*listener, *f.flow) == BoundLoopbackStatus::received);
	BOOST_CHECK(listener->poll(*f.flow, 0) == BoundLoopbackStatus::closed);
}
BOOST_AUTO_TEST_CASE(windows_oversize_headers_do_not_consume_the_valid_attempt) {
	Fixture f;
	auto listener = BoundLoopbackListener::create("/callback");
	BOOST_REQUIRE(listener);
	const auto uri = listener->redirect_uri();
	BoundEnrollmentView view;
	BOOST_REQUIRE(f.flow->begin(uri, view).status == BoundEnrollmentStatus::ready);
	LocalSocket oversized(AF_INET);
	connect_local(oversized, uri, false);
	const std::string bytes(8192, 'x');
	BOOST_REQUIRE_EQUAL(send(oversized.value, bytes.data(), static_cast<int>(bytes.size()), 0),
						static_cast<int>(bytes.size()));
	BOOST_CHECK(pump(*listener, *f.flow) == BoundLoopbackStatus::rejected);
	LocalSocket valid(AF_INET);
	connect_local(valid, uri, false);
	const auto wire = callback_request(uri, f.registration.fields.at("state").text);
	BOOST_REQUIRE_EQUAL(send(valid.value, wire.data(), static_cast<int>(wire.size()), 0),
						static_cast<int>(wire.size()));
	BOOST_CHECK(pump(*listener, *f.flow) == BoundLoopbackStatus::received);
}
BOOST_AUTO_TEST_CASE(windows_busy_flow_retains_callback_without_browser_retransmission) {
	for (unsigned scenario : {0u, 1u, 2u, 3u}) {
		std::uint64_t ticks = 1000;
		Fixture f;
		auto listener = BoundLoopbackListener::create("/callback", false, [&] { return ticks; });
		BOOST_REQUIRE(listener);
		const auto uri = listener->redirect_uri();
		auto normal = f.call;
		LocalSocket client(AF_INET);
		connect_local(client, uri, false);
		std::promise<void> entered, release;
		auto released = release.get_future().share();
		f.call = [&](BoundWireOperation op, std::string_view body, BoundHttpResponse& out) {
			auto status = normal(op, body, out);
			entered.set_value();
			released.wait();
			return status;
		};
		auto beginning = std::async(std::launch::async, [&] {
			BoundEnrollmentView view;
			return f.flow->begin(uri, view);
		});
		entered.get_future().wait();
		const auto wire = callback_request(uri, f.registration.fields.at("state").text);
		const auto sent = send(client.value, wire.data(), static_cast<int>(wire.size()), 0);
		const auto while_busy = listener->poll(*f.flow, 10);
		int reset_result = 0;
		if (scenario == 1) {
			linger reset{1, 0};
			reset_result =
				setsockopt(client.value, SOL_SOCKET, SO_LINGER, reinterpret_cast<const char*>(&reset), sizeof(reset));
			closesocket(client.value);
			client.value = INVALID_SOCKET;
		}
		if (scenario == 2) ticks += 5000;
		if (scenario == 3) ticks += 300000;
		release.set_value();
		const auto begun = beginning.get();
		BOOST_CHECK_EQUAL(reset_result, 0);
		BOOST_REQUIRE_EQUAL(sent, static_cast<int>(wire.size()));
		BOOST_CHECK(while_busy == BoundLoopbackStatus::waiting);
		BOOST_REQUIRE(begun.status == BoundEnrollmentStatus::ready);
		const auto expected = scenario == 2	  ? BoundLoopbackStatus::rejected
							  : scenario == 3 ? BoundLoopbackStatus::expired
											  : BoundLoopbackStatus::received;
		BOOST_CHECK(pump(*listener, *f.flow) == expected);
		if (scenario >= 2) BOOST_CHECK(f.flow->activate().status == BoundRenewStatus::rejected);
	}
}
BOOST_AUTO_TEST_CASE(windows_partial_bytes_do_not_extend_the_connection_deadline) {
	std::uint64_t ticks = 1000;
	Fixture f;
	auto listener = BoundLoopbackListener::create("/callback", false, [&] { return ticks; });
	BOOST_REQUIRE(listener);
	const auto uri = listener->redirect_uri();
	BoundEnrollmentView view;
	BOOST_REQUIRE(f.flow->begin(uri, view).status == BoundEnrollmentStatus::ready);
	LocalSocket slow(AF_INET);
	connect_local(slow, uri, false);
	BOOST_REQUIRE_EQUAL(send(slow.value, "G", 1, 0), 1);
	BOOST_CHECK(listener->poll(*f.flow, 10) == BoundLoopbackStatus::waiting);
	ticks += 2500;
	BOOST_REQUIRE_EQUAL(send(slow.value, "E", 1, 0), 1);
	BOOST_CHECK(listener->poll(*f.flow, 10) == BoundLoopbackStatus::waiting);
	ticks += 2500;
	BOOST_CHECK(listener->poll(*f.flow, 0) == BoundLoopbackStatus::rejected);
	LocalSocket valid(AF_INET);
	connect_local(valid, uri, false);
	const auto wire = callback_request(uri, f.registration.fields.at("state").text);
	BOOST_REQUIRE_EQUAL(send(valid.value, wire.data(), static_cast<int>(wire.size()), 0),
						static_cast<int>(wire.size()));
	BOOST_CHECK(pump(*listener, *f.flow) == BoundLoopbackStatus::received);
}
BOOST_AUTO_TEST_CASE(windows_listener_clock_regression_expires_instead_of_resetting) {
	std::uint64_t ticks = 1000;
	Fixture f;
	auto listener = BoundLoopbackListener::create("/callback", false, [&] { return ticks; });
	BOOST_REQUIRE(listener);
	ticks += 100;
	BOOST_CHECK(listener->poll(*f.flow, 0) == BoundLoopbackStatus::waiting);
	--ticks;
	BOOST_CHECK(listener->poll(*f.flow, 0) == BoundLoopbackStatus::expired);
}
#endif
