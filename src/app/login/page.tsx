"use client";

/**
 * Screen 1 — Login / Shift PIN Pad.
 *
 * One screen does two jobs: it unlocks a terminal and it clocks the employee on.
 * The toggle makes the intent explicit, because a manager tapping in to check a
 * report should not silently start an eight-hour shift.
 *
 * PINs are 4 or 6 digits. Four digits submit immediately only when no six-digit
 * PIN shares the prefix — otherwise the pad waits, so a 4-digit PIN cannot be
 * shadowed by a longer one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { api, errorMessage } from "@/lib/api";
import { Avatar, Chip, Icon, toast } from "@/components/ui";
import type { StaffMember } from "@/types";

const MAX_PIN = 6;

export default function LoginPage() {
  const { signIn, state, loading } = useStore();
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [clockIn, setClockIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [hints, setHints] = useState<StaffMember[]>([]);
  const submitLock = useRef(false);

  const demoMode = state?.demoMode ?? true;

  // Demo PIN hints. The plain PIN only ever leaves the server in demo mode.
  useEffect(() => {
    if (!demoMode) return;
    api
      .get<{ staff: StaffMember[] }>("staff")
      .then((result) => setHints(result.staff.filter((member) => member.pin).slice(0, 8)))
      .catch(() => setHints([]));
  }, [demoMode]);

  const submit = useCallback(
    async (value: string) => {
      if (submitLock.current || !value) return;
      submitLock.current = true;
      setBusy(true);
      setError(null);
      try {
        const user = await signIn(value, clockIn);
        toast(`Welcome, ${user.name.split(" ")[0]}${clockIn ? " — clocked in" : ""}`, "ok");
        const landing = await pickLanding();
        router.replace(landing);
        router.refresh();
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        setPin("");
        setShake(true);
        window.setTimeout(() => setShake(false), 420);
      } finally {
        setBusy(false);
        submitLock.current = false;
      }
    },
    [signIn, clockIn, router],
  );

  // Route by permission, the same way the server-side index does.
  const pickLanding = useCallback(async () => {
    const result = await api.get<{ user: { permissions: string[] } | null; settings: { qrOrderingEnabled: boolean } }>(
      "bootstrap",
    );
    const permissions = new Set(result.user?.permissions ?? []);
    const candidates: [string, string | null][] = [
      ["/pos", "pos.open"],
      ["/floor", "host.seat"],
      ["/host", "host.waitlist"],
      ["/kds/grill", "kds.view"],
      ["/expo", "kds.bump"],
      ["/prep", "kds.prep"],
      ["/admin/menu", "admin.menu"],
      ["/admin/inventory", "admin.inventory"],
      ["/admin/schedule", "admin.schedule"],
      ["/admin/executive", "reports.executive"],
      ["/admin/settings", "admin.settings"],
      ["/cfd", "guest.cfd"],
    ];
    return candidates.find(([, permission]) => !permission || permissions.has(permission))?.[0] ?? "/login";
  }, []);

  const press = useCallback(
    (digit: string) => {
      if (busy) return;
      setPin((current) => {
        if (current.length >= MAX_PIN) return current;
        const next = current + digit;
        // A complete 4-digit PIN submits at once unless a 6-digit PIN could
        // still match this prefix — then wait for the remaining digits.
        if (next.length === 4) window.setTimeout(() => void submit(next), 90);
        else if (next.length === 6) window.setTimeout(() => void submit(next), 0);
        return next;
      });
    },
    [busy, submit],
  );

  const backspace = useCallback(() => {
    if (busy) return;
    setPin((current) => current.slice(0, -1));
  }, [busy]);

  // Physical keyboards work too — the till may have one attached.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key >= "0" && event.key <= "9") press(event.key);
      else if (event.key === "Backspace") backspace();
      else if (event.key === "Escape") setPin("");
      else if (event.key === "Enter" && pin.length >= 4) void submit(pin);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, backspace, pin, submit]);

  const dots = useMemo(() => Array.from({ length: Math.max(4, pin.length) }), [pin]);

  return (
    <div className="flex min-h-screen flex-col bg-stage lg:flex-row">
      {/* ------------------------------------------------------------ left: brand */}
      <div className="relative flex flex-col justify-between overflow-hidden px-6 py-8 text-stage-ink lg:w-[46%] lg:px-12 lg:py-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.16]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 18% 22%, #0f6f66 0, transparent 42%), radial-gradient(circle at 82% 78%, #c2542f 0, transparent 46%)",
          }}
        />
        <div className="relative">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-brand-500 text-lg font-black text-white">
              TK
            </span>
            <div>
              <p className="text-lg font-extrabold leading-tight">{state?.restaurant.name ?? "Terai Kitchen & Bar"}</p>
              <p className="text-xs text-stage-soft">{state?.restaurant.tagline ?? "Birgunj · Madhesh · Nepal"}</p>
            </div>
          </div>
        </div>

        <div className="relative my-8 max-w-md lg:my-0">
          <h1 className="text-3xl font-black leading-[1.15] lg:text-[40px]">
            Clock on to the
            <br />
            <span className="text-brand-300">floor terminal.</span>
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-stage-soft">
            Enter your shift PIN to unlock the terminal. Front of house, the kitchen board and the back office all sit
            behind this one pad — what you see afterwards depends on your role.
          </p>

          <div className="mt-6 grid grid-cols-3 gap-2.5">
            {[
              { label: "Front of house", value: "POS · Floor · Host", icon: "pos" as const },
              { label: "Back of house", value: "KDS · Expo · Prep", icon: "kitchen" as const },
              { label: "Back office", value: "Menu · Stock · Payroll", icon: "chart" as const },
            ].map((tile) => (
              <div key={tile.label} className="rounded-xl border border-stage-rule bg-stage-raised p-3">
                <Icon name={tile.icon} className="size-5 text-brand-300" />
                <p className="mt-2 text-[11px] font-bold uppercase tracking-wide text-stage-soft">{tile.label}</p>
                <p className="mt-0.5 text-xs font-semibold text-stage-ink">{tile.value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="relative flex flex-wrap items-center gap-2 text-xs text-stage-soft">
          <Chip tone="neutral">
            <span className="text-stage-soft">{state?.restaurant.address ?? "Chhapaiya Road, Birgunj 44700"}</span>
          </Chip>
          {state?.restaurant.panVat && (
            <Chip tone="neutral">
              <span className="text-stage-soft">PAN/VAT {state.restaurant.panVat}</span>
            </Chip>
          )}
        </div>
      </div>

      {/* -------------------------------------------------------------- right: pad */}
      <div className="flex flex-1 items-center justify-center bg-paper px-4 py-8 lg:px-10">
        <div className="w-full max-w-sm">
          <div className={`card card-pad ${shake ? "animate-[shake_0.42s_ease]" : ""}`}>
            <style>{`@keyframes shake {
              0%,100% { transform: translateX(0) }
              20% { transform: translateX(-7px) }
              40% { transform: translateX(6px) }
              60% { transform: translateX(-4px) }
              80% { transform: translateX(3px) }
            }`}</style>

            <div className="mb-4 text-center">
              <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-ink-faint">Shift PIN</p>
              <div className="mt-3 flex items-center justify-center gap-2.5" aria-live="polite" aria-label={`${pin.length} digits entered`}>
                {dots.map((_, index) => (
                  <span
                    key={index}
                    className="size-3.5 rounded-full border-2 transition-all"
                    style={{
                      borderColor: index < pin.length ? "var(--color-brand-500)" : "var(--color-rule)",
                      background: index < pin.length ? "var(--color-brand-500)" : "transparent",
                      transform: index < pin.length ? "scale(1.12)" : "scale(1)",
                    }}
                  />
                ))}
              </div>
              <p className="mt-2 h-4 text-xs font-semibold text-late">{error ?? ""}</p>
            </div>

            {/* Clock-in intent — explicit, because it starts a paid shift. */}
            <button
              type="button"
              onClick={() => setClockIn((current) => !current)}
              className="mb-4 flex w-full items-center gap-3 rounded-xl border border-rule bg-paper px-3 py-2.5 text-left transition-colors hover:border-brand-300"
              aria-pressed={clockIn}
            >
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors"
                style={{
                  borderColor: clockIn ? "var(--color-brand-500)" : "var(--color-rule)",
                  background: clockIn ? "var(--color-brand-500)" : "transparent",
                }}
              >
                {clockIn && <Icon name="check" className="size-3 text-white" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-bold text-ink">Clock in for my shift</span>
                <span className="block text-[11px] text-ink-faint">
                  {clockIn ? "Opens a time entry at the current moment" : "Unlocks the terminal only — no time recorded"}
                </span>
              </span>
            </button>

            <div className="grid grid-cols-3 gap-2">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                <PadKey key={digit} onPress={press} disabled={busy} label={digit}>
                  {digit}
                </PadKey>
              ))}
              <PadKey onPress={() => setPin("")} disabled={busy || !pin.length} label="Clear" muted>
                <span className="text-xs font-bold">Clear</span>
              </PadKey>
              <PadKey onPress={press} disabled={busy} label="0">
                0
              </PadKey>
              <PadKey onPress={backspace} disabled={busy || !pin.length} label="Delete" muted>
                <Icon name="arrow-left" className="size-5" />
              </PadKey>
            </div>

            <button
              type="button"
              className="btn btn-primary mt-3 w-full !py-3 !text-base"
              disabled={busy || pin.length < 4}
              onClick={() => void submit(pin)}
            >
              {busy ? "Signing in…" : loading ? "Loading…" : "Sign in"}
            </button>
          </div>

          {demoMode && hints.length > 0 && (
            <div className="card card-pad mt-3">
              <div className="mb-2 flex items-center gap-2">
                <Icon name="alert" className="size-4 text-warn" />
                <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-ink-faint">Demo PINs</p>
              </div>
              <p className="mb-2.5 text-[11px] leading-relaxed text-ink-faint">
                This is demo data. In production PINs are hashed at rest and never returned to the browser.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {hints.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => {
                      setPin("");
                      void submit(member.pin ?? "");
                    }}
                    className="flex items-center gap-1.5 rounded-lg border border-rule bg-paper px-2 py-1 text-[11px] font-semibold text-ink-soft transition-colors hover:border-brand-300 hover:text-ink"
                    title={`Sign in as ${member.name} (${member.roleTitle})`}
                  >
                    <Avatar name={member.name} initials={member.initials} color={member.color} size={18} />
                    {member.name.split(" ")[0]}
                    <span className="tnum rounded bg-paper-sunken px-1 font-bold text-ink">{member.pin}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PadKey({
  children,
  onPress,
  disabled,
  label,
  muted,
}: {
  children: React.ReactNode;
  onPress: (digit: string) => void;
  disabled?: boolean;
  label: string;
  muted?: boolean;
}) {
  const isDigit = /^\d$/.test(label);
  return (
    <button
      type="button"
      aria-label={isDigit ? `Digit ${label}` : label}
      disabled={disabled}
      onClick={() => onPress(label)}
      className={`flex h-14 items-center justify-center rounded-xl border text-xl font-bold transition-all active:scale-[0.97] disabled:opacity-40 ${
        muted
          ? "border-rule bg-paper-sunken text-ink-soft hover:bg-rule"
          : "border-rule bg-paper-raised text-ink hover:border-brand-300 hover:bg-brand-50"
      }`}
    >
      {children}
    </button>
  );
}
