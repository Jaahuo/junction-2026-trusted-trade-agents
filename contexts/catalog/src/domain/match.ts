import {
  FREE_FROM_DATA,
  type HardConstraint,
  type MatchState,
  type SearchResult,
} from "@app/contract";

export type Constraints = SearchResult["constraints"];

/** GS1 allergen codes of animal origin: crustaceans, eggs, fish, milk, beef, chicken, lactose, pork, molluscs, shellfish, tuna, pollock. */
const ANIMAL_ALLERGENS = ["AC", "AE", "AF", "AM", "BF", "CM", "ML", "PO", "UM", "UN", "ABD", "ADQ"];

type Data = { allergen?: string; claim?: string; low?: string };

/** Contradiction wins: an allergy is never confirmed against a CONTAINS or MAY_CONTAIN fact. */
const freeFrom = ({ allergen, claim, low }: Data, claims: ReadonlySet<string>): MatchState => {
  const has = (code: string | undefined) => code !== undefined && claims.has(code);
  if (has(low) || has(`CONTAINS:${allergen}`) || has(`MAY_CONTAIN:${allergen}`))
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
