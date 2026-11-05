"use client";

/**
 * Screen 20 — Product Mix (menu engineering).
 *
 * A bestseller list tells you what sells; it does not tell you what earns. This
 * screen plots every dish on the two axes that decide a menu's profitability —
 * how much of the mix it takes (popularity) against what each portion leaves
 * behind (contribution margin) — and sorts the result into the four classic
 * quadrants, each with the action that quadrant actually calls for.
 *
 * The thresholds are computed, not chosen: popularity is 70% of an equal share,
 * and margin is the menu's own average contribution. So the chart always
 * describes this restaurant, this period.
 */
import { useMemo, useState } from "react";
import { RangePicker, rangeQuery } from "@/components/RangePicker";
import { usePoll } from "@/lib/store";
import { Card, Chip, Empty, Icon, Meter, QuadrantChart } from "@/components/ui";
import { formatMoney, formatMoneyShort, formatQuantity } from "@/domain/money";
import { formatDay } from "@/domain/time";
import { QUADRANT_META, type Quadrant } from "@/domain/pmix";
import type { PmixReport, PmixRowView } from "@/types";

interface PmixResponse {
  preset: string;
  report: PmixReport;
}

const QUADRANT_TONE: Record<Quadrant, string> = {
  star: "var(--color-ok)",
  plowhorse: "var(--color-warn)",
  puzzle: "var(--color-info)",
  dog: "var(--color-late)",
};

const QUADRANT_ORDER: Quadrant[] = ["star", "plowhorse", "puzzle", "dog"];

type SortKey = "name" | "unitsSold" | "revenue" | "contributionMargin" | "marginPercent" | "menuMixPercent" | "foodCostPercent";

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "name", label: "Dish" },
  { key: "menuMixPercent", label: "Mix %", numeric: true },
  { key: "unitsSold", label: "Units", numeric: true },
  { key: "revenue", label: "Revenue", numeric: true },
  { key: "contributionMargin", label: "Contribution", numeric: true },
  { key: "marginPercent", label: "Margin %", numeric: true },
  { key: "foodCostPercent", label: "Food cost %", numeric: true },
];

