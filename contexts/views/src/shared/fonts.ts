import barlowCondensed400 from "@app/ui/fonts/barlow-condensed-latin-400-normal.woff2";
import barlowCondensed600 from "@app/ui/fonts/barlow-condensed-latin-600-normal.woff2";
import barlowCondensed700 from "@app/ui/fonts/barlow-condensed-latin-700-normal.woff2";
import barlowCondensed800 from "@app/ui/fonts/barlow-condensed-latin-800-normal.woff2";
import nunito400 from "@app/ui/fonts/nunito-latin-400-normal.woff2";
import nunito600 from "@app/ui/fonts/nunito-latin-600-normal.woff2";
import nunito700 from "@app/ui/fonts/nunito-latin-700-normal.woff2";
import nunito800 from "@app/ui/fonts/nunito-latin-800-normal.woff2";

const FONTS = [
  ["Nunito", "400", nunito400],
  ["Nunito", "600", nunito600],
  ["Nunito", "700", nunito700],
  ["Nunito", "800", nunito800],
  ["Barlow Condensed", "400", barlowCondensed400],
  ["Barlow Condensed", "600", barlowCondensed600],
  ["Barlow Condensed", "700", barlowCondensed700],
  ["Barlow Condensed", "800", barlowCondensed800],
] as const;

let loaded = false;

/** Adds the brand fonts to the page once; does nothing without a DOM (tests, server). */
export function loadFonts() {
  if (loaded || typeof document === "undefined") return;
  loaded = true;
  for (const [family, weight, url] of FONTS)
    document.fonts.add(
      new FontFace(family, `url(${url}) format("woff2")`, { weight, display: "swap" }),
    );
}
