import butter from "./images/butter.jpg";
import cream2dl from "./images/cream-2dl.jpg";
import cream from "./images/cream.jpg";
import eggs from "./images/eggs.jpg";
import flour from "./images/flour.jpg";
import green from "./images/green.jpg";
import milk from "./images/milk.jpg";
import oat from "./images/oat.jpg";
import rice from "./images/rice.jpg";

// The AI-made placeholder images of Figma (Screens › "Product images (AI placeholders)"),
// matched by product type until the catalog has real product images. First match wins.
const IMAGES: [RegExp, string][] = [
  [/\beggs?\b|kananmun/i, eggs],
  [/butter|\bvoi\b/i, butter],
  [/flour|jauho/i, flour],
  [/\brice\b|riisi/i, rice],
  [/\boat\b|kaura/i, oat],
  [/(cream|kerma).*\b(2 dl|200 ml)/i, cream2dl],
  [/cream|kerma/i, cream],
  [/milk|maito/i, milk],
  [/drink|juice|mehu|juoma/i, green],
];

/** The placeholder image for a product name, or null when no type matches (no image slot). */
export const productImage = (name: string) =>
  IMAGES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
