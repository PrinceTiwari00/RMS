"use client";

/**
 * Screen 21 — Z-Report & End-of-Day Reconciliation.
 *
 * Closing the day is a signature, not a button press: it freezes the numbers,
 * records who counted the drawer and what they found, and refuses to run while
 * a ticket is still open. So this screen is built around the count sheet — the
 * expected denomination breakdown sits next to what was physically in the drawer,
 * and the variance is impossible to miss.
 *
 * A closed day can be reopened, but only by someone holding `reports.zreport`,
 * and the reopening is audited along with everything else.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, qs } from "@/lib/api";
import { usePoll, useStore, useTicker } from "@/lib/store";
import { Button, Card, Chip, ColumnChart, Empty, Icon, Modal, TextInput, toast } from "@/components/ui";
import { formatMoney, formatMoneyShort, formatQuantity } from "@/domain/money";
import { businessDateNow, formatDay } from "@/domain/time";
import { LABOR_TARGET } from "@/domain/labor";
import type { BusinessDay, ZReport } from "@/types";

interface Denomination {
  label: string;
  value: number;
  kind: "note" | "coin";
}

interface DrawerRow {
  denomination: string;
  value: number;
  expectedCount: number;
  kind: "note" | "coin";
}

interface ZResponse {
  date: string;
  report: ZReport | null;
  denominations: Denomination[];
  drawer: DrawerRow[];
  day: BusinessDay | null;
  float: number;
  previousDays: BusinessDay[];
}

export default function ZReportPage() {
  const { user, allowed } = useStore();
  useTicker(30000);

  const canClose = allowed("reports.zreport");
  const [date, setDate] = useState(businessDateNow());
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<ZReport | null>(null);

  const { data, reload } = usePoll<ZResponse>(`reports/zreport?${qs({ date, history: 14 })}`, { interval: 15000 });

  const report = data?.report ?? null;
  const closed = report?.status === "closed";

  // A live preview of the numbers before anything is frozen.
  useEffect(() => {
    if (closed) {
      setPreview(null);
      return;
    }
    let live = true;
    void api
      .get<{ report: ZReport }>(`reports/zreport/preview?${qs({ date })}`)
      .then((response) => {
        if (live) setPreview(response.report);
      })
      .catch(() => {
        if (live) setPreview(null);
      });
    return () => {
      live = false;
    };
  }, [date, closed]);

  const drawer = data?.drawer ?? [];
  const shown = report ?? preview;

  /** Seed the count sheet with the expected breakdown, so only the differences get typed. */
  useEffect(() => {
    if (!drawer.length || closed) return;
    setCounts((current) => {
      if (Object.keys(current).length) return current;
      const seeded: Record<string, string> = {};
      for (const row of drawer) seeded[row.denomination] = String(row.expectedCount);
      return seeded;
    });
  }, [drawer, closed]);

  /** Counted drawer value, computed from the sheet as it is typed. */
  const counted = useMemo(() => {
    return drawer.reduce<number>((total, row) => {
      const notes = Math.max(0, Math.round(Number(counts[row.denomination]) || 0));
      return total + notes * row.value;
    }, 0);
  }, [drawer, counts]);

  const expectedCash = shown?.cash.expectedCash ?? 0;
  const variance = counted - expectedCash;

  const closeDay = useCallback(async () => {
    setBusy(true);
    try {
      const payload = drawer.map((row) => ({
        denomination: row.denomination,
        counted: Math.max(0, Math.round(Number(counts[row.denomination]) || 0)),
      }));
      const result = await api.post<{ report: ZReport }>("reports/zreport/close", { date, counts: payload, notes });
      toast(`Business day ${formatDay(date)} closed and frozen`, "ok");
      setConfirming(false);
      setCounts({});
      setNotes("");
      await reload();
      void result;
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }, [drawer, counts, date, notes, reload]);

  const reopenDay = useCallback(async () => {
    setBusy(true);
    try {
      await api.post("reports/zreport/reopen", { date });
      toast(`Business day ${formatDay(date)} reopened for correction`, "warn");
      await reload();
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }, [date, reload]);

  const openDay = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.post<{ openingFloat: number }>("reports/day/open", { date });
      toast(`Till opened for ${formatDay(date)} with a float of ${formatMoney(result.openingFloat)}`, "ok");
      await reload();
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }, [date, reload]);

  if (!data) {
    return (
      <div className="p-6">
        <Empty title="Loading the Z-report…" icon="report" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[19px] font-extrabold text-ink">
            Z-Report
            {closed ? (
              <Chip tone="ok">
                <Icon name="lock" className="size-3" />
                Closed
              </Chip>
            ) : (
              <Chip tone="warn">Day still open</Chip>
            )}
          </h1>
          <p className="text-[12px] text-ink-faint">
            {closed
              ? `Frozen ${report?.closedAt?.slice(0, 16).replace("T", " ") ?? ""} by ${report?.closedBy ?? "—"}`
              : "Figures are live and will change until the day is closed."}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-soft">
            Business date
            <input
              type="date"
              className="field !w-auto tnum"
              value={date}
              max={businessDateNow()}
              onChange={(event) => {
                setDate(event.target.value);
                setCounts({});
              }}
            />
          </label>
          <Button variant="soft" onClick={() => window.print()}>
            <Icon name="print" className="size-4" />
            Print
          </Button>
          {canClose && !closed && !data.day && (
            <Button variant="primary" disabled={busy} onClick={() => void openDay()}>
              <Icon name="cash" className="size-4" />
              Open the till
            </Button>
          )}
          {canClose && !closed && shown && (
            <Button variant="primary" disabled={busy} onClick={() => setConfirming(true)}>
              <Icon name="lock" className="size-4" />
              Close day &amp; freeze
            </Button>
          )}
          {canClose && closed && (
            <Button variant="danger" disabled={busy} onClick={() => void reopenDay()}>
              <Icon name="refresh" className="size-4" />
              Reopen day
            </Button>
          )}
        </div>
      </div>

      {/* Previous days, so a manager can jump straight to the one they need. */}
      {data.previousDays.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.previousDays.slice(0, 14).map((day) => (
            <button
              key={day.id}
              type="button"
              onClick={() => {
                setDate(day.businessDate);
                setCounts({});
              }}
              className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors"
              style={{
                borderColor: day.businessDate === date ? "var(--color-brand-500)" : "var(--color-rule)",
                background: day.businessDate === date ? "var(--color-brand-50)" : "var(--color-paper-raised)",
                color: day.status === "closed" ? "var(--color-ink-soft)" : "var(--color-warn)",
              }}
              title={`${day.status} · ${formatMoney(day.liveSales)}`}
            >
              {formatDay(day.businessDate)}
              <span className="tnum text-ink-faint">{formatMoneyShort(day.liveSales)}</span>
              {day.status === "open" && <span className="size-1.5 rounded-full bg-warn" />}
            </button>
          ))}
        </div>
      )}

      {!shown ? (
        <Card>
          <Empty
            title="No activity recorded for this date"
            hint="Open the till to start the day, or pick another date."
            icon="report"
          />
        </Card>
      ) : (
        <>
          {/* ------------------------------------------------------- sales summary */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card>
              <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Net sales</p>
              <p className="tnum mt-1 text-2xl font-black text-ink">{formatMoney(shown.netSales)}</p>
              <p className="tnum mt-0.5 text-[11px] text-ink-faint">Gross {formatMoney(shown.grossSales)}</p>
            </Card>
            <Card>
              <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Checks</p>
              <p className="tnum mt-1 text-2xl font-black text-ink">{shown.checks}</p>
              <p className="tnum mt-0.5 text-[11px] text-ink-faint">
                {formatQuantity(shown.guests, 0)} guests · avg {formatMoney(shown.averageCheck)}
              </p>
            </Card>
            <Card>
              <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Food cost</p>
              <p
                className="tnum mt-1 text-2xl font-black"
                style={{ color: shown.foodCostPercent > 34 ? "var(--color-late)" : "var(--color-ink)" }}
              >
                {shown.foodCostPercent.toFixed(1)}%
              </p>
              <p className="tnum mt-0.5 text-[11px] text-ink-faint">{formatMoney(shown.foodCost)}</p>
            </Card>
            <Card>
              <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Labour cost</p>
              <p
                className="tnum mt-1 text-2xl font-black"
                style={{
                  color:
                    shown.laborPercent > LABOR_TARGET.max
                      ? "var(--color-late)"
                      : shown.laborPercent < LABOR_TARGET.min
                        ? "var(--color-warn)"
                        : "var(--color-ok)",
                }}
              >
                {shown.laborPercent.toFixed(1)}%
              </p>
              <p className="tnum mt-0.5 text-[11px] text-ink-faint">
                {formatMoney(shown.laborCost)} · {formatQuantity(shown.laborHours, 1)} hrs
              </p>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {/* ------------------------------------------------------ drawer count */}
            <Card
              title="Cash drawer reconciliation"
              icon="cash"
              subtitle={
                closed
                  ? "Counted and signed off when the day was closed."
                  : "Count the drawer physically, then type what you actually find."
              }
              accent={variance === 0 ? "var(--color-ok)" : Math.abs(variance) > 50000 ? "var(--color-late)" : "var(--color-warn)"}
            >
              <dl className="mb-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-paper-sunken px-2 py-1.5">
                  <dt className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">Opening float</dt>
                  <dd className="tnum text-[14px] font-black text-ink">{formatMoney(shown.cash.openingFloat)}</dd>
                </div>
                <div className="rounded-lg bg-paper-sunken px-2 py-1.5">
                  <dt className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">Expected</dt>
                  <dd className="tnum text-[14px] font-black text-ink">{formatMoney(expectedCash)}</dd>
                </div>
                <div
                  className="rounded-lg px-2 py-1.5"
                  style={{
                    background: variance === 0 ? "var(--color-ok-soft)" : Math.abs(variance) > 50000 ? "var(--color-late-soft)" : "var(--color-warn-soft)",
                  }}
                >
                  <dt className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">
                    {closed ? "Variance" : variance === 0 ? "Balanced" : variance > 0 ? "Over" : "Short"}
                  </dt>
                  <dd
                    className="tnum text-[14px] font-black"
                    style={{
                      color:
                        variance === 0
                          ? "#1f6b43"
                          : Math.abs(variance) > 50000
                            ? "#96271a"
                            : "#8a5d10",
                    }}
                  >
                    {variance === 0 ? "0.00" : `${variance > 0 ? "+" : "−"} ${formatMoney(Math.abs(variance)).replace("Rs ", "")}`}
                  </dd>
                </div>
              </dl>

              <div className="scroll-x">
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>Denomination</th>
                      <th className="text-right">Value</th>
                      <th className="text-right">Expected</th>
                      <th className="text-right w-24">{closed ? "Counted" : "You counted"}</th>
                      <th className="text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drawer.map((row) => {
                      const stored = closed
                        ? (shown.cash.counts.find((entry) => entry.denomination === row.denomination)?.countedCount ?? 0)
                        : Math.max(0, Math.round(Number(counts[row.denomination]) || 0));
                      const expectedRow = shown.cash.counts.find((entry) => entry.denomination === row.denomination);
                      const difference = stored - (expectedRow?.expectedCount ?? row.expectedCount);
                      return (
                        <tr key={row.denomination}>
                          <td className="font-semibold text-ink">
                            {row.denomination}
                            {row.kind === "coin" && <span className="ml-1.5 text-[10px] font-bold uppercase text-ink-faint">coin</span>}
                          </td>
                          <td className="tnum text-right text-ink-faint">{formatMoney(row.value)}</td>
                          <td className="tnum text-right">{expectedRow?.expectedCount ?? row.expectedCount}</td>
                          <td className="text-right">
                            {closed ? (
                              <span className="tnum font-bold">{stored}</span>
                            ) : (
                              <TextInput
                                value={counts[row.denomination] ?? ""}
                                onChange={(value) =>
                                  setCounts((current) => ({ ...current, [row.denomination]: value.replace(/\D/g, "") }))
                                }
                                className="tnum !w-20 !px-2 !py-1 text-right"
                                inputMode="numeric"
                                placeholder="0"
                              />
                            )}
                          </td>
                          <td
                            className="tnum text-right font-bold"
                            style={{ color: difference === 0 ? "var(--color-ink)" : difference > 0 ? "var(--color-ok)" : "var(--color-late)" }}
                          >
                            {formatMoney(stored * row.value)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="font-extrabold text-ink">
                        Drawer total
                      </td>
                      <td className="tnum text-right font-black">{formatMoney(closed ? (shown.cash.countedCash ?? 0) : counted)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {closed && shown.cash.notes && (
                <p className="mt-2 rounded-lg bg-paper-sunken px-3 py-2 text-[12px] italic text-ink-soft">
                  “{shown.cash.notes}”
                </p>
              )}

              {!closed && canClose && (
                <label className="mt-3 block">
                  <span className="label">Notes for the variance (signed off by {user?.name ?? "you"})</span>
                  <TextInput
                    value={notes}
                    onChange={setNotes}
                    placeholder={variance === 0 ? "Drawer balanced." : "Explain the difference — short change, unrecorded comp…"}
                  />
                </label>
              )}
            </Card>

            <div className="flex flex-col gap-4">
              <Card title="Tenders taken" icon="cash" subtitle="Cash, card and wallet volume for the day.">
                {shown.tenders.length === 0 ? (
                  <Empty title="No payments recorded" icon="cash" />
                ) : (
                  <table className="grid-table">
                    <thead>
                      <tr>
                        <th>Method</th>
                        <th className="text-right">Count</th>
                        <th className="text-right">Amount</th>
                        <th className="text-right">Tips</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.tenders.map((tender) => (
                        <tr key={tender.method}>
                          <td className="font-semibold text-ink">{tender.label}</td>
                          <td className="tnum text-right">{tender.count}</td>
                          <td className="tnum text-right font-bold">{formatMoney(tender.amount)}</td>
                          <td className="tnum text-right text-ok">{tender.tips ? formatMoney(tender.tips) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card title="Discounts & voids" icon="alert" subtitle="Every one of these was approved by a named person and is audited.">
                {shown.discounts === 0 && shown.voids === 0 ? (
                  <p className="text-[12px] text-ink-faint">Nothing given away and nothing voided — a clean day.</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="label">Discounts · {formatMoney(shown.discounts)}</p>
                      {shown.discountDetail.length === 0 ? (
                        <p className="text-[12px] text-ink-faint">None</p>
                      ) : (
                        <ul className="space-y-0.5">
                          {shown.discountDetail.map((entry) => (
                            <li key={entry.reason} className="flex justify-between gap-2 text-[12px]">
                              <span className="truncate text-ink-soft">{entry.reason}</span>
                              <span className="tnum shrink-0 font-bold text-late">
                                {formatMoney(entry.amount)} · {entry.count}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <p className="label">
                        Voids · {shown.voids} item{shown.voids === 1 ? "" : "s"} · {formatMoney(shown.voidAmount)}
                      </p>
                      {shown.voidDetail.length === 0 ? (
                        <p className="text-[12px] text-ink-faint">None</p>
                      ) : (
                        <ul className="space-y-0.5">
                          {shown.voidDetail.map((entry) => (
                            <li key={entry.reason} className="flex justify-between gap-2 text-[12px]">
                              <span className="truncate text-ink-soft">{entry.reason}</span>
                              <span className="tnum shrink-0 font-bold text-late">
                                {formatMoney(entry.amount)} · {entry.count}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Tip payout by server" icon="users" subtitle="Owed at the end of this shift.">
              {shown.tipPayout.length === 0 ? (
                <Empty title="No tips recorded" icon="users" />
              ) : (
                <ul className="space-y-1">
                  {shown.tipPayout.map((entry) => (
                    <li key={entry.employeeId} className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="truncate font-semibold text-ink">{entry.name}</span>
                      <span className="tnum shrink-0 text-ink-faint">{entry.checks} checks</span>
                      <span className="tnum shrink-0 font-black text-ok">{formatMoney(entry.tips)}</span>
                    </li>
                  ))}
                  <li className="flex justify-between gap-2 border-t border-rule pt-1 text-[12px] font-extrabold">
                    <span className="text-ink">Total tips</span>
                    <span className="tnum text-ok">{formatMoney(shown.tips)}</span>
                  </li>
                </ul>
              )}
            </Card>

            <Card title="Server performance" icon="chart" subtitle="Checks, sales and average ticket.">
              {shown.byServer.length === 0 ? (
                <Empty title="No server activity" icon="chart" />
              ) : (
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>Server</th>
                      <th className="text-right">Checks</th>
                      <th className="text-right">Sales</th>
                      <th className="text-right">Avg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.byServer.map((entry) => (
                      <tr key={entry.id}>
                        <td className="truncate font-semibold text-ink">{entry.name}</td>
                        <td className="tnum text-right">{entry.checks}</td>
                        <td className="tnum text-right font-bold">{formatMoney(entry.sales)}</td>
                        <td className="tnum text-right text-ink-faint">{formatMoney(entry.averageCheck)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Sales by hour" icon="clock" subtitle="Shape tomorrow's rota around the real peak.">
              {shown.byHour.length === 0 ? (
                <Empty title="No hourly data" icon="clock" />
              ) : (
                <ColumnChart
                  points={shown.byHour.map((entry) => ({ label: `${String(entry.hour).padStart(2, "0")}h`, value: entry.sales }))}
                  height={160}
                  format={(value) => formatMoneyShort(value)}
                />
              )}
            </Card>
          </div>

          <Card title="Top sellers" icon="star">
            {shown.topItems.length === 0 ? (
              <Empty title="Nothing sold" icon="star" />
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {shown.topItems.map((item, index) => (
                  <span key={item.name} className="flex items-center gap-1.5 rounded-full border border-rule bg-paper px-2.5 py-1 text-[12px]">
                    <span className="tnum font-black text-ink-faint">{index + 1}</span>
                    <span className="font-semibold text-ink">{item.name}</span>
                    <span className="tnum text-ink-faint">{formatQuantity(item.units, 0)}</span>
                    <span className="tnum font-bold text-brand-600">{formatMoney(item.revenue)}</span>
                  </span>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {/* ------------------------------------------------------- close-the-day gate */}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Close the business day · ${formatDay(date)}`}
        subtitle="This freezes the report and records your count against it. It cannot be undone without reopening the day."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void closeDay()}>
              <Icon name="lock" className="size-4" />
              Freeze the day
            </Button>
          </>
        }
      >
        {shown && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <ConfirmTile label="Net sales" value={formatMoney(shown.netSales)} />
              <ConfirmTile label="Checks" value={String(shown.checks)} />
              <ConfirmTile label="Drawer expected" value={formatMoney(expectedCash)} />
              <ConfirmTile
                label="You counted"
                value={formatMoney(counted)}
                tone={variance === 0 ? "var(--color-ok)" : Math.abs(variance) > 50000 ? "var(--color-late)" : "var(--color-warn)"}
              />
            </div>

            {variance !== 0 && (
              <p
                className="flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] font-semibold"
                style={{
                  background: Math.abs(variance) > 50000 ? "var(--color-late-soft)" : "var(--color-warn-soft)",
                  color: Math.abs(variance) > 50000 ? "#96271a" : "#8a5d10",
                }}
              >
                <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
                <span>
                  The drawer is {variance > 0 ? "over" : "short"} by {formatMoney(Math.abs(variance))}. Add a note
                  explaining it — the variance is recorded against your name.
                </span>
              </p>
            )}

            {!notes.trim() && variance !== 0 && (
              <p className="text-[12px] font-semibold text-late">A note is strongly advised when the drawer does not balance.</p>
            )}

            <p className="text-[12px] text-ink-soft">
              Closing will be refused while any ticket is still open — settle or void them first.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ConfirmTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-rule bg-paper px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="tnum text-[15px] font-black" style={{ color: tone ?? "var(--color-ink)" }}>
        {value}
      </p>
    </div>
  );
}
