"use client";

/**
 * Screen 19 — Executive Financial Dashboard.
 *
 * An owner reads this screen to answer one question: is the restaurant making
 * money, and if not, which of the two controllable costs is eating it? So prime
 * cost is the headline, not gross sales — food cost and labour cost are shown
 * against their target bands rather than as raw numbers, because a percentage
 * only means something next to the range it should sit in.
 *
 * Every figure is compared with the equivalent previous period, so a good month
 * is distinguishable from a merely busy one.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useLiveEvents, usePoll, useStore } from "@/lib/store";
import { RangePicker, rangeQuery } from "@/components/RangePicker";
import {
  BarList,
  Card,
  Chip,
  ColumnChart,
  Donut,
  Empty,
  Icon,
  LineChart,
  Meter,
  Stat,
} from "@/components/ui";
import { formatMoney, formatMoneyShort, formatQuantity } from "@/domain/money";
import { formatDay } from "@/domain/time";
import { LABOR_TARGET } from "@/domain/labor";
import type {
  BusinessDay,
  ExecutiveReport,
  GuestReviewInfo,
  KdsMetrics,
  Metrics,
  OrderSnapshot,
  SalesPoint,
  ServiceRequestInfo,
} from "@/types";

interface ExecutiveResponse {
  preset: string;
  report: ExecutiveReport;
  days: BusinessDay[];
}

interface OverviewResponse {
  metrics: Metrics;
  pendingQrOrders: OrderSnapshot[];
  serviceRequests: ServiceRequestInfo[];
  kds: KdsMetrics;
  reviews: GuestReviewInfo[];
}

const CHANNEL_TONES: Record<string, string> = {
  dine_in: "var(--color-brand-500)",
  takeout: "var(--color-ember-500)",
  delivery: "var(--color-info)",
  qr: "var(--color-warn)",
};

export default function ExecutivePage() {
  const { state } = useStore();
  const [preset, setPreset] = useState("7d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const query = rangeQuery(preset, from, to);
  const { data } = usePoll<ExecutiveResponse>(`reports/executive?${query}`, { interval: 30000 });
  const { data: overview, reload: reloadOverview } = usePoll<OverviewResponse>("overview", { interval: 4000 });

  useLiveEvents(
    (ev) => {
      if (
        ev.type === "floor.updated" ||
        ev.type === "order.updated" ||
        ev.type === "kds.updated" ||
        ev.type === "help.updated" ||
        ev.type === "review.created"
      ) {
        void reloadOverview();
      }
    },
    { enabled: Boolean(state?.tenant) },
  );

  const report = data?.report;
  const days = data?.days ?? [];

  const salesSeries = useMemo(
    () => (report?.series ?? []).map((point: SalesPoint) => ({ label: point.label, value: point.netSales })),
    [report],
  );
  const laborSeries = useMemo(
    () => (report?.series ?? []).map((point: SalesPoint) => ({ label: point.label, value: point.laborPercent })),
    [report],
  );
  const hourSeries = useMemo(
    () => (report?.hourOfDay ?? []).map((entry) => ({ label: `${String(entry.hour).padStart(2, "0")}h`, value: entry.sales })),
    [report],
  );

  if (!report) {
    return (
      <div className="p-6">
        <Empty title="Crunching the numbers…" hint="The executive report aggregates every closed check in range." icon="chart" />
      </div>
    );
  }

  const { kpis, previous } = report;
  const netDelta = percentChange(kpis.netSales, previous.netSales);
  const checkDelta = percentChange(kpis.checks, previous.checks);
  const avgDelta = percentChange(kpis.averageCheck, previous.averageCheck);
  const laborDelta = kpis.laborPercent - previous.laborPercent;
  const foodDelta = kpis.foodCostPercent - previous.foodCostPercent;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[19px] font-extrabold text-ink">Executive Dashboard & Live Overview</h1>
          <p className="text-[12px] text-ink-faint">
            {report.range.label} · {formatDay(report.range.from)} → {formatDay(report.range.to)} · {report.range.days} day
            {report.range.days === 1 ? "" : "s"}
          </p>
        </div>
        <div className="ml-auto">
          <RangePicker
            preset={preset}
            from={from}
            to={to}
            onChange={(next) => {
              setPreset(next.preset);
              setFrom(next.from);
              setTo(next.to);
            }}
          />
        </div>
      </div>

      {/* --------------------------------------------------- 10 Overview Live Strip */}
      {overview && (
        <Card className="border-brand-200 bg-gradient-to-br from-paper-raised to-brand-50/40">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-black uppercase tracking-wider text-brand-600">Live Operations Overview</p>
              <p className="text-xs text-ink-soft">Real-time floor, kitchen, QR queue, and guest satisfaction</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={overview.metrics.floorHealth === "ALL TABLES OK" ? "ok" : "ember"} dot>
                {overview.metrics.floorHealth}
              </Chip>
              <Link href="/floor" className="btn btn-soft !py-1 !text-xs">Live Floor →</Link>
              <Link href="/kds/all" className="btn btn-soft !py-1 !text-xs">KDS All →</Link>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-xl border border-rule bg-paper-raised p-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Floor Occupancy</p>
              <p className="tnum mt-1 text-2xl font-black text-ink">
                {overview.metrics.occupiedTables}/{overview.metrics.totalTables}
              </p>
              <p className="text-[11px] text-ink-soft">{overview.metrics.occupancy}% occupied</p>
            </div>
            <div className="rounded-xl border border-rule bg-paper-raised p-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Total Orders Today</p>
              <p className="tnum mt-1 text-2xl font-black text-ink">
                {overview.metrics.checksToday + overview.metrics.openOrders + overview.metrics.sentOrders}
              </p>
              <p className="text-[11px] text-ink-soft">
                {overview.metrics.sentOrders + overview.metrics.openOrders} active · {overview.pendingQrOrders.length} QR awaiting
              </p>
            </div>
            <div className="rounded-xl border border-rule bg-paper-raised p-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Live Sales Today</p>
              <p className="tnum mt-1 text-2xl font-black text-brand-600">
                {formatMoneyShort(overview.metrics.salesToday)}
              </p>
              <p className="text-[11px] text-ink-soft">{overview.metrics.checksToday} settled checks</p>
            </div>
            <div className="rounded-xl border border-rule bg-paper-raised p-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Guest Rating & Help</p>
              <p className="tnum mt-1 text-2xl font-black text-ink">
                {(overview.metrics.reviewCount ?? 0) > 0 ? `${overview.metrics.avgReviewRating} ★` : "—"}
              </p>
              <p className="text-[11px] text-ink-soft">
                {overview.metrics.reviewCount ?? 0} reviews · {overview.serviceRequests.length} active help calls
              </p>
            </div>
          </div>

          {overview.reviews.length > 0 && (
            <div className="mt-3 border-t border-rule pt-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-ink-faint">Recent Guest Feedback</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {overview.reviews.slice(0, 4).map((rev) => (
                  <div key={rev.id} className="rounded-xl border border-rule bg-paper-raised p-2.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-ink">{rev.tableLabel || rev.guestName || "Guest"}</span>
                      <span className="font-black text-ember-500">{"★".repeat(rev.rating)}</span>
                    </div>
                    {rev.tags.length > 0 && (
                      <p className="mt-1 truncate text-[10px] font-semibold text-brand-600">{rev.tags.join(" · ")}</p>
                    )}
                    {rev.comment && <p className="mt-1 line-clamp-2 text-[11px] text-ink-soft">“{rev.comment}”</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ------------------------------------------------------------------ KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Net sales" value={kpis.netSales} compact delta={netDelta} sub={`${report.range.days} days`} tone="brand" />
        <Stat label="Checks" value={kpis.checks} delta={checkDelta} sub={`${formatQuantity(kpis.guests, 0)} guests served`} tone="info" />
        <Stat label="Average check" value={kpis.averageCheck} delta={avgDelta} sub={`${formatQuantity(kpis.coversPerDay, 1)} covers/day`} tone="neutral" />
        <Stat
          label="Sales per labour hour"
          value={kpis.salesPerLaborHour}
          compact
          sub={`${formatQuantity(kpis.laborHours, 1)} hours worked`}
          tone={kpis.salesPerLaborHour > 0 ? "ok" : "neutral"}
        />
      </div>

      {/* ---------------------------------------------------------- prime cost */}
      <Card
        title="Prime cost — the two numbers you control"
        icon="chart"
        subtitle="Food plus labour as a share of net sales. Under 60% is a healthy kitchen."
        action={
          <PrimeBadge percent={kpis.primeCostPercent} />
        }
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <CostGauge
            label="Food cost"
            percent={kpis.foodCostPercent}
            amount={kpis.foodCost}
            target={{ min: 28, max: 34 }}
            delta={foodDelta}
            hint="Ingredient cost from live BOMs, not a guess."
          />
          <CostGauge
            label="Labour cost"
            percent={kpis.laborPercent}
            amount={kpis.laborCost}
            target={{ min: LABOR_TARGET.min, max: LABOR_TARGET.max }}
            delta={laborDelta}
            hint={`Target band ${LABOR_TARGET.min}–${LABOR_TARGET.max}%. Includes overtime at 1.5×.`}
          />
          <div className="rounded-xl border-2 border-rule bg-paper px-3 py-2.5">
            <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Prime cost</p>
            <p className="tnum mt-1 text-3xl font-black leading-none text-ink">{kpis.primeCostPercent.toFixed(1)}%</p>
            <p className="tnum mt-1 text-[13px] font-bold text-ink-soft">{formatMoney(kpis.primeCost)}</p>
            <Meter
              value={kpis.primeCostPercent}
              max={100}
              tone={kpis.primeCostPercent > 65 ? "var(--color-late)" : kpis.primeCostPercent > 60 ? "var(--color-warn)" : "var(--color-ok)"}
            />
            <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
              {kpis.primeCostPercent <= 60
                ? "Comfortably inside the 60% ceiling — margin is intact."
                : kpis.primeCostPercent <= 65
                  ? "Above the 60% ceiling. Check portioning and the schedule before it hardens."
                  : "Well over target. Every rupee of sales is leaving less behind."}
            </p>
            <dl className="mt-2 space-y-1 border-t border-rule pt-2 text-[11px]">
              <Row label="Gross sales" value={formatMoney(kpis.grossSales)} />
              <Row label="Discounts given" value={`− ${formatMoney(kpis.discounts)}`} tone="var(--color-late)" />
              <Row label={`Voids (${kpis.voids})`} value={`− ${formatMoney(kpis.voidAmount)}`} tone="var(--color-late)" />
              <Row label="VAT collected" value={formatMoney(kpis.vat)} />
              <Row label="Service charge" value={formatMoney(kpis.serviceCharge)} />
              <Row label="Tips to staff" value={formatMoney(kpis.tips)} tone="var(--color-ok)" />
            </dl>
          </div>
        </div>

        {kpis.laborHealth !== "target" && (
          <p
            className="mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] font-semibold"
            style={{
              background: kpis.laborHealth === "over" ? "var(--color-late-soft)" : "var(--color-warn-soft)",
              color: kpis.laborHealth === "over" ? "#96271a" : "#8a5d10",
            }}
          >
            <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
            {kpis.laborHealth === "over"
              ? `Labour is running ${kpis.laborPercent.toFixed(1)}% against a ${LABOR_TARGET.max}% ceiling — the schedule is carrying more hours than the sales support.`
              : `Labour is only ${kpis.laborPercent.toFixed(1)}% of sales. That reads as efficiency, but check you are not understaffed at peak.`}
          </p>
        )}
      </Card>

      {/* --------------------------------------------------------------- trends */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Net sales by business day" icon="chart" subtitle="Closed days only — an open day is excluded so the trend is not diluted.">
          {salesSeries.length === 0 ? (
            <Empty title="No closed business days in range" icon="chart" />
          ) : (
            <LineChart points={salesSeries} height={190} format={(value) => formatMoneyShort(value)} />
          )}
        </Card>

        <Card title="Labour % by day" icon="schedule" subtitle={`Target ${LABOR_TARGET.min}–${LABOR_TARGET.max}%`}>
          {laborSeries.length === 0 ? (
            <Empty title="No labour data" icon="schedule" />
          ) : (
            <LineChart
              points={laborSeries}
              height={190}
              tone={kpis.laborHealth === "over" ? "var(--color-late)" : "var(--color-brand-500)"}
              format={(value) => `${value.toFixed(1)}%`}
            />
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Sales by hour" icon="clock" subtitle="Where the day actually peaks — use it to shape the rota.">
          {hourSeries.length === 0 ? (
            <Empty title="No hourly data" icon="clock" />
          ) : (
            <ColumnChart points={hourSeries} height={170} format={(value) => formatMoneyShort(value)} />
          )}
        </Card>

        <Card title="Channel mix" icon="pos" subtitle="How guests are reaching you.">
          {report.channelMix.length === 0 ? (
            <Empty title="No channel data" icon="pos" />
          ) : (
            <div className="flex flex-col items-center gap-3">
              <Donut
                segments={report.channelMix.map((entry) => ({
                  label: entry.label,
                  value: entry.sales,
                  tone: CHANNEL_TONES[entry.channel] ?? "var(--color-ink-faint)",
                }))}
                centre={formatMoneyShort(kpis.netSales)}
                sub="net"
                size={168}
              />
              <ul className="w-full space-y-1">
                {report.channelMix.map((entry) => (
                  <li key={entry.channel} className="flex items-center gap-2 text-[12px]">
                    <span className="size-2.5 rounded-full" style={{ background: CHANNEL_TONES[entry.channel] ?? "var(--color-ink-faint)" }} />
                    <span className="flex-1 truncate font-semibold text-ink-soft">{entry.label}</span>
                    <span className="tnum text-ink-faint">{entry.checks} checks</span>
                    <span className="tnum w-14 text-right font-bold text-ink">{entry.percent.toFixed(0)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card title="Tender mix" icon="cash" subtitle="Cash exposure drives the drawer count at close.">
          {report.tenderMix.length === 0 ? (
            <Empty title="No tender data" icon="cash" />
          ) : (
            <BarList
              rows={report.tenderMix.map((entry) => ({
                label: entry.label,
                value: entry.amount,
                meta: `${entry.count} · ${entry.percent.toFixed(0)}%`,
              }))}
              format={(value) => formatMoneyShort(value)}
            />
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top sellers by revenue" icon="star" subtitle="Cross-reference with the product mix to see whether they actually earn.">
          {report.topItems.length === 0 ? (
            <Empty title="No item sales in range" icon="star" />
          ) : (
            <BarList
              rows={report.topItems.map((item) => ({
                label: item.name,
                value: item.revenue,
                meta: `${formatQuantity(item.units, 0)} sold · ${item.margin.toFixed(0)}% margin`,
                tone: item.margin < 55 ? "var(--color-warn)" : "var(--color-brand-500)",
              }))}
              format={(value) => formatMoneyShort(value)}
            />
          )}
        </Card>

        <Card title="Labour by role" icon="users" subtitle="Hours and cost, including the 18% statutory burden.">
          {report.laborByRole.length === 0 ? (
            <Empty title="No labour recorded in range" icon="users" />
          ) : (
            <BarList
              rows={report.laborByRole.map((entry) => ({
                label: entry.role,
                value: entry.cost,
                meta: `${formatQuantity(entry.hours, 1)} hrs`,
              }))}
              format={(value) => formatMoneyShort(value)}
              tone="var(--color-info)"
            />
          )}
        </Card>
      </div>

      <Card title="Business days" icon="report" subtitle="Only closed days are frozen into the ledger; open days are still moving.">
        {days.length === 0 ? (
          <Empty title="No business days recorded" icon="report" />
        ) : (
          <div className="scroll-x">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="text-right">Checks</th>
                  <th className="text-right">Net sales</th>
                  <th className="text-right">Float</th>
                  <th>Status</th>
                  <th>Closed</th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.id}>
                    <td className="font-semibold text-ink">{formatDay(day.businessDate)}</td>
                    <td className="tnum text-right">{day.liveChecks}</td>
                    <td className="tnum text-right font-bold">{formatMoney(day.liveSales)}</td>
                    <td className="tnum text-right text-ink-faint">{formatMoney(day.openingFloat)}</td>
                    <td>
                      <span
                        className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold"
                        style={{
                          background: day.status === "closed" ? "var(--color-ok-soft)" : "var(--color-warn-soft)",
                          color: day.status === "closed" ? "#1f6b43" : "#8a5d10",
                        }}
                      >
                        {day.status}
                      </span>
                    </td>
                    <td className="text-[12px] text-ink-faint">{day.closedAt ? day.closedAt.slice(0, 16) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

function PrimeBadge({ percent }: { percent: number }) {
  const tone = percent > 65 ? "late" : percent > 60 ? "warn" : "ok";
  const label = percent > 65 ? "Over target" : percent > 60 ? "Watch" : "Healthy";
  return (
    <span
      className="tnum flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-black"
      style={{
        background: tone === "late" ? "var(--color-late-soft)" : tone === "warn" ? "var(--color-warn-soft)" : "var(--color-ok-soft)",
        color: tone === "late" ? "#96271a" : tone === "warn" ? "#8a5d10" : "#1f6b43",
      }}
    >
      {percent.toFixed(1)}% · {label}
    </span>
  );
}

/** A cost percentage drawn against the band it is supposed to sit in. */
function CostGauge({
  label,
  percent,
  amount,
  target,
  delta,
  hint,
}: {
  label: string;
  percent: number;
  amount: number;
  target: { min: number; max: number };
  delta: number;
  hint: string;
}) {
  const over = percent > target.max;
  const under = percent < target.min;
  const tone = over ? "var(--color-late)" : under ? "var(--color-warn)" : "var(--color-ok)";
  // The scale runs a little past the ceiling so the target band is visible.
  const scaleMax = Math.max(target.max * 1.6, percent * 1.15, 45);

  return (
    <div className="rounded-xl border border-rule bg-paper px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">{label}</p>
        <p className="tnum text-[11px] font-bold" style={{ color: delta > 0 ? "var(--color-late)" : "var(--color-ok)" }}>
          {delta === 0 ? "flat" : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1)} pts`}
        </p>
      </div>
      <p className="tnum mt-1 text-3xl font-black leading-none" style={{ color: tone }}>
        {percent.toFixed(1)}%
      </p>
      <p className="tnum mt-0.5 text-[13px] font-bold text-ink-soft">{formatMoney(amount)}</p>

      {/* Bar with the target band marked out. */}
      <div className="relative mt-2 h-2.5 w-full overflow-hidden rounded-full bg-paper-sunken">
        <span
          className="absolute inset-y-0 bg-ok/22"
          style={{ left: `${(target.min / scaleMax) * 100}%`, width: `${((target.max - target.min) / scaleMax) * 100}%` }}
        />
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, (percent / scaleMax) * 100)}%`, background: tone }} />
      </div>
      <p className="tnum mt-1 text-[10px] font-semibold text-ink-faint">
        Target {target.min}–{target.max}%
      </p>
      <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">{hint}</p>
      <p className="mt-1 text-[11px] font-semibold" style={{ color: tone }}>
        {over
          ? `${(percent - target.max).toFixed(1)} points over the ceiling`
          : under
            ? `${(target.min - percent).toFixed(1)} points under target`
            : "Inside target"}
      </p>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="tnum font-semibold" style={{ color: tone ?? "var(--color-ink-soft)" }}>
        {value}
      </dd>
    </div>
  );
}
