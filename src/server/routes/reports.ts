/**
 * Analytics routes — executive dashboard, product mix and end-of-day Z-report.
 *
 * Closing a day is gated behind `reports.zreport` and refuses to run while any
 * ticket is still open, so the frozen payload always describes a complete day.
 */
import { route, badRequest } from "@/server/router";
import {
  buildZReport,
  closeBusinessDay,
  DENOMINATIONS,
  ensureBusinessDay,
  expectedDrawer,
  executiveReport,
  getBusinessDay,
  getBusinessDays,
  getZReport,
  pmixReport,
  rangePresets,
  reopenBusinessDay,
} from "@/server/reports";
import { arr, num, q, qInt, str } from "@/server/coerce";
import { businessDateNow, shiftDate, today } from "@/domain/time";
import { getSettings } from "@/server/settings";

/** Resolve a preset id or an explicit from/to pair. */
function resolveRange(query: URLSearchParams): { from: string; to: string; preset: string } {
  const preset = q(query, "range");
  const match = rangePresets().find((candidate) => candidate.id === preset);
  if (match) return { from: match.from, to: match.to, preset: match.id };
  return { from: q(query, "from", shiftDate(today(), -6)), to: q(query, "to", today()), preset: "custom" };
}

route("GET", "reports/ranges", null, () => ({ ranges: rangePresets(), today: today() }));

route("GET", "reports/executive", "reports.executive", ({ query }) => {
  const { from, to, preset } = resolveRange(query);
  const report = executiveReport(from, to);
  return { preset, report, days: getBusinessDays(qInt(query, "days", 14)) };
});

route("GET", "reports/pmix", "reports.pmix", ({ query }) => {
  const { from, to, preset } = resolveRange(query);
  return { preset, report: pmixReport(from, to) };
});

/** A single day's numbers, for the trend strip on the executive dashboard. */
route("GET", "reports/days", "reports.executive", ({ query }) => ({
  days: getBusinessDays(qInt(query, "limit", 30)),
  current: getBusinessDay(businessDateNow()),
}));

// -------------------------------------------------------------------- Z-report
route("GET", "reports/zreport", "reports.zreport", ({ query }) => {
  const date = q(query, "date", businessDateNow());
  const settings = getSettings();
  return {
    date,
    report: getZReport(date),
    denominations: DENOMINATIONS,
    drawer: expectedDrawer(date),
    day: getBusinessDay(date),
    float: settings.cashFloat,
    previousDays: getBusinessDays(qInt(query, "history", 14)).filter((day) => day.businessDate !== date),
  };
});

/** Live preview of the report before it is frozen — no writes. */
route("GET", "reports/zreport/preview", "reports.zreport", ({ query }) => ({
  report: buildZReport(q(query, "date", businessDateNow())),
}));

route("POST", "reports/zreport/close", "reports.zreport", ({ body, user }) => {
  const date = str(body, "date", businessDateNow());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("Date must be YYYY-MM-DD");
  const counts = arr(body, "counts").map((entry) => {
    const row = entry as Record<string, unknown>;
    return { denomination: String(row.denomination ?? ""), counted: Number(row.counted ?? 0) };
  });
  return { report: closeBusinessDay(date, { counts, notes: str(body, "notes") }, user) };
});

/** Reopen a closed day — clears the frozen payload so it can be signed off again. */
route("POST", "reports/zreport/reopen", "reports.zreport", ({ body, user }) => {
  const date = str(body, "date", businessDateNow());
  reopenBusinessDay(date, user);
  return { report: getZReport(date), day: getBusinessDay(date) };
});

/** Open the till for a date (idempotent) and report the float in use. */
route("POST", "reports/day/open", "reports.zreport", ({ body, user }) => {
  const date = str(body, "date", businessDateNow());
  const day = ensureBusinessDay(date, user);
  return { day: getBusinessDay(date), openingFloat: day.opening_float };
});

/** Reconciliation helper: counted drawer value from a denomination sheet. */
route("POST", "reports/drawer/count", "reports.zreport", ({ body }) => {
  const counted = arr(body, "counts").reduce<number>((total, entry) => {
    const row = entry as Record<string, unknown>;
    const denomination = DENOMINATIONS.find((candidate) => candidate.label === String(row.denomination ?? ""));
    if (!denomination) throw badRequest(`Unknown denomination "${String(row.denomination ?? "")}"`);
    const notes = Math.max(0, Math.round(Number(row.counted ?? 0)));
    if (!Number.isFinite(notes)) throw badRequest("Note count must be a number");
    return total + notes * denomination.value;
  }, 0);
  const expected = num(body, "expected", 0);
  return { counted, expected, variance: counted - expected, denominations: DENOMINATIONS };
});
