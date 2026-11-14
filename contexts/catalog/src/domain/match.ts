import type { MatchState, SearchResult } from "@app/contract";

export type Constraints = SearchResult["constraints"];

type Rule = (is: string, claims: ReadonlySet<string>) => MatchState;

const lactose: Rule = (is, claims) => {
  if (is !== "free_from") return "unknown";
  if (claims.has("LOW_LACTOSE")) return "contradicted";
  return claims.has("FREE_FROM_LACTOSE") ? "confirmed" : "unknown";
};

const RULES = new Map<string, Rule>([["lactose", lactose]]);

/** The match per hard constraint attribute. Missing data or an attribute without a rule is `unknown`, never `confirmed`. */
export const matchHard = (
  claims: ReadonlySet<string>,
  hard: readonly { attribute: string; is: string }[],
): Record<string, MatchState> =>
  Object.fromEntries(
    hard.map(({ attribute, is }) => [attribute, RULES.get(attribute)?.(is, claims) ?? "unknown"]),
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
