"use client";

/**
 * Screen 17 — Floor Plan Builder.
 *
 * A table that is misplaced is invisible for the rest of the night, which is why
 * every edit here writes a geometry record rather than a view preference: the
 * same x, y, size and rotation the host stand and the POS read, so what you see
 * here is what the floor is actually using.
 *
 * Changes are staged locally and committed as one layout write, so a drag that
 * goes wrong costs one click to undo rather than six. Tables holding a live
 * ticket refuse to be deleted, and a table's status is deliberately not editable
 * here — that belongs to the host stand, where the ticket is being worked.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { usePoll, useStore } from "@/lib/store";
import { Button, Card, Chip, Empty, Field, Icon, Modal, TextInput, Toggle, toast, type Tone } from "@/components/ui";
import { formatMoneyShort } from "@/domain/money";
import { elapsedLabel } from "@/domain/time";
import { SHAPES, TABLE_STATUS_COLOR, TABLE_STATUS_LABEL } from "@/domain/tables";
import type { Section, TableSnapshot } from "@/types";

interface FloorResponse {
  sections: Section[];
  tables: TableSnapshot[];
  stats: { total: number; occupied: number; seats: number; guests: number; dirty: number; byStatus: Record<string, number> };
  servers: { id: string; name: string }[];
  transitions: Record<string, string[]>;
  statuses: string[];
}

const CANVAS_W = 1240;
const CANVAS_H = 820;
const MIN_W = 56;
const MIN_H = 44;
const GRID = 8;

const SHAPE_ICON: Record<string, string> = {
  round: "⬤",
  square: "⬛",
  rect: "▭",
  booth: "🚶",
  bar: "───",
};

export default function FloorPlanPage() {
  const { allowed } = useStore();
  const canEdit = allowed("admin.floorplan");

  const [layout, setLayout] = useState<Record<string, { x: number; y: number; w: number; h: number; rotation: number }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creatingSection, setCreatingSection] = useState(false);

  const { data, reload } = usePoll<FloorResponse>("floor", { interval: 30000 });
  const tables = data?.tables ?? [];
  const sections = data?.sections ?? [];

  /** Working copy of geometry; the server's copy stays authoritative until saved. */
  const geometry = useCallback(
    (table: TableSnapshot) => layout[table.id] ?? { x: table.x, y: table.y, w: table.w, h: table.h, rotation: table.rotation },
    [layout],
  );

  const place = useCallback(
    (id: string, next: Partial<{ x: number; y: number; w: number; h: number; rotation: number }>) => {
      setLayout((current) => {
        const base = tables.find((entry) => entry.id === id);
        const prior = current[id] ?? (base ? { x: base.x, y: base.y, w: base.w, h: base.h, rotation: base.rotation } : null);
        if (!prior) return current;
        return { ...current, [id]: { ...prior, ...next } };
      });
      setDirty(true);
    },
    [tables],
  );

  const reset = useCallback(() => {
    setLayout({});
    setDirty(false);
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const response = await api.put<FloorResponse>("floor/layout", {
        tables: tables.map((table) => {
          const geo = geometry(table);
          return {
            id: table.id,
            label: table.label,
            sectionId: table.sectionId,
            capacity: table.capacity,
            shape: table.shape,
            x: Math.round(geo.x),
            y: Math.round(geo.y),
            w: Math.round(geo.w),
            h: Math.round(geo.h),
            rotation: Math.round(geo.rotation),
          };
        }),
      });
      toast(`Layout saved — ${response.tables.length} tables committed`, "ok");
      setLayout({});
      setDirty(false);
      await reload();
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }, [tables, geometry, reload]);

  const selectedTable = tables.find((entry) => entry.id === selected) ?? null;

  if (!data) {
    return (
      <div className="p-6">
        <Empty title="Loading the floor plan…" icon="floor" />
      </div>
    );
  }

  const stats = data.stats;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[19px] font-extrabold text-ink">Floor Plan</h1>
          <p className="text-[12px] text-ink-faint">
            Drag, resize and rotate tables — the geometry here is what the host stand and the POS read.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {dirty && (
            <Chip tone="warn">
              <Icon name="alert" className="size-3.5" />
              {Object.keys(layout).length} table(s) changed — save to commit
            </Chip>
          )}
          <Button variant="ghost" disabled={!dirty || busy} onClick={reset}>
            <Icon name="refresh" className="size-4" />
            Discard
          </Button>
          <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
            <Icon name="check" className="size-4" />
            Save layout
          </Button>
          <Button variant="soft" onClick={() => setCreatingSection(true)}>
            <Icon name="plus" className="size-4" />
            New section
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Tables</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{stats.total}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">{stats.seats} seats in total</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Occupied</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{stats.occupied}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">{stats.guests} guests seated</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Available</p>
          <p className="tnum mt-1 text-2xl font-black text-ok">{stats.byStatus.available ?? 0}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Empty and clean</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Ordered</p>
          <p className="tnum mt-1 text-2xl font-black text-warn">{stats.byStatus.ordered ?? 0}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Ticket open on the table</p>
        </Card>
        <Card accent="var(--color-late)">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Dirty</p>
          <p className="tnum mt-1 text-2xl font-black text-late">{stats.dirty}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">Needs clearing before it can be seated</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Sections</p>
          <p className="tnum mt-1 text-2xl font-black text-ink">{sections.length}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">{sections.filter((section) => section.sortOrder > 0).length} after the first</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* ------------------------------------------------------------------ canvas */}
        <Card pad={false} accent="var(--color-rule)">
          <div className="flex items-center gap-3 border-b border-rule px-3 py-2.5">
            <Icon name="floor" className="size-4 text-ink-faint" />
            <span className="text-[12px] font-bold text-ink-soft">
              {CANVAS_W} × {CANVAS_H}
              {dirty ? " · unsaved edits" : " · saved"}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {data.statuses.map((status) => (
                <span key={status} className="flex items-center gap-1 text-[10px] font-bold capitalize text-ink-faint">
                  <span className="size-2.5 rounded-full" style={{ background: TABLE_STATUS_COLOR[status as keyof typeof TABLE_STATUS_COLOR] }} />
                  {TABLE_STATUS_LABEL[status as keyof typeof TABLE_STATUS_LABEL]}
                  {stats.byStatus[status] ?? 0}
                </span>
              ))}
            </div>
          </div>

          <div className="scroll-x">
            <div
              className="relative bg-[repeating-linear-gradient(to_right,var(--color-paper-sunken)_0_1px,transparent_1px_40px),repeating-linear-gradient(to_bottom,var(--color-paper-sunken)_0_1px,transparent_1px_40px)] bg-paper"
              style={{ width: CANVAS_W, height: CANVAS_H }}
            >
              {/* Section zones — the bounding box of each section's tables. */}
              {sections.map((section) => {
                const zoneTables = tables.filter((entry) => entry.sectionId === section.id);
                if (zoneTables.length === 0) return null;
                const boxes = zoneTables.map((entry) => geometry(entry));
                const minX = Math.min(...boxes.map((box) => box.x)) - 40;
                const minY = Math.min(...boxes.map((box) => box.y)) - 40;
                const maxX = Math.max(...boxes.map((box) => box.x + box.w)) + 40;
                const maxY = Math.max(...boxes.map((box) => box.y + box.h)) + 40;
                return (
                  <div
                    key={section.id}
                    className="absolute rounded-2xl border-2 border-dashed"
                    style={{
                      left: minX,
                      top: minY,
                      width: Math.max(0, maxX - minX),
                      height: Math.max(0, maxY - minY),
                      borderColor: section.color,
                      background: `${section.color}14`,
                    }}
                  >
                    <span
                      className="absolute -top-6 left-2 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white"
                      style={{ background: section.color }}
                    >
                      {section.name} · {zoneTables.length}
                    </span>
                  </div>
                );
              })}

              <div className="absolute inset-0">
                {tables.length === 0 && (
                  <div className="grid h-full place-items-center p-10 text-center">
                    <Empty title="No tables on the floor" hint="Add one to start building the room." icon="table" />
                  </div>
                )}
                {tables.map((table) => {
                  const geo = geometry(table);
                  const isSelected = selected === table.id;
                  return (
                    <TableCard
                      key={table.id}
                      table={table}
                      geometry={geo}
                      sectionColor={sections.find((entry) => entry.id === table.sectionId)?.color}
                      selected={isSelected}
                      canEdit={canEdit}
                      onSelect={() => setSelected(table.id)}
                      onMove={(next) => place(table.id, next)}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {!canEdit && (
            <p className="border-t border-rule px-3 py-2 text-[11px] text-ink-faint">
              Read-only — you do not hold admin.floorplan.
            </p>
          )}
        </Card>

        {/* ------------------------------------------------------------- properties */}
        <div className="flex flex-col gap-4">
          {selectedTable ? (
            <Card
              title={
                <span className="flex items-center gap-2">
                  <Icon name="table" className="size-4" />
                  {selectedTable.label}
                </span>
              }
              subtitle={`${selectedTable.sectionName || "No section"} · ${selectedTable.capacity} seats`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone={statusTone(selectedTable.status)} dot>
                  {TABLE_STATUS_LABEL[selectedTable.status as keyof typeof TABLE_STATUS_LABEL]}
                </Chip>
                {selectedTable.guests > 0 && <Chip tone="info">{selectedTable.guests} guests</Chip>}
                {selectedTable.serverName && <Chip tone="neutral">{selectedTable.serverName}</Chip>}
              </div>

              {selectedTable.orderId && (
                <p className="mt-2 rounded-lg bg-paper-sunken px-2.5 py-1.5 text-[11px] text-ink-soft">
                  <span className="font-bold">Live ticket · {formatMoneyShort(selectedTable.totalPaisa)}</span> ·{" "}
                  {selectedTable.checkNumber ? `check #${selectedTable.checkNumber}` : "not yet billed"} ·{" "}
                  {selectedTable.oldestItemMinutes > 0
                    ? `oldest item ${durationLabel(selectedTable.oldestItemMinutes)}`
                    : `${selectedTable.itemCount} item(s)`}
                </p>
              )}

              {selectedTable.seatedAt && (
                <p className="mt-1 text-[11px] text-ink-faint">Seated {elapsedLabel(selectedTable.seatedAt)} ago</p>
              )}

              <div className="mt-3 flex flex-col gap-2">
                <Toggle
                  checked={Boolean(selectedTable.sectionId)}
                  onChange={(value) => selectedTable.sectionId && void moveSection(selectedTable, value ? selectedTable.sectionId : null)}
                  label="Has a section"
                  disabled={!canEdit}
                />
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-1.5 text-[11px]">
                <Metric label="Position" value={`${Math.round(geometry(selectedTable).x)}, ${Math.round(geometry(selectedTable).y)}`} />
                <Metric label="Size" value={`${Math.round(geometry(selectedTable).w)} × ${Math.round(geometry(selectedTable).h)}`} />
                <Metric label="Rotation" value={`${Math.round(geometry(selectedTable).rotation)}°`} />
                <Metric label="Shape" value={SHAPE_ICON[selectedTable.shape] ?? selectedTable.shape} />
              </dl>

              {canEdit && (
                <div className="mt-3 flex flex-col gap-1.5 border-t border-rule pt-3">
                  <Button
                    variant="soft"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      const next = geometry(selectedTable);
                      place(selectedTable.id, { rotation: (next.rotation + 45) % 360 });
                    }}
                  >
                    <Icon name="refresh" className="size-3.5" />
                    Rotate 45°
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      try {
                        await api.del(`floor/tables/${selectedTable.id}`);
                        toast(`${selectedTable.label} removed from the floor`, "neutral");
                        setSelected(null);
                        await reload();
                      } catch (error) {
                        toast(errorMessage(error), "late");
                      }
                    }}
                  >
                    <Icon name="trash" className="size-3.5" />
                    Remove this table
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                    Deselect
                  </Button>
                </div>
              )}
            </Card>
          ) : (
            <Card title="Table properties" icon="table" subtitle="Select a table to inspect it.">
              <Empty title="Nothing selected" hint="Tap a table on the canvas." icon="table" />
              {canEdit && (
                <Button
                  variant="soft"
                  className="mt-2"
                  size="sm"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const nextLabel = `T${tables.length + 1}`;
                      await api.post("floor/tables", {
                        label: nextLabel,
                        sectionId: sections[0]?.id ?? null,
                        capacity: 4,
                        shape: "round",
                        x: 120 + (tables.length % 6) * 200,
                        y: 140 + Math.floor(tables.length / 6) * 160,
                      });
                      toast(`${nextLabel} added`, "ok");
                      await reload();
                    } catch (error) {
                      toast(errorMessage(error), "late");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Icon name="plus" className="size-3.5" />
                  Add a table
                </Button>
              )}
            </Card>
          )}

          <Card title="Sections" icon="floor">
            <ul className="flex flex-col gap-1">
              {sections.map((section) => (
                <li key={section.id} className="flex items-center gap-2 rounded-lg border border-rule bg-paper px-2.5 py-1.5">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: section.color }} aria-hidden="true" />
                  <span className="flex-1 truncate text-[12px] font-bold text-ink">{section.name}</span>
                  <span className="tnum text-[11px] text-ink-faint">
                    {tables.filter((entry) => entry.sectionId === section.id).length} tables
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="What is live right now" icon="clock">
            <ul className="flex flex-col gap-1">
              {tables
                .filter((entry) => entry.status !== "available")
                .slice(0, 8)
                .map((entry) => (
                  <li key={entry.id} className="flex items-center gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate font-bold text-ink">{entry.label}</span>
                    <span className="text-[11px] text-ink-faint">{TABLE_STATUS_LABEL[entry.status as keyof typeof TABLE_STATUS_LABEL]}</span>
                    <span className="tnum shrink-0 text-[11px] font-semibold text-ink-soft">
                      {entry.guests > 0 ? `${entry.guests}p` : ""}
                      {entry.totalPaisa > 0 ? ` · ${formatMoneyShort(entry.totalPaisa)}` : ""}
                    </span>
                  </li>
                ))}
              {tables.filter((entry) => entry.status !== "available").length === 0 && (
                <li className="text-[12px] text-ink-faint">The floor is clear — every table is available.</li>
              )}
            </ul>
          </Card>
        </div>
      </div>

      {creatingSection && (
        <SectionEditor
          onClose={() => setCreatingSection(false)}
          onSaved={() => {
            setCreatingSection(false);
            void reload();
          }}
        />
      )}
    </div>
  );

  async function moveSection(table: TableSnapshot, sectionId: string | null) {
    try {
      await api.patch(`floor/tables/${table.id}`, { sectionId });
      toast(`${table.label} moved to ${sections.find((entry) => entry.id === sectionId)?.name ?? "no section"}`, "ok");
      await reload();
    } catch (error) {
      toast(errorMessage(error), "late");
    }
  }
}

