import { ERROR_STATUS, ErrorEnvelopeSchema, ROUTES } from "@app/contract";

type JsonObject = Record<string, unknown>;
type Route = (typeof ROUTES)[number];

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutDialect = ({ $schema: _dialect, ...schema }: JsonObject): JsonObject => schema;

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

/** Removes the path parameters from an object schema and from each branch of a union. */
const withoutProperties = (schema: JsonObject, names: readonly string[]): JsonObject => {
  const result: JsonObject = { ...schema };
  if (isObject(schema["properties"])) {
    result["properties"] = Object.fromEntries(
      Object.entries(schema["properties"]).filter(([name]) => !names.includes(name)),
    );
  }
  if (Array.isArray(schema["required"])) {
    result["required"] = schema["required"].filter(
      (name: unknown) => typeof name !== "string" || !names.includes(name),
    );
  }
  for (const key of COMBINATORS) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      result[key] = branches.map((branch: unknown) =>
        isObject(branch) ? withoutProperties(branch, names) : branch,
      );
    }
  }
  return result;
};

const hasBody = (schema: JsonObject): boolean =>
  COMBINATORS.some((key) => key in schema) ||
  (isObject(schema["properties"]) && Object.keys(schema["properties"]).length > 0);

const pathParams = (path: string): string[] =>
  [...path.matchAll(/:([A-Za-z]\w*)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

const json = (schema: JsonObject) => ({ "application/json": { schema } });

const errorStatuses = [...new Set(Object.values(ERROR_STATUS))].toSorted((a, b) => a - b);

const errorResponses = Object.fromEntries(
  errorStatuses.map((status) => [
    String(status),
    {
      description: "Error envelope.",
      content: json({ $ref: "#/components/schemas/ErrorEnvelope" }),
    },
  ]),
);

const operation = (route: Route) => {
  const params = pathParams(route.path);
  const body = withoutProperties(withoutDialect(route.input.toJSONSchema({ io: "input" })), params);
  return {
    operationId: route.key,
    ...(route.tool === null ? {} : { "x-mcp-tool": route.tool }),
    tags: [route.context],
    ...(params.length === 0
      ? {}
      : {
          parameters: params.map((name) => ({
            name,
            in: "path",
            required: true,
            schema: { type: "string" },
          })),
        }),
    ...(hasBody(body) ? { requestBody: { required: true, content: json(body) } } : {}),
    responses: {
      "200": {
        description: "Success.",
        content: json(withoutDialect(route.output.toJSONSchema({ io: "output" }))),
      },
      ...errorResponses,
    },
  };
};

/** OpenAPI 3.1 for every `/api` route of `ROUTES` (SPEC-014). Paths are relative to `baseUrl`. */
export const openApiDocument = (baseUrl: string) => {
  const paths: Record<string, Record<string, ReturnType<typeof operation>>> = {};
  for (const route of ROUTES) {
    if (!route.path.startsWith("/api/")) continue;
    const path = route.path.replaceAll(/:([A-Za-z]\w*)/g, "{$1}");
    paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation(route) };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Trusted Trade Agents",
      version: "1.0.0",
      description:
        "Open ordering contract for buyer agents: search, signed offers, mandates and orders. The first build has no authentication.",
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      schemas: {
        ErrorEnvelope: withoutDialect(ErrorEnvelopeSchema.toJSONSchema({ io: "output" })),
      },
    },
  };
};
