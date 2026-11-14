import barlowCondensed700 from "@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2";
import nunito400 from "@fontsource/nunito/files/nunito-latin-400-normal.woff2";
import nunito600 from "@fontsource/nunito/files/nunito-latin-600-normal.woff2";
import nunito800 from "@fontsource/nunito/files/nunito-latin-800-normal.woff2";

// The view fonts of Figma v11: Nunito for text, Barlow Condensed for buttons. WOFF2 only;
// the build embeds them, so a view needs no external asset (SPEC-013).
const FONTS = [
  ["Nunito", "400", nunito400],
  ["Nunito", "600", nunito600],
  ["Nunito", "800", nunito800],
  ["Barlow Condensed", "700", barlowCondensed700],
] as const;

let loaded = false;

/** Adds the view fonts to the page once. Font faces are page-wide, so shadow DOM sees them. */
export function loadFonts() {
  if (loaded) return;
  loaded = true;
  for (const [family, weight, url] of FONTS)
    document.fonts.add(
      new FontFace(family, `url(${url}) format("woff2")`, { weight, display: "swap" }),
    );
}
