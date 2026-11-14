import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DemoProductsSchema } from "@app/contract";
import { z } from "zod";
import { RawProductSchema } from "./projection.ts";

export const DATA_FILES = {
  products: "valio_aimo_junction26_product_data.json",
  schema: "valio_aimo_junction26_product_data_schema.json",
  reliability: "valio_aimo_junction26_delivery_reliability.csv",
  co2: "valio_aimo_junction26_carbon_footprint.csv",
  demo: "demo-products.json",
} as const;

const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const decode = (file: Buffer): string => new TextDecoder("utf-8", { fatal: true }).decode(file);

function assertSafeNumbers(value: unknown): void {
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new Error("Catalogue contains an unsafe number");
  if (Array.isArray(value)) {
    for (const item of value) assertSafeNumbers(item);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) assertSafeNumbers(item);
  }
}
async function checkedDirectory(sourceDir: string): Promise<string> {
  if (!isAbsolute(sourceDir)) throw new Error("Catalogue source directory must be absolute");
  const dir = await realpath(sourceDir);
  for (let parent = dir; ; parent = dirname(parent)) {
    try {
      await lstat(join(parent, ".git"));
      throw new Error("Catalogue source directory must be outside Git");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (dirname(parent) === parent) break;
  }
  return dir;
}

function parseCsv(text: string, header: string[], range: { min: number; max: number }): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else cell += c;
    } else if (c === '"' && cell === "" && !closed) quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
      closed = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      closed = false;
    } else {
      if (closed || c === '"') throw new Error("Malformed CSV quoting");
      cell += c;
    }
  }
  if (quoted) throw new Error("Malformed CSV quoting");
  if (row.length || cell !== "" || closed) {
    row.push(cell);
    rows.push(row);
  }
  if (JSON.stringify(rows.shift()) !== JSON.stringify(header))
    throw new Error("Invalid CSV header");
  const seen = new Set<string>();
  for (const cells of rows) {
    if (cells.length !== 2) throw new Error("Invalid CSV row width");
    const [id, raw] = cells;
    if (id === undefined || raw === undefined) throw new Error("Invalid CSV row");
    if (id !== "") {
      if (seen.has(id)) throw new Error(`Duplicate CSV product ID: ${id}`);
      seen.add(id);
    } else if (raw.trim() !== "") throw new Error("CSV value without product ID");
    if (raw.trim() !== "") {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < range.min || value > range.max)
        throw new Error("Invalid CSV value");
    }
  }
  return rows;
}

export async function readSource(sourceDir: string) {
  const dir = await checkedDirectory(sourceDir);
  const entries = await Promise.all(
    Object.entries(DATA_FILES).map(async ([key, name]) => {
      const path = join(dir, name);
      try {
        const target = await realpath(path);
        if (!inside(dir, target)) throw new Error(`Source file escapes directory: ${name}`);
        return [key, await readFile(target)] as const;
      } catch (error) {
        if (key === "demo" && isMissing(error)) return [key, null] as const;
        throw error;
      }
    }),
  );
  const files = Object.fromEntries(entries);
  const required = (key: Exclude<keyof typeof DATA_FILES, "demo">) => {
    const file = files[key];
    if (file === null || file === undefined) throw new Error(`Missing ${DATA_FILES[key]}`);
    return decode(file);
  };
  const sourceSchema = z.record(z.string(), z.unknown()).parse(JSON.parse(required("schema")));
  assertSafeNumbers(sourceSchema);
  const records: unknown = JSON.parse(required("products"));
  assertSafeNumbers(records);
  z.fromJSONSchema(sourceSchema).parse(records);
  if (!Array.isArray(records) || records.length === 0) throw new Error("No catalogue products");
  const ids = new Set<string>();
  const productRows = records.map((record: unknown, ordinal: number) => {
    const parsed = RawProductSchema.parse(record);
    if (parsed.id.trim() === "") throw new Error("Empty product ID");
    if (ids.has(parsed.id)) throw new Error(`Duplicate product ID: ${parsed.id}`);
    ids.add(parsed.id);
    return { ordinal, productId: parsed.id, record };
  });
  const reliability = parseCsv(required("reliability"), ["productId", "deliveryReliability"], {
    min: 0,
    max: 1,
  });
  const co2 = parseCsv(required("co2"), ["productId", "AVG kg CO2-eq/kg"], {
    min: 0,
    max: Infinity,
  });
  const demoFile = files["demo"];
  const demoProducts =
    demoFile === null || demoFile === undefined
      ? null
      : DemoProductsSchema.parse(JSON.parse(decode(demoFile)));
  const checksums = Object.fromEntries(
    entries.map(([key, data]) => [
      key,
      data === null ? null : createHash("sha256").update(data).digest("hex"),
    ]),
  );
  const counts = { products: productRows.length, reliability: reliability.length, co2: co2.length };
  return { productRows, reliability, co2, sourceSchema, demoProducts, checksums, counts };
}
