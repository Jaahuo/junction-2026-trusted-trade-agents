import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_FILES } from "./source.ts";

export const fictionalProducts = [
  {
    id: "fictional-oats",
    salesUnit: "ST",
    baseUnit: "KG",
    category: "PANTRY",
    allowedLotSize: 1,
    countryOfOrigin: "fi",
    units: [{ unitId: "ST", sizeInBaseUnits: 1 }],
    synkkaData: {
      names: [{ value: "Fictional oats", language: "en" }],
      classifications: [{ name: "nutritionalClaim", values: [{ id: "FIBRE" }] }],
      extra: { nested: [1, null, "invented"] },
    },
    custom: { preserved: true },
  },
  {
    id: "fictional-milk",
    salesUnit: "ST",
    baseUnit: "KG",
    category: "DAIRY",
    allowedLotSize: 1,
    units: [{ unitId: "ST", sizeInBaseUnits: 2 }],
    synkkaData: { names: [{ value: "Fictional milk", language: "en" }] },
  },
];

export async function writeFictionalSources(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const files: Record<string, string> = {
    [DATA_FILES.products]: JSON.stringify(fictionalProducts),
    [DATA_FILES.schema]: JSON.stringify({
      type: "array",
      items: {
        type: "object",
        required: ["id", "synkkaData"],
        properties: { id: { type: "string" }, synkkaData: { type: "object" } },
      },
    }),
    [DATA_FILES.reliability]:
      "productId,deliveryReliability\nfictional-oats,0.95\nfictional-milk,\norphan,0.5\n,\n",
    [DATA_FILES.co2]: "productId,AVG kg CO2-eq/kg\nfictional-oats,1.25\nfictional-milk,2\n",
    [DATA_FILES.demo]: JSON.stringify({
      observedAt: "2026-11-14T08:00:00Z",
      requestedDate: "2026-11-16",
      s1: { productId: "fictional-oats", quantity: { value: 1, unit: "KGM" } },
      s2: { productId: "fictional-milk", quantity: { value: 2, unit: "KGM" } },
      s3: null,
      late: null,
      triedForS3: [],
    }),
  };
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(join(dir, name), contents)),
  );
}

export const failureOf = (operation: Promise<unknown>): Promise<string | null> =>
  operation.then(
    () => null,
    (error: unknown) => String(error),
  );
