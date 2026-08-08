/*
 * default_strategy.hpp
 *
 *  Created on: Jan 2, 2020
 *      Author: devel
 */

#ifndef SRC_LIBRARY_PC_IDENTIFIER_DEFAULT_STRATEGY_HPP_
#define SRC_LIBRARY_PC_IDENTIFIER_DEFAULT_STRATEGY_HPP_
#include "identification_strategy.hpp"

namespace license {
namespace hw_identifier {

class DefaultStrategy : public IdentificationStrategy {
public:
	DefaultStrategy();
	explicit DefaultStrategy(const std::vector<LCC_API_HW_IDENTIFICATION_STRATEGY> &strategy_to_try);
	virtual ~DefaultStrategy();
	virtual LCC_API_HW_IDENTIFICATION_STRATEGY identification_strategy() const;
	virtual FUNCTION_RETURN generate_pc_id(HwIdentifier &pc_id) const;
	virtual std::vector<HwIdentifier> alternative_ids() const;
	virtual LCC_EVENT_TYPE validate_identifier(const HwIdentifier &identifier) const;

private:
	bool m_has_strategy_override;
	std::vector<LCC_API_HW_IDENTIFICATION_STRATEGY> m_strategy_override;
};
}  // namespace hw_identifier
} /* namespace license */

#endif /* SRC_LIBRARY_PC_IDENTIFIER_DEFAULT_STRATEGY_HPP_ */
