import type { Result } from "@app/kernel";
import type { Mandate } from "../mandate.ts";
import { notImplemented } from "./not-implemented.ts";

/** ES256 compact JWS, typ "mandate+jwt". */
export const signMandate = async (_m: Mandate, _key: JsonWebKey): Promise<string> =>
  notImplemented();

export const verifyMandate = async (
  _jws: string,
  _key: JsonWebKey,
): Promise<Result<Mandate, "MANDATE_INVALID">> => notImplemented();
