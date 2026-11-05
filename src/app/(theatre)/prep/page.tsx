"use client";

/**
 * Screen 9 — Recipe & Prep Sheet Viewer.
 *
 * A cook looking at this screen has wet hands and about four seconds of
 * attention, so the sheet is written for that: allergens first (they are the
 * only line that can hurt someone), then plating, then the method with a
 * tappable countdown for every step that carries a time.
 *
 * Items with no sheet at all are listed separately — that gap is a training
 * risk, and hiding it would be worse than showing it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, qs } from "@/lib/api";
import { usePoll, useStore, useTicker } from "@/lib/store";
import { Button, Icon, Modal, TextInput, toast } from "@/components/ui";
import { formatMoney } from "@/domain/money";
import type { PrepSheet, PrepStep } from "@/types";

type Sheet = PrepSheet & { price: number; course: string; categoryName: string | null };

interface PrepResponse {
  sheets: Sheet[];
  station: string;
  missing: { id: string; name: string; emoji: string; station: string }[];
}

export default function PrepPage() {
  const { state, allowed } = useStore();
  useTicker(1000); // drives the step countdowns

  const canEdit = allowed("admin.menu");
  const [stationFilter, setStationFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Sheet | null>(null);
  const [editing, setEditing] = useState<Sheet | null>(null);
  const [showMissing, setShowMissing] = useState(false);

  const path = `prep${stationFilter === "all" ? "" : `?${qs({ station: stationFilter })}`}`;
  const { data, reload } = usePoll<PrepResponse>(path, { interval: 15000 });

  const stations = state?.stations ?? [];
  const sheets = data?.sheets ?? [];
  const missing = data?.missing ?? [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sheets.filter((sheet) => {
      if (needle && !`${sheet.itemName} ${sheet.allergens} ${sheet.plating} ${sheet.categoryName ?? ""}`.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
  }, [sheets, query]);

  const stationName = useCallback(
    (id: string) => stations.find((entry) => entry.id === id)?.name ?? id,
    [stations],
  );

  return (
    <div className="flex min-h-screen flex-col bg-stage text-stage-ink">
      <header className="flex flex-wrap items-center gap-2 border-b border-stage-rule bg-stage-raised px-3 py-2">
        <h1 className="text-lg font-black uppercase tracking-wide">Prep & Plating</h1>

        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-stage-soft" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search dishes, allergens…"
            aria-label="Search prep sheets"
            className="w-56 rounded-lg border border-stage-rule bg-stage-card py-1.5 pl-8 pr-2.5 text-[13px] text-stage-ink placeholder:text-stage-soft focus:border-brand-400 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap gap-1">
          <StationTab active={stationFilter === "all"} onClick={() => setStationFilter("all")} label="All" />
          {stations.map((entry) => (
            <StationTab
              key={entry.id}
              active={stationFilter === entry.id}
              onClick={() => setStationFilter(entry.id)}
              label={entry.name}
              color={entry.color}
            />
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {missing.length > 0 && (
            <button
              type="button"
              onClick={() => setShowMissing(true)}
              className="flex items-center gap-1.5 rounded-lg bg-warn px-2.5 py-1.5 text-[12px] font-black uppercase text-white"
            >
              <Icon name="alert" className="size-4" />
              {missing.length} without a sheet
            </button>
          )}
          <span className="tnum text-[12px] font-bold text-stage-soft">
            {filtered.length} of {sheets.length}
          </span>
        </div>
      </header>

      <main className="scroll-y flex-1 p-3">
        {filtered.length === 0 ? (
          <div className="flex h-[55vh] flex-col items-center justify-center gap-3 text-center">
            <span className="flex size-20 items-center justify-center rounded-full bg-stage-card text-stage-soft">
              <Icon name="prep" className="size-10" />
            </span>
            <p className="text-xl font-black uppercase tracking-wide">No sheets match</p>
            <p className="max-w-sm text-sm text-stage-soft">
              Try another station, or clear the search. Sheets are written per menu item by the kitchen manager.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((sheet) => (
              <button
                key={sheet.id}
                type="button"
                onClick={() => setOpen(sheet)}
                className="stage-card flex flex-col gap-2 p-3 text-left transition-transform hover:-translate-y-0.5"
                style={{ borderTop: `3px solid ${stations.find((entry) => entry.id === sheet.station)?.color ?? "var(--color-stage-rule)"}` }}
              >
                <div className="flex items-start gap-2">
                  <span className="text-2xl leading-none" aria-hidden="true">
                    {sheet.emoji || "🍽"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-black leading-tight">{sheet.itemName}</p>
                    <p className="truncate text-[11px] font-semibold text-stage-soft">
                      {stationName(sheet.station)} · {sheet.course}
                      {sheet.categoryName ? ` · ${sheet.categoryName}` : ""}
                    </p>
                  </div>
                  <span className="tnum shrink-0 text-[12px] font-bold text-stage-soft">{formatMoney(sheet.price)}</span>
                </div>

                {sheet.allergens && (
                  <p className="flex items-start gap-1.5 rounded-md bg-late/18 px-2 py-1 text-[11px] font-bold text-late">
                    <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
                    <span className="line-clamp-2">{sheet.allergens}</span>
                  </p>
                )}

                <p className="line-clamp-2 text-[12px] leading-snug text-stage-soft">{sheet.plating || "No plating note."}</p>

                <div className="mt-auto flex items-center gap-2 pt-1">
                  <span className="tnum flex items-center gap-1 text-[11px] font-bold text-stage-soft">
                    <Icon name="prep" className="size-3.5" />
                    {sheet.steps.length} step{sheet.steps.length === 1 ? "" : "s"}
                  </span>
                  {sheet.steps.some((step) => step.seconds) && (
                    <span className="tnum flex items-center gap-1 text-[11px] font-bold text-info">
                      <Icon name="clock" className="size-3.5" />
                      timed
                    </span>
                  )}
                  {canEdit && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditing(sheet);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.stopPropagation();
                          setEditing(sheet);
                        }
                      }}
                      className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-bold text-stage-soft hover:text-stage-ink"
                    >
                      <Icon name="edit" className="size-3.5" />
                      Edit
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </main>

      {open && (
        <SheetModal
          sheet={open}
          stationLabel={stationName(open.station)}
          canEdit={canEdit}
          onClose={() => setOpen(null)}
          onEdit={() => {
            setEditing(open);
            setOpen(null);
          }}
        />
      )}

      {editing && (
        <EditSheetModal
          sheet={editing}
          stations={stations}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}

      <Modal open={showMissing} onClose={() => setShowMissing(false)} title="Menu items with no prep sheet" width="max-w-lg">
        <p className="mb-3 text-[12px] text-ink-soft">
          These dishes can be sold but have no written method. That is a consistency and allergen risk — write a sheet
          for each one from the menu manager.
        </p>
        <ul className="scroll-y max-h-[50vh] divide-y divide-rule">
          {missing.map((item) => (
            <li key={item.id} className="flex items-center gap-2 py-2">
              <span className="text-lg" aria-hidden="true">
                {item.emoji || "🍽"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-bold text-ink">{item.name}</span>
                <span className="block text-[11px] text-ink-faint">{stationName(item.station)}</span>
              </span>
              {canEdit && (
                <Button variant="soft" size="sm" onClick={() => window.location.assign("/admin/menu")}>
                  Write sheet
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

function StationTab({
  active,
  onClick,
  label,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-black uppercase tracking-wide transition-colors"
      style={{
        background: active ? (color ?? "var(--color-brand-500)") : "var(--color-stage-card)",
        color: active ? "#fff" : "var(--color-stage-soft)",
        border: `1px solid ${active ? (color ?? "var(--color-brand-500)") : "var(--color-stage-rule)"}`,
      }}
    >
      {color && !active && <span className="size-2 rounded-full" style={{ background: color }} />}
      {label}
    </button>
  );
}

/** Full sheet with a working countdown on every timed step. */
function SheetModal({
  sheet,
  stationLabel,
  canEdit,
  onClose,
  onEdit,
}: {
  sheet: Sheet;
  stationLabel: string;
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span aria-hidden="true">{sheet.emoji || "🍽"}</span>
          {sheet.itemName}
        </span>
      }
      subtitle={`${stationLabel} · ${sheet.course} · ${formatMoney(sheet.price)}`}
      width="max-w-xl"
      footer={
        canEdit ? (
          <Button variant="primary" onClick={onEdit}>
            <Icon name="edit" className="size-4" />
            Edit sheet
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {sheet.allergens && (
          <div className="rounded-xl border-2 border-late/40 bg-late-soft px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-late">
              <Icon name="alert" className="size-4" />
              Allergens
            </p>
            <p className="mt-0.5 text-[13px] font-bold text-late">{sheet.allergens}</p>
          </div>
        )}

        <div>
          <p className="label">Plating & service</p>
          <p className="rounded-xl border border-rule bg-paper px-3 py-2 text-[13px] leading-relaxed text-ink-soft">
            {sheet.plating || "No plating note written yet."}
          </p>
        </div>

        <div>
          <p className="label mb-1.5">Method</p>
          {sheet.steps.length === 0 ? (
            <p className="text-[13px] text-ink-faint">No steps written yet.</p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {sheet.steps.map((step, index) => (
                <StepRow key={`${step.text}-${index}`} index={index + 1} step={step} />
              ))}
            </ol>
          )}
        </div>

        <p className="text-[11px] text-ink-faint">Last updated {sheet.updatedAt.slice(0, 10)}</p>
      </div>
    </Modal>
  );
}

/** One method step; if it carries a time, the cook can run it as a countdown. */
function StepRow({ index, step }: { index: number; step: PrepStep }) {
  const [remaining, setRemaining] = useState<number | null>(null);

  // Count down once a second while a timer is running.
  useEffect(() => {
    if (remaining === null) return;
    if (remaining <= 0) return;
    const handle = window.setTimeout(() => setRemaining((current) => (current === null ? null : Math.max(0, current - 1))), 1000);
    return () => window.clearTimeout(handle);
  }, [remaining]);

  const running = remaining !== null && remaining > 0;
  const done = remaining === 0;

  return (
    <li
      className="flex items-start gap-2.5 rounded-xl border px-3 py-2"
      style={{
        borderColor: done ? "var(--color-ok)" : running ? "var(--color-info)" : "var(--color-rule)",
        background: done ? "var(--color-ok-soft)" : "var(--color-paper-raised)",
      }}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-paper-sunken text-[12px] font-black text-ink-soft">
        {index}
      </span>
      <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink">{step.text}</p>

      {step.seconds ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="tnum text-[13px] font-black" style={{ color: done ? "var(--color-ok)" : running ? "var(--color-info)" : "var(--color-ink-faint)" }}>
            {running || done ? `${Math.floor((remaining ?? 0) / 60)}:${String((remaining ?? 0) % 60).padStart(2, "0")}` : `${step.seconds}s`}
          </span>
          <button
            type="button"
            onClick={() => setRemaining(running ? null : (step.seconds ?? 0))}
            className={`btn !px-2 !py-1 !text-[11px] ${running ? "btn-danger" : done ? "btn-soft" : "btn-ghost"}`}
            aria-label={running ? "Stop timer" : `Start ${step.seconds} second timer`}
          >
            {done ? "Again" : running ? "Stop" : "Start"}
          </button>
        </span>
      ) : null}
    </li>
  );
}

