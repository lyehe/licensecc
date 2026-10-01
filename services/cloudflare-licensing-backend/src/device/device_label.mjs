// The device-label rule. The approval page shows the app-supplied device label beside the real
// comparison code, so a label must not hold a character that renders as nothing or breaks or
// reorders text, and must not spell anything shaped like a comparison code.
//
// This module is the single source of the rule. The backend applies it at registration, and
// scripts/generate-device-label-table.mjs derives the native client's code-point table
// (src/library/device_identity/bound_label_table.hpp) from these same property escapes, so the
// app refuses the same labels before it sends one. Worker-safe: no imports.

/** Controls, format characters (bidi controls included), line and paragraph separators, and
 *  default-ignorable code points such as variation selectors, fillers and tag characters. */
export const DEVICE_LABEL_REFUSED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** Dashes and spaces, any of which could separate the groups of a comparison code. */
export const DEVICE_LABEL_SEPARATOR = /[\p{Pd}\p{Zs}]/u;

/** Fullwidth ASCII, U+FF01-U+FF5E, folds to ASCII by subtracting this offset. */
export const FULLWIDTH_ASCII = Object.freeze({ first: 0xff01, last: 0xff5e, offset: 0xfee0 });

const COMPARISON_CODE_SHAPE = /[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}/;

/**
 * The form a label is compared in: fullwidth ASCII folded to ASCII, every dash and space mapped
 * to "-", and each run of "-" collapsed to one.
 */
export function deviceLabelComparisonForm(label) {
  let form = "";
  for (const character of label) {
    let point = character.codePointAt(0);
    if (point >= FULLWIDTH_ASCII.first && point <= FULLWIDTH_ASCII.last) point -= FULLWIDTH_ASCII.offset;
    const folded = String.fromCodePoint(point);
    if (!DEVICE_LABEL_SEPARATOR.test(folded)) form += folded;
    else if (!form.endsWith("-")) form += "-";
  }
  return form;
}

/** True for a (trimmed) label the approval page must not show. */
export function isMisleadingDeviceLabel(label) {
  return DEVICE_LABEL_REFUSED.test(label) || COMPARISON_CODE_SHAPE.test(deviceLabelComparisonForm(label));
}
