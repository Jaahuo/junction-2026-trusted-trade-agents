import type { WholesalerLive } from "@app/contract";
import { z } from "zod";
import recording from "./wholesaler-fixture.json";
import { mockWholesaler } from "./wholesaler-mock.ts";

const DAY_MS = 86_400_000;
const NEVER_YEAR = "9999";
const DATE_PREFIX =
  /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const helsinkiDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" });

const RecordingSchema = z.object({
  recordedAt: z.string(),
  calls: z.array(
    z.object({
      path: z.string(),
      request: z.object({ requestedDate: z.string() }),
      response: z.unknown(),
    }),
  ),
});
const RequestSchema = z.object({ requestedDate: z.string() });
const { recordedAt, calls } = RecordingSchema.parse(recording);

/** When the replayed response was recorded, for the startup line that discloses the fixture. */
export const FIXTURE_RECORDED_AT = recordedAt;

const dayIndex = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const fromDayIndex = (index: number): string => new Date(index * DAY_MS).toISOString().slice(0, 10);

/**
 * Moves every date by `days`. A time keeps its local clock time and loses its offset, so the
 * adapter reads it as Europe/Helsinki local time. The year 9999 means "no end" and stays.
 */
const shiftDates = (value: unknown, days: number): unknown => {
  if (typeof value === "string") {
    const match = DATE_PREFIX.exec(value);
    const date = match?.[1];
    if (date === undefined || date.startsWith(NEVER_YEAR)) return value;
    return `${fromDayIndex(dayIndex(date) + days)}${match?.[2] ?? ""}`;
  }
  if (Array.isArray(value)) return value.map((item) => shiftDates(item, days));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shiftDates(item, days)]),
    );
  }
  return value;
};

export interface FixtureWholesalerOptions {
  now?: () => Date;
}

/**
 * Replays one recorded live response (wholesaler-fixture.json) through the mock adapter's mapping.
 * The recording keeps its distance from the clock: its dates move by the days between the
 * recording day and today in Helsinki, so the cutoff stays ahead of now. A request gets the
 * recorded call for the same shifted date, or else the closest earlier one, or else the first.
 */
export const fixtureWholesaler = (options: FixtureWholesalerOptions = {}): WholesalerLive => {
  const recordedDay = dayIndex(helsinkiDate.format(new Date(recordedAt)));
  const now = options.now ?? (() => new Date());

  const replay = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const { requestedDate } = RequestSchema.parse(await request.json());
    const days = dayIndex(helsinkiDate.format(now())) - recordedDay;
    const asRecorded = dayIndex(requestedDate) - days;
    const candidates = calls
      .filter((call) => call.path === path)
      .map((call) => ({ day: dayIndex(call.request.requestedDate), response: call.response }));
    const earlier = candidates
      .filter((call) => call.day <= asRecorded)
      .toSorted((a, b) => b.day - a.day);
    const chosen = earlier[0] ?? candidates[0];
    if (chosen === undefined) return new Response(null, { status: 404 });
    return Response.json(shiftDates(chosen.response, days));
  };

  return mockWholesaler({
    baseUrl: "https://fixture.invalid",
    apiKey: "fixture",
    fetch: Object.assign(replay, { preconnect: fetch.preconnect }),
  });
};
