import { err, ok, type Result } from "@app/kernel";
import { selfBaseUrl } from "@app/server-kit";
import { type ErrorCode, ErrorEnvelopeSchema } from "../errors.ts";
import { ROUTES, type RouteInput, type RouteKey, type RouteOutput } from "../routes.ts";

type Route = (typeof ROUTES)[number];
type RouteOf<K extends RouteKey> = Extract<Route, { key: K }>;

const ROUTE_TIMEOUT_MS = 10_000;

const isRoute =
  <K extends RouteKey>(key: K) =>
  (route: Route): route is RouteOf<K> =>
    route.key === key;

/**
 * Contract schemas are strictObject or looseObject with no transforms or defaults, so a value that passes
 * the output schema equals its parsed output. A plain z.object (which strips keys) or a transform would break that.
 */
const isOutputOf = <K extends RouteKey>(
  route: RouteOf<K>,
  value: unknown,
): value is RouteOutput<K> => route.output.safeParse(value).success;

const upstreamFailed = (key: RouteKey, reason: string) => {
  console.error(`callRoute ${key}: ${reason}`);
  return err("UPSTREAM_FAILED" as const);
};

/** Fills `:name` segments of the path from the input and returns the remaining fields as the body. */
const splitInput = (path: string, input: Record<string, unknown>) => {
  const segments = path.split("/");
  const params = new Set(segments.filter((s) => s.startsWith(":")).map((s) => s.slice(1)));
  const filled = segments.map((segment) => {
    if (!segment.startsWith(":")) return segment;
    const value = input[segment.slice(1)];
    return typeof value === "string" ? encodeURIComponent(value) : null;
  });
  if (filled.includes(null)) return null;
  const body = Object.fromEntries(Object.entries(input).filter(([name]) => !params.has(name)));
  return { path: filled.join("/"), body };
};

/**
 * Calls a route of SPEC-003, validating the input and the 2xx body with the route's schemas.
 * An input that fails the schema returns BAD_REQUEST without sending. A non-2xx with an error envelope
 * returns its code. A network error, timeout, non-JSON body, non-2xx without an envelope, or 2xx body that
 * fails the schema returns UPSTREAM_FAILED. Throws only when PORT and INTERNAL_BASE_URL are both unset.
 */
export const callRoute = async <K extends RouteKey>(
  key: K,
  input: RouteInput<K>,
): Promise<Result<RouteOutput<K>, "UPSTREAM_FAILED" | ErrorCode>> => {
  const route = ROUTES.find(isRoute(key));
  if (route === undefined) throw new Error(`Unknown route key ${key}.`);
  const request = route.input.safeParse(input);
  if (!request.success) return err("BAD_REQUEST");
  const target = splitInput(route.path, { ...request.data });
  if (target === null) return err("BAD_REQUEST");
  // Outside the try: a missing base URL is a deployment bug, not an upstream failure.
  const url = `${selfBaseUrl()}${target.path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: route.method,
      ...(route.method === "GET"
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(target.body) }),
      signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
    });
  } catch (error) {
    return upstreamFailed(key, `request failed: ${String(error)}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return upstreamFailed(key, `answered ${response.status} with a body that is not JSON`);
  }
  if (!response.ok) {
    const envelope = ErrorEnvelopeSchema.safeParse(json);
    return envelope.success
      ? err(envelope.data.error.code)
      : upstreamFailed(key, `answered ${response.status} without an error envelope`);
  }
  return isOutputOf(route, json)
    ? ok(json)
    : upstreamFailed(key, "answered a body that does not match its schema");
};
