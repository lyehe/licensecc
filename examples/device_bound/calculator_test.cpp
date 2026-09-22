#include "feature_session_stubs.hpp"
#define main calculator_example_main
#include "calculator.cpp"
#undef main

void require(bool condition) {
	if (!condition) throw std::runtime_error("calculator guard assertion failed");
}

int invoke(const char* operation, const char* left, const char* right) {
	char name[] = "calculator";
	std::string a(operation), b(left), c(right);
	char* args[]{name, a.data(), b.data(), c.data()};
	return calculator::run(4, args);
}

int main() {
	using namespace feature_fixture;
	std::ostringstream output, errors;
	auto* old_output = std::cout.rdbuf(output.rdbuf());
	auto* old_errors = std::cerr.rdbuf(errors.rdbuf());
	int result = 0;
	try {
		require(invoke("add", "2", "3") == 0 && output.str() == "5\n" && opened.empty());
		output.str("");
		require(invoke("sub", "2", "3") == 0 && output.str() == "-1\n" && opened.empty());
		for (const char* invalid : {"nan", "inf", "2oops", "1e999", ""}) {
			output.str("");
			require(invoke("mul", invalid, "3") == 2 && output.str().empty() && opened.empty());
		}
		require(invoke("div", "2", "0") == 2 && opened.empty());
		output.str("");
		require(invoke("mul", "6", "7") == 0 && output.str() == "42\n");
		require(starts == 1 && checks == 2 && stops == 1 && closes == 1);
		require(opened.front() == configuration::feature);
		output.str("");
		require(invoke("div", "9", "2") == 0 && output.str() == "4.5\n" && starts == 2 && closes == 2);
		reset();
		for (unsigned denied_at : {0u, 1u, 2u}) {
			output.str("");
			reject_start = denied_at == 0;
			deny_check = denied_at;
			require(!calculator::licensed_calculation(false, 6, 7, output));
			require(output.str().empty() && closes == 1);
			reset();
		}
		output.str("");
		due = true;
		reject_renew = true;
		require(!calculator::licensed_calculation(false, 6, 7, output) && output.str().empty());
		require(renewals == 1 && closes == 1);
		reset();
		due = true;
		require(calculator::licensed_calculation(false, 6, 7, output));
		require(checks == 4 && renewals == 2 && closes == 1);
		reset();
		output.str("");
		example_work::cancelled = 1;
		require(!calculator::licensed_calculation(false, 6, 7, output) && output.str().empty());
		require(starts == 0 && closes == 1);
		example_work::cancelled = 0;
		reset();
	} catch (const std::exception& error) {
		old_errors->sputn(error.what(), static_cast<std::streamsize>(std::strlen(error.what())));
		result = 1;
	}
	std::cout.rdbuf(old_output);
	std::cerr.rdbuf(old_errors);
	return result;
}
