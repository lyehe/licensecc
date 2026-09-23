#include "enrollment_work.hpp"
#include "feature_work.hpp"
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <limits>
#include <string>

namespace calculator {
bool number(const char* text, double& value) {
	if (!text || !*text) return false;
	char* end = nullptr;
	errno = 0;
	value = std::strtod(text, &end);
	return end != text && *end == '\0' && errno != ERANGE && std::isfinite(value);
}

int activate() {
	auto config = example_configuration::options();
	std::cout << "Activate licensed multiplication and division (feature " << config.feature << ").\n";
	LccDeviceBoundOutcome detail;
	lcc_init_device_bound_outcome(&detail);
	LccDeviceBoundClient* raw = nullptr;
	const auto opened = lcc_device_bound_open_enrollment(&config, &raw, &detail);
	std::unique_ptr<LccDeviceBoundClient, decltype(&lcc_device_bound_close)> client(raw, lcc_device_bound_close);
	if (opened == LCC_BOUND_RESUME_REQUIRED) {
		std::cerr << "This device already has activation state. Run mul or div to verify it online.\n";
		return 1;
	}
	if (opened != LCC_BOUND_OK) {
		std::cerr << "Activation unavailable (" << opened << ", provider " << detail.provider_result
				  << "). Existing device state was preserved.\n";
		return 1;
	}
	if (!example_enrollment::enroll(client.get())) return 1;
	std::cout << "Device activated. You can now use mul and div.\n";
	return 0;
}

// Guard the operation itself. Calling this from a future GUI still needs permission.
bool licensed_calculation(bool divide, double left, double right, std::ostream& output) {
	if (!std::isfinite(left) || !std::isfinite(right) || (divide && right == 0)) return false;
	example_work::Session job;
	constexpr auto feature = configuration::feature;
	if (!job.start(feature) || !job.authorize(feature)) return false;
	const double result = divide ? left / right : left * right;
	if (!std::isfinite(result) || !job.authorize(feature)) return false;
	output << std::setprecision(std::numeric_limits<double>::max_digits10) << result << '\n';
	return job.stop() && static_cast<bool>(output);
}

int run(int argc, char** argv) {
	if (argc == 2 && std::string(argv[1]) == "activate") return activate();
	std::signal(SIGINT, example_work::cancel_work);
	if (argc != 4) {
		std::cout << "Licensecc calculator\n"
				  << "  licensecc_calculator add|sub NUMBER NUMBER  (free)\n"
				  << "  licensecc_calculator mul|div NUMBER NUMBER  (licensed)\n"
				  << "  licensecc_calculator activate              (browser sign-in)\n";
		return 2;
	}
	const std::string operation = argv[1];
	double left, right;
	if ((operation != "add" && operation != "sub" && operation != "mul" && operation != "div") ||
		!number(argv[2], left) || !number(argv[3], right)) {
		std::cerr << "Use add, sub, mul or div with two finite numbers.\n";
		return 2;
	}
	if (operation == "div" && right == 0) {
		std::cerr << "Cannot divide by zero.\n";
		return 2;
	}
	if (operation == "mul" || operation == "div") {
		if (licensed_calculation(operation == "div", left, right, std::cout)) return 0;
		std::cerr << "Licensed calculation did not complete. Check activation and connection, then retry.\n";
		return 1;
	}
	const double result = operation == "add" ? left + right : left - right;
	if (!std::isfinite(result)) {
		std::cerr << "Result is outside the supported numeric range.\n";
		return 2;
	}
	std::cout << std::setprecision(std::numeric_limits<double>::max_digits10) << result << '\n';
	return std::cout ? 0 : 1;
}
}  // namespace calculator

int main(int argc, char** argv) { return calculator::run(argc, argv); }
