"use client";

/**
 * Platform entry — super admin sign-in and first-run setup.
 *
 * This page is the top of the hierarchy: the platform owner creates restaurant
 * accounts here, and each restaurant then runs its own back office through the
 * normal staff PIN pad. The restaurant picker in the console shows the exact
 * link and code to hand to a new owner.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { platformApi, platformErrorMessage } from "@/lib/platform-api";
import { Button, Field, Icon, Spinner, TextInput, toast } from "@/components/ui";
import { PlatformConsole, type PlatformAccount } from "./console";

interface PlatformSession {
  user: PlatformAccount | null;
  required: boolean;
  demoMode: boolean;
  tokenConfigured: boolean;
  restaurants: number;
  demoCredentials: { email: string; password: string } | null;
}

export default function PlatformPage() {
  const [session, setSession] = useState<PlatformSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const status = await platformApi.get<{
        required: boolean;
        demoMode: boolean;
        tokenConfigured: boolean;
        restaurants: number;
        demoCredentials: { email: string; password: string } | null;
      }>("status");
      const current = await platformApi.get<{ user: PlatformAccount | null }>("session");
      setSession({ ...status, user: current.user });
      setFatal(null);
    } catch (caught) {
      setFatal(platformErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = useCallback(async () => {
    try {
      await platformApi.post("signout");
    } finally {
      setSession((current) => (current ? { ...current, user: null } : current));
    }
  }, []);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center gap-3 bg-stage text-sm font-semibold text-stage-soft">
        <Spinner /> Opening the platform console…
      </main>
    );
  }

  if (session?.user) {
    return (
      <PlatformConsole
        account={session.user}
        demoMode={session.demoMode}
        demoCredentials={session.demoCredentials}
        onSignOut={() => void signOut()}
      />
    );
  }

  return (
    <PlatformAuth
      session={session}
      fatal={fatal}
      onAuthenticated={load}
    />
  );
}

function PlatformAuth({
  session,
  fatal,
  onAuthenticated,
}: {
  session: PlatformSession | null;
  fatal: string | null;
  onAuthenticated: () => Promise<void>;
}) {
  const firstRun = Boolean(session?.required);
  return (
    <main className="min-h-screen bg-stage text-stage-ink lg:grid lg:grid-cols-[minmax(340px,.9fr)_minmax(460px,1.1fr)]">
      <section className="relative flex flex-col justify-between overflow-hidden px-6 py-10 lg:px-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 20%, #0f6f66 0, transparent 45%), radial-gradient(circle at 80% 80%, #c2542f 0, transparent 45%)",
          }}
        />
        <div className="relative flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-brand-500 text-sm font-black text-white">RMS</span>
          <div>
            <p className="text-base font-extrabold leading-tight">Platform console</p>
            <p className="text-[11px] text-stage-soft">Super administration · restaurant registry</p>
          </div>
        </div>

        <div className="relative my-10 max-w-md">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-brand-300">One deployment, many restaurants</p>
          <h1 className="mt-3 text-3xl font-black leading-tight lg:text-[40px]">
            Create a restaurant.
            <br />
            <span className="text-brand-300">Hand over one PIN.</span>
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-stage-soft">
            Each restaurant gets its own isolated database, role matrix and administrator. Staff never see another
            restaurant, and a restaurant admin never sees this console.
          </p>
          <div className="mt-6 grid gap-2.5 sm:grid-cols-3">
            {[
              ["lock", "You provision", "Platform account, restaurant code and the first admin PIN."],
              ["users", "They run it", "Menu, floor, staff, inventory and reports inside their own store."],
              ["alert", "You can suspend", "Sign-in stops immediately; the data is untouched."],
            ].map(([icon, title, detail]) => (
              <div key={title} className="rounded-xl border border-stage-rule bg-stage-raised p-3">
                <Icon name={icon as "lock"} className="size-4 text-brand-300" />
                <p className="mt-2 text-[12px] font-bold">{title}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-stage-soft">{detail}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-[11px] text-stage-soft">
          <Link href="/login" className="font-bold text-brand-300 hover:underline">
            Restaurant staff sign-in →
          </Link>
        </p>
      </section>

      <section className="flex items-center justify-center bg-paper px-4 py-10 lg:px-10">
        <div className="w-full max-w-md">
          {fatal && (
            <p role="alert" className="mb-3 rounded-xl bg-late-soft px-3 py-2.5 text-[12px] font-semibold text-late">
              {fatal}
            </p>
          )}
          {firstRun ? (
            <PlatformSetupForm tokenConfigured={Boolean(session?.tokenConfigured)} onDone={onAuthenticated} />
          ) : (
            <PlatformSignInForm
              demoCredentials={session?.demoCredentials ?? null}
              demoMode={Boolean(session?.demoMode)}
              onDone={onAuthenticated}
            />
          )}
          <p className="mt-4 text-center text-[11px] text-ink-faint">
            Looking for your restaurant? <Link href="/login" className="font-bold text-brand-700 hover:underline">Open the staff PIN pad</Link>
          </p>
        </div>
      </section>
    </main>
  );
}

function PlatformSignInForm({
  demoCredentials,
  demoMode,
  onDone,
}: {
  demoCredentials: { email: string; password: string } | null;
  demoMode: boolean;
  onDone: () => Promise<void>;
}) {
  const [email, setEmail] = useState(demoCredentials?.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (demoCredentials) setEmail((current) => current || demoCredentials.email);
  }, [demoCredentials]);

  async function submit() {
    if (!email.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await platformApi.post("signin", { email, password });
      toast("Signed in to the platform", "ok");
      await onDone();
    } catch (caught) {
      setError(platformErrorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <p className="text-[10px] font-black uppercase tracking-[0.1em] text-brand-600">Super admin</p>
      <h2 className="mt-1 text-xl font-black text-ink">Sign in to the platform</h2>
      <p className="mt-1 text-[11px] text-ink-faint">This is a separate account from restaurant staff PINs.</p>

      {error && <p role="alert" className="mt-3 rounded-xl bg-late-soft px-3 py-2 text-[12px] font-semibold text-late">{error}</p>}

      <div className="mt-4 grid gap-3">
        <Field label="Email">
          <TextInput value={email} onChange={setEmail} placeholder="you@platform.com" inputMode="email" autoFocus />
        </Field>
        <Field label="Password">
          <input
            className="field"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder="••••••••••"
            autoComplete="current-password"
          />
        </Field>
        <Button variant="primary" size="lg" className="w-full" disabled={busy || !email.trim() || !password} onClick={() => void submit()}>
          {busy ? <Spinner className="size-4" /> : <Icon name="lock" className="size-4" />}
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </div>

      {demoMode && demoCredentials && (
        <div className="mt-4 rounded-xl border border-warn/25 bg-warn-soft px-3 py-2.5 text-[11px] font-semibold leading-relaxed text-warn">
          <p className="font-bold">Demo platform account</p>
          <p className="mt-0.5 font-mono">{demoCredentials.email}</p>
          <p className="font-mono">{demoCredentials.password}</p>
          <button
            type="button"
            className="btn btn-ghost mt-2 w-full !py-1.5 !text-[11px]"
            onClick={() => {
              setEmail(demoCredentials.email);
              setPassword(demoCredentials.password);
            }}
          >
            Use demo credentials
          </button>
        </div>
      )}
    </div>
  );
}

function PlatformSetupForm({ tokenConfigured, onDone }: { tokenConfigured: boolean; onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = password.length >= 10 && password === confirm && name.trim() && email.trim() && setupToken;
  const canSubmit = Boolean(valid && !busy);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // The setup endpoint creates the first account and signs it in atomically.
      await platformApi.post("setup", { name, email, password, setupToken });
      toast("Platform initialized", "ok");
      await onDone();
    } catch (caught) {
      setError(platformErrorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-rule px-5 py-4">
        <p className="text-[10px] font-black uppercase tracking-[0.1em] text-brand-600">First run</p>
        <h2 className="mt-1 text-xl font-black text-ink">Create the platform owner</h2>
        <p className="mt-1 text-[11px] text-ink-faint">
          This account creates restaurants. It is not a restaurant login and holds no restaurant permissions.
        </p>
      </div>

      <div className="p-5">
        {!tokenConfigured && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-warn/25 bg-warn-soft px-3 py-3 text-[11px] font-semibold leading-relaxed text-warn">
            <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
            <p>
              <strong>Setup is locked by the deployer.</strong>
              <br />
              Set <code>RMS_SETUP_TOKEN</code> to a random value of at least 32 characters and restart RMS, or provide
              <code> RMS_PLATFORM_EMAIL</code> and <code>RMS_PLATFORM_PASSWORD</code>.
            </p>
          </div>
        )}
        {error && <p role="alert" className="mb-4 rounded-xl bg-late-soft px-3 py-2.5 text-[12px] font-semibold text-late">{error}</p>}

        <div className="grid gap-3">
          <Field label="Your name">
            <TextInput value={name} onChange={setName} placeholder="Platform owner" autoFocus />
          </Field>
          <Field label="Email">
            <TextInput value={email} onChange={setEmail} placeholder="you@platform.com" inputMode="email" />
          </Field>
          <Field label="Password" hint="At least 10 characters.">
            <input className="field" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Confirm password" hint={confirm && confirm !== password ? "Passwords do not match" : ""}>
            <input className="field" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Deployment setup token" hint="The random RMS_SETUP_TOKEN from the server, not a staff PIN.">
            <input
              className="field font-mono"
              type="password"
              value={setupToken}
              onChange={(event) => setSetupToken(event.target.value)}
              autoComplete="off"
              placeholder="Paste the one-time deployment token"
            />
          </Field>
          <Button variant="primary" size="lg" className="w-full" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? <Spinner className="size-4" /> : <Icon name="lock" className="size-4" />}
            {busy ? "Creating platform…" : "Create platform account"}
          </Button>
          <p className="text-center text-[10px] leading-relaxed text-ink-faint">
            Remove <code>RMS_SETUP_TOKEN</code> from the runtime environment after this step.
          </p>
        </div>
      </div>
    </div>
  );
}
