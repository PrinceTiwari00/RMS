/**
 * Labour maths.
 *
 *   Gross Pay       = (Reg Hrs × Rate) + (OT Hrs × Rate × 1.5)
 *   Total Labour    = Gross Pay × 1.18            (taxes + benefits burden)
 *   Labour Cost %   = Total Labour / Gross Sales   (healthy band: 25–35%)
 *
 * The hourly rate is copied from the role into each time entry at clock-in, so a
 * future wage change never rewrites history.
 */
import { stampToEpoch } from "./time";

export const BURDEN_FACTOR = 1.18;
export const OVERTIME_MULTIPLIER = 1.5;
export const DAILY_OT_THRESHOLD_HRS = 8;

/**
 * Healthy labour-cost band. The widely quoted 25–35% benchmark assumes a US
 * wage floor; Nepali restaurants carry a much lower one, so a well-run store
 * here lands nearer 15–22%. The band is a business setting
 * (`labor_target_min` / `labor_target_max`) and this is only the default.
 */
export const LABOR_TARGET = { min: 15, max: 22 };

/** Wall-clock hours between two local stamps, minus an unpaid break. */
export function shiftHours(startsAt: string, endsAt: string, breakMinutes = 0): number {
  const start = stampToEpoch(startsAt);
  const end = stampToEpoch(endsAt);
  if (start === null || end === null) return 0;
  const hours = (end - start) / 3_600_000 - (breakMinutes || 0) / 60;
  return Math.max(0, round4(hours));
}

export function splitHours(hours: number, threshold = DAILY_OT_THRESHOLD_HRS): { regular: number; overtime: number } {
  const regular = Math.min(hours, threshold);
  return { regular: round4(regular), overtime: round4(Math.max(0, hours - threshold)) };
}

/** Gross pay in paisa. `hourlyRate` is paisa per hour. */
export function grossPay(regularHours: number, overtimeHours: number, hourlyRate: number): number {
  return Math.round(
    regularHours * hourlyRate + overtimeHours * hourlyRate * OVERTIME_MULTIPLIER,
  );
}

export function totalLaborCost(grossPaisa: number): number {
  return Math.round(grossPaisa * BURDEN_FACTOR);
}

export function laborCostPercent(totalLaborPaisa: number, grossSalesPaisa: number): number {
  if (!grossSalesPaisa) return 0;
  return round2((totalLaborPaisa / grossSalesPaisa) * 100);
}

export type LaborHealth = "under" | "target" | "over";

export function laborHealth(
  percent: number,
  target: { min: number; max: number } = LABOR_TARGET,
): LaborHealth {
  if (percent < target.min) return "under";
  if (percent > target.max) return "over";
  return "target";
}

/** Sales needed to bring an over-target labour spend back inside the band. */
export function salesToReachTarget(totalLaborPaisa: number, targetPercent = LABOR_TARGET.max): number {
  if (!targetPercent) return 0;
  return Math.round((totalLaborPaisa / targetPercent) * 100);
}

/** Scheduled hours for a published week, used to plan coverage against forecast. */
export function scheduledHours(shifts: { starts_at: string; ends_at: string; break_minutes: number }[]): number {
  return round4(
    shifts.reduce((total, shift) => total + shiftHours(shift.starts_at, shift.ends_at, shift.break_minutes), 0),
  );
}

/** Sales per labour hour — the single most-used productivity KPI on the floor. */
export function salesPerLaborHour(salesPaisa: number, laborHours: number): number {
  if (!laborHours) return 0;
  return round2(salesPaisa / 100 / laborHours);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
