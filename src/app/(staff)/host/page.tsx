"use client";

/**
 * Screen 6 — Waitlist & Reservation Management.
 *
 * The host's real problem is the promise they made at the door. Every waiting
 * party therefore shows quoted minutes against minutes actually waited, and the
 * card turns amber, then red, as that promise erodes — the host should see a
 * table slipping before the guest does.
 *
 * Seating a party is the pivot of the whole screen: it picks the smallest table
 * that fits (never wasting a six-top on a couple), marks the table seated and
 * optionally opens the ticket, in one action.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, qs } from "@/lib/api";
import { usePoll, useStore, useTicker } from "@/lib/store";
import { Button, Card, Chip, Empty, Icon, Modal, TextInput, toast } from "@/components/ui";
import { atClock, formatClock, formatDay, today } from "@/domain/time";
import type { GuestAlert, Reservation, Section, TableSnapshot, WaitlistParty } from "@/types";

interface HostSummary {
  waiting: number;
  notified: number;
  coversWaiting: number;
  averageWait: number;
  longestWait: number;
  reservationsToday: number;
  upcomingToday: number;
  seatedToday: number;
  noShows: number;
  nextReservation: string | null;
  queue: WaitlistParty[];
}

interface HostResponse {
  date: string;
  summary: HostSummary;
  waitlist: WaitlistParty[];
  reservations: Reservation[];
  alerts: GuestAlert[];
  suggestedTable: TableSnapshot | null;
}

interface FloorResponse {
  sections: Section[];
  tables: TableSnapshot[];
}

const SOURCES = [
  { id: "phone", label: "Phone" },
  { id: "walk_in", label: "Walk-in" },
  { id: "online", label: "Online" },
  { id: "third_party", label: "Third party" },
];

export default function HostPage() {
  const { allowed } = useStore();
  const router = useRouter();
  useTicker(20000); // keep the wait timers honest

  const [seating, setSeating] = useState<WaitlistParty | null>(null);
  const [addingParty, setAddingParty] = useState(false);
  const [addingReservation, setAddingReservation] = useState(false);
  const [tab, setTab] = useState<"waitlist" | "reservations">("waitlist");

  // The suggested table is sized off the party currently being seated.
  const { data, reload } = usePoll<HostResponse>(`host?${qs({ party: seating?.partySize ?? 0, alerts: 15 })}`, {
    interval: 3000,
  });

  const waitlist = data?.waitlist ?? [];
  const reservations = data?.reservations ?? [];
  const summary = data?.summary;

  const live = useMemo(() => waitlist.filter((party) => party.status === "waiting" || party.status === "notified"), [waitlist]);
  const resolved = useMemo(() => waitlist.filter((party) => party.status !== "waiting" && party.status !== "notified"), [waitlist]);

  const setStatus = useCallback(
    async (party: WaitlistParty, status: WaitlistParty["status"]) => {
      try {
        await api.patch(`host/waitlist/${party.id}`, { status });
        toast(`${party.guestName} marked ${status.replace("_", " ")}`, "ok");
        await reload();
      } catch (error) {
        toast(errorMessage(error), "late");
      }
    },
    [reload],
  );

  const notify = useCallback(
    async (party: WaitlistParty) => {
      try {
        const result = await api.post<{ message: string }>(`host/waitlist/${party.id}/notify`, {});
        toast(result.message || `${party.guestName} notified`, "ok");
        await reload();
      } catch (error) {
        toast(errorMessage(error), "late");
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (party: WaitlistParty) => {
      try {
        await api.del(`host/waitlist/${party.id}`);
        toast(`${party.guestName} removed from the list`, "neutral");
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
        <Empty title="Loading the host stand…" icon="host" />
      </div>
    );
  }

  const groupedReservations = groupByDay(reservations);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[17px] font-extrabold text-ink">Host Stand</h1>
        <Chip tone="neutral">{formatDay(data.date)}</Chip>
        <div className="ml-auto flex gap-1.5">
          {allowed("host.waitlist") && (
            <Button variant="primary" onClick={() => setAddingParty(true)}>
              <Icon name="plus" className="size-4" />
              Add to waitlist
            </Button>
          )}
          {allowed("host.waitlist") && (
            <Button variant="soft" onClick={() => setAddingReservation(true)}>
              <Icon name="schedule" className="size-4" />
              New reservation
            </Button>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------- headline */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Waiting" value={String(summary?.waiting ?? 0)} sub={`${summary?.coversWaiting ?? 0} covers in the queue`} />
        <Stat label="Notified" value={String(summary?.notified ?? 0)} sub="Table almost ready" tone={summary?.notified ? "info" : "neutral"} />
        <Stat label="Average wait" value={`${summary?.averageWait ?? 0}m`} sub="Across the queue" />
        <Stat
          label="Longest wait"
          value={`${summary?.longestWait ?? 0}m`}
          sub={summary?.longestWait && summary.longestWait > 30 ? "Over half an hour" : "Within tolerance"}
          tone={(summary?.longestWait ?? 0) > 30 ? "late" : (summary?.longestWait ?? 0) > 20 ? "warn" : "neutral"}
        />
        <Stat label="Seated today" value={String(summary?.seatedToday ?? 0)} sub={`${summary?.noShows ?? 0} no-shows`} />
        <Stat
          label="Reservations"
          value={String(summary?.upcomingToday ?? 0)}
          sub={summary?.nextReservation ?? `${summary?.reservationsToday ?? 0} booked today`}
          tone={summary?.upcomingToday ? "brand" : "neutral"}
        />
      </div>

      {/* ----------------------------------------------------------------- tabs */}
      <div className="flex gap-1.5 border-b border-rule">
        <TabButton active={tab === "waitlist"} onClick={() => setTab("waitlist")} count={live.length}>
          Waitlist
        </TabButton>
        <TabButton active={tab === "reservations"} onClick={() => setTab("reservations")} count={reservations.length}>
          Reservations
        </TabButton>
      </div>

      {tab === "waitlist" ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-3">
            <Card title="In the queue" icon="host" subtitle="Ordered by arrival — position 1 is next up">
              {live.length === 0 ? (
                <Empty title="No one is waiting" hint="The queue is clear. Add a party when a walk-in arrives." icon="host" />
              ) : (
                <div className="flex flex-col gap-2">
                  {live.map((party) => (
                    <WaitlistRow
                      key={party.id}
                      party={party}
                      canSeat={allowed("host.seat")}
                      onSeat={() => setSeating(party)}
                      onNotify={() => void notify(party)}
                      onStatus={(status) => void setStatus(party, status)}
                      onRemove={() => void remove(party)}
                    />
                  ))}
                </div>
              )}
            </Card>

            {resolved.length > 0 && (
              <Card title="Resolved today" icon="check">
                <div className="flex flex-wrap gap-1.5">
                  {resolved.slice(0, 16).map((party) => (
                    <Chip key={party.id} tone={party.status === "seated" ? "ok" : party.status === "no_show" ? "late" : "neutral"}>
                      {party.guestName} · {party.partySize}p · {party.status.replace("_", " ")}
                    </Chip>
                  ))}
                </div>
              </Card>
            )}
          </div>

          <Card title="Guest alerts" icon="phone" subtitle="SMS and notification log">
            {data.alerts.length === 0 ? (
              <Empty title="No alerts sent yet" icon="phone" />
            ) : (
              <ul className="flex flex-col gap-2">
                {data.alerts.map((alert) => (
                  <li key={alert.id} className="rounded-lg border border-rule bg-paper px-2.5 py-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">
                      <Icon name="phone" className="size-3" />
                      {alert.channel} · {formatClock(alert.createdAt)}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">{alert.message}</p>
                    <Chip tone={alert.status === "sent" ? "ok" : alert.status === "failed" ? "late" : "neutral"}>
                      {alert.status}
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {groupedReservations.length === 0 && (
            <Card>
              <Empty title="No reservations in the next week" icon="schedule" />
            </Card>
          )}
          {groupedReservations.map((group) => (
            <Card key={group.day} title={formatDay(group.day)} icon="schedule" subtitle={`${group.parties.length} booking(s)`}>
              <div className="flex flex-col gap-2">
                {group.parties.map((reservation) => (
                  <ReservationRow
                    key={reservation.id}
                    reservation={reservation}
                    onStatus={async (status, tableId) => {
                      try {
                        const result = await api.post<{ reservation: Reservation; orderId?: string | null }>(
                          `host/reservations/${reservation.id}/status`,
                          { status, tableId },
                        );
                        toast(`${reservation.guestName} · ${status.replace("_", " ")}`, "ok");
                        await reload();
                        const orderId = (result as { orderId?: string | null }).orderId;
                        if (orderId) router.push(`/checkout/${orderId}`);
                      } catch (error) {
                        toast(errorMessage(error), "late");
                      }
                    }}
                    onSeat={() =>
                      setSeating({
                        id: reservation.id,
                        guestName: reservation.guestName,
                        phone: reservation.phone,
                        partySize: reservation.partySize,
                        status: "waiting",
                        quotedMinutes: 0,
                        notes: reservation.notes,
                        tableId: reservation.tableId,
                        tableLabel: reservation.tableLabel,
                        createdAt: reservation.reservationAt,
                        notifiedAt: null,
                        seatedAt: null,
                        waitedMinutes: 0,
                        position: 0,
                        reservationId: reservation.id,
                      } as WaitlistParty & { reservationId: string })
                    }
                  />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      <SeatModal
        party={seating}
        suggested={data.suggestedTable}
        onClose={() => setSeating(null)}
        onSeated={async (orderId) => {
          setSeating(null);
          await reload();
          if (orderId) router.push(`/checkout/${orderId}`);
        }}
      />
      <AddPartyModal open={addingParty} onClose={() => setAddingParty(false)} onAdded={() => { setAddingParty(false); void reload(); }} />
      <AddReservationModal
        open={addingReservation}
        onClose={() => setAddingReservation(false)}
        onAdded={() => { setAddingReservation(false); void reload(); }}
      />
    </div>
  );
}

/** Bucket reservations by calendar day so the host can scan the week. */
function groupByDay(reservations: Reservation[]): { day: string; parties: Reservation[] }[] {
  const buckets = new Map<string, Reservation[]>();
  for (const reservation of reservations) {
    const day = reservation.reservationAt.slice(0, 10);
    const list = buckets.get(day) ?? [];
    list.push(reservation);
    buckets.set(day, list);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, parties]) => ({ day, parties: parties.sort((a, b) => a.reservationAt.localeCompare(b.reservationAt)) }));
}

function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "info" | "warn" | "late" | "brand";
}) {
  const colour =
    tone === "late"
      ? "var(--color-late)"
      : tone === "warn"
        ? "var(--color-warn)"
        : tone === "info"
          ? "var(--color-info)"
          : tone === "brand"
            ? "var(--color-brand-600)"
            : "var(--color-ink)";
  return (
    <div className="card px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.07em] text-ink-faint">{label}</p>
      <p className="tnum text-xl font-extrabold leading-tight" style={{ color: colour }}>
        {value}
      </p>
      {sub && <p className="truncate text-[11px] text-ink-faint">{sub}</p>}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-bold transition-colors ${
        active ? "border-brand-500 text-brand-700" : "border-transparent text-ink-faint hover:text-ink-soft"
      }`}
    >
      {children}
      <span className="tnum rounded-full bg-paper-sunken px-1.5 text-[11px]">{count}</span>
    </button>
  );
}

function WaitlistRow({
  party,
  canSeat,
  onSeat,
  onNotify,
  onStatus,
  onRemove,
}: {
  party: WaitlistParty;
  canSeat: boolean;
  onSeat: () => void;
  onNotify: () => void;
  onStatus: (status: WaitlistParty["status"]) => void;
  onRemove: () => void;
}) {
  const overQuote = party.quotedMinutes > 0 && party.waitedMinutes > party.quotedMinutes;
  const slipping = party.quotedMinutes > 0 && party.waitedMinutes > party.quotedMinutes * 1.5;
  const border = slipping ? "var(--color-late)" : overQuote ? "var(--color-warn)" : "var(--color-rule)";

  return (
    <div className="rounded-xl border bg-paper px-3 py-2.5" style={{ borderColor: border, borderWidth: slipping ? 2 : 1 }}>
      <div className="flex flex-wrap items-start gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-black text-white">
          {party.position}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-extrabold text-ink">
            {party.guestName}
            <span className="ml-1.5 text-[12px] font-semibold text-ink-faint">{party.partySize} guests</span>
          </p>
          {party.phone && (
            <a href={`tel:${party.phone}`} className="tnum text-[12px] text-ink-soft hover:text-brand-600 hover:underline">
              {party.phone}
            </a>
          )}
          {party.notes && <p className="mt-0.5 truncate text-[11px] italic text-ink-faint">“{party.notes}”</p>}
        </div>

        <div className="text-right">
          <p className="tnum text-[15px] font-black" style={{ color: slipping ? "var(--color-late)" : overQuote ? "var(--color-warn)" : "var(--color-ink)" }}>
            {party.waitedMinutes}m
          </p>
          <p className="tnum text-[11px] text-ink-faint">quoted {party.quotedMinutes}m</p>
        </div>

        <Chip tone={party.status === "notified" ? "info" : overQuote ? "warn" : "neutral"}>
          {party.status === "notified" ? "Notified" : overQuote ? "Over quote" : "Waiting"}
        </Chip>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5 border-t border-rule pt-2">
        {canSeat && (
          <Button variant="primary" size="sm" onClick={onSeat}>
            <Icon name="table" className="size-3.5" />
            Seat now
          </Button>
        )}
        {party.status === "waiting" && (
          <Button variant="soft" size="sm" onClick={onNotify}>
            <Icon name="phone" className="size-3.5" />
            Notify
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => onStatus("no_show")}>
          No-show
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onStatus("cancelled")}>
          Cancel
        </Button>
        <button type="button" onClick={onRemove} className="ml-auto text-ink-faint transition-colors hover:text-late" title="Remove from list">
          <Icon name="trash" className="size-4" />
        </button>
      </div>
    </div>
  );
}

function ReservationRow({
  reservation,
  onStatus,
  onSeat,
}: {
  reservation: Reservation;
  onStatus: (status: Reservation["status"], tableId?: string | null) => void;
  onSeat: () => void;
}) {
  const isToday = reservation.reservationAt.slice(0, 10) === today();
  const imminent = isToday && reservation.minutesUntil >= 0 && reservation.minutesUntil <= 30;
  const late = isToday && reservation.minutesUntil < 0 && reservation.status === "confirmed";

  return (
    <div
      className="rounded-xl border bg-paper px-3 py-2.5"
      style={{ borderColor: late ? "var(--color-late)" : imminent ? "var(--color-warn)" : "var(--color-rule)" }}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-14 shrink-0 text-center">
          <p className="tnum text-[15px] font-black text-ink">{formatClock(reservation.reservationAt)}</p>
          <p className="tnum text-[10px] font-semibold text-ink-faint">
            {reservation.minutesUntil >= 0 ? `in ${reservation.minutesUntil}m` : `${Math.abs(reservation.minutesUntil)}m ago`}
          </p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-extrabold text-ink">
            {reservation.guestName}
            <span className="ml-1.5 text-[12px] font-semibold text-ink-faint">{reservation.partySize} guests</span>
          </p>
          <p className="truncate text-[11px] text-ink-faint">
            {reservation.tableLabel ? `Table ${reservation.tableLabel}` : "No table assigned"}
            {reservation.source ? ` · ${reservation.source.replace("_", " ")}` : ""}
            {reservation.phone ? ` · ${reservation.phone}` : ""}
          </p>
          {reservation.notes && <p className="mt-0.5 truncate text-[11px] italic text-ink-faint">“{reservation.notes}”</p>}
        </div>
        <Chip
          tone={
            reservation.status === "seated"
              ? "ok"
              : reservation.status === "cancelled"
                ? "neutral"
                : reservation.status === "no_show"
                  ? "late"
                  : late
                    ? "late"
                    : imminent
                      ? "warn"
                      : "info"
          }
        >
          {reservation.status.replace("_", " ")}
        </Chip>
      </div>

      {reservation.status === "confirmed" && (
        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-rule pt-2">
          <Button variant="primary" size="sm" onClick={onSeat}>
            <Icon name="table" className="size-3.5" />
            Seat
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onStatus("cancelled")}>
            Cancel
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onStatus("no_show")}>
            No-show
          </Button>
        </div>
      )}
    </div>
  );
}

/** Seat a party: suggest the smallest table that fits, but let the host override. */
function SeatModal({
  party,
  suggested,
  onClose,
  onSeated,
}: {
  party: (WaitlistParty & { reservationId?: string }) | null;
  suggested: TableSnapshot | null;
  onClose: () => void;
  onSeated: (orderId: string | null) => void;
}) {
  const { data: floor } = usePoll<FloorResponse>("floor", { interval: 5000, enabled: Boolean(party) });
  const [tableId, setTableId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Default to the server's suggestion whenever the party changes.
  useEffect(() => {
    setTableId(suggested?.id ?? null);
  }, [suggested?.id, party?.id]);

  if (!party) return null;

  const tables = (floor?.tables ?? []).filter((table) => table.status === "available");
  const chosen = tables.find((table) => table.id === tableId) ?? suggested;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Seat ${party.guestName}`}
      subtitle={`${party.partySize} guests${party.phone ? ` · ${party.phone}` : ""}`}
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !chosen}
            onClick={async () => {
              if (!chosen) return;
              setBusy(true);
              try {
                if (party.reservationId) {
                  const result = await api.post<{ orderId?: string | null }>(`host/reservations/${party.reservationId}/status`, {
                    status: "seated",
                    tableId: chosen.id,
                  });
                  onSeated((result as { orderId?: string | null }).orderId ?? null);
                } else {
                  const result = await api.post<{ tableLabel: string; orderId: string | null }>(`host/waitlist/${party.id}/seat`, {
                    tableId: chosen.id,
                  });
                  toast(`Seated at ${result.tableLabel}`, "ok");
                  onSeated(result.orderId);
                }
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            <Icon name="check" className="size-4" />
            Seat at {chosen ? chosen.label : "…"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {suggested && (
          <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-[12px] text-brand-700">
            <Icon name="star" className="size-4 shrink-0" />
            <span>
              <strong>Suggested: table {suggested.label}</strong> — the smallest free table that seats{" "}
              {party.partySize} (capacity {suggested.capacity}).
            </span>
          </div>
        )}

        {tables.length === 0 ? (
          <Empty title="No tables are free right now" hint="Wait for a table to be cleaned, or seat at an occupied one from the floor plan." icon="table" />
        ) : (
          <div>
            <p className="label mb-1.5">Choose a table</p>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {tables.map((table) => {
                const fits = table.capacity >= party.partySize;
                const active = table.id === chosen?.id;
                return (
                  <button
                    key={table.id}
                    type="button"
                    onClick={() => setTableId(table.id)}
                    className={`flex flex-col items-center rounded-xl border-2 px-2 py-2 transition-colors ${
                      active ? "border-brand-500 bg-brand-50" : fits ? "border-rule bg-paper hover:border-brand-300" : "border-rule bg-paper-sunken opacity-55"
                    }`}
                    title={fits ? `Seats ${table.capacity}` : `Too small — seats ${table.capacity}`}
                  >
                    <span className="text-[13px] font-black text-ink">{table.label}</span>
                    <span className="tnum text-[10px] text-ink-faint">{table.capacity} seats</span>
                    {!fits && <span className="text-[9px] font-bold uppercase text-warn">too small</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function AddPartyModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [guestName, setGuestName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState("2");
  const [quoted, setQuoted] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const size = Math.max(1, Number(partySize) || 1);

  // Live quote so the host can answer "how long?" before committing the party.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void api
      .get<{ quotedMinutes: number }>(`host/waitlist/estimate?${qs({ party: size })}`)
      .then((response) => {
        if (live) setQuoted(String(response.quotedMinutes));
      })
      .catch(() => {
        if (live) setQuoted(null);
      });
    return () => {
      live = false;
    };
  }, [open, size]);

  useEffect(() => {
    if (!open) {
      setGuestName("");
      setPhone("");
      setPartySize("2");
      setNotes("");
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a party to the waitlist"
      subtitle={quoted !== null ? `Current estimate for ${size}: about ${quoted} minutes` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !guestName.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("host/waitlist", {
                  guestName: guestName.trim(),
                  phone: phone.trim(),
                  partySize: size,
                  quotedMinutes: quoted !== null ? Number(quoted) : undefined,
                  notes: notes.trim(),
                });
                toast(`${guestName.trim()} added to the waitlist`, "ok");
                onAdded();
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            Add party
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="label">Guest name</span>
          <TextInput value={guestName} onChange={setGuestName} placeholder="e.g. Sunita Yadav" autoFocus />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="label">Phone (for SMS)</span>
            <TextInput value={phone} onChange={setPhone} placeholder="98…" inputMode="tel" />
          </label>
          <label className="block">
            <span className="label">Party size</span>
            <TextInput value={partySize} onChange={setPartySize} type="number" min={1} inputMode="numeric" />
          </label>
        </div>
        <label className="block">
          <span className="label">Quoted wait (minutes)</span>
          <TextInput value={quoted ?? ""} onChange={setQuoted} type="number" min={0} inputMode="numeric" />
          <span className="mt-1 block text-[11px] text-ink-faint">
            Pre-filled from the live estimate, which accounts for the queue ahead and how fast tables are turning.
          </span>
        </label>
        <label className="block">
          <span className="label">Notes</span>
          <TextInput value={notes} onChange={setNotes} placeholder="High chair, birthday, wheelchair access…" />
        </label>
      </div>
    </Modal>
  );
}

function AddReservationModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [guestName, setGuestName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState("2");
  const [day, setDay] = useState(today());
  const [clock, setClock] = useState("19:00");
  const [source, setSource] = useState("phone");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setGuestName("");
      setPhone("");
      setPartySize("2");
      setNotes("");
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title="New reservation"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !guestName.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("host/reservations", {
                  guestName: guestName.trim(),
                  phone: phone.trim(),
                  partySize: Math.max(1, Number(partySize) || 1),
                  reservationAt: atClock(day, clock),
                  source,
                  notes: notes.trim(),
                });
                toast(`${guestName.trim()} booked for ${formatDay(day)} at ${clock}`, "ok");
                onAdded();
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            Book table
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="label">Guest name</span>
          <TextInput value={guestName} onChange={setGuestName} placeholder="e.g. Anil Chaudhary" autoFocus />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="label">Phone</span>
            <TextInput value={phone} onChange={setPhone} placeholder="98…" inputMode="tel" />
          </label>
          <label className="block">
            <span className="label">Party size</span>
            <TextInput value={partySize} onChange={setPartySize} type="number" min={1} inputMode="numeric" />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="label">Date</span>
            <input className="field" type="date" value={day} onChange={(event) => setDay(event.target.value)} />
          </label>
          <label className="block">
            <span className="label">Time</span>
            <input className="field tnum" type="time" value={clock} onChange={(event) => setClock(event.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className="label">Source</span>
          <select className="field" value={source} onChange={(event) => setSource(event.target.value)}>
            {SOURCES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Notes</span>
          <TextInput value={notes} onChange={setNotes} placeholder="Window seat, anniversary…" />
        </label>
        <Chip tone="info">
          <Icon name="alert" className="size-3" />
          A table can be assigned when the guest arrives — seating picks the smallest one that fits.
        </Chip>
      </div>
    </Modal>
  );
}
