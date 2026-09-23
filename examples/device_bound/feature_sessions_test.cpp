#include "feature_session_stubs.hpp"
#define main feature_example_main
#include "feature_sessions.cpp"
#undef main
void require(bool value) {
	if (!value) throw std::runtime_error("feature example flow assertion failed");
}
int main() {
	using namespace feature_fixture;
	// These tests characterize application guards, not native/server enforcement.
	const char* path = "feature-session-example-input.tmp";
	{
		std::ofstream file(path, std::ios::binary);
		file << "abc";
	}
	std::ostringstream output;
	auto* previous = std::cout.rdbuf(output.rdbuf());
	int result = 0;
	try {
		Report report;
		require(run_batch(path, report) && run_batch(path, report) && export_report(report));
		require(opened == std::vector<std::string>({"BATCH_RUN", "BATCH_RUN", "EXPORT"}));
		require(starts == 3 && checks == 5 && stops == 3 && closes == 3);
		require(report.bytes == 3 && report.checksum == 294 && output.str() == "bytes,checksum\n3,294\n");
		reset();
		reject_start = true;
		report = {99, 99};
		require(!run_batch(path, report) && starts == 1 && checks == 0 && closes == 1 && report.bytes == 99);
		reset();
		deny_check = 1;
		require(!run_batch(path, report) && checks == 1 && report.bytes == 99 && closes == 1);
		reset();
		deny_check = 2;
		require(!run_batch(path, report) && checks == 2 && report.bytes == 99 && closes == 1);
		reset();
		output.str("");
		deny_check = 1;
		require(!export_report(report) && output.str().empty() && closes == 1);
		reset();
		due = true;
		reject_renew = true;
		require(!run_batch(path, report) && renewals == 1 && report.bytes == 99 && closes == 1);
		reset();
		due = true;
		require(run_batch(path, report) && renewals == 2 && checks == 4 && closes == 1);
		reset();
		cancelled = 1;
		require(!run_batch(path, report) && starts == 0 && checks == 0 && closes == 1);
		reset();
		cancelled = 0;
	} catch (const std::exception& error) {
		std::cerr << error.what() << '\n';
		result = 1;
	}
	std::cout.rdbuf(previous);
	std::remove(path);
	return result;
}