/** Minutes since a stamp as a compact duration — `elapsedLabel` wants a stamp. */
function durationLabel(minutes: number): string {
  if (!(minutes > 0)) return "now";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function statusTone(status: string): Tone {
  void 0;
  switch (status) {
    case "available":
      return "ok";
    case "seated":
      return "info";
    case "ordered":
      return "warn";
    case "billed":
      return "brand";
    case "dirty":
      return "late";
    default:
      return "neutral";
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 rounded-lg bg-paper-sunken px-2 py-1">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="tnum font-bold text-ink-soft">{value}</dd>
    </div>
  );
}

/** One draggable, resizable, rotating table on the canvas. */
function TableCard({
  table,
  geometry,
  sectionColor,
  selected,
  canEdit,
  onSelect,
  onMove,
}: {
  table: TableSnapshot;
  geometry: { x: number; y: number; w: number; h: number; rotation: number };
  sectionColor?: string;
  selected: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onMove: (next: Partial<{ x: number; y: number; w: number; h: number; rotation: number }>) => void;
}) {
  const drag = useRef<{ mode: "move" | "resize"; startX: number; startY: number; x: number; y: number; w: number; h: number } | null>(null);
  const pointerId = useRef<number | null>(null);

  const onPointerDown = (mode: "move" | "resize", event: React.PointerEvent<HTMLDivElement>) => {
    if (!canEdit) return;
    drag.current = { mode, startX: event.clientX, startY: event.clientY, x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h };
    pointerId.current = event.pointerId;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    event.stopPropagation();
    onSelect();
  };

  // Drag math lives on the window so the table does not escape under the cursor.
  useEffect(() => {
    const update = (event: PointerEvent) => {
      const state = drag.current;
      if (!state || pointerId.current === null) return;
      const stepX = Math.round((event.clientX - state.startX) / 1);
      const stepY = Math.round((event.clientY - state.startY) / 1);
      if (state.mode === "move") {
        onMove({ x: Math.max(0, Math.min(CANVAS_W - state.w, Math.round((state.x + stepX) / GRID) * GRID)), y: Math.max(0, Math.min(CANVAS_H - state.h, Math.round((state.y + stepY) / GRID) * GRID)) });
      } else {
        onMove({ w: Math.max(MIN_W, Math.round((state.w + stepX) / GRID) * GRID), h: Math.max(MIN_H, Math.round((state.h + stepY) / GRID) * GRID) });
      }
    };
    const end = (event: PointerEvent) => {
      if (pointerId.current === null) return;
      try {
        (event.target as HTMLElement).releasePointerCapture(pointerId.current);
      } catch {
        /* the element may already be gone */
      }
      pointerId.current = null;
      drag.current = null;
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [onMove]);

  const live = useMemo(
    () => ({ ...geometry, rotation: geometry.rotation % 360 }),
    [geometry],
  );

  return (
    <div
      className={`absolute select-none ${canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
      style={{
        left: live.x,
        top: live.y,
        width: live.w,
        height: live.h,
        transform: `rotate(${live.rotation}deg)`,
        transformOrigin: "center",
        zIndex: selected ? 20 : 10,
        outline: selected ? "2px solid var(--color-ink)" : "2px solid transparent",
        outlineOffset: 2,
      }}
      onPointerDown={(event) => onPointerDown("move", event)}
      onClick={(event) => {
        if (!canEdit) onSelect();
        event.stopPropagation();
      }}
      onDoubleClick={() => canEdit && onSelect()}
    >
      <div
        className="flex h-full w-full flex-col items-center justify-center rounded-xl border-2 text-center"
        style={{
          borderColor: sectionColor ?? "var(--color-rule)",
          background: `linear-gradient(160deg, ${table.status === "available" ? "var(--color-paper-raised)" : TABLE_STATUS_COLOR[table.status as keyof typeof TABLE_STATUS_COLOR]}, color-mix(in srgb, ${sectionColor ?? TABLE_STATUS_COLOR[table.status as keyof typeof TABLE_STATUS_COLOR]} 60%, var(--color-paper)) )`,
          color: "var(--color-ink)",
          boxShadow: selected ? "0 0 0 3px var(--color-ink-soft)" : undefined,
        }}
      >
        <span aria-hidden="true">{SHAPE_ICON[table.shape] ?? "⬤"}</span>
        <span className="tnum text-[13px] font-black leading-tight">{table.label}</span>
        <span className="tnum text-[10px] font-bold leading-tight text-ink-faint">{table.capacity}p</span>
        {table.guests > 0 && (
          <span className="mt-0.5 rounded-full bg-white/85 px-1.5 py-0.5 tnum text-[10px] font-black">
            {table.guests}
          </span>
        )}
        {table.totalPaisa > 0 && <span className="tnum text-[9px] font-bold leading-tight text-ink-faint">{formatMoneyShort(table.totalPaisa)}</span>}
      </div>

      {canEdit && (
        <div
          className="absolute -bottom-2.5 -right-2.5 grid size-5 cursor-nwse-resize place-items-center rounded-full border-2 border-ink bg-white text-ink-soft shadow"
          onPointerDown={(event) => onPointerDown("resize", event)}
          aria-label={`Resize ${table.label}`}
        >
          <Icon name="chevronDown" className="size-3 rotate-[-45deg]" />
        </div>
      )}
    </div>
  );
}

function SectionEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#c2542f");
  const [busy, setBusy] = useState(false);

  const palette = useMemo(() => {
    const base = ["#c2542f", "#3d6ea8", "#3f8f5f", "#8a5aa8", "#c98a1e", "#6b7280", "#0f766e", "#9f1239"];
    return base;
  }, []);

  return (
    <Modal
      open
      onClose={onClose}
      title="New section"
      subtitle="Sections group tables on the plan and colour them on the POS. Deleting a section works only once it is empty."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post("floor/sections", { name: name.trim(), color });
                toast(`${name.trim()} added`, "ok");
                onSaved();
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            Create section
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Section name">
          <TextInput value={name} onChange={setName} autoFocus placeholder="Terrace, Bar Lounge…" />
        </Field>
        <Field label="Colour">
          <div className="flex flex-wrap gap-1.5">
            {palette.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setColor(entry)}
                className={`size-9 rounded-lg transition-transform ${color === entry ? "outline outline-2 outline-ink outline-offset-2" : ""}`}
                style={{ background: entry }}
                aria-label={`colour ${entry}`}
              />
            ))}
          </div>
        </Field>
        <div
          className="rounded-xl border border-rule bg-paper px-3 py-2"
          style={{ borderColor: color }}
        >
          <p className="text-[12px] font-bold text-ink">Preview</p>
          <div className="mt-1.5 flex gap-2">
            <span className="grid size-10 place-items-center rounded-lg border-2 text-[12px] font-black" style={{ borderColor: color }}>
              T1
            </span>
            <span className="grid size-10 place-items-center rounded-lg border-2 text-[12px] font-black" style={{ borderColor: color }}>
              T2
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