export default function PmixPage() {
  const [preset, setPreset] = useState("14d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<SortKey>("contributionMargin");
  const [descending, setDescending] = useState(true);
  const [quadrantFilter, setQuadrantFilter] = useState<Quadrant | "all">("all");

  const query = rangeQuery(preset, from, to);
  const { data } = usePoll<PmixResponse>(`reports/pmix?${query}`, { interval: 60000 });
  const report = data?.report;

  const rows = useMemo(() => {
    const source = (report?.rows ?? []).filter((row) => quadrantFilter === "all" || row.quadrant === quadrantFilter);
    return [...source].sort((a, b) => {
      const left = a[sort];
      const right = b[sort];
      const comparison = typeof left === "string" && typeof right === "string" ? left.localeCompare(right) : Number(left) - Number(right);
      return descending ? -comparison : comparison;
    });
  }, [report, sort, descending, quadrantFilter]);

  const points = useMemo(
    () =>
      (report?.rows ?? []).map((row: PmixRowView) => ({
        id: row.id,
        name: row.name,
        x: row.menuMixPercent,
        y: row.contributionMargin,
        tone: QUADRANT_TONE[row.quadrant],
        units: row.unitsSold,
      })),
    [report],
  );

  if (!report) {
    return (
      <div className="p-6">
        <Empty title="Building the product mix…" hint="Costs come from each dish's live bill of materials." icon="matrix" />
      </div>
    );
  }

  const { totals, thresholds } = report;
  const maxUnits = Math.max(1, ...report.rows.map((row) => row.unitsSold));

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[19px] font-extrabold text-ink">Product Mix</h1>
          <p className="text-[12px] text-ink-faint">
            {report.range.label} · {formatDay(report.range.from)} → {formatDay(report.range.to)}
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

      {/* ---------------------------------------------------------------- totals */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="Units sold" value={formatQuantity(totals.units, 0)} sub={`${report.rows.length} dishes`} />
        <Tile label="Revenue" value={formatMoneyShort(totals.revenue)} sub="at menu price" />
        <Tile label="Ingredient cost" value={formatMoneyShort(totals.cost)} sub={`${totals.foodCostPercent.toFixed(1)}% of revenue`} tone="var(--color-late)" />
        <Tile label="Contribution" value={formatMoneyShort(totals.contribution)} sub="what is left to pay for everything else" tone="var(--color-ok)" />
        <Tile label="Average margin" value={`${totals.marginPercent.toFixed(1)}%`} sub="across the menu" tone="var(--color-brand-600)" />
      </div>

      {/* --------------------------------------------------------------- quadrant */}
      <Card
        title="Menu engineering map"
        icon="matrix"
        subtitle={`Popularity cut-off ${thresholds.popularityPercent.toFixed(1)}% of mix (70% of an equal share) · margin cut-off ${formatMoney(thresholds.contributionMargin)} per period`}
        action={
          <div className="flex flex-wrap gap-1">
            <FilterChip active={quadrantFilter === "all"} onClick={() => setQuadrantFilter("all")}>
              All {report.rows.length}
            </FilterChip>
            {QUADRANT_ORDER.map((quadrant) => (
              <FilterChip
                key={quadrant}
                active={quadrantFilter === quadrant}
                onClick={() => setQuadrantFilter(quadrant)}
                color={QUADRANT_TONE[quadrant]}
              >
                {QUADRANT_META[quadrant].label} {report.quadrants[quadrant]?.count ?? 0}
              </FilterChip>
            ))}
          </div>
        }
      >
        {points.length === 0 ? (
          <Empty title="Nothing sold in this period" icon="matrix" />
        ) : (
          <QuadrantChart points={points} xThreshold={thresholds.popularityPercent} yThreshold={thresholds.contributionMargin} height={360} />
        )}

        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {QUADRANT_ORDER.map((quadrant) => {
            const bucket = report.quadrants[quadrant];
            const meta = QUADRANT_META[quadrant];
            return (
              <div
                key={quadrant}
                className="rounded-xl border-l-4 bg-paper px-3 py-2"
                style={{ borderColor: QUADRANT_TONE[quadrant], border: `1px solid var(--color-rule)`, borderLeft: `4px solid ${QUADRANT_TONE[quadrant]}` }}
              >
                <p className="flex items-center gap-1.5 text-[12px] font-black uppercase tracking-wide" style={{ color: QUADRANT_TONE[quadrant] }}>
                  {meta.label}
                  <span className="tnum rounded-full bg-paper-sunken px-1.5 text-[11px] text-ink-soft">{bucket?.count ?? 0}</span>
                </p>
                <p className="mt-0.5 text-[11px] font-semibold text-ink-faint">{meta.blurb}</p>
                <p className="mt-1 text-[11px] leading-snug text-ink-soft">{meta.action}</p>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ------------------------------------------------------------------ table */}
      <Card
        title="Every dish in range"
        icon="menu"
        subtitle="Click a column to sort. Contribution is the money each dish leaves after its own ingredients."
      >
        {rows.length === 0 ? (
          <Empty title="No dishes match this filter" icon="menu" />
        ) : (
          <div className="scroll-x">
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-8">#</th>
                  {COLUMNS.map((column) => (
                    <th key={column.key} className={column.numeric ? "text-right" : undefined}>
                      <button
                        type="button"
                        onClick={() => {
                          if (sort === column.key) setDescending((current) => !current);
                          else {
                            setSort(column.key);
                            setDescending(column.key !== "name");
                          }
                        }}
                        className={`flex items-center gap-1 ${column.numeric ? "justify-end" : ""} hover:text-ink`}
                      >
                        {column.label}
                        {sort === column.key && <span aria-hidden="true">{descending ? "▼" : "▲"}</span>}
                      </button>
                    </th>
                  ))}
                  <th>Quadrant</th>
                  <th className="w-28">Popularity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.id}>
                    <td className="tnum text-ink-faint">{index + 1}</td>
                    <td>
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden="true">{row.emoji || "🍽"}</span>
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-ink">{row.name}</span>
                          <span className="block truncate text-[11px] text-ink-faint">
                            {row.category} · sells for {formatMoney(row.price)}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="tnum text-right">{row.menuMixPercent.toFixed(1)}%</td>
                    <td className="tnum text-right">{formatQuantity(row.unitsSold, 0)}</td>
                    <td className="tnum text-right font-bold">{formatMoney(row.revenue)}</td>
                    <td className="tnum text-right font-bold" style={{ color: QUADRANT_TONE[row.quadrant] }}>
                      {formatMoney(row.contributionMargin)}
                    </td>
                    <td className="tnum text-right">{row.marginPercent.toFixed(1)}%</td>
                    <td
                      className="tnum text-right"
                      style={{ color: row.foodCostPercent > 40 ? "var(--color-late)" : row.foodCostPercent > 34 ? "var(--color-warn)" : undefined }}
                    >
                      {row.foodCostPercent.toFixed(1)}%
                    </td>
                    <td>
                      <Chip tone={row.quadrant === "star" ? "ok" : row.quadrant === "plowhorse" ? "warn" : row.quadrant === "puzzle" ? "info" : "late"}>
                        {QUADRANT_META[row.quadrant].label.replace(/s$/, "")}
                      </Chip>
                    </td>
                    <td>
                      <Meter value={row.unitsSold} max={maxUnits} tone={QUADRANT_TONE[row.quadrant]} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td className="font-extrabold text-ink">Totals</td>
                  <td className="tnum text-right font-extrabold">100%</td>
                  <td className="tnum text-right font-extrabold">{formatQuantity(totals.units, 0)}</td>
                  <td className="tnum text-right font-extrabold">{formatMoney(totals.revenue)}</td>
                  <td className="tnum text-right font-extrabold text-ok">{formatMoney(totals.contribution)}</td>
                  <td className="tnum text-right font-extrabold">{totals.marginPercent.toFixed(1)}%</td>
                  <td className="tnum text-right font-extrabold">{totals.foodCostPercent.toFixed(1)}%</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <Card title="How to read this" icon="report">
        <ul className="grid gap-2 text-[12px] leading-relaxed text-ink-soft sm:grid-cols-2">
          <li className="flex gap-2">
            <Icon name="star" className="mt-0.5 size-4 shrink-0 text-ok" />
            <span>
              <strong>Stars</strong> sell well and earn well. Keep the recipe locked and the portions consistent — they
              are what pays the rent.
            </span>
          </li>
          <li className="flex gap-2">
            <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-warn" />
            <span>
              <strong>Plowhorses</strong> carry the volume but barely earn. Reprice gently, trim the portion, or
              renegotiate the ingredient — a 5% margin gain here beats any promotion elsewhere.
            </span>
          </li>
          <li className="flex gap-2">
            <Icon name="chart" className="mt-0.5 size-4 shrink-0 text-info" />
            <span>
              <strong>Puzzles</strong> earn well but nobody orders them. Rename, reposition on the page, or have servers
              recommend them — the margin is already there.
            </span>
          </li>
          <li className="flex gap-2">
            <Icon name="close" className="mt-0.5 size-4 shrink-0 text-late" />
            <span>
              <strong>Dogs</strong> neither sell nor earn. They tie up stock and prep time. Retire them or rebuild the
              recipe from scratch.
            </span>
          </li>
        </ul>
      </Card>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="card card-pad">
      <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">{label}</p>
      <p className="tnum mt-1 text-2xl font-extrabold leading-none" style={{ color: tone ?? "var(--color-ink)" }}>
        {value}
      </p>
      {sub && <p className="mt-1 truncate text-[11px] text-ink-faint">{sub}</p>}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
  color,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors"
      style={{
        background: active ? "var(--color-ink)" : "var(--color-paper-sunken)",
        color: active ? "#fff" : "var(--color-ink-soft)",
      }}
    >
      {color && <span className="size-2 rounded-full" style={{ background: color }} />}
      {children}
    </button>
  );
}
