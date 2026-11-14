import { expect, test } from "bun:test";
import { grossAt, type ReduceLine, reduceToFit } from "./reduce.ts";

const line = (id: string, quantity: number, gross: number, current = quantity): ReduceLine => ({
  id,
  quantity,
  gross,
  current,
});

const totalAt = (lines: ReduceLine[], amounts: Map<string, number>, fixedGross = 0) =>
  Math.round(lines.reduce((sum, l) => sum + grossAt(l, amounts.get(l.id) ?? 0), fixedGross));

test("an order already within the limit keeps its amounts", () => {
  const lines = [line("a", 10, 400), line("b", 5, 100)];
  expect(reduceToFit({ lines, fixedGross: 0, limit: 500 })).toEqual(
    new Map([
      ["a", 10],
      ["b", 5],
    ]),
  );
});

test("one line drops to the largest whole amount under the limit", () => {
  // 900 cartons at 1.328 gross each (1195.16) against a 1000 limit.
  const lines = [line("oat", 900, 1195.16)];
  const amounts = reduceToFit({ lines, fixedGross: 0, limit: 1000 });
  expect(amounts?.get("oat")).toBe(753);
  expect(totalAt(lines, amounts ?? new Map())).toBeLessThanOrEqual(1000);
  expect(grossAt(lines[0] ?? line("x", 1, 1), 754)).toBeGreaterThan(1000);
});

test("many lines shrink together and the result fits the gross limit, not the net one", () => {
  const lines = [line("milk", 100, 1627.92), line("flour", 6, 184.68), line("butter", 40, 164.16)];
  const amounts = reduceToFit({ lines, fixedGross: 0, limit: 1700 }) ?? new Map();
  expect(totalAt(lines, amounts)).toBeLessThanOrEqual(1700);
  for (const l of lines) {
    const q = amounts.get(l.id) ?? 0;
    expect(q).toBeGreaterThanOrEqual(1);
    expect(q).toBeLessThanOrEqual(l.quantity);
    expect(Number.isInteger(q)).toBe(true);
  }
});

test("a total exactly at the limit is left as it is", () => {
  const lines = [line("a", 4, 250), line("b", 2, 750)];
  expect(reduceToFit({ lines, fixedGross: 0, limit: 1000 })?.get("a")).toBe(4);
});

test("lines the card cannot change count toward the limit", () => {
  const lines = [line("a", 10, 1000)];
  const amounts = reduceToFit({ lines, fixedGross: 600, limit: 1000 });
  expect(amounts?.get("a")).toBe(4);
});

test("a removed line stays removed and is not counted", () => {
  const lines = [line("a", 10, 1000), line("b", 10, 1000, 0)];
  const amounts = reduceToFit({ lines, fixedGross: 0, limit: 500 });
  expect(amounts?.get("b")).toBe(0);
  expect(amounts?.get("a")).toBe(5);
});

test("no amounts when even one of each is over the limit", () => {
  const lines = [line("a", 2, 800), line("b", 2, 800)];
  expect(reduceToFit({ lines, fixedGross: 0, limit: 500 })).toBeNull();
});
