/*
 * hw_identifier_facade.cpp
 *
 *  Created on: Dec 26, 2019
 *      Author: devel
 */

#include "hw_identifier_facade.hpp"

#include <cctype>
#include <cstdlib>
#include <stdexcept>

#include "../base/base.h"
#include "../base/logger.h"
#include "identification_strategy.hpp"
#include "hw_identifier.hpp"

#ifndef LCC_ALLOW_RUNTIME_IP_BINDING
#define LCC_ALLOW_RUNTIME_IP_BINDING false
#endif

#ifndef LCC_ALLOW_RUNTIME_ENV_SELECTED_BINDING
#define LCC_ALLOW_RUNTIME_ENV_SELECTED_BINDING false
#endif

#ifndef LCC_ALLOW_WEAK_DISK_LABEL_BINDING
#define LCC_ALLOW_WEAK_DISK_LABEL_BINDING false
#endif

namespace license {
namespace hw_identifier {

using namespace std;

LCC_API_HW_IDENTIFICATION_STRATEGY parse_identification_strategy_env_value(const char* env_var_value) {
	if (env_var_value == nullptr) {
		return STRATEGY_DEFAULT;
	}
	if (env_var_value[0] == '\0') {
		throw invalid_argument(string(LCC_IDENTIFICATION_STRATEGY_ENV_VAR) + " must not be empty");
	}
	unsigned int value = 0;
	for (const unsigned char ch : string(env_var_value)) {
		if (!isdigit(ch)) {
			throw invalid_argument(string(LCC_IDENTIFICATION_STRATEGY_ENV_VAR) +
								   " must be a numeric hardware strategy id");
		}
		value = value * 10 + static_cast<unsigned int>(ch - '0');
		if (value > static_cast<unsigned int>(STRATEGY_DISK)) {
			throw invalid_argument(string(LCC_IDENTIFICATION_STRATEGY_ENV_VAR) +
								   " must be ETHERNET(0), IP_ADDRESS(1), or DISK(2)");
		}
	}
	return static_cast<LCC_API_HW_IDENTIFICATION_STRATEGY>(value);
}

LCC_EVENT_TYPE HwIdentifierFacade::validate_pc_signature(const std::string& str_code) {
	return validate_pc_signature(str_code, LCC_ALLOW_RUNTIME_IP_BINDING, LCC_ALLOW_RUNTIME_ENV_SELECTED_BINDING);
}

LCC_EVENT_TYPE HwIdentifierFacade::validate_pc_signature(const std::string& str_code, bool allow_ip_binding,
														 bool allow_env_selected_binding) {
	LCC_EVENT_TYPE result = IDENTIFIERS_MISMATCH;
	try {
		HwIdentifier pc_id(str_code);
		LCC_API_HW_IDENTIFICATION_STRATEGY id_strategy = pc_id.get_identification_strategy();
		if (id_strategy == STRATEGY_IP_ADDRESS && !allow_ip_binding) {
			LOG_WARN("Rejecting IP-address hardware binding by runtime policy");
			return LICENSE_MALFORMED;
		}
		if (pc_id.uses_environment_var() && !allow_env_selected_binding) {
			LOG_WARN("Rejecting environment-selected hardware binding by runtime policy");
			return LICENSE_MALFORMED;
		}
		if (pc_id.uses_weak_source() && !LCC_ALLOW_WEAK_DISK_LABEL_BINDING) {
			LOG_WARN("Rejecting weak disk-label hardware binding by runtime policy");
			return LICENSE_MALFORMED;
		}
		unique_ptr<IdentificationStrategy> strategy = IdentificationStrategy::get_strategy(id_strategy);
		result = strategy->validate_identifier(pc_id);
	} catch (logic_error& e) {
		LOG_ERROR("Error validating hardware identifier: malformed or unsupported identifier");
		((void)(e));
		result = LICENSE_MALFORMED;
	}
	return result;
}

std::string HwIdentifierFacade::generate_user_pc_signature(LCC_API_HW_IDENTIFICATION_STRATEGY strategy) {
	bool use_env_var = false;
	vector<LCC_API_HW_IDENTIFICATION_STRATEGY> strategies_to_try;
	if (strategy == STRATEGY_DEFAULT) {
		char* env_var_value = getenv(LCC_IDENTIFICATION_STRATEGY_ENV_VAR);
		if (env_var_value != nullptr) {
			strategy = parse_identification_strategy_env_value(env_var_value);
			use_env_var = true;
		}
	}

	unique_ptr<IdentificationStrategy> strategy_ptr = IdentificationStrategy::get_strategy(strategy);
	HwIdentifier pc_id;
	FUNCTION_RETURN result = strategy_ptr->generate_pc_id(pc_id);
	pc_id.set_use_environment_var(use_env_var);
	if (result != FUNC_RET_OK) {
		throw logic_error("strategy " + to_string(strategy_ptr->identification_strategy()) + " failed");
	}
	return pc_id.print();
}

}  // namespace hw_identifier
} /* namespace license */
