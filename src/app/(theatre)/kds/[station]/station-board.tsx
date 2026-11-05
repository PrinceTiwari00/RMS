"use client";

/**
 * Screen 7 — KDS Station View (theatre mode).
 *
 * This screen is read at arm's length in a bright, wet, loud room, often with
 * gloves on. Everything about it follows from that: one station's work only,
 * colour-banded by how late it is, tap targets the size of a palm, and no
 * interaction that requires reading small text or hitting a precise pixel.
 *
 * A line is a single tap to mark ready, and a tap again undoes a mistap — the
 * most common error on a KDS has to be the cheapest to fix.
 */
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { api, errorMessage } from "@/lib/api";
import { usePoll, useStore, useTicker } from "@/lib/store";
import { Icon, toast } from "@/components/ui";
import { COURSE_LABEL } from "@/domain/kds";
import type { KdsMetrics, KdsTicket, OrderLine, StationInfo } from "@/types";

interface StationResponse {
  station: StationInfo;
  tickets: KdsTicket[];
  pendingCount: number;
  holdCount: number;
  readyCount: number;
  oldestMinutes: number;
  itemCount: number;
  metrics: KdsMetrics;
}

const URGENCY_LABEL: Record<string, string> = {
  hold: "On hold",
  ok: "Working",
  warn: "Getting up",
  late: "LATE",
  ready: "Ready",
};

