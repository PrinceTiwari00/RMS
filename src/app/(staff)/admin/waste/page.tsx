"use client";

/**
 * Screen 15 — Waste Log & Reconciliation.
 *
 * Waste is the gap between what the recipes say should have gone out and what
 * actually left the building. Logging it is easy; the discipline is in the
 * reconciliation, which is why this screen puts the theoretical position beside
 * the physical count and makes the variance — and its rupee value — the headline
 * rather than a footnote.
 *
 * Applying a count is an audited stock correction. It is offered per row, not
 * in bulk, because each variance needs a human to decide what it means.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, qs } from "@/lib/api";
import { usePoll } from "@/lib/store";
import { BarList, Button, Card, Chip, Donut, Empty, Field, Icon, Modal, TextInput, toast } from "@/components/ui";
import { formatMoney, formatMoneyShort, formatQuantity } from "@/domain/money";
import { formatClock, formatDay, shiftDate, today } from "@/domain/time";
import type { CountRecord, InventoryItem, WasteEntry } from "@/types";

interface WasteSummary {
  entries: number;
  totalValue: number;
  byReason: { reason: string; quantity: number; value: number; count: number }[];
  topItems: { key: string; value: number }[];
}

interface WasteResponse {
  from: string;
  to: string;
  entries: WasteEntry[];
  summary: WasteSummary;
  reasons: string[];
}

interface CountsResponse {
  counts: CountRecord[];
  sheet: { id: string; name: string; unit: string; currentStock: number; value: number; reason: string }[];
}

interface ReconciliationResponse {
  date: string;
  opening: { itemId: string; name: string; opening: number; movements: number }[];
  counts: CountRecord[];
  waste: WasteEntry[];
  ledger: { id: string; itemName: string; unit: string; delta: number; reason: string; actor: string; createdAt: string }[];
}

const REASON_TONE: Record<string, string> = {
  spoiled: "var(--color-late)",
  dropped: "var(--color-warn)",
  expired: "var(--color-ember-500)",
  overcook: "var(--color-info)",
  theft: "var(--color-900)",
  other: "var(--color-ink-faint)",
};

const RANGES = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "14d", label: "14 days", days: 14 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "today", label: "Today", days: 1 },
];

export default function WastePage() {
  const [tab, setTab] = useState<"waste" | "counts" | "reconcile">("waste");
  const [rangeId, setRangeId] = useState("14d");
  const [reason, setReason] = useState("all");
  const [logging, setLogging] = useState(false);
  const [counting, setCounting] = useState(false);

  const range = RANGES.find((entry) => entry.id === rangeId) ?? RANGES[1];
  const from = shiftDate(today(), -(range.days - 1));
  const to = today();

  const { data, reload } = usePoll<WasteResponse>(`waste?${qs({ from, to, reason, limit: 500 })}`, {
    interval: 30000,
    enabled: tab === "waste",
  });

  if (!data && tab === "waste") {
    return (
      <div className="p-6">
        <Empty title="Loading the waste log…" icon="waste" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[19px] font-extrabold text-ink">Waste &amp; Reconciliation</h1>
          <p className="text-[12px] text-ink-faint">
            Every entry is valued at the item's own unit cost, so the total is real money lost, not a count of incidents.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {tab === "waste" && (
            <Button variant="primary" onClick={() => setLogging(true)}>
              <Icon name="plus" className="size-4" />
              Log waste
            </Button>
          )}
          {tab !== "waste" && (
            <Button variant="primary" onClick={() => setCounting(true)}>
              <Icon name="plus" className="size-4" />
              Record a count
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-rule pb-2">
        <Tab active={tab === "waste"} onClick={() => setTab("waste")} count={data?.entries.length ?? 0}>
          Waste log
        </Tab>
        <Tab active={tab === "counts"} onClick={() => setTab("counts")}>
          Physical counts
        </Tab>
        <Tab active={tab === "reconcile"} onClick={() => setTab("reconcile")}>
          Reconciliation
        </Tab>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {RANGES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setRangeId(entry.id)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
                rangeId === entry.id ? "bg-ink text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "waste" && data && (
        <WasteLog data={data} reason={reason} onReason={setReason} from={from} to={to} />
      )}
      {tab === "counts" && <CountsPanel onCounted={() => void reload()} />}
      {tab === "reconcile" && <ReconcilePanel />}

      {logging && <LogWasteModal onClose={() => setLogging(false)} onLogged={() => { setLogging(false); void reload(); }} />}
      {counting && <CountModal onClose={() => setCounting(false)} onRecorded={() => { setCounting(false); void reload(); }} />}
    </div>
  );
}

function WasteLog({
  data,
  reason,
  onReason,
  from,
  to,
}: {
  data: WasteResponse;
  reason: string;
  onReason: (value: string) => void;
  from: string;
  to: string;
}) {
  const { summary, entries } = data;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card accent="var(--color-late)">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Value wasted</p>
          <p className="tnum mt-1 text-2xl font-black text-late">{formatMoney(summary.totalValue)}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            {formatDay(from)} → {formatDay(to)}
          </p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Entries</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{summary.entries}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            {summary.entries ? formatMoney(Math.round(summary.totalValue / summary.entries)) : "Rs 0"} average per entry
          </p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Worst reason</p>
          <p className="mt-1 truncate text-2xl font-black capitalize text-ink">{summary.byReason[0]?.reason ?? "—"}</p>
          <p className="tnum mt-0.5 text-[11px] text-ink-faint">
            {summary.byReason[0] ? `${formatMoney(summary.byReason[0].value)} across ${summary.byReason[0].count}` : "Nothing logged"}
          </p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Worst item</p>
          <p className="mt-1 truncate text-2xl font-black text-ink">{summary.topItems[0]?.key ?? "—"}</p>
          <p className="tnum mt-0.5 text-[11px] text-ink-faint">
            {summary.topItems[0] ? formatMoney(summary.topItems[0].value) : "Nothing logged"}
          </p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card pad={false}>
          <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2.5">
            <span className="text-[13px] font-bold text-ink">Entries</span>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => onReason("all")}
                className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
                  reason === "all" ? "bg-ink text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
                }`}
              >
                All reasons
              </button>
              {data.reasons.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => onReason(entry)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-bold capitalize transition-colors ${
                    reason === entry ? "bg-ink text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
                  }`}
                >
                  {entry}
                </button>
              ))}
            </div>
            <span className="tnum ml-auto text-[12px] font-semibold text-ink-faint">{entries.length} shown</span>
          </div>

          {entries.length === 0 ? (
            <Empty
              title="No waste logged in this window"
              hint="That is either good news or a discipline problem — check the counts tab to find out which."
              icon="waste"
            />
          ) : (
            <div className="scroll-y max-h-[560px] overflow-auto">
              <table className="grid-table">
                <thead className="sticky top-0">
                  <tr>
                    <th>When</th>
                    <th>Item</th>
                    <th>Reason</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Value</th>
                    <th>Logged by</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="tnum whitespace-nowrap text-[11px] text-ink-faint">
                        {formatDay(entry.businessDate ?? entry.createdAt)} {formatClock(entry.createdAt)}
                      </td>
                      <td>
                        <span className="block font-semibold text-ink">{entry.itemName}</span>
                        {entry.notes && <span className="block truncate text-[11px] italic text-ink-faint">“{entry.notes}”</span>}
                      </td>
                      <td>
                        <span
                          className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold capitalize text-white"
                          style={{ background: REASON_TONE[entry.reason] ?? "var(--color-ink-faint)" }}
                        >
                          {entry.reason}
                        </span>
                      </td>
                      <td className="tnum text-right font-bold">
                        {formatQuantity(entry.quantity, 2)} <span className="text-[11px] font-normal text-ink-faint">{entry.unit}</span>
                      </td>
                      <td className="tnum text-right font-bold text-late">{formatMoney(entry.value)}</td>
                      <td className="truncate text-[12px] text-ink-soft">{entry.loggedBy || "system"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="By reason" icon="waste">
            {summary.byReason.length === 0 ? (
              <Empty title="Nothing to break down" icon="waste" />
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Donut
                  segments={summary.byReason.map((entry) => ({
                    label: entry.reason,
                    value: entry.value,
                    tone: REASON_TONE[entry.reason] ?? "var(--color-ink-faint)",
                  }))}
                  centre={formatMoneyShort(summary.totalValue)}
                  sub="lost"
                  size={150}
                />
                <ul className="w-full space-y-1">
                  {summary.byReason.map((entry) => (
                    <li key={entry.reason} className="flex items-center gap-2 text-[12px]">
                      <span className="size-2.5 rounded-full" style={{ background: REASON_TONE[entry.reason] ?? "var(--color-ink-faint)" }} />
                      <span className="flex-1 capitalize font-semibold text-ink-soft">{entry.reason}</span>
                      <span className="tnum text-ink-faint">{entry.count}</span>
                      <span className="tnum w-20 text-right font-bold text-ink">{formatMoney(entry.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card title="Costliest items" icon="alert" subtitle="Where the money is actually going.">
            {summary.topItems.length === 0 ? (
              <Empty title="No waste recorded" icon="alert" />
            ) : (
              <BarList
                rows={summary.topItems.map((entry) => ({
                  label: entry.key,
                  value: entry.value,
                  tone: "var(--color-late)",
                }))}
                format={(value) => formatMoneyShort(value)}
              />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function CountsPanel({ onCounted }: { onCounted: () => void }) {
  const [applied, setApplied] = useState<"all" | "pending" | "applied">("all");
  const [busy, setBusy] = useState<string | null>(null);

  const query = qs({ limit: 200, sheet: 16, ...(applied === "all" ? {} : { applied: applied === "applied" }) });
  const { data, reload } = usePoll<CountsResponse>(`counts?${query}`, { interval: 30000 });

  const counts = data?.counts ?? [];
  const sheet = data?.sheet ?? [];

  const pending = useMemo(() => counts.filter((entry) => !entry.applied), [counts]);
  const pendingValue = useMemo(
    () => pending.reduce((total, entry) => total + Math.abs(entry.varianceValue), 0),
    [pending],
  );

  const apply = useCallback(
    async (count: CountRecord) => {
      setBusy(count.id);
      try {
        await api.post(`counts/${count.id}/apply`, {});
        toast(
          `${count.itemName} corrected by ${count.variance > 0 ? "+" : ""}${formatQuantity(count.variance, 2)} ${count.unit}`,
          "ok",
        );
        await reload();
        onCounted();
      } catch (error) {
        toast(errorMessage(error), "late");
      } finally {
        setBusy(null);
      }
    },
    [reload, onCounted],
  );

  if (!data) {
    return (
      <div className="p-6">
        <Empty title="Loading counts…" icon="inventory" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Counts recorded</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{counts.length}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">{pending.length} awaiting a decision</p>
        </Card>
        <Card accent="var(--color-warn)">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Unapplied variance</p>
          <p className="tnum mt-1 text-2xl font-black text-warn">{formatMoney(pendingValue)}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Absolute value still on the books</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Net variance</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">
            {formatMoney(counts.reduce((total, entry) => total + entry.varianceValue, 0))}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Negative means stock went missing</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Applied</p>
          <p className="tnum mt-1 text-2xl font-black text-ok">{counts.filter((entry) => entry.applied).length}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Posted to stock with an audit entry</p>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card
          pad={false}
          title="Count records"
          icon="inventory"
          subtitle="A count is a claim about physical reality; applying it is what corrects the book stock."
          action={
            <div className="flex gap-1">
              {(["all", "pending", "applied"] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setApplied(entry)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-bold capitalize transition-colors ${
                    applied === entry ? "bg-ink text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
                  }`}
                >
                  {entry}
                </button>
              ))}
            </div>
          }
        >
          {counts.length === 0 ? (
            <Empty title="No counts recorded yet" hint="Count the high-risk items below to start." icon="inventory" />
          ) : (
            <div className="scroll-x">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>When</th>
                    <th className="text-right">Expected</th>
                    <th className="text-right">Counted</th>
                    <th className="text-right">Variance</th>
                    <th className="text-right">Value</th>
                    <th>Counted by</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {counts.map((entry) => (
                    <tr key={entry.id} style={{ opacity: entry.applied ? 0.7 : 1 }}>
                      <td className="font-semibold text-ink">{entry.itemName}</td>
                      <td className="tnum whitespace-nowrap text-[11px] text-ink-faint">
                        {formatDay(entry.businessDate ?? entry.createdAt)} {formatClock(entry.createdAt)}
                      </td>
                      <td className="tnum text-right">
                        {formatQuantity(entry.expected, 2)} <span className="text-[11px] text-ink-faint">{entry.unit}</span>
                      </td>
                      <td className="tnum text-right font-bold">
                        {formatQuantity(entry.counted, 2)} <span className="text-[11px] font-normal text-ink-faint">{entry.unit}</span>
                      </td>
                      <td
                        className="tnum text-right font-black"
                        style={{ color: entry.variance === 0 ? "var(--color-ink-faint)" : entry.variance > 0 ? "var(--color-ok)" : "var(--color-late)" }}
                      >
                        {entry.variance > 0 ? "+" : ""}
                        {formatQuantity(entry.variance, 2)}
                      </td>
                      <td
                        className="tnum text-right font-bold"
                        style={{ color: entry.varianceValue < 0 ? "var(--color-late)" : entry.varianceValue > 0 ? "var(--color-ok)" : undefined }}
                      >
                        {entry.varianceValue > 0 ? "+" : entry.varianceValue < 0 ? "−" : ""}
                        {formatMoney(Math.abs(entry.varianceValue))}
                      </td>
                      <td className="truncate text-[12px] text-ink-soft">{entry.countedBy || "system"}</td>
                      <td className="text-right">
                        {entry.applied ? (
                          <Chip tone="ok">Applied</Chip>
                        ) : (
                          <Button variant="soft" size="sm" disabled={busy === entry.id} onClick={() => void apply(entry)}>
                            <Icon name="check" className="size-3.5" />
                            Apply
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Suggested count sheet"
          icon="star"
          subtitle="Prioritised by risk: out of stock first, then the most valuable."
        >
          {sheet.length === 0 ? (
            <Empty title="Nothing to count" icon="star" />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {sheet.map((item) => (
                <li key={item.id} className="rounded-lg border border-rule bg-paper px-2.5 py-1.5">
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] font-bold text-ink">{item.name}</span>
                    <span className="tnum shrink-0 text-[11px] text-ink-faint">{formatMoney(item.value)}</span>
                  </p>
                  <p className="tnum flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-ink-soft">
                      {formatQuantity(item.currentStock, 2)} {item.unit} on the books
                    </span>
                    <Chip tone={item.reason === "Out of stock" ? "late" : item.reason === "Below reorder point" ? "warn" : "neutral"}>
                      {item.reason}
                    </Chip>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Theoretical versus physical for a single day, with the ledger that explains the gap. */
