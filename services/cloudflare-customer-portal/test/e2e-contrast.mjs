// Shared WCAG relative-luminance / contrast-ratio math for e2e visual-contrast assertions (D5): the
// e2e tests parse a getComputedStyle() rgb()/rgba() string and compute the contrast ratio themselves,
// per https://www.w3.org/TR/WCAG21/#dfn-relative-luminance -- no third-party contrast library.

export function parseRgb(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value ?? "");
  if (!match) throw new Error(`Not an rgb()/rgba() colour: ${String(value)}`);
  const [r, g, b] = match[1].split(",").slice(0, 3).map((part) => parseFloat(part.trim()));
  return [r, g, b];
}

function relativeLuminance([r, g, b]) {
  const [rl, gl, bl] = [r, g, b].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

// Ratio of the lighter to the darker relative luminance, WCAG-style: (L1 + 0.05) / (L2 + 0.05).
export function contrastRatio(rgbA, rgbB) {
  const [lighter, darker] = [relativeLuminance(rgbA), relativeLuminance(rgbB)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}
