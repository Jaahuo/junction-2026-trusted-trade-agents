import { parseResult, type Source, viewEntry } from "../../shared/bridge.ts";
import { isNoCurrentMandate } from "./presentation.ts";

export async function loadMandate(source: Source, retry = false) {
  try {
    const result = retry ? await source.call("get_mandate", {}) : await source.load();
    return parseResult(viewEntry("mandate-settings"), result);
  } catch (error) {
    return isNoCurrentMandate(error)
      ? { kind: "empty" as const }
      : { kind: "error" as const, message: "Could not load the limits.", plainUrl: null };
  }
}
