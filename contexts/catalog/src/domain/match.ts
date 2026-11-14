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

const union = <T>(first: readonly T[], second: readonly T[]): T[] => {
  const seen = new Set<string>();
  return [...first, ...second].filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** hard = request ∪ standing, soft = request ∪ standing. */
export const mergeConstraints = (request: Constraints, standing: Constraints | null): Constraints =>
  standing === null
    ? { hard: union(request.hard, []), soft: union(request.soft, []) }
    : { hard: union(request.hard, standing.hard), soft: union(request.soft, standing.soft) };
