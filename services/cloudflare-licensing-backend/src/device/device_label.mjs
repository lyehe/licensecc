// The device-label rule. The approval page shows the app-supplied device label beside the real
// comparison code, so a label must not hold a character that renders as nothing or breaks or
// reorders text, and its UTS #39 skeleton must not hold anything shaped like the skeleton of a
// comparison code, so look-alike characters in any script cannot spell one either.
//
// This module is the single source of the rule. The backend applies it at registration, and
// scripts/generate-device-label-table.mjs derives the native client's code-point table
// (src/library/device_identity/bound_label_table.hpp) from these same property escapes and from the
// committed confusables subset in device_label_confusables.mjs, so the app refuses the same labels
// before it sends one. Worker-safe: it imports only that generated data module.
import { DEVICE_LABEL_CODE_SKELETONS, DEVICE_LABEL_CONFUSABLES } from "./device_label_confusables.mjs";

/** Controls, format characters (bidi controls included), line and paragraph separators, and
 *  default-ignorable code points such as variation selectors, fillers and tag characters. */
export const DEVICE_LABEL_REFUSED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** Dashes and spaces, any of which could separate the groups of a comparison code. */
export const DEVICE_LABEL_SEPARATOR = /[\p{Pd}\p{Zs}]/u;

/** Fullwidth ASCII, U+FF01-U+FF5E, folds to ASCII by subtracting this offset. */
export const FULLWIDTH_ASCII = Object.freeze({ first: 0xff01, last: 0xff5e, offset: 0xfee0 });

/** Each code point whose Unicode confusable prototype (UTS #39) is the skeleton of a
 *  comparison-code character, mapped to that skeleton's code point. 0 maps to O and 1 to l. */
const SKELETON_FOLD = new Map();
for (const [skeleton, points] of Object.entries(DEVICE_LABEL_CONFUSABLES)) {
  for (const point of points) SKELETON_FOLD.set(point, skeleton.codePointAt(0));
}

/** The skeletons of the comparison-code digits and letters [0-9A-Fa-f]: O, l, 2-9, A-F and a-f.
 *  The generator guarantees each is one ASCII letter or digit. */
const CODE_SKELETON = `[${[...new Set(Object.entries(DEVICE_LABEL_CODE_SKELETONS)
  .filter(([character]) => character !== "-").map(([, skeleton]) => skeleton))].join("")}]`;

/** Three groups of four code skeletons joined by "-": the skeleton of XXXX-XXXX-XXXX in hex digits. */
const COMPARISON_CODE_SHAPE = new RegExp(`${CODE_SKELETON}{4}-${CODE_SKELETON}{4}-${CODE_SKELETON}{4}`, "u");

/**
 * The form a label is compared in, its skeleton as far as a comparison code goes: fullwidth ASCII
 * folded to ASCII, each code point whose confusable prototype is the skeleton of a comparison-code
 * character folded to that skeleton, every dash and space mapped to "-", and each run of "-"
 * collapsed to one.
 */
export function deviceLabelComparisonForm(label) {
  let form = "";
  for (const character of label) {
    let point = character.codePointAt(0);
    if (point >= FULLWIDTH_ASCII.first && point <= FULLWIDTH_ASCII.last) point -= FULLWIDTH_ASCII.offset;
    point = SKELETON_FOLD.get(point) ?? point;
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
