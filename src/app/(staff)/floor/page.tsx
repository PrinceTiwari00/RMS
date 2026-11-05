"use client";

/**
 * Screen 4 — Table & Floor Plan View.
 *
 * A true 2D room, not a list: every table is drawn at its stored x/y/w/h in a
 * normalised 100-unit canvas, with its shape (round, square, rect, booth, bar)
 * and rotation respected. Status drives the fill colour and each occupied table
 * carries a live turn timer, so a server can spot a table that has been sitting
 * on its mains for twenty minutes without opening a ticket.
 *
 * Tables seeded with zero width/height (the private room, which has no fixed
 * place on the canvas yet) are still shown — collapsed into an "unplaced" tray
 * — because hiding a real table from the floor would be worse than drawing it
 * slightly wrong.
 */
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "@/lib/api";
import { usePoll, useStore, useTicker } from "@/lib/store";
import { Button, Card, Chip, Empty, Icon, Modal, TextInput, toast } from "@/components/ui";
import { formatMoney } from "@/domain/money";
import { ALLOWED_TRANSITIONS, TABLE_STATUS_LABEL, turnLabel, type TableStatus } from "@/domain/tables";
import type { Section, TableSnapshot } from "@/types";

interface FloorResponse {
  sections: Section[];
  tables: TableSnapshot[];
  stats: { total: number; occupied: number; seats: number; guests: number; dirty: number; byStatus: Record<string, number> };
  servers: { id: string; name: string; initials: string; color: string; roleTitle: string }[];
}

const STATUS_LEGEND: TableStatus[] = ["available", "seated", "ordered", "billed", "dirty"];