export function StationBoard({ station }: { station: string }) {
  const { state, allowed } = useStore();
  useTicker(10000);

  const canReady = allowed("kds.ready");
  const { data } = usePoll<StationResponse>(`kds/${station}`, { interval: 2000 });
  const [busyLine, setBusyLine] = useState<string | null>(null);

  const stations = state?.stations ?? [];
  const tickets = data?.tickets ?? [];

  /** Per-station live counts, so the tabs show load without another request. */
  const loadByStation = useMemo(() => {
    const map = new Map<string, KdsMetrics["byStation"][number]>();
    for (const entry of data?.metrics.byStation ?? []) map.set(entry.station.id, entry);
    return map;
  }, [data]);

  const working = tickets.filter((ticket) => !ticket.allReady);
  const done = tickets.filter((ticket) => ticket.allReady);

  const toggleLine = useCallback(
    async (line: OrderLine) => {
      setBusyLine(line.id);
      try {
        if (line.kdsStatus === "READY") {
          await api.post(`kds/lines/${line.id}/unready`, {});
          toast(`${line.name} put back on the rail`, "neutral");
        } else {
          const result = await api.post<{ allReady: boolean }>(`kds/lines/${line.id}/ready`, {});
          if (result.allReady) toast(`Ticket ready for the pass`, "ok");
        }
      } catch (error) {
        toast(errorMessage(error), "late");
      } finally {
        setBusyLine(null);
      }
    },
    [],
  );

  const readyAll = useCallback(async (ticket: KdsTicket) => {
    try {
      const result = await api.post<{ marked: number; allReady: boolean }>(`kds/orders/${ticket.orderId}/ready-all`, {});
      toast(`${result.marked} item(s) marked ready`, "ok");
    } catch (error) {
      toast(errorMessage(error), "late");
    }
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-stage text-stage-ink">
      {/* ------------------------------------------------------------- station bar */}
      <header className="flex flex-wrap items-center gap-2 border-b border-stage-rule bg-stage-raised px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="size-3 rounded-full" style={{ background: data?.station.color ?? "var(--color-brand-500)" }} />
          <h1 className="text-lg font-black uppercase tracking-wide">{data?.station.name ?? station}</h1>
        </div>

        <nav className="flex flex-wrap gap-1" aria-label="Kitchen stations">
          {stations.map((entry) => {
            const load = loadByStation.get(entry.id);
            const active = entry.id === station;
            return (
              <Link
                key={entry.id}
                href={`/kds/${entry.id}`}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-extrabold uppercase tracking-wide transition-colors"
                style={{
                  background: active ? entry.color : "var(--color-stage-card)",
                  color: active ? "#fff" : "var(--color-stage-soft)",
                  border: `1px solid ${active ? entry.color : "var(--color-stage-rule)"}`,
                }}
              >
                {entry.name}
                {load && load.pending + load.hold > 0 && (
                  <span className="tnum rounded-full bg-black/30 px-1.5 text-[10px]">{load.pending + load.hold}</span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <Counter label="Pending" value={data?.pendingCount ?? 0} />
          <Counter label="Hold" value={data?.holdCount ?? 0} tone="var(--color-stage-soft)" />
          <Counter label="Ready" value={data?.readyCount ?? 0} tone="var(--color-ok)" />
          <Counter
            label="Oldest"
            value={`${data?.oldestMinutes ?? 0}m`}
            tone={(data?.oldestMinutes ?? 0) > 15 ? "var(--color-late)" : (data?.oldestMinutes ?? 0) > 8 ? "var(--color-warn)" : undefined}
          />
          {(data?.metrics.lateTickets ?? 0) > 0 && (
            <span className="flex items-center gap-1.5 rounded-lg bg-late px-2.5 py-1.5 text-[12px] font-black uppercase text-white">
              <Icon name="alert" className="size-4" />
              {data?.metrics.lateTickets} late
            </span>
          )}
        </div>
      </header>

      {/* ------------------------------------------------------------------ rail */}
      <main className="scroll-y flex-1 p-3">
        {tickets.length === 0 ? (
          <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center">
            <span className="flex size-20 items-center justify-center rounded-full bg-stage-card text-stage-soft">
              <Icon name="check" className="size-10" />
            </span>
            <p className="text-2xl font-black uppercase tracking-wide">Station clear</p>
            <p className="max-w-md text-sm text-stage-soft">
              Nothing on the rail for {data?.station.name ?? station}. New tickets appear here the moment a server sends
              them.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {working.map((ticket) => (
                <TicketCard
                  key={ticket.orderId}
                  ticket={ticket}
                  canReady={canReady}
                  busyLine={busyLine}
                  onToggleLine={toggleLine}
                  onReadyAll={readyAll}
                />
              ))}
            </div>

            {done.length > 0 && (
              <section className="mt-4">
                <h2 className="mb-2 text-[13px] font-black uppercase tracking-[0.09em] text-stage-soft">
                  Waiting for the pass ({done.length})
                </h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                  {done.map((ticket) => (
                    <TicketCard
                      key={ticket.orderId}
                      ticket={ticket}
                      canReady={canReady}
                      busyLine={busyLine}
                      onToggleLine={toggleLine}
                      onReadyAll={readyAll}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Counter({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="text-center">
      <p className="tnum text-lg font-black leading-none" style={{ color: tone ?? "var(--color-stage-ink)" }}>
        {value}
      </p>
      <p className="text-[9px] font-bold uppercase tracking-[0.08em] text-stage-soft">{label}</p>
    </div>
  );
}

function TicketCard({
  ticket,
  canReady,
  busyLine,
  onToggleLine,
  onReadyAll,
}: {
  ticket: KdsTicket;
  canReady: boolean;
  busyLine: string | null;
  onToggleLine: (line: OrderLine) => void;
  onReadyAll: (ticket: KdsTicket) => void;
}) {
  const late = ticket.urgency === "late";
  const warn = ticket.urgency === "warn";
  const ready = ticket.allReady;
  const remaining = ticket.lines.filter((line) => line.kdsStatus !== "READY").length;

  return (
    <article
      className={`stage-card urg-${ticket.urgency} flex flex-col overflow-hidden`}
      aria-label={`Ticket for ${ticket.tableLabel || "order"}, ${ticket.minutesElapsed} minutes old`}
    >
      {/* Ticket header — table and age are the two things a cook reads first. */}
      <header className="flex items-start gap-2 border-b border-stage-rule px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xl font-black leading-tight">
            {ticket.tableLabel || ticket.channel.replace("_", " ")}
            <span className="tnum ml-2 text-sm font-bold text-stage-soft">#{ticket.checkNumber ?? "—"}</span>
          </p>
          <p className="truncate text-[11px] font-semibold text-stage-soft">
            {ticket.serverName || "Unassigned"}
            {ticket.guests > 0 && ` · ${ticket.guests} guests`}
            {ticket.channel !== "dine_in" && ` · ${ticket.channel.replace("_", " ")}`}
            {ticket.firedAt && " · FIRED"}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p
            className="tnum text-2xl font-black leading-none"
            style={{ color: late ? "var(--color-late)" : warn ? "var(--color-warn)" : "var(--color-stage-ink)" }}
          >
            {ticket.minutesElapsed}
            <span className="text-sm">m</span>
          </p>
          <p
            className="text-[9px] font-black uppercase tracking-[0.08em]"
            style={{ color: late ? "var(--color-late)" : warn ? "var(--color-warn)" : "var(--color-stage-soft)" }}
          >
            {URGENCY_LABEL[ticket.urgency] ?? ticket.urgency}
          </p>
        </div>
      </header>

      {ticket.note && (
        <p className="border-b border-stage-rule bg-warn/12 px-3 py-1.5 text-[12px] font-bold italic text-warn">
          “{ticket.note}”
        </p>
      )}

      {/* Lines — each one a palm-sized tap target. */}
      <ul className="flex-1 divide-y divide-stage-rule">
        {ticket.lines.map((line) => (
          <li key={line.id}>
            <button
              type="button"
              disabled={!canReady || busyLine === line.id}
              onClick={() => onToggleLine(line)}
              className="flex w-full items-start gap-2.5 px-3 py-3 text-left transition-colors disabled:opacity-60"
              style={{
                background:
                  line.kdsStatus === "READY"
                    ? "color-mix(in srgb, var(--color-ok) 16%, transparent)"
                    : line.urgency === "late"
                      ? "color-mix(in srgb, var(--color-late) 14%, transparent)"
                      : "transparent",
              }}
            >
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-lg text-base font-black"
                style={{
                  background: line.kdsStatus === "READY" ? "var(--color-ok)" : "var(--color-stage-raised)",
                  color: line.kdsStatus === "READY" ? "#fff" : "var(--color-stage-ink)",
                  border: `1px solid ${line.kdsStatus === "READY" ? "var(--color-ok)" : "var(--color-stage-rule)"}`,
                }}
              >
                {line.kdsStatus === "READY" ? <Icon name="check" className="size-5" /> : line.quantity}
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-base font-extrabold leading-tight"
                  style={{ textDecoration: line.kdsStatus === "READY" ? "line-through" : undefined }}
                >
                  {line.name}
                </span>
                {line.modifiers.map((modifier) => (
                  <span key={modifier.id} className="block truncate text-[12px] font-semibold text-warn">
                    {modifier.name}
                  </span>
                ))}
                {line.note && <span className="block truncate text-[12px] italic text-stage-soft">“{line.note}”</span>}
                <span className="mt-0.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-stage-soft">
                  <span>{COURSE_LABEL[line.course] ?? line.course}</span>
                  {line.seat > 0 && <span>· seat {line.seat}</span>}
                  <span className="tnum">· {line.minutesElapsed}m</span>
                  {line.kdsStatus === "HOLD" && <span className="text-warn">· hold</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <footer className="flex items-center gap-2 border-t border-stage-rule bg-stage-raised px-3 py-2">
        {ready ? (
          <p className="flex items-center gap-1.5 text-[13px] font-black uppercase tracking-wide text-ok">
            <Icon name="check" className="size-4" />
            All {ticket.lines.length} ready — waiting for expo
          </p>
        ) : (
          <>
            <p className="tnum text-[12px] font-bold text-stage-soft">
              {remaining} of {ticket.lines.length} left
            </p>
            {canReady && remaining > 1 && (
              <button type="button" onClick={() => onReadyAll(ticket)} className="stage-btn stage-btn-go ml-auto !px-3 !py-2 !text-[13px]">
                <Icon name="check" className="size-4" />
                All ready
              </button>
            )}
          </>
        )}
      </footer>
    </article>
  );
}
