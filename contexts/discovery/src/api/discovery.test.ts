import { expect, test } from "bun:test";
import {
  APPROVAL_REASONS,
  ERROR_STATUS,
  GUARDRAILS,
  MODEL_TOOLS,
  OpenApiDocumentSchema,
  PAYMENT_TERMS,
  REJECT_REASONS,
  ROUTES,
  VIEW_TOOLS,
  VIEWS,
} from "@app/contract";
import { discoveryApi, discoveryRoot } from "./index.ts";
import { openApiDocument } from "./openapi.ts";

// Stands in for publicBaseUrl(), which the routes read on every request.
const publicBase = { url: "https://wholesaler.example.test" };
const api = discoveryApi(() => publicBase.url);
const root = discoveryRoot(() => publicBase.url);

const fetchJson = async (
  app: { handle: (request: Request) => Promise<Response> },
  path: string,
) => {
  const response = await app.handle(new Request(`http://localhost${path}`));
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return body;
};

const keysOf = (schema: Record<string, unknown>): string[] => {
  const own =
    typeof schema["properties"] === "object" && schema["properties"] !== null
      ? Object.keys(schema["properties"])
      : [];
  const branches = Array.isArray(schema["oneOf"]) ? schema["oneOf"] : [];
  const nested = branches.flatMap((branch: unknown) =>
    typeof branch === "object" && branch !== null && !Array.isArray(branch)
      ? keysOf(Object.fromEntries(Object.entries(branch)))
      : [],
  );
  return [...new Set([...own, ...nested])].toSorted();
};

test("openapi.json has every /api ROUTES entry with request and response schemas", async () => {
  publicBase.url = "https://wholesaler.example.test";
  const served = OpenApiDocumentSchema.parse(await fetchJson(api, "/discovery/openapi.json"));
  expect(served.openapi).toBe("3.1.0");
  const document = openApiDocument("https://wholesaler.example.test");
  expect(JSON.parse(JSON.stringify(served))).toEqual(JSON.parse(JSON.stringify(document)));

  const apiRoutes = ROUTES.filter((route) => route.path.startsWith("/api/"));
  expect(apiRoutes).toHaveLength(ROUTES.length);
  const operations = Object.values(document.paths).flatMap((methods) => Object.values(methods));
  expect(operations).toHaveLength(apiRoutes.length);

  for (const route of apiRoutes) {
    const path = route.path.replaceAll(/:(\w+)/g, "{$1}");
    const operation = document.paths[path]?.[route.method.toLowerCase()];
    if (operation === undefined) throw new Error(`${route.method} ${path} is missing.`);
    expect(operation.operationId).toBe(route.key);

    // Request: every input field is a path parameter or a body field, never both.
    const pathNames = (operation.parameters ?? []).map((parameter) => parameter.name).toSorted();
    expect(pathNames).toEqual(
      [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1] ?? "").toSorted(),
    );
    const body = operation.requestBody?.content["application/json"].schema ?? {};
    const bodyKeys = keysOf(body);
    expect(bodyKeys.filter((key) => pathNames.includes(key))).toEqual([]);
    const inputKeys = keysOf(Object.fromEntries(Object.entries(route.input.toJSONSchema())));
    expect([...pathNames, ...bodyKeys].toSorted()).toEqual(inputKeys);
    if (route.method === "GET") expect(operation.requestBody).toBeUndefined();

    // Response: the 2xx schema and the error envelope for every error status.
    expect(operation.responses["200"].content["application/json"].schema).toEqual(
      Object.fromEntries(
        Object.entries(route.output.toJSONSchema({ io: "output" })).filter(
          ([key]) => key !== "$schema",
        ),
      ),
    );
    for (const status of new Set(Object.values(ERROR_STATUS))) {
      expect(Object.keys(operation.responses)).toContain(String(status));
    }
  }
});

test("the OpenAPI document marks requote and validate as not implemented, and no other operation", () => {
  const { paths } = openApiDocument("https://x.test");
  const marked = Object.entries(paths).flatMap(([path, methods]) =>
    Object.values(methods)
      .filter((op) => "x-not-implemented" in op)
      .map((op) => [path, op.operationId, op.description]),
  );
  expect(marked).toEqual([
    ["/api/offers/requote", "requote", "Not implemented yet: always answers 501 NOT_IMPLEMENTED."],
    [
      "/api/offers/validate",
      "validate",
      "Not implemented yet: always answers 501 NOT_IMPLEMENTED.",
    ],
  ]);
});

test("the decision body has no orderId and keeps its decision union", () => {
  const operation =
    openApiDocument("https://x.test").paths["/api/orders/{orderId}/decision"]?.["post"];
  const body = operation?.requestBody?.content["application/json"].schema ?? {};
  expect(Array.isArray(body["oneOf"])).toBe(true);
  expect(keysOf(body)).not.toContain("orderId");
  expect(keysOf(body)).toContain("decision");
  expect(JSON.stringify(body)).not.toContain('"orderId"');
});

test("trusted-trade.json lists the SPEC-014 fields with authorization null", async () => {
  publicBase.url = "https://wholesaler.example.test";
  const document = await fetchJson(root, "/.well-known/trusted-trade.json");
  const base = "https://wholesaler.example.test";
  expect(document).toEqual({
    endpoint: base,
    mcp: `${base}/mcp`,
    jwksUri: `${base}/.well-known/jwks.json`,
    openapi: `${base}/api/discovery/openapi.json`,
    skill: `${base}/skills/trusted-trade-ordering/SKILL.md`,
    authorization: null,
    guardrails: GUARDRAILS,
    paymentTerms: [...PAYMENT_TERMS],
    reasonCodes: expect.any(Array),
    tools: { model: [...MODEL_TOOLS], view: [...VIEW_TOOLS] },
    views: JSON.parse(JSON.stringify(VIEWS)),
  });
  const codes = JSON.stringify(document);
  for (const code of [...APPROVAL_REASONS, ...REJECT_REASONS]) expect(codes).toContain(`"${code}"`);
});

test("PUBLIC_BASE_URL changes every URL in the document", async () => {
  for (const expected of ["https://one.example.test", "https://two.example.test/shop"]) {
    publicBase.url = expected;
    const document = await fetchJson(root, "/.well-known/trusted-trade.json");
    const urls = JSON.stringify(document).match(/https?:\/\/[^"]+/g) ?? [];
    expect(urls).toHaveLength(5);
    for (const url of urls) expect(url.startsWith(`${expected}/`) || url === expected).toBe(true);
    const openapi = OpenApiDocumentSchema.parse(await fetchJson(api, "/discovery/openapi.json"));
    expect(openapi["servers"]).toEqual([{ url: expected }]);
  }
});