function ReconcilePanel() {
  const [date, setDate] = useState(today());
  const { data } = usePoll<ReconciliationResponse>(`reconciliation?${qs({ date })}`, { interval: 30000 });

  const countsByItem = useMemo(() => {
    const map = new Map<string, CountRecord>();
    for (const count of data?.counts ?? []) map.set(count.inventoryItemId, count);
    return map;
  }, [data]);

  const wasteByItem = useMemo(() => {
    const map = new Map<string, { quantity: number; value: number }>();
    for (const entry of data?.waste ?? []) {
      const bucket = map.get(entry.inventoryItemId) ?? { quantity: 0, value: 0 };
      bucket.quantity += entry.quantity;
      bucket.value += entry.value;
      map.set(entry.inventoryItemId, bucket);
    }
    return map;
  }, [data]);

  const rows = useMemo(() => {
    return (data?.opening ?? []).map((row) => {
      const count = countsByItem.get(row.itemId);
      const waste = wasteByItem.get(row.itemId);
      // Book position today = opening + every movement since.
      const book = row.opening + row.movements;
      const variance = count ? count.counted - book : null;
      return { ...row, book, count, waste, variance };
    });
  }, [data, countsByItem, wasteByItem]);

  const unexplained = rows.filter((row) => row.variance !== null && Math.abs(row.variance) > 0.001);

  if (!data) {
    return (
      <div className="p-6">
        <Empty title="Loading reconciliation…" icon="report" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-[15px] font-bold text-ink">Reconcile a single day</h2>
            <p className="text-[12px] text-ink-faint">
              Opening stock is back-computed from the ledger, so the theoretical position is always explained by real
              movements rather than assumed.
            </p>
          </div>
          <label className="ml-auto flex items-center gap-2 text-[12px] font-semibold text-ink-soft">
            Date
            <input className="field !w-auto tnum" type="date" value={date} max={today()} onChange={(event) => setDate(event.target.value)} />
          </label>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Items tracked</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{rows.length}</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Counted</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{rows.filter((row) => row.count).length}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Physical counts on record</p>
        </Card>
        <Card accent="var(--color-late)">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Variances</p>
          <p className="tnum mt-1 text-2xl font-black text-late">{unexplained.length}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Book stock does not match the shelf</p>
        </Card>
        <Card accent="var(--color-warn)">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Waste logged</p>
          <p className="tnum mt-1 text-2xl font-black text-warn">{formatMoney(data.waste.reduce((total, entry) => total + entry.value, 0))}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">{data.waste.length} entries on this date</p>
        </Card>
      </div>

      <Card pad={false} title="Theoretical versus physical" icon="report" subtitle="Only items with a count on record can be reconciled.">
        {rows.filter((row) => row.count).length === 0 ? (
          <Empty
            title="No counts recorded for this date"
            hint="Record a physical count on the previous tab and the reconciliation appears here."
            icon="report"
          />
        ) : (
          <div className="scroll-x">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right">Opening</th>
                  <th className="text-right">Movements</th>
                  <th className="text-right">Book stock</th>
                  <th className="text-right">Counted</th>
                  <th className="text-right">Variance</th>
                  <th className="text-right">Waste logged</th>
                  <th>Explained?</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((row) => row.count)
                  .map((row) => {
                    const wasteQty = row.waste?.quantity ?? 0;
                    // A shortage that waste already accounts for is explained; the rest is not.
                    const explained = row.variance !== null && wasteQty > 0 && Math.abs(row.variance) <= wasteQty + 0.001;
                    return (
                      <tr key={row.itemId}>
                        <td className="font-semibold text-ink">{row.name}</td>
                        <td className="tnum text-right text-ink-faint">{formatQuantity(row.opening, 2)}</td>
                        <td className="tnum text-right">
                          <span style={{ color: row.movements < 0 ? "var(--color-late)" : "var(--color-ok)" }}>
                            {row.movements > 0 ? "+" : ""}
                            {formatQuantity(row.movements, 2)}
                          </span>
                        </td>
                        <td className="tnum text-right font-bold">{formatQuantity(row.book, 2)}</td>
                        <td className="tnum text-right font-bold">{formatQuantity(row.count?.counted ?? 0, 2)}</td>
                        <td
                          className="tnum text-right font-black"
                          style={{
                            color:
                              row.variance === null || Math.abs(row.variance) < 0.001
                                ? "var(--color-ink-faint)"
                                : row.variance > 0
                                  ? "var(--color-ok)"
                                  : "var(--color-late)",
                          }}
                        >
                          {row.variance !== null && row.variance > 0 ? "+" : ""}
                          {row.variance === null ? "—" : formatQuantity(row.variance, 2)}
                        </td>
                        <td className="tnum text-right text-warn">{wasteQty ? formatQuantity(wasteQty, 2) : "—"}</td>
                        <td>
                          {row.variance === null || Math.abs(row.variance) < 0.001 ? (
                            <Chip tone="ok">Balanced</Chip>
                          ) : explained ? (
                            <Chip tone="warn">Covered by waste</Chip>
                          ) : (
                            <Chip tone="late">Unexplained</Chip>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Ledger for this date" icon="inventory" subtitle="Every movement that explains the theoretical column.">
        {data.ledger.length === 0 ? (
          <Empty title="No stock movements recorded" icon="inventory" />
        ) : (
          <div className="scroll-y max-h-80 overflow-auto">
            <table className="grid-table">
              <thead className="sticky top-0">
                <tr>
                  <th>When</th>
                  <th>Item</th>
                  <th>Reason</th>
                  <th className="text-right">Movement</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td className="tnum whitespace-nowrap text-[11px] text-ink-faint">{formatClock(entry.createdAt)}</td>
                    <td className="font-semibold text-ink">{entry.itemName}</td>
                    <td className="text-[12px] text-ink-soft">{entry.reason}</td>
                    <td
                      className="tnum text-right font-bold"
                      style={{ color: entry.delta < 0 ? "var(--color-late)" : "var(--color-ok)" }}
                    >
                      {entry.delta > 0 ? "+" : ""}
                      {formatQuantity(entry.delta, 2)} {entry.unit}
                    </td>
                    <td className="truncate text-[11px] text-ink-faint">{entry.actor || "system"}</td>
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

function LogWasteModal({ onClose, onLogged }: { onClose: () => void; onLogged: () => void }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("spoiled");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .get<{ items: InventoryItem[] }>("inventory")
      .then((response) => {
        if (live) setItems(response.items);
      })
      .catch((error) => {
        if (live) toast(errorMessage(error), "late");
      });
    return () => {
      live = false;
    };
  }, []);

  const item = items.find((entry) => entry.id === itemId);
  const qty = Number(quantity) || 0;
  const value = item ? Math.round(qty * item.unitCost) : 0;
  const exceeds = item ? qty > item.currentStock : false;

  return (
    <Modal
      open
      onClose={onClose}
      title="Log waste"
      subtitle="Waste comes straight off stock, so what you record here is what disappears from the shelf."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !item || qty <= 0 || exceeds}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("waste", { inventoryItemId: itemId, quantity: qty, reason, notes: notes.trim() });
                toast(`Logged ${formatQuantity(qty, 2)} ${item?.unit} of ${item?.name} as ${reason}`, "ok");
                onLogged();
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            Log {value ? formatMoney(value) : "waste"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Item">
          <select className="field" value={itemId} onChange={(event) => setItemId(event.target.value)} autoFocus>
            <option value="">Choose an inventory item…</option>
            {items.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} — {formatQuantity(entry.currentStock, 2)} {entry.unit} on hand
              </option>
            ))}
          </select>
        </Field>

        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={item ? `Quantity (${item.unit})` : "Quantity"}>
            <TextInput value={quantity} onChange={setQuantity} type="number" step="0.01" min="0" className="tnum" placeholder="0" />
          </Field>
          <Field label="Reason">
            <select className="field" value={reason} onChange={(event) => setReason(event.target.value)}>
              {["spoiled", "dropped", "expired", "overcook", "theft", "other"].map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Notes" hint="Optional, but useful when the variance is questioned later.">
          <TextInput value={notes} onChange={setNotes} placeholder="Freezer failed overnight…" />
        </Field>

        {item && qty > 0 && (
          <div
            className="rounded-lg px-3 py-2 text-[12px] font-semibold"
            style={{
              background: exceeds ? "var(--color-late-soft)" : "var(--color-warn-soft)",
              color: exceeds ? "#96271a" : "#8a5d10",
            }}
          >
            {exceeds
              ? `Only ${formatQuantity(item.currentStock, 2)} ${item.unit} on hand — you cannot waste more than you hold.`
              : `This removes ${formatQuantity(qty, 2)} ${item.unit} worth ${formatMoney(value)}, leaving ${formatQuantity(item.currentStock - qty, 2)} ${item.unit}.`}
          </div>
        )}
      </div>
    </Modal>
  );
}

function CountModal({ onClose, onRecorded }: { onClose: () => void; onRecorded: () => void }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [sheet, setSheet] = useState<{ id: string; name: string; unit: string; currentStock: number; reason: string }[]>([]);
  const [itemId, setItemId] = useState("");
  const [counted, setCounted] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([api.get<{ items: InventoryItem[] }>("inventory"), api.get<CountsResponse>("counts?sheet=16")])
      .then(([inventory, counts]) => {
        if (!live) return;
        setItems(inventory.items);
        setSheet(counts.sheet);
      })
      .catch((error) => {
        if (live) toast(errorMessage(error), "late");
      });
    return () => {
      live = false;
    };
  }, []);

  const item = items.find((entry) => entry.id === itemId);
  const value = Number(counted);
  const variance = item && Number.isFinite(value) ? value - item.currentStock : 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Record a physical count"
      subtitle="Nothing changes on the books until the count is applied — you get a chance to look at the variance first."
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !item || counted.trim() === ""}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("counts", { inventoryItemId: itemId, counted: value });
                toast(
                  `Counted ${formatQuantity(value, 2)} ${item?.unit} of ${item?.name} — variance ${variance > 0 ? "+" : ""}${formatQuantity(variance, 2)}`,
                  Math.abs(variance) < 0.001 ? "ok" : "warn",
                );
                onRecorded();
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            Record count
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {sheet.length > 0 && (
          <div>
            <p className="label">Suggested — highest risk first</p>
            <div className="flex flex-wrap gap-1.5">
              {sheet.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    setItemId(entry.id);
                    setCounted("");
                  }}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                    itemId === entry.id ? "border-brand-500 bg-brand-50 text-brand-700" : "border-rule bg-paper text-ink-soft hover:border-brand-300"
                  }`}
                  title={entry.reason}
                >
                  {entry.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <Field label="Item">
          <select className="field" value={itemId} onChange={(event) => { setItemId(event.target.value); setCounted(""); }} autoFocus>
            <option value="">Choose an inventory item…</option>
            {items.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} — book stock {formatQuantity(entry.currentStock, 2)} {entry.unit}
              </option>
            ))}
          </select>
        </Field>

        <Field label={item ? `What did you actually count? (${item.unit})` : "Counted quantity"}>
          <TextInput value={counted} onChange={setCounted} type="number" step="0.01" min="0" className="tnum" placeholder="0" />
        </Field>

        {item && counted.trim() !== "" && (
          <div
            className="rounded-lg px-3 py-2 text-[12px] font-semibold"
            style={{
              background: Math.abs(variance) < 0.001 ? "var(--color-ok-soft)" : variance < 0 ? "var(--color-late-soft)" : "var(--color-warn-soft)",
              color: Math.abs(variance) < 0.001 ? "#1f6b43" : variance < 0 ? "#96271a" : "#8a5d10",
            }}
          >
            {Math.abs(variance) < 0.001
              ? "Book stock matches the shelf — no correction needed."
              : `Variance ${variance > 0 ? "+" : ""}${formatQuantity(variance, 2)} ${item.unit}, worth ${formatMoney(Math.abs(Math.round(variance * item.unitCost)))}. ${
                  variance < 0 ? "Stock is missing — check waste and theft before applying." : "More than the books say."
                }`}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Tab({ active, onClick, count, children }: { active: boolean; onClick: () => void; count?: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-bold transition-colors ${
        active ? "border-brand-500 text-brand-700" : "border-transparent text-ink-faint hover:text-ink-soft"
      }`}
    >
      {children}
      {count !== undefined && <span className="tnum rounded-full bg-paper-sunken px-1.5 text-[11px]">{count}</span>}
    </button>
  );
}
