import {
  FREE_FROM_DATA,
  type FreeFromData,
  type HardConstraint,
  type MatchState,
  type SearchResult,
} from "@app/contract";

export type Constraints = SearchResult["constraints"];

const ANIMAL_ALLERGENS = (
  [
    "beef",
    "chicken",
    "crustaceans",
    "egg",
    "fish",
    "lactose",
    "milk",
    "molluscs",
    "pollock",
    "pork",
    "shellfish",
    "tuna",
  ] as const
).map((attribute) => FREE_FROM_DATA[attribute].allergen);

/**
 * Contradiction wins: an allergy is never confirmed against a CONTAINS or MAY_CONTAIN fact of the
 * allergen or of one it includes (wheat for gluten). Only the allergen's own code or claim confirms.
 */
const freeFrom = (
  { allergen, includes = [], claim, low }: FreeFromData,
  claims: ReadonlySet<string>,
): MatchState => {
  const has = (code: string | undefined) => code !== undefined && claims.has(code);
  const present = (code: string) => has(`CONTAINS:${code}`) || has(`MAY_CONTAIN:${code}`);
  if (has(low) || (allergen !== undefined && [allergen, ...includes].some(present)))
    return "contradicted";
  return has(claim) || has(`FREE_FROM:${allergen}`) ? "confirmed" : "unknown";
};

/** Traces (MAY_CONTAIN) do not make a product non-vegan. */
const vegan = (claims: ReadonlySet<string>): MatchState => {
  if (ANIMAL_ALLERGENS.some((code) => claims.has(`CONTAINS:${code}`))) return "contradicted";
  return claims.has("VEGAN") ? "confirmed" : "unknown";
};

/** The match per hard constraint attribute. Missing data is `unknown`, never `confirmed`. */
export const matchHard = (
  claims: ReadonlySet<string>,
  hard: readonly HardConstraint[],
): Record<string, MatchState> =>
  Object.fromEntries(
    hard.map(({ attribute }) => [
      attribute,
      attribute === "vegan" ? vegan(claims) : freeFrom(FREE_FROM_DATA[attribute], claims),
    ]),
  );

export const isContradicted = (match: Record<string, MatchState>): boolean =>
  Object.values(match).includes("contradicted");

const union = <T>(first: readonly T[], second: readonly T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return [...first, ...second].filter((item) => {
    const itemKey = key(item);
    if (seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
};

const hardKey = (constraint: Constraints["hard"][number]) =>
  `${constraint.attribute}|${constraint.is}`;
const softKey = (constraint: Constraints["soft"][number]) =>
  `${constraint.attribute}|${constraint.prefer.toLowerCase()}`;

/** hard = request ∪ standing, soft = request ∪ standing; soft preferences compare case-insensitively. */
export const mergeConstraints = (
  request: Constraints,
  standing: Constraints | null,
): Constraints => ({
  hard: union(request.hard, standing?.hard ?? [], hardKey),
  soft: union(request.soft, standing?.soft ?? [], softKey),
});
