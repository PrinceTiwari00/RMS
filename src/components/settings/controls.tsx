"use client";

import { useState, type ReactNode } from "react";
import { Button, Chip, Field, Icon, Select, TextInput, Toggle, type IconName, type Tone } from "@/components/ui";
import type { Category, StationInfo } from "@/types";

export type SettingsDraft = Record<string, string>;

export interface SettingsSectionProps {
  draft: SettingsDraft;
  onChange: (key: string, value: string | number | boolean) => void;
  onChangeMany: (patch: Record<string, string | number | boolean>) => void;
  categories: Category[];
  stations: StationInfo[];
  canEdit: boolean;
}

export function Panel({
  title,
  description,
  icon,
  action,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  icon?: IconName;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      <header className="flex items-start justify-between gap-3 border-b border-rule bg-paper-raised px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          {icon && (
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
              <Icon name={icon} className="size-[17px]" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[14px] font-extrabold text-ink">{title}</h2>
            {description && <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-ink-faint">{description}</p>}
          </div>
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  type = "text",
  disabled,
  className,
  inputMode,
  maxLength,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  className?: string;
  inputMode?: "text" | "numeric" | "decimal" | "tel" | "search" | "email" | "url";
  maxLength?: number;
}) {
  return (
    <Field label={label} hint={hint} className={className}>
      <TextInput
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        type={type}
        disabled={disabled}
        inputMode={inputMode}
        maxLength={maxLength}
      />
    </Field>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Field label={label} hint={hint} className={className}>
      <Select value={value} onChange={onChange} options={options} disabled={disabled} />
    </Field>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  suffix,
  hint,
  min = 0,
  max,
  step = "1",
  disabled,
  className,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  suffix?: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Field label={label} hint={hint} className={className}>
      <div className="relative">
        <input
          className={`field tnum ${suffix ? "!pr-12" : ""}`}
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-ink-faint">{suffix}</span>}
      </div>
    </Field>
  );
}

export function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  badge,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  badge?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13px] font-bold text-ink">{title}</p>
          {badge && <Chip tone="neutral">{badge}</Chip>}
        </div>
        {description && <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-ink-faint">{description}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

export function Segmented({
  value,
  onChange,
  options,
  disabled,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; icon?: IconName }[];
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="inline-flex rounded-xl border border-rule bg-paper-sunken p-1" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold transition-all disabled:opacity-40 ${
            value === option.value ? "bg-white text-ink shadow-sm" : "text-ink-faint hover:text-ink"
          }`}
        >
          {option.icon && <Icon name={option.icon} className="size-3.5" />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({
  children,
  tone = "info",
  icon = "alert",
}: {
  children: ReactNode;
  tone?: "info" | "warn" | "ok" | "neutral";
  icon?: IconName;
}) {
  const styles: Record<string, string> = {
    info: "border-info/20 bg-info-soft text-info",
    warn: "border-warn/25 bg-warn-soft text-warn",
    ok: "border-ok/20 bg-ok-soft text-ok",
    neutral: "border-rule bg-paper-sunken text-ink-soft",
  };
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[11px] font-semibold leading-relaxed ${styles[tone]}`}>
      <Icon name={icon} className="mt-0.5 size-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function SecretField({
  label,
  value,
  onChange,
  hint,
  placeholder = "Enter a new value to replace the saved credential",
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <input
          type={visible ? "text" : "password"}
          className="field !pr-11 font-mono !text-[12px]"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[10px] font-bold text-ink-faint hover:bg-paper-sunken hover:text-ink"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    </Field>
  );
}

export function AddRowButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="soft" size="sm" onClick={onClick} disabled={disabled}>
      <Icon name="plus" className="size-3.5" />
      {children}
    </Button>
  );
}

export function Status({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <Chip tone={tone} dot>{children}</Chip>;
}

export function DaySelector({
  days,
  onChange,
  disabled,
}: {
  days: number[];
  onChange: (days: number[]) => void;
  disabled?: boolean;
}) {
  const labels = ["S", "M", "T", "W", "T", "F", "S"];
  return (
    <div className="flex gap-1" aria-label="Active days">
      {labels.map((label, day) => {
        const active = days.includes(day);
        return (
          <button
            key={day}
            type="button"
            disabled={disabled}
            aria-label={`${active ? "Disable" : "Enable"} ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]}`}
            aria-pressed={active}
            onClick={() => onChange(active ? days.filter((entry) => entry !== day) : [...days, day].sort())}
            className={`size-6 rounded-md text-[10px] font-extrabold transition-colors disabled:opacity-40 ${
              active ? "bg-brand-500 text-white" : "bg-paper-sunken text-ink-faint hover:bg-rule"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
