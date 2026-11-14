import { ok, type Result } from "@app/kernel";
import type { Principal } from "../account.ts";
import { DEMO_ACCOUNT } from "../demo.ts";

/** First build (SPEC-002): every request acts as the demo account. */
export const principalOf = async (
  _headers: Headers,
): Promise<Result<Principal, "NOT_AUTHENTICATED">> => ok(DEMO_ACCOUNT);