function EditSheetModal({
  sheet,
  stations,
  onClose,
  onSaved,
}: {
  sheet: Sheet;
  stations: { id: string; name: string; color: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [station, setStation] = useState(sheet.station);
  const [allergens, setAllergens] = useState(sheet.allergens);
  const [plating, setPlating] = useState(sheet.plating);
  const [steps, setSteps] = useState<PrepStep[]>(sheet.steps.length ? sheet.steps : [{ text: "" }]);
  const [busy, setBusy] = useState(false);

  const patchStep = (index: number, patch: Partial<PrepStep>) =>
    setSteps((current) => current.map((step, position) => (position === index ? { ...step, ...patch } : step)));

  return (
    <Modal
      open
      onClose={onClose}
      title={`Prep sheet — ${sheet.itemName}`}
      subtitle="Written for a cook mid-service: short lines, allergens first."
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post(`prep/${sheet.menuItemId}`, {
                  station,
                  allergens: allergens.trim(),
                  plating: plating.trim(),
                  steps: steps
                    .filter((step) => step.text.trim())
                    .map((step) => ({ text: step.text.trim(), seconds: step.seconds && step.seconds > 0 ? step.seconds : undefined })),
                });
                toast(`Prep sheet saved for ${sheet.itemName}`, "ok");
                onSaved();
              } catch (error) {
                toast(errorMessage(error), "late");
                setBusy(false);
              }
            }}
          >
            Save sheet
          </Button>
        </>
      }
    >
      <div className="scroll-y flex max-h-[65vh] flex-col gap-3">
        <label className="block">
          <span className="label">Station</span>
          <select className="field" value={station} onChange={(event) => setStation(event.target.value)}>
            {stations.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="label">Allergens</span>
          <TextInput value={allergens} onChange={setAllergens} placeholder="Dairy, gluten, mustard…" />
        </label>

        <label className="block">
          <span className="label">Plating & service</span>
          <textarea
            className="field min-h-[72px] resize-y"
            value={plating}
            onChange={(event) => setPlating(event.target.value)}
            placeholder="Sear presentation-side, rest 2 minutes, sauce under not over…"
          />
        </label>

        <div>
          <p className="label mb-1.5">Method steps</p>
          <div className="flex flex-col gap-1.5">
            {steps.map((step, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-paper-sunken text-[11px] font-black text-ink-soft">
                  {index + 1}
                </span>
                <TextInput
                  value={step.text}
                  onChange={(value) => patchStep(index, { text: value })}
                  placeholder="What the cook does"
                  className="flex-1"
                />
                <TextInput
                  value={step.seconds ? String(step.seconds) : ""}
                  onChange={(value) => patchStep(index, { seconds: Number(value.replace(/\D/g, "")) || undefined })}
                  placeholder="sec"
                  className="!w-16 tnum"
                  inputMode="numeric"
                />
                <button
                  type="button"
                  onClick={() => setSteps((current) => current.filter((_, position) => position !== index))}
                  className="shrink-0 text-ink-faint transition-colors hover:text-late"
                  aria-label={`Remove step ${index + 1}`}
                >
                  <Icon name="trash" className="size-4" />
                </button>
              </div>
            ))}
          </div>
          <Button variant="soft" size="sm" className="mt-2" onClick={() => setSteps((current) => [...current, { text: "" }])}>
            <Icon name="plus" className="size-4" />
            Add step
          </Button>
          <p className="mt-1.5 text-[11px] text-ink-faint">
            Give a step a number of seconds and the cook gets a countdown button on the sheet.
          </p>
        </div>
      </div>
    </Modal>
  );
}
