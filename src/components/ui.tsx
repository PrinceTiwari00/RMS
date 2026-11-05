"use client";

/**
 * Shared UI primitives.
 *
 * Hand-rolled throughout: charts are inline SVG and icons are embedded paths,
 * because the preview runs in a sandboxed iframe with no network access — no CDN
 * fonts, no icon package, no chart library can load.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatMoney, formatMoneyShort, formatQuantity } from "@/domain/money";

// ----------------------------------------------------------------------- tone
export type Tone = "neutral" | "ok" | "warn" | "late" | "info" | "brand" | "ember";

const CHIP_TONE: Record<Tone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: "var(--color-paper-sunken)", fg: "var(--color-ink-soft)", border: "var(--color-rule)" },
  ok: { bg: "var(--color-ok-soft)", fg: "#1f6b43", border: "#bfe2cd" },
  warn: { bg: "var(--color-warn-soft)", fg: "#8a5d10", border: "#efd9a4" },
  late: { bg: "var(--color-late-soft)", fg: "#96271a", border: "#f0c4bd" },
  info: { bg: "var(--color-info-soft)", fg: "#2c527e", border: "#c3d6ec" },
  brand: { bg: "var(--color-brand-50)", fg: "var(--color-brand-700)", border: "var(--color-brand-200)" },
  ember: { bg: "var(--color-ember-50)", fg: "var(--color-ember-700)", border: "var(--color-ember-200)" },
};

export function Chip({
  tone = "neutral",
  children,
  dot,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  title?: string;
}) {
  const style = CHIP_TONE[tone];
  return (
    <span
      className="chip"
      title={title}
      style={{ background: style.bg, color: style.fg, border: `1px solid ${style.border}` }}
    >
      {dot && <span className="size-1.5 rounded-full" style={{ background: style.fg }} />}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------- cards
export function Card({
  children,
  className = "",
  pad = true,
  title,
  subtitle,
  icon,
  action,
  accent,
}: {
  children: ReactNode;
  className?: string;
  pad?: boolean;
  /** Optional header — nearly every panel on the admin screens wants one. */
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  /** Colour for a left rule, used to tie a card to a station or status. */
  accent?: string;
}) {
  const hasHead = title !== undefined || action !== undefined;
  return (
    <div
      className={`card ${pad ? "card-pad" : ""} ${className}`}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
    >
      {hasHead && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            {icon && <Icon name={icon} className="mt-0.5 size-4 shrink-0 text-ink-faint" />}
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-bold text-ink">{title}</h2>
              {subtitle && <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p>}
            </div>
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function CardHead({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-bold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">{children}</h3>
      {right}
    </div>
  );
}

// ------------------------------------------------------------------------ KPI
export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
  delta,
  compact,
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone?: Tone;
  /** Percentage change against the previous period. */
  delta?: number | null;
  /** Money values are shortened above one lakh. */
  compact?: boolean;
}) {
  const accent = CHIP_TONE[tone];
  const display =
    typeof value === "number"
      ? compact
        ? formatMoneyShort(value)
        : value >= 1000
          ? formatMoney(value)
          : formatQuantity(value, value % 1 === 0 ? 0 : 2)
      : value;
  return (
    <div className="card card-pad relative overflow-hidden">
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: accent.fg, opacity: 0.75 }} />
      <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">{label}</p>
      <p className="tnum mt-1.5 text-2xl font-extrabold leading-none text-ink">{display}</p>
      <div className="mt-1.5 flex items-center gap-2">
        {sub && <span className="truncate text-xs text-ink-soft">{sub}</span>}
        {delta !== null && delta !== undefined && Number.isFinite(delta) && delta !== 0 && (
          <span
            className="tnum text-xs font-bold"
            style={{ color: delta > 0 ? "var(--color-ok)" : "var(--color-late)" }}
          >
            {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- button
export function Button({
  children,
  onClick,
  variant = "ghost",
  disabled,
  title,
  type = "button",
  size = "md",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger" | "soft";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const padding = size === "sm" ? "!px-2.5 !py-1.5 !text-xs" : size === "lg" ? "!px-5 !py-3 !text-base" : "";
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`btn btn-${variant} ${padding} ${className}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------- fields
export function Field({
  label,
  children,
  hint,
  className = "",
}: {
  label?: string;
  children: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="label">{label}</span>}
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span>}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  step,
  min,
  autoFocus,
  onKeyDown,
  className = "",
  inputMode,
  maxLength,
}: {
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  step?: string;
  min?: string | number;
  autoFocus?: boolean;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
  inputMode?: "text" | "numeric" | "decimal" | "tel" | "search" | "email" | "url";
  maxLength?: number;
}) {
  return (
    <input
      className={`field ${className}`}
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      step={step}
      min={min}
      autoFocus={autoFocus}
      inputMode={inputMode}
      maxLength={maxLength}
      onKeyDown={onKeyDown}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  disabled,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      className={`field ${className}`}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 disabled:opacity-40"
    >
      <span
        className="relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? "var(--color-brand-500)" : "var(--color-rule)" }}
      >
        <span
          className="absolute top-0.5 size-4 rounded-full bg-white shadow transition-all"
          style={{ left: checked ? 18 : 2 }}
        />
      </span>
      {label && <span className="text-sm text-ink-soft">{label}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------- modal
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4">
      <div
        className={`card max-h-[92vh] w-full ${width} flex flex-col overflow-hidden`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3 border-b border-rule px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-ink-faint hover:bg-paper-sunken hover:text-ink"
          >
            <Icon name="close" className="size-5" />
          </button>
        </div>
        <div className="scroll-y flex-1 px-4 py-3">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-rule px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------- toast
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

let pushToast: ((message: string, tone?: Tone) => void) | null = null;

/** Fire a toast from anywhere, including non-React modules. */
export function toast(message: string, tone: Tone = "neutral"): void {
  if (pushToast) pushToast(message, tone);
}

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    pushToast = (message, tone = "neutral") => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, message, tone }]);
      window.setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 4200);
    };
    return () => {
      pushToast = null;
    };
  }, []);

  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4">
      {toasts.map((entry) => {
        const style = CHIP_TONE[entry.tone];
        return (
          <div
            key={entry.id}
            className="pointer-events-auto rounded-xl border px-4 py-3 text-sm font-semibold shadow-lg"
            style={{ background: style.bg, color: style.fg, borderColor: style.border }}
            role="status"
          >
            {entry.message}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ emptiness
export function Empty({ title, hint, icon = "search" }: { title: string; hint?: string; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon name={icon} className="size-8 text-ink-faint/50" />
      <p className="text-sm font-semibold text-ink-soft">{title}</p>
      {hint && <p className="max-w-sm text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export function Spinner({ className = "size-5" }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      aria-label="Loading"
    />
  );
}

// --------------------------------------------------------------------- charts
/**
 * Sparkline / area chart. Points are [label, value]; the path is generated with
 * a Catmull-Rom-to-Bezier smoothing so trends read cleanly at small sizes.
 */
export function LineChart({
  points,
  height = 120,
  tone = "var(--color-brand-500)",
  format = (value: number) => formatMoneyShort(value),
  compare,
}: {
  points: { label: string; value: number }[];
  height?: number;
  tone?: string;
  format?: (value: number) => string;
  /** Optional second series drawn as a dashed reference line. */
  compare?: { label: string; value: number }[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <Empty title="No data in this range" icon="chart" />;

  const width = 640;
  const padY = 14;
  const values = points.map((point) => point.value);
  const max = Math.max(...values, ...(compare ?? []).map((point) => point.value), 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const stepX = points.length > 1 ? width / (points.length - 1) : width;
  const xAt = (index: number) => index * stepX;
  const yAt = (value: number) => padY + (1 - (value - min) / span) * (height - padY * 2);

  const coords = points.map((point, index) => [xAt(index), yAt(point.value)] as const);
  const line = smoothPath(coords);
  const area = `${line} L ${xAt(points.length - 1)} ${height} L 0 ${height} Z`;
  const comparePath = compare?.length
    ? smoothPath(compare.map((point, index) => [xAt(index), yAt(point.value)] as const))
    : null;

  const active = hover !== null ? points[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
        }}
      >
        <defs>
          <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity="0.28" />
            <stop offset="100%" stopColor={tone} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1="0"
            x2={width}
            y1={padY + fraction * (height - padY * 2)}
            y2={padY + fraction * (height - padY * 2)}
            stroke="var(--color-rule)"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
        ))}
        <path d={area} fill="url(#area-fill)" />
        {comparePath && (
          <path d={comparePath} fill="none" stroke="var(--color-ink-faint)" strokeWidth="1.5" strokeDasharray="5 4" />
        )}
        <path d={line} fill="none" stroke={tone} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
        {hover !== null && (
          <g>
            <line x1={xAt(hover)} x2={xAt(hover)} y1="0" y2={height} stroke={tone} strokeWidth="1" strokeOpacity="0.4" />
            <circle cx={xAt(hover)} cy={yAt(points[hover].value)} r="4" fill={tone} stroke="#fff" strokeWidth="2" />
          </g>
        )}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] font-semibold text-ink-faint">
        {points.map((point, index) => (
          <span key={point.label} className={index % Math.ceil(points.length / 8) === 0 ? "" : "opacity-0 sm:opacity-100"}>
            {point.label}
          </span>
        ))}
      </div>
      {active && (
        <div className="pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 rounded-lg bg-ink px-2.5 py-1 text-xs font-bold text-white shadow-lg">
          {active.label} · {format(active.value)}
        </div>
      )}
    </div>
  );
}

/** Catmull-Rom smoothing, emitted as cubic beziers. */
function smoothPath(coords: readonly (readonly [number, number])[]): string {
  if (coords.length === 0) return "";
  if (coords.length === 1) return `M ${coords[0][0]} ${coords[0][1]}`;
  let path = `M ${coords[0][0]} ${coords[0][1]}`;
  for (let index = 0; index < coords.length - 1; index += 1) {
    const p0 = coords[index - 1] ?? coords[index];
    const p1 = coords[index];
    const p2 = coords[index + 1];
    const p3 = coords[index + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  return path;
}

/** Horizontal bar list — tender mix, channel mix, top items. */
export function BarList({
  rows,
  format = (value: number) => formatMoneyShort(value),
  tone = "var(--color-brand-500)",
  max: forcedMax,
}: {
  rows: { label: string; value: number; meta?: string; tone?: string }[];
  format?: (value: number) => string;
  tone?: string;
  max?: number;
}) {
  if (!rows.length) return <Empty title="Nothing to show yet" icon="chart" />;
  const max = forcedMax ?? Math.max(...rows.map((row) => row.value), 1);
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <div className="flex items-baseline gap-2 truncate">
            <span className="truncate text-[13px] font-semibold text-ink">{row.label}</span>
            {row.meta && <span className="tnum shrink-0 text-[11px] text-ink-faint">{row.meta}</span>}
          </div>
          <span className="tnum text-[13px] font-bold text-ink">{format(row.value)}</span>
          <div className="col-span-2 h-2 overflow-hidden rounded-full bg-paper-sunken">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.max(2, (row.value / max) * 100)}%`, background: row.tone ?? tone }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Stacked vertical bars — sales by hour of day. */
export function ColumnChart({
  points,
  height = 110,
  tone = "var(--color-brand-400)",
  format = (value: number) => formatMoneyShort(value),
}: {
  points: { label: string; value: number }[];
  height?: number;
  tone?: string;
  format?: (value: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <Empty title="No sales recorded" icon="chart" />;
  const max = Math.max(...points.map((point) => point.value), 1);
  return (
    <div>
      <div className="flex items-end gap-[3px]" style={{ height }}>
        {points.map((point, index) => (
          <button
            key={point.label}
            type="button"
            className="group relative flex-1 rounded-t transition-colors"
            style={{
              height: `${Math.max(2, (point.value / max) * 100)}%`,
              background: hover === index ? tone : `color-mix(in srgb, ${tone} 72%, transparent)`,
            }}
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
            aria-label={`${point.label}: ${format(point.value)}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] font-semibold text-ink-faint">
        <span>{points[0]?.label}</span>
        {hover !== null && (
          <span className="tnum font-bold text-ink">
            {points[hover].label} · {format(points[hover].value)}
          </span>
        )}
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/** Donut with a centre label — used for quadrant mix and occupancy. */
export function Donut({
  segments,
  size = 132,
  thickness = 18,
  centre,
  sub,
}: {
  segments: { label: string; value: number; tone: string }[];
  size?: number;
  thickness?: number;
  centre?: string;
  sub?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--color-paper-sunken)" strokeWidth={thickness} />
        {total > 0 &&
          segments.map((segment) => {
            const length = (segment.value / total) * circumference;
            const dash = `${length} ${circumference - length}`;
            const element = (
              <circle
                key={segment.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={segment.tone}
                strokeWidth={thickness}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += length;
            return element;
          })}
      </svg>
      <div className="min-w-0 flex-1">
        {centre && <p className="tnum text-xl font-extrabold leading-none text-ink">{centre}</p>}
        {sub && <p className="mt-1 text-xs text-ink-faint">{sub}</p>}
        <ul className="mt-2 flex flex-col gap-1">
          {segments.map((segment) => (
            <li key={segment.label} className="flex items-center gap-2 text-xs">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: segment.tone }} />
              <span className="truncate text-ink-soft">{segment.label}</span>
              <span className="tnum ml-auto font-bold text-ink">{segment.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Scatter/quadrant plot for the P-Mix matrix. Axes are popularity (menu mix %)
 * and contribution margin, with the classic Kasavana-Smith crosshairs.
 */
export function QuadrantChart({
  points,
  xThreshold,
  yThreshold,
  height = 340,
}: {
  points: { id: string; name: string; x: number; y: number; tone: string; units: number }[];
  xThreshold: number;
  yThreshold: number;
  height?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const width = 560;
  const pad = 34;
  const maxX = Math.max(...points.map((point) => point.x), xThreshold * 2, 1);
  const maxY = Math.max(...points.map((point) => point.y), yThreshold * 2, 1);
  const xAt = (value: number) => pad + (value / maxX) * (width - pad * 2);
  const yAt = (value: number) => height - pad - (value / maxY) * (height - pad * 2);
  const active = points.find((point) => point.id === hover);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
        <rect x={pad} y={pad} width={width - pad * 2} height={height - pad * 2} fill="var(--color-paper-sunken)" rx="8" />
        {/* Quadrant crosshairs at the popularity and margin thresholds. */}
        <line x1={xAt(xThreshold)} x2={xAt(xThreshold)} y1={pad} y2={height - pad} stroke="var(--color-ink-faint)" strokeDasharray="5 4" strokeWidth="1.5" />
        <line x1={pad} x2={width - pad} y1={yAt(yThreshold)} y2={yAt(yThreshold)} stroke="var(--color-ink-faint)" strokeDasharray="5 4" strokeWidth="1.5" />
        {[
          { label: "Puzzles", x: pad + 8, y: pad + 18 },
          { label: "Stars", x: width - pad - 8, y: pad + 18, anchor: "end" as const },
          { label: "Dogs", x: pad + 8, y: height - pad - 10 },
          { label: "Plowhorses", x: width - pad - 8, y: height - pad - 10, anchor: "end" as const },
        ].map((corner) => (
          <text
            key={corner.label}
            x={corner.x}
            y={corner.y}
            textAnchor={corner.anchor ?? "start"}
            className="fill-ink-faint"
            style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}
          >
            {corner.label}
          </text>
        ))}
        {points.map((point) => {
          const radius = 5 + Math.min(13, Math.sqrt(point.units) * 0.85);
          return (
            <circle
              key={point.id}
              cx={xAt(point.x)}
              cy={yAt(point.y)}
              r={radius}
              fill={point.tone}
              fillOpacity={hover === point.id ? 0.95 : 0.62}
              stroke={hover === point.id ? "var(--color-ink)" : "#fff"}
              strokeWidth={hover === point.id ? 2 : 1.25}
              className="cursor-pointer transition-all"
              onMouseEnter={() => setHover(point.id)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        <text x={width / 2} y={height - 8} textAnchor="middle" className="fill-ink-faint" style={{ fontSize: 11, fontWeight: 700 }}>
          Popularity (menu mix %) →
        </text>
        <text
          x={12}
          y={height / 2}
          textAnchor="middle"
          className="fill-ink-faint"
          style={{ fontSize: 11, fontWeight: 700 }}
          transform={`rotate(-90 12 ${height / 2})`}
        >
          Contribution margin →
        </text>
      </svg>
      {active && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-lg bg-ink px-3 py-1.5 text-xs font-bold text-white shadow-lg">
          {active.name} · {active.x.toFixed(1)}% mix · {formatMoney(active.y)} CM
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------- icons
export type IconName =
  | "pos"
  | "floor"
  | "host"
  | "kitchen"
  | "expo"
  | "prep"
  | "menu"
  | "users"
  | "inventory"
  | "recipe"
  | "vendor"
  | "waste"
  | "schedule"
  | "clock"
  | "chart"
  | "matrix"
  | "report"
  | "settings"
  | "qr"
  | "display"
  | "close"
  | "plus"
  | "minus"
  | "check"
  | "search"
  | "alert"
  | "logout"
  | "arrow-left"
  | "arrow-right"
  | "refresh"
  | "print"
  | "trash"
  | "edit"
  | "drag"
  | "phone"
  | "cash"
  | "card"
  | "wallet"
  | "split"
  | "fire"
  | "star"
  | "filter"
  | "lock"
  | "receipt"
  | "table"
  | "chevronLeft"
  | "chevronRight"
  | "chevronDown";

const PATHS: Record<IconName, string> = {
  pos: "M4 6h16v12H4zM8 10h8M8 14h5",
  floor: "M3 20h18M6 20V9l6-5 6 5v11M10 20v-6h4v6",
  host: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.6-6 8-6s8 2 8 6",
  kitchen: "M6 3v8a3 3 0 006 0V3M9 11v10M17 3c-1.5 2-2 4-2 6s.5 3 2 3 2-1 2-3-.5-4-2-6zM17 12v9",
  expo: "M3 5h18v10H3zM7 19h10M12 15v4",
  prep: "M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h4",
  menu: "M4 6h16M4 12h16M4 18h10",
  users: "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5M17 4.5a3.5 3.5 0 010 7M18 14.6c2.4.6 4 2.3 4 4.9",
  inventory: "M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10",
  recipe: "M5 4h9a3 3 0 013 3v13H8a3 3 0 01-3-3zM17 8h2v12H8M8 9h6M8 13h6",
  vendor: "M3 8l2-4h14l2 4M3 8h18v12H3zM3 8l3 4h12l3-4M9 12v4h6v-4",
  waste: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v7M14 11v7",
  schedule: "M4 5h16v16H4zM4 10h16M8 3v4M16 3v4M8 14h3M8 17h6",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3.5 2",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  matrix: "M3 3v18h18M12 3v18M3 12h18",
  report: "M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h4",
  settings:
    "M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-2.9 1.2v.2a2 2 0 11-4 0v-.1a1.7 1.7 0 00-3-1.2l-.1.1a2 2 0 11-2.9-2.9l.1-.1A1.7 1.7 0 003 15h-.2a2 2 0 110-4h.1a1.7 1.7 0 001.2-3l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 002.9-1.2V3a2 2 0 114 0v.1a1.7 1.7 0 003 1.2l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 001.2 2.9h.2a2 2 0 110 4h-.1z",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z",
  display: "M3 5h18v11H3zM8 20h8M12 16v4",
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  check: "M4 12.5l5 5L20 6.5",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
  alert: "M12 3l9.5 17H2.5zM12 9v5M12 17.5v.5",
  logout: "M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9",
  "arrow-left": "M19 12H5M11 18l-6-6 6-6",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
  refresh: "M21 12a9 9 0 11-3-6.7M21 4v5h-5",
  print: "M6 9V3h12v6M6 18H4v-6h16v6h-2M8 14h8v7H8z",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14",
  edit: "M4 20h4L20 8l-4-4L4 16zM14 6l4 4",
  drag: "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
  phone: "M5 3h4l2 5-2.5 1.5a12 12 0 006 6L16 13l5 2v4a2 2 0 01-2 2A17 17 0 013 5a2 2 0 012-2z",
  cash: "M2 6h20v12H2zM12 15a3 3 0 100-6 3 3 0 000 6zM6 12h.01M18 12h.01",
  card: "M2 6h20v12H2zM2 10h20M6 15h4",
  wallet: "M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 7V5a2 2 0 012-2h11M17 13h.01",
  split: "M6 3v6a6 6 0 006 6 6 6 0 016 6M6 3l-3 3M6 3l3 3M18 21l-3-3M18 21l3-3",
  fire: "M12 22c4 0 7-2.7 7-6.5 0-4.5-4-6-4-10.5-2.5 1.5-4 4-4 6 0-1-.5-2-1.5-3C8 9.5 5 12 5 15.5 5 19.3 8 22 12 22z",
  star: "M12 3l2.7 5.8 6.3.8-4.6 4.4 1.2 6.2L12 17.3 6.4 20.2l1.2-6.2L3 9.6l6.3-.8z",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  lock: "M6 11h12v9H6zM9 11V8a3 3 0 016 0v3M12 15v2",
  receipt: "M6 3h12v18l-2.5-1.6L13 21l-2.5-1.6L8 21l-2-1.6zM9 8h6M9 12h6M9 16h4",
  table: "M3 9h18M4 9v11M20 9v11M3 9l2-4h14l2 4M8 13h8",
  chevronLeft: "M15 5l-7 7 7 7",
  chevronRight: "M9 5l7 7-7 7",
  chevronDown: "M5 9l7 7 7-7",
};

export function Icon({ name, className = "size-5", title }: { name: IconName; className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

// ------------------------------------------------------------------- progress
export function Meter({ value, max, tone = "var(--color-brand-500)" }: { value: number; max: number; tone?: string }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-paper-sunken">
      <div className="h-full rounded-full transition-all" style={{ width: `${percent}%`, background: tone }} />
    </div>
  );
}

export function Avatar({ name, initials, color, size = 32 }: { name: string; initials: string; color: string; size?: number }) {
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}
    >
      {initials || name.slice(0, 2).toUpperCase()}
    </span>
  );
}

export { formatMoney, formatMoneyShort, formatQuantity };
