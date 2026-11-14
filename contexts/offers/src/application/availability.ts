import type { AvailabilityRequest, AvailabilityResult, Principal } from "@app/contract";
import { err, ok, type Result } from "@app/kernel";
import { isDeliverableBy } from "../domain/offer-rules.ts";
import type { OffersDeps } from "./ports.ts";

/** The requested products that can be delivered on or before the date, from one live availability read (SPEC-006). */
export async function deliverableBy(
  deps: Pick<OffersDeps, "live" | "now">,
  principal: Principal,
  req: AvailabilityRequest,
): Promise<Result<AvailabilityResult, "UPSTREAM_FAILED">> {
  if (deps.live === null) return err("UPSTREAM_FAILED");
  const productIds = [...new Set(req.productIds)];
  const read = await deps.live.getAvailability({
    customer: principal.customer,
    requestedDate: req.deliverBy,
    productIds,
  });
  if (!read.ok) return read;
  const quotes = new Map(read.value.quotes.map((quote) => [quote.productId, quote]));
  const now = deps.now();
  return ok({
    deliverable: productIds.filter((id) => isDeliverableBy(quotes.get(id), req.deliverBy, now)),
  });
}
