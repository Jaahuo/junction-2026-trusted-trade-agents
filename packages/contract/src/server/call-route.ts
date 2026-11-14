import type { Result } from "@app/kernel";
import type { ErrorCode } from "../errors.ts";
import type { RouteInput, RouteKey, RouteOutput } from "../routes.ts";
import { notImplemented } from "./not-implemented.ts";

/** Calls a route of SPEC-003 and validates the request and the response with its schemas. Never throws for a non-2xx response. */
export const callRoute = async <K extends RouteKey>(
  _key: K,
  _input: RouteInput<K>,
): Promise<Result<RouteOutput<K>, "UPSTREAM_FAILED" | ErrorCode>> => notImplemented();
