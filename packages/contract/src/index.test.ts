import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { z } from "zod";
import * as contract from "./index.ts";
import {
  APPROVAL_REASONS,
  AUDIT_EVENTS,
  DEMO_ACCOUNT,
  DraftMandateRequestSchema,
  ERROR_CODES,
  fixtures,
  MODEL_TOOLS,
  ORDER_STATUSES,
  OrderSchema,
  PAYMENT_TERMS,
  PlaceOrderRequestSchema,
  REASON_TEXT,
  REJECT_REASONS,
  MandateDraftSchema,
  ROUTES,
  SearchRequestSchema,
  TOOL_INPUT,
  TOOL_OUTPUT,
  VIEW_TOOLS,
  VIEWS,
} from "./index.ts";

const spec = await Bun.file(resolve(import.meta.dir, "../../../docs/specs.md")).text();
const exported: Record<string, unknown> = { ...contract };

const schemaNamed = (name: string): z.ZodType => {
  const value = exported[name];
  if (!(value instanceof z.ZodType)) throw new Error(`${name} is not an exported zod schema`);
  return value;
};

/** The quoted strings of `export const <name> = [ ... ]` in docs/specs.md. */
const specList = (name: string): string[] => {
  const block = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(spec)?.[1];
  if (block === undefined) throw new Error(`docs/specs.md has no list ${name}`);
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
};

/** Parses a JavaScript object literal from docs/specs.md as JSON. */
const literal = (source: string): unknown =>
  JSON.parse(
    source
      .replace(/ as const;?\s*(\/\/.*)?$/, "")
      .replaceAll(/([{,\s])(\w+):/g, '$1"$2":')
      .replaceAll(/,(\s*[}\]])/g, "$1"),
  );

/** `key: Name` pairs inside `export const <name> = { ... }` in docs/specs.md. */
const specRecord = (name: string): Record<string, string> => {
  const block = new RegExp(`export const ${name} = \\{([^}]*)\\}`).exec(spec)?.[1];
  if (block === undefined) throw new Error(`docs/specs.md has no record ${name}`);
  return Object.fromEntries(
    [...block.matchAll(/(\w+): (\w+)/g)].map((match) => [match[1] ?? "", match[2] ?? ""]),
  );
};

const routeTable = (): {
  key: string;
  tool: string | null;
  method: string;
  path: string;
  context: string;
  output: string;
}[] => {
  const start = spec.indexOf("| Key ");
  const rows = spec.slice(start).split("\n").slice(2);
  const end = rows.findIndex((row) => !row.startsWith("|"));
  return rows.slice(0, end).map((row) => {
    const cells = row.split("|").map((cell) => cell.trim());
    const [method = "", path = ""] = (cells[3] ?? "").split(" ");
    const response = (cells[6] ?? "").split("→")[1]?.trim() ?? "";
    return {
      key: cells[1] ?? "",
      tool: cells[2] === "—" ? null : (cells[2] ?? null),
      method,
      path,
      context: cells[4] ?? "",
      output: /(?:\d{3} )?(\w+)/.exec(response)?.[1] ?? "",
    };
  });
};

const same = (actual: unknown, expected: unknown): void => {
  expect(actual).toEqual(expected);
};

const tools = [...MODEL_TOOLS, ...VIEW_TOOLS].toSorted();
const reasonCodes = [...APPROVAL_REASONS, ...REJECT_REASONS];

test("every fixture parses with its schema", () => {
  for (const [name, value] of Object.entries(fixtures)) {
    const schemaName = `${name.charAt(0).toUpperCase()}${name.slice(1)}Schema`;
    const result = schemaNamed(schemaName).safeParse(value);
    expect({ name, issues: result.error?.issues ?? [] }).toEqual({ name, issues: [] });
  }
});

test("MODEL_TOOLS, VIEW_TOOLS, PAYMENT_TERMS, ORDER_STATUSES, reason lists, AUDIT_EVENTS, ROUTES, VIEWS equal docs/specs.md", () => {
  same(MODEL_TOOLS, specList("MODEL_TOOLS"));
  same(VIEW_TOOLS, specList("VIEW_TOOLS"));
  same(PAYMENT_TERMS, specList("PAYMENT_TERMS"));
  same(ERROR_CODES, specList("ERROR_CODES"));
  same(ORDER_STATUSES, specList("ORDER_STATUSES"));
  same(APPROVAL_REASONS, specList("APPROVAL_REASONS"));
  same(REJECT_REASONS, specList("REJECT_REASONS"));
  same(AUDIT_EVENTS, specList("AUDIT_EVENTS"));
  const table = routeTable();
  expect(table).toHaveLength(17);
  same(
    ROUTES.map(({ key, tool, method, path, context, output }) => ({
      key,
      tool,
      method,
      path,
      context,
      output: output === contract.OpenApiDocumentSchema ? "OpenAPI" : output,
    })),
    table.map(({ key, tool, method, path, context, output }) => ({
      key,
      tool,
      method,
      path,
      context,
      output: output === "OpenAPI" ? "OpenAPI" : schemaNamed(`${output}Schema`),
    })),
  );
  const views = /export const VIEWS = (\[[\s\S]*?\] as const;)/.exec(spec)?.[1] ?? "";
  same(VIEWS, literal(views));
});

