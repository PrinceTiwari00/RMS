"use client";

/**
 * Shared date-range control for the analytics screens.
 *
 * The presets come from the server so "this week" and "last 30 days" mean the
 * same thing everywhere and are always computed in the restaurant's own
 * timezone rather than the browser's. A custom from/to pair is offered too,
 * because an owner reconciling a specific festival period needs exact dates.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Icon } from "@/components/ui";
import { qs } from "@/lib/api";

export interface RangePreset {
  id: string;
  label: string;
  from: string;
  to: string;
}

interface RangesResponse {
  ranges: RangePreset[];
  today: string;
}

/** Build the query string for a report request given the current selection. */
export function rangeQuery(preset: string, from: string, to: string): string {
  return preset === "custom" ? qs({ from, to }) : qs({ range: preset });
}

export function RangePicker({
  preset,
  from,
  to,
  onChange,
}: {
  preset: string;
  from: string;
  to: string;
  onChange: (next: { preset: string; from: string; to: string }) => void;
}) {
  const [ranges, setRanges] = useState<RangePreset[]>([]);
  const [today, setToday] = useState("");
  const [showCustom, setShowCustom] = useState(preset === "custom");

  useEffect(() => {
    let live = true;
    void api
      .get<RangesResponse>("reports/ranges")
      .then((response) => {
        if (!live) return;
        setRanges(response.ranges);
        setToday(response.today);
      })
      .catch(() => {
        /* the presets are a convenience; the screen still works without them */
      });
    return () => {
      live = false;
    };
  }, []);

  const active = ranges.find((entry) => entry.id === preset);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ranges.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => {
            setShowCustom(false);
            onChange({ preset: entry.id, from: entry.from, to: entry.to });
          }}
          className={`rounded-full px-3 py-1.5 text-[12px] font-bold transition-colors ${
            preset === entry.id ? "bg-ink text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
          }`}
        >
          {entry.label}
        </button>
      ))}

      <button
        type="button"
        onClick={() => setShowCustom((current) => !current)}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-bold transition-colors ${
          preset === "custom" || showCustom ? "bg-brand-500 text-white" : "bg-paper-sunken text-ink-soft hover:bg-rule"
        }`}
        aria-expanded={showCustom}
      >
        <Icon name="filter" className="size-3.5" />
        Custom
      </button>

      {showCustom && (
        <span className="flex items-center gap-1.5 rounded-full border border-rule bg-paper-raised px-2.5 py-1">
          <input
            type="date"
            className="tnum bg-transparent text-[12px] font-semibold text-ink focus:outline-none"
            value={from}
            max={to || today}
            aria-label="From date"
            onChange={(event) => onChange({ preset: "custom", from: event.target.value, to })}
          />
          <span className="text-[11px] text-ink-faint">→</span>
          <input
            type="date"
            className="tnum bg-transparent text-[12px] font-semibold text-ink focus:outline-none"
            value={to}
            min={from}
            max={today}
            aria-label="To date"
            onChange={(event) => onChange({ preset: "custom", from, to: event.target.value })}
          />
        </span>
      )}

      {active && (
        <span className="tnum text-[11px] text-ink-faint">
          {active.from} → {active.to}
        </span>
      )}
    </div>
  );
}
