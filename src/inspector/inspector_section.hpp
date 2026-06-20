#ifndef LCC_INSPECTOR_SECTION_HPP
#define LCC_INSPECTOR_SECTION_HPP

#include <string>

#include <licensecc/licensecc.h>

// Classification of an INI section name read from a license file. Extracted from
// inspector.cpp's verifyLicense so the fix for the round-3 over-read is unit-testable:
// the section name is read at its TRUE length (std::string(ptr), not a fixed 15 bytes),
// so short names compare correctly and the feature name is bounded via the public setter
// rather than an unbounded std::copy.
//
// LCC_PROJECT_NAME comes from the project-scoped generated properties header, which the
// including translation unit must pull in before this header.

namespace lccinspector {

enum class SectionAction {
	SkipDefaultProject,	 // section equals the default project; already checked separately
	NameTooLong,  // feature name does not fit the fixed public buffer
	CheckFeature,  // caller_out.feature_name was set; check this feature
};

inline SectionAction classify_inspector_section(const char* section_name, CallerInformations& caller_out) {
	const std::string name(section_name);  // true length, not a fixed width
	if (name == LCC_PROJECT_NAME) {
		return SectionAction::SkipDefaultProject;
	}
	if (!lcc_set_caller_feature_name(&caller_out, name.c_str())) {
		return SectionAction::NameTooLong;
	}
	return SectionAction::CheckFeature;
}

}  // namespace lccinspector

#endif	// LCC_INSPECTOR_SECTION_HPP
