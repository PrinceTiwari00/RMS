/**
 * Time helpers.
 *
 * The restaurant runs on Asia/Kathmandu wall-clock time regardless of the host
 * server's TZ, and the business day rolls over at 04:00 so a late-night ticket
 * still lands on the day it was opened. All timestamps written to the database
 * are local-zone `YYYY-MM-DD HH:MM:SS` strings produced here — SQL `datetime()`
 * defaults are UTC and are only ever a fallback.
 */

export const TZ = process.env.RMS_TZ ?? "Asia/Kathmandu";

/** Hour (0-23) at which the previous business day ends. */
export const BUSINESS_DAY_ROLLOVER_HOUR = 4;

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hour12: false,
});

export interface ZonedTime {
  /** YYYY-MM-DD in the restaurant's timezone */
  date: string;
  /** HH:MM:SS */
  time: string;
  /** YYYY-MM-DD HH:MM:SS — the canonical storage format */
  stamp: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
  weekdayShort: string;
  /** The business date this instant belongs to (rolls over at 04:00). */
  businessDate: string;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zoned(at: Date = new Date()): ZonedTime {
  const parts = partsFormatter.formatToParts(at);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayShort = read("weekday");
  let hour = Number(read("hour"));
  if (hour === 24) hour = 0; // Intl can emit "24" for midnight in some locales
  const year = Number(read("year"));
  const month = Number(read("month"));
  const day = Number(read("day"));
  const date = `${year}-${pad(month)}-${pad(day)}`;
  const time = `${pad(hour)}:${read("minute")}:${read("second")}`;
  return {
    date,
    time,
    stamp: `${date} ${time}`,
    year,
    month,
    day,
    hour,
    minute: Number(read("minute")),
    second: Number(read("second")),
    weekday: WEEKDAY_INDEX[weekdayShort] ?? 0,
    weekdayShort,
    businessDate: hour < BUSINESS_DAY_ROLLOVER_HOUR ? shiftDate(date, -1) : date,
  };
}

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function nowStamp(): string {
  return zoned().stamp;
}

export function today(): string {
  return zoned().date;
}

/** The business date to stamp transactions with right now. */
export function businessDateNow(): string {
  return zoned().businessDate;
}

/** Add (or subtract) days to a YYYY-MM-DD string, staying in calendar space. */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const reference = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  reference.setUTCDate(reference.getUTCDate() + days);
  return reference.toISOString().slice(0, 10);
}

/** Parse a stored local stamp into a comparable epoch. Same-zone only. */
export function stampToEpoch(stamp: string | null | undefined): number | null {
  if (!stamp) return null;
  const normalized = stamp.includes("T") ? stamp.replace("T", " ").slice(0, 19) : stamp.slice(0, 19);
  const epoch = Date.parse(`${normalized.replace(" ", "T")}Z`);
  return Number.isNaN(epoch) ? null : epoch;
}

export function elapsedMinutes(fromStamp: string | null | undefined, at: Date = new Date()): number {
  const start = stampToEpoch(fromStamp);
  if (start === null) return 0;
  const end = Date.parse(`${zoned(at).stamp.replace(" ", "T")}Z`);
  return Math.max(0, Math.round((end - start) / 60000));
}

export function elapsedLabel(fromStamp: string | null | undefined, at: Date = new Date()): string {
  const minutes = elapsedMinutes(fromStamp, at);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

export function formatClock(stamp: string | null | undefined): string {
  if (!stamp) return "--:--";
  const normalized = stamp.includes("T") ? stamp.replace("T", " ") : stamp;
  return normalized.slice(11, 16) || "--:--";
}

export function formatDay(date: string | null | undefined): string {
  if (!date) return "—";
  const normalized = date.length > 10 ? date.slice(0, 10) : date;
  const [year, month, day] = normalized.split("-").map(Number);
  const reference = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  return reference.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

export function weekdayName(index: number): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][index % 7];
}

/** Sunday-based start of week, matching the Nepali working week. */
export function startOfWeek(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const reference = new Date(Date.UTC(year, month - 1, day));
  return shiftDate(date, -reference.getUTCDay());
}

/** Seven consecutive YYYY-MM-DD dates starting at `from`. */
export function weekDates(from: string): string[] {
  return Array.from({ length: 7 }, (_, index) => shiftDate(from, index));
}

/** Inclusive list of dates between two YYYY-MM-DD strings. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard < 400) {
    out.push(cursor);
    cursor = shiftDate(cursor, 1);
    guard += 1;
  }
  return out;
}

/** "HH:MM" arithmetic helper used by the scheduler. */
export function minutesFromClock(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

export function clockFromMinutes(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/** Combine a date and an "HH:MM" clock into a full stamp. */
export function atClock(date: string, clock: string): string {
  return `${date} ${clock.length === 5 ? `${clock}:00` : clock}`;
}
