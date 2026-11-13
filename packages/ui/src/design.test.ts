import { expect, test } from "bun:test";
import * as ui from "./index.ts";

const design = await Bun.file(`${import.meta.dir}/../../../DESIGN.md`).text();
const theme = await Bun.file(`${import.meta.dir}/theme.css`).text();

const rows = design
  .split("\n")
  .filter((line) => line.startsWith("|"))
  .map((line) => line.split("|").map((cell) => cell.trim()));
const hasRow = (...cells: string[]): boolean =>
  rows.some((row) => cells.every((cell, index) => row[index + 1] === `\`${cell}\``));

test("DESIGN.md lists every theme token with its current value", () => {
  const tokens = [...theme.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map(
    ([, name = "", value = ""]) => ({ name, value }),
  );

  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens.filter(({ name, value }) => !hasRow(name, value))).toEqual([]);
});

test("DESIGN.md documents every component the kit exports", () => {
  expect(Object.keys(ui).filter((name) => !hasRow(name))).toEqual([]);
});