export default function FloorPage() {
  const { allowed } = useStore();
  const router = useRouter();
  useTicker(20000); // re-render so the turn timers stay live

  const { data, reload } = usePoll<FloorResponse>("floor", { interval: 3000 });
  const [sectionId, setSectionId] = useState("all");
  const [selected, setSelected] = useState<TableSnapshot | null>(null);
  const [seating, setSeating] = useState<TableSnapshot | null>(null);

  const sections = data?.sections ?? [];
  const tables = data?.tables ?? [];
  const stats = data?.stats;

  const visible = useMemo(
    () => (sectionId === "all" ? tables : tables.filter((table) => table.sectionId === sectionId)),
    [tables, sectionId],
  );
  const placed = visible.filter((table) => table.w > 0 && table.h > 0);
  const unplaced = visible.filter((table) => table.w <= 0 || table.h <= 0);

  const setStatus = useCallback(
    async (table: TableSnapshot, status: TableStatus) => {
      try {
        await api.post(`floor/tables/${table.id}/status`, { status });
        toast(`${table.label} → ${TABLE_STATUS_LABEL[status]}`, "ok");
        setSelected(null);
        await reload();
      } catch (error) {
        toast(errorMessage(error), "late");
      }
    },
    [reload],
  );

  const cleanTable = useCallback(
    async (table: TableSnapshot) => {
      try {
        await api.post(`floor/tables/${table.id}/clean`);
        toast(`${table.label} marked clean`, "ok");
        setSelected(null);
        await reload();
      } catch (error) {
        toast(errorMessage(error), "late");
      }
    },
    [reload],
  );

  if (!data) {
    return (
      <div className="p-6">
        <Empty title="Loading the floor plan…" icon="floor" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-49px)] min-h-[560px] flex-col">
      {/* ------------------------------------------------------------- header bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-paper-raised px-4 py-2.5">
        <h1 className="mr-2 text-[15px] font-extrabold text-ink">Floor Plan</h1>

        <div className="flex flex-wrap items-center gap-1">
          <FilterChip active={sectionId === "all"} onClick={() => setSectionId("all")}>
            All sections
          </FilterChip>
          {sections.map((section) => (
            <FilterChip key={section.id} active={sectionId === section.id} onClick={() => setSectionId(section.id)} color={section.color}>
              {section.name}
            </FilterChip>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {STATUS_LEGEND.map((status) => (
            <span key={status} className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-soft">
              <span className="size-2.5 rounded-sm" style={{ background: `var(--table-${status})` }} />
              {TABLE_STATUS_LABEL[status]}
              <span className="tnum text-ink-faint">{stats?.byStatus[status] ?? 0}</span>
            </span>
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------------- summary */}
      <div className="grid grid-cols-2 gap-2 px-4 py-2.5 sm:grid-cols-5">
        <MiniStat label="Occupancy" value={`${stats?.occupied ?? 0}/${stats?.total ?? 0}`} sub={`${occupancyPercent(stats)}% full`} />
        <MiniStat label="Guests seated" value={String(stats?.guests ?? 0)} sub={`${stats?.seats ?? 0} seats on the floor`} />
        <MiniStat
          label="Needs cleaning"
          value={String(stats?.dirty ?? 0)}
          tone={stats?.dirty ? "warn" : "neutral"}
          sub={stats?.dirty ? "Tap to reset" : "All tables ready"}
        />
        <MiniStat label="On order" value={String(stats?.byStatus.ordered ?? 0)} sub="Kitchen working" />
        <MiniStat label="Billed" value={String(stats?.byStatus.billed ?? 0)} sub="Awaiting payment" />
      </div>

      {/* ------------------------------------------------------------------- room */}
      <div className="scroll-y flex-1 px-4 pb-4">
        <div
          className="relative w-full overflow-hidden rounded-2xl border border-rule"
          style={{
            aspectRatio: "100 / 62",
            background:
              "repeating-linear-gradient(45deg, var(--color-paper-sunken) 0 12px, var(--color-paper) 12px 24px)",
          }}
        >
          {placed.map((table) => (
            <TableToken
              key={table.id}
              table={table}
              onClick={() => (allowed("host.seat") ? setSelected(table) : toast("You cannot manage the floor", "warn"))}
            />
          ))}

          {placed.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Empty title="No tables placed in this section" hint="Add them from the floor plan builder." icon="floor" />
            </div>
          )}
        </div>

        {unplaced.length > 0 && (
          <Card className="mt-3">
            <div className="mb-2 flex items-center gap-2">
              <Icon name="alert" className="size-4 text-warn" />
              <p className="text-[13px] font-bold text-ink">Not placed on the canvas ({unplaced.length})</p>
              <span className="text-[11px] text-ink-faint">These tables have no position yet — place them in the builder.</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {unplaced.map((table) => (
                <button key={table.id} type="button" onClick={() => setSelected(table)} className="btn btn-soft !py-1.5 !text-xs">
                  <span className="size-2.5 rounded-sm" style={{ background: `var(--table-${table.status})` }} />
                  {table.label} · seats {table.capacity}
                </button>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* ------------------------------------------------------------ table detail */}
      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Table ${selected.label}` : ""}
        subtitle={selected ? `${selected.sectionName} · seats ${selected.capacity} · ${TABLE_STATUS_LABEL[selected.status]}` : ""}
        width="max-w-md"
        footer={
          selected?.orderId ? (
            <Button variant="primary" onClick={() => router.push(`/checkout/${selected.orderId}`)}>
              <Icon name="cash" className="size-4" />
              Open payment
            </Button>
          ) : undefined
        }
      >
        {selected && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <DetailTile label="Status" value={TABLE_STATUS_LABEL[selected.status]} tone={`var(--table-${selected.status})`} />
              <DetailTile
                label="Turn time"
                value={selected.minutesSeated > 0 ? turnLabel(selected.minutesSeated) : "—"}
                warn={selected.minutesSeated > 75}
              />
              <DetailTile label="Guests" value={selected.guests > 0 ? String(selected.guests) : "—"} />
              <DetailTile label="Server" value={selected.serverName || "Unassigned"} />
              <DetailTile label="Items" value={String(selected.itemCount)} />
              <DetailTile label="Check total" value={selected.totalPaisa ? formatMoney(selected.totalPaisa) : "—"} />
            </div>

            {selected.oldestItemMinutes > 0 && (
              <div
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-semibold"
                style={{
                  background: selected.oldestItemMinutes > 15 ? "var(--color-late-soft)" : "var(--color-warn-soft)",
                  color: selected.oldestItemMinutes > 15 ? "#96271a" : "#8a5d10",
                }}
              >
                <Icon name="clock" className="size-4" />
                Oldest item has been waiting {selected.oldestItemMinutes} min
              </div>
            )}

            {selected.checkNumber && (
              <p className="text-[12px] text-ink-faint">
                Ticket #{selected.checkNumber} · {selected.orderStatus}
              </p>
            )}

            <div>
              <p className="label">Change status</p>
              <div className="flex flex-wrap gap-1.5">
                {(ALLOWED_TRANSITIONS[selected.status] ?? []).map((next) => (
                  <Button key={next} variant="soft" onClick={() => void setStatus(selected, next)}>
                    → {TABLE_STATUS_LABEL[next]}
                  </Button>
                ))}
                {(ALLOWED_TRANSITIONS[selected.status] ?? []).length === 0 && (
                  <p className="text-[12px] text-ink-faint">No further transitions from this state.</p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 border-t border-rule pt-3">
              {selected.status === "available" && allowed("host.seat") && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setSeating(selected);
                    setSelected(null);
                  }}
                >
                  <Icon name="host" className="size-4" />
                  Seat a party
                </Button>
              )}
              {selected.status === "dirty" && allowed("host.seat") && (
                <Button variant="primary" onClick={() => void cleanTable(selected)}>
                  <Icon name="check" className="size-4" />
                  Mark clean
                </Button>
              )}
              {selected.status !== "available" && allowed("host.seat") && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api.post(`floor/tables/${selected.id}/release`);
                      toast(`${selected.label} released`, "ok");
                      setSelected(null);
                      await reload();
                    } catch (error) {
                      toast(errorMessage(error), "late");
                    }
                  }}
                >
                  Release table
                </Button>
              )}
              {allowed("admin.floorplan") && (
                <Button variant="ghost" onClick={() => router.push("/admin/floorplan")}>
                  <Icon name="edit" className="size-4" />
                  Edit layout
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <SeatModal
        table={seating}
        servers={data.servers}
        onClose={() => setSeating(null)}
        onSeated={async (orderId) => {
          setSeating(null);
          await reload();
          if (orderId) router.push(`/checkout/${orderId}`);
        }}
      />
    </div>
  );
}

function occupancyPercent(stats?: FloorResponse["stats"]): number {
  if (!stats?.total) return 0;
  return Math.round((stats.occupied / stats.total) * 100);
}

/** One table drawn on the canvas, with its live turn timer. */
function TableToken({ table, onClick }: { table: TableSnapshot; onClick: () => void }) {
  const colour = `var(--table-${table.status})`;
  const occupied = table.status !== "available";
  const radius =
    table.shape === "round"
      ? "50%"
      : table.shape === "booth"
        ? "10px 10px 4px 4px"
        : table.shape === "bar"
          ? "6px"
          : "8px";
  const alert = table.oldestItemMinutes > 15 || table.minutesSeated > 90;

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${table.label} · ${TABLE_STATUS_LABEL[table.status]}${table.guests ? ` · ${table.guests} guests` : ""}`}
      className="absolute flex flex-col items-center justify-center gap-0.5 border-2 text-center transition-transform hover:z-10 hover:scale-[1.04] active:scale-[0.98]"
      style={{
        left: `${table.x}%`,
        top: `${table.y}%`,
        width: `${Math.max(table.w, 6)}%`,
        height: `${Math.max(table.h, 6)}%`,
        borderRadius: radius,
        borderColor: colour,
        background: occupied ? colour : "var(--color-paper-raised)",
        color: occupied ? "#fff" : "var(--color-ink)",
        transform: table.rotation ? `rotate(${table.rotation}deg)` : undefined,
        boxShadow: alert ? `0 0 0 3px color-mix(in srgb, var(--color-late) 45%, transparent)` : "0 1px 3px rgb(18 24 28 / 0.14)",
      }}
    >
      <span className="text-[13px] font-black leading-none">{table.label}</span>
      <span className="text-[9px] font-bold leading-none opacity-80">{table.capacity} seats</span>
      {occupied && table.minutesSeated > 0 && (
        <span className="tnum rounded-full bg-black/22 px-1.5 text-[9px] font-bold leading-tight">
          {turnLabel(table.minutesSeated)}
        </span>
      )}
      {table.status === "dirty" && <span className="text-[9px] font-black uppercase leading-none">clean me</span>}
    </button>
  );
}

function MiniStat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div className="card px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.07em] text-ink-faint">{label}</p>
      <p
        className="tnum text-lg font-extrabold leading-tight"
        style={{ color: tone === "warn" ? "var(--color-warn)" : "var(--color-ink)" }}
      >
        {value}
      </p>
      {sub && <p className="truncate text-[11px] text-ink-faint">{sub}</p>}
    </div>
  );
}

