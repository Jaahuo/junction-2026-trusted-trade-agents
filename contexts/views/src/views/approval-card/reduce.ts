/** One line the card can change: its offered amount and gross total, and its amount now. */
export type ReduceLine = { id: string; quantity: number; gross: number; current: number };

/** A line's gross total at `q` sales units, estimated the way the card shows it. */
export function grossAt(line: ReduceLine, q: number) {
  return q === line.quantity ? line.gross : Math.round((line.gross / line.quantity) * q);
}

const totalOf = (lines: ReduceLine[], amounts: Map<string, number>, fixedGross: number) =>
  Math.round(lines.reduce((sum, l) => sum + grossAt(l, amounts.get(l.id) ?? 0), fixedGross));

/**
 * Whole sales-unit amounts that bring the gross total to the limit or under it, for the
 * "Reduce to fit" button. Rule: scale every line by limit / total (rounded down), then take one
 * unit at a time from the line with the largest gross total until the order fits. A line keeps
 * at least 1 and never grows; a removed line (0) stays removed. `fixedGross` is the gross total
 * of the lines the card cannot change. Null when even one of each is over the limit.
 */
export function reduceToFit({
  lines,
  fixedGross,
  limit,
}: {
  lines: ReduceLine[];
  fixedGross: number;
  limit: number;
}): Map<string, number> | null {
  const amounts = new Map(lines.map((l) => [l.id, l.current]));
  const total = totalOf(lines, amounts, fixedGross);
  if (total <= limit) return amounts;
  const factor = (limit - fixedGross) / (total - fixedGross);
  for (const l of lines)
    if (l.current > 0) amounts.set(l.id, Math.max(1, Math.floor(l.current * factor)));
  while (totalOf(lines, amounts, fixedGross) > limit) {
    const largest = lines
      .filter((l) => (amounts.get(l.id) ?? 0) > 1)
      .toSorted(
        (a, b) => grossAt(b, amounts.get(b.id) ?? 0) - grossAt(a, amounts.get(a.id) ?? 0),
      )[0];
    if (largest === undefined) return null;
    amounts.set(largest.id, (amounts.get(largest.id) ?? 0) - 1);
  }
  return amounts;
}
