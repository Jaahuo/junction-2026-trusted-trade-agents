const helsinkiParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Helsinki",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

const helsinkiOffsetMinutes = (instantMs: number): number => {
  const parts: Record<string, number> = {};
  for (const part of helsinkiParts.formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts["year"] ?? 0,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
};

const formatOffset = (minutes: number): string => {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
};

/** The earlier instant wins in an overlap. */
const helsinkiOffset = (localMs: number): string => {
  const match = [180, 120].find(
    (minutes) => helsinkiOffsetMinutes(localMs - minutes * 60_000) === minutes,
  );
  return formatOffset(match ?? helsinkiOffsetMinutes(localMs - 120 * 60_000));
};

const TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** ISO 8601 with offset; offsetless times are Helsinki local time. */
export const toHelsinkiTime = (value: string, dateOnly: string | null): string | null => {
  const match = TIME_PATTERN.exec(value.trim());
  const date = match?.[1];
  if (date === undefined) return null;
  const hm = match?.[2];
  if (hm === undefined && dateOnly === null) return null;
  const time = hm === undefined ? (dateOnly ?? "") : `${hm}:${match?.[3] ?? "00"}`;
  const withSeconds = time.length === 5 ? `${time}:00` : time;
  const offset =
    hm === undefined ? undefined : match?.[4]?.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const local = `${date}T${withSeconds}`;
  const localMs = Date.parse(`${local}Z`);
  if (Number.isNaN(localMs)) return null;
  return `${local}${offset ?? helsinkiOffset(localMs)}`;
};

/** Move an instant by calendar days, preserving its Helsinki wall clock time. */
export const shiftHelsinkiDays = (instant: string, days: number): string => {
  const ms = Date.parse(instant);
  const local = new Date(ms + helsinkiOffsetMinutes(ms) * 60_000 + days * 86_400_000)
    .toISOString()
    .slice(0, -1);
  return toHelsinkiTime(local, null) ?? instant;
};
