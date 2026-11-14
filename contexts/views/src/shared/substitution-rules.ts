import type { StoredMandate, SubstitutionRule } from "@app/contract";
import { callAction, type Source, type ViewState } from "./bridge.ts";

/**
 * Registers the current mandate again with its substitution rules changed by `change`, keeping
 * every other term and the expiry. Reads the mandate first, so a newer version is not rolled
 * back; a mandate that is not active gives the error state.
 */
export async function saveRules(
  source: Source,
  change: (rules: SubstitutionRule[]) => SubstitutionRule[],
): Promise<ViewState<StoredMandate>> {
  const current = await callAction(source, "get_mandate", {}, null);
  if (current.kind !== "done") return current;
  if (current.data.status !== "active")
    return { kind: "error", message: "The mandate is not active.", plainUrl: null };
  const { limits, standingConstraints, exp } = current.data.mandate;
  return callAction(
    source,
    "register_mandate",
    {
      limits: { ...limits, substitutionRules: change(limits.substitutionRules ?? []) },
      standingConstraints,
      exp,
    },
    null,
  );
}
