type Decimal = { coefficient: bigint; scale: number };

const maxCount = BigInt(Number.MAX_SAFE_INTEGER);

function decimal(value: number): Decimal {
  const [mantissa = "", exponent = "0"] = value.toString().split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  return { coefficient: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
}

function ratio(value: number, divisors: readonly number[]): [bigint, bigint] {
  const source = decimal(value);
  let numerator = source.coefficient;
  let denominator = 1n;
  let scale = source.scale;
  for (const divisor of divisors) {
    const part = decimal(divisor);
    denominator *= part.coefficient;
    scale -= part.scale;
  }
  if (scale > 0) denominator *= 10n ** BigInt(scale);
  else numerator *= 10n ** BigInt(-scale);
  return [numerator, denominator];
}

// Compare decimal ratios exactly so floating-point division cannot hide fractional lots.
export function lotCount(
  value: number,
  divisors: readonly number[],
  mode: "floor" | "ceil" | "whole",
): bigint | null {
  const [numerator, denominator] = ratio(value, divisors);
  if (numerator > maxCount * denominator) return null;
  const floor = numerator / denominator;
  const remainder = numerator % denominator;
  const nearest = remainder * 2n < denominator ? floor : floor + 1n;
  const distance = nearest === floor ? remainder : denominator - remainder;
  const magnitude = numerator > denominator ? numerator : denominator;
  const normalized =
    (nearest > 0n || numerator === 0n) &&
    distance * 1000000000n <= denominator &&
    distance * (1n << 50n) <= magnitude;
  if (normalized) return nearest <= maxCount ? nearest : null;
  if (mode === "whole") return null;
  const count = mode === "floor" || remainder === 0n ? floor : floor + 1n;
  return count <= maxCount ? count : null;
}

export function lotProduct(count: bigint, factors: readonly number[]): number | null {
  let coefficient = count;
  let scale = 0;
  for (const factor of factors) {
    const part = decimal(factor);
    coefficient *= part.coefficient;
    scale += part.scale;
  }
  const value = Number(`${coefficient}e${-scale}`);
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) return null;
  const represented = decimal(value);
  const difference = scale - represented.scale;
  const exact =
    difference >= 0
      ? coefficient === represented.coefficient * 10n ** BigInt(difference)
      : coefficient * 10n ** BigInt(-difference) === represented.coefficient;
  return exact ? value : null;
}