test("TOOL_INPUT and TOOL_OUTPUT have one schema per tool and every TOOL_INPUT schema is an object", () => {
  expect(Object.keys(TOOL_INPUT).toSorted()).toEqual(tools);
  expect(Object.keys(TOOL_OUTPUT).toSorted()).toEqual(tools);
  for (const [map, values] of [
    ["TOOL_INPUT", TOOL_INPUT],
    ["TOOL_OUTPUT", TOOL_OUTPUT],
  ] as const) {
    const expected = specRecord(map);
    for (const [tool, schema] of Object.entries(values)) {
      expect({ map, tool, same: schema === schemaNamed(expected[tool] ?? "") }).toEqual({
        map,
        tool,
        same: true,
      });
    }
  }
  for (const [tool, schema] of Object.entries(TOOL_INPUT)) {
    expect({ tool, type: z.toJSONSchema(schema).type }).toEqual({ tool, type: "object" });
  }
  for (const route of ROUTES) {
    if (route.tool !== null) expect(TOOL_OUTPUT[route.tool]).toBe(route.output);
  }
});

test("REASON_TEXT covers every reason code", () => {
  expect(Object.keys(REASON_TEXT).toSorted()).toEqual(reasonCodes.toSorted());
  for (const code of reasonCodes) expect(REASON_TEXT[code]).toMatch(/^[A-Z].*\.$/);
});

test("OrderSchema and PlaceOrderRequestSchema reject an unknown key such as status", () => {
  expect(OrderSchema.safeParse({ ...fixtures.order, extra: true }).success).toBe(false);
  expect(
    PlaceOrderRequestSchema.safeParse({ ...fixtures.placeOrderRequest, status: "placed" }).success,
  ).toBe(false);
  expect(PlaceOrderRequestSchema.safeParse(fixtures.placeOrderRequest).success).toBe(true);
});

test("a mandate draft takes the register body without operationId and has the current mandate or null", () => {
  const { operationId: _operationId, ...draft } = fixtures.registerMandateRequest;
  expect(DraftMandateRequestSchema.safeParse(draft).success).toBe(true);
  expect(DraftMandateRequestSchema.safeParse(fixtures.registerMandateRequest).success).toBe(false);
  expect(DraftMandateRequestSchema.safeParse({ ...draft, mandateId: "mnd_1" }).success).toBe(false);
  expect(MandateDraftSchema.safeParse({ draft, current: null }).success).toBe(true);
  expect(MandateDraftSchema.safeParse({ draft }).success).toBe(false);
  expect(MandateDraftSchema.safeParse({ ...fixtures.mandateDraft, registered: true }).success).toBe(
    false,
  );
});

test("DEMO_ACCOUNT equals the SPEC-015 values", () => {
  const source = /- `DEMO_ACCOUNT`: `(\{[^`]*\})`/.exec(spec)?.[1] ?? "";
  same(DEMO_ACCOUNT, literal(source));
});

const refusal = (hard: unknown) =>
  SearchRequestSchema.safeParse({ ...fixtures.searchRequest, hard }).error?.issues[0]?.message;

describe("hard constraints (SPEC-003, SPEC-004)", () => {
  test("an unsupported attribute or value is refused", () => {
    const request = fixtures.searchRequest;
    expect(SearchRequestSchema.safeParse(request).success).toBe(true);
    for (const hard of [
      [{ attribute: "gluten", is: "free_from" }],
      [{ attribute: "vegan", is: "yes" }],
    ]) {
      expect(SearchRequestSchema.safeParse({ ...request, hard }).success).toBe(true);
    }
    for (const hard of [
      [{ attribute: "unicorn", is: "free_from" }],
      [{ attribute: "Gluten", is: "free_from" }],
      [{ attribute: "AW", is: "free_from" }],
      [{ attribute: "lactose", is: "low" }],
      [{ attribute: "vegan", is: "free_from" }],
    ]) {
      expect(SearchRequestSchema.safeParse({ ...request, hard }).success).toBe(false);
    }
  });

  test("the refusal names the attribute, or says it is missing", () => {
    expect(refusal([{ attribute: "unicorn", is: "free_from" }])).toContain('"unicorn"');
    expect(refusal([{ is: "free_from" }])).toContain('"missing"');
  });

  test("empty terms are refused", () => {
    expect(SearchRequestSchema.safeParse({ ...fixtures.searchRequest, terms: [] }).success).toBe(
      false,
    );
  });
});
