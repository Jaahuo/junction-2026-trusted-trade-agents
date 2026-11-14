import {
  type OfferClaims,
  OfferClaimsSchema,
  type OmitReason,
  type RequoteRequest,
} from "@app/contract";
import { err, ok } from "@app/kernel";
import type { RequotePort } from "../application/ports.ts";
import { mount } from "./test-support.ts";

export const claimsOf = (token: string): OfferClaims => {
  const payload = token.split(".")[1] ?? "";
  return OfferClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
};

export const cents = (value: number) => Math.round(value * 100) / 100;

type Sign = (changes?: Partial<OfferClaims>, exp?: Date) => Promise<string>;

/**
 * Stands in for the offers context's requote route: a fresh signed offer per token, valid for ten
 * minutes from the orders clock, with the quantity and date changes applied and the total scaled
 * to the new amount, under `mandate` when set (the real route signs under the current mandate).
 * `omit` leaves products out with a reason (or with no omitted entry when the reason is null);
 * `price` scales every unit price and `priceOf` one product's; `fail` makes the call fail; `reuse`
 * answers with the token it was given; `broken` sends a token that fails verification; `ignore`
 * leaves the asked amount or date unapplied.
 */
const fakeOffers = (sign: Sign, clock: { now: Date }) => {
  const calls: RequoteRequest[] = [];
  const state = {
    omit: new Map<string, OmitReason | null>(),
    fail: false,
    reuse: false,
    broken: false,
    ignore: null as "quantity" | "deliverBy" | null,
    price: 1,
    priceOf: new Map<string, number>(),
    mandate: null as { mandateId: string; version: number } | null,
  };
  const port: RequotePort = {
    requote: async (request) => {
      calls.push(request);
      if (state.fail) return err("UPSTREAM_FAILED");
      const offers = [];
      const omitted = [];
      for (const token of request.tokens) {
        const { iat: _iat, exp: _exp, offerId: _offerId, ...claims } = claimsOf(token);
        if (state.omit.has(claims.productId)) {
          const reason = state.omit.get(claims.productId) ?? null;
          if (reason !== null)
            omitted.push({ productId: claims.productId, reason, detail: `test ${reason}` });
          continue;
        }
        const change = request.changes?.find((entry) => entry.productId === claims.productId);
        const quantity =
          state.ignore === "quantity" ? claims.quantity : (change?.quantity ?? claims.quantity);
        const requestedDate =
          state.ignore === "deliverBy"
            ? claims.requestedDate
            : (change?.deliverBy ?? claims.requestedDate);
        const price = state.price * (state.priceOf.get(claims.productId) ?? 1);
        const ratio = (quantity.value / claims.quantity.value) * price;
        const fresh = state.reuse
          ? token
          : await sign(
              {
                ...claims,
                quantity,
                requestedDate,
                unitPrice: { ...claims.unitPrice, net: cents(claims.unitPrice.net * price) },
                total: {
                  net: cents(claims.total.net * ratio),
                  gross: cents(claims.total.gross * ratio),
                },
                ...(state.mandate === null
                  ? {}
                  : { mandateId: state.mandate.mandateId, mandateVersion: state.mandate.version }),
              },
              new Date(clock.now.getTime() + 10 * 60_000),
            );
        const freshClaims = claimsOf(fresh);
        offers.push({
          offerId: freshClaims.offerId,
          token: state.broken ? `${fresh.split(".").slice(0, 2).join(".")}.broken` : fresh,
          claims: freshClaims,
          precheck: null,
          rank: null,
          comparison: null,
        });
      }
      return ok({ offers, omitted });
    },
  };
  return { port, calls, state };
};

export const mountWithOffers = async (db: Parameters<typeof mount>[0]) => {
  const mounted = await mount(db);
  const offers = fakeOffers(mounted.sign, mounted.clock);
  return { ...mounted, offers, app: mounted.appWith({ offers: offers.port }) };
};