function DetailTile({ label, value, tone, warn }: { label: string; value: string; tone?: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-rule bg-paper px-2.5 py-1.5">
      <p className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="truncate text-[13px] font-bold" style={{ color: warn ? "var(--color-late)" : tone ?? "var(--color-ink)" }}>
        {value}
      </p>
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
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold transition-colors ${
        active ? "bg-ink text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
      }`}
    >
      {color && <span className="size-2 rounded-full" style={{ background: color }} />}
      {children}
    </button>
  );
}

/** Seat a party: choose size and server, optionally opening a ticket at once. */
function SeatModal({
  table,
  servers,
  onClose,
  onSeated,
}: {
  table: TableSnapshot | null;
  servers: FloorResponse["servers"];
  onClose: () => void;
  onSeated: (orderId: string | null) => void;
}) {
  const { user } = useStore();
  const [guests, setGuests] = useState("2");
  const [serverId, setServerId] = useState(user?.id ?? "");
  const [openTicket, setOpenTicket] = useState(true);
  const [busy, setBusy] = useState(false);

  if (!table) return null;
  const count = Math.max(1, Number(guests) || 1);
  const tooBig = count > table.capacity;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Seat at ${table.label}`}
      subtitle={`${table.sectionName} · capacity ${table.capacity}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || tooBig}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api.post<{ orderId: string | null; table: TableSnapshot }>(`floor/tables/${table.id}/seat`, {
                  guests: count,
                  serverId: serverId || null,
                  createOrder: openTicket,
                });
                toast(`${count} seated at ${table.label}`, "ok");
                onSeated(result.orderId);
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            Seat party
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="label">Party size</span>
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-soft !px-3" onClick={() => setGuests(String(Math.max(1, count - 1)))} aria-label="Fewer guests">
              <Icon name="minus" className="size-4" />
            </button>
            <TextInput value={String(count)} onChange={setGuests} type="number" min={1} className="!w-20 text-center" />
            <button type="button" className="btn btn-soft !px-3" onClick={() => setGuests(String(count + 1))} aria-label="More guests">
              <Icon name="plus" className="size-4" />
            </button>
            <div className="flex flex-wrap gap-1">
              {[2, 4, 6].map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => setGuests(String(size))}
                  className={`btn !px-2 !py-1 !text-xs ${count === size ? "btn-primary" : "btn-ghost"}`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
          {tooBig && (
            <span className="mt-1 block text-[11px] font-semibold text-late">
              {table.label} seats {table.capacity} — this party will not fit.
            </span>
          )}
        </label>

        <label className="block">
          <span className="label">Server</span>
          <select className="field" value={serverId} onChange={(event) => setServerId(event.target.value)}>
            <option value="">Unassigned</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name} — {server.roleTitle}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => setOpenTicket((current) => !current)}
          className="flex items-center gap-2.5 rounded-xl border border-rule bg-paper px-3 py-2.5 text-left"
          aria-pressed={openTicket}
        >
          <span
            className="flex size-5 shrink-0 items-center justify-center rounded-md border-2"
            style={{
              borderColor: openTicket ? "var(--color-brand-500)" : "var(--color-rule)",
              background: openTicket ? "var(--color-brand-500)" : "transparent",
            }}
          >
            {openTicket && <Icon name="check" className="size-3 text-white" />}
          </span>
          <span>
            <span className="block text-[13px] font-bold text-ink">Open a ticket now</span>
            <span className="block text-[11px] text-ink-faint">Otherwise the table is only marked seated.</span>
          </span>
        </button>

        <Chip tone="info">
          <Icon name="alert" className="size-3" />
          Seating moves the table to “Seated” and starts the turn timer.
        </Chip>
      </div>
    </Modal>
  );
}
