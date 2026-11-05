"use client";

/** One-time production setup. No demo identities are created by this flow. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "@/lib/api";
import { Button, Field, Icon, Spinner, TextInput, toast } from "@/components/ui";

interface SetupStatus {
  required: boolean;
  tokenConfigured: boolean;
  production: boolean;
}

export default function ProductionSetupPage() {
  const router = useRouter();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [tagline, setTagline] = useState("");
  const [adminName, setAdminName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [adminPin, setAdminPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<SetupStatus>("setup/status")
      .then(setStatus)
      .catch((error) => setLoadError(errorMessage(error)));
  }, []);

  const validPin = /^\d{4}(\d{2})?$/.test(adminPin);
  const canSubmit = Boolean(
    status?.required && status.tokenConfigured && restaurantName.trim() && adminName.trim() && setupToken && validPin && adminPin === confirmPin && !busy,
  );

  async function initialize() {
    if (!canSubmit) return;
    setBusy(true);
    setLoadError("");
    try {
      await api.post("setup/initialize", { restaurantName, tagline, adminName, adminPin, setupToken });
      setSetupToken("");
      setAdminPin("");
      setConfirmPin("");
      toast("Restaurant initialized. Sign in with your new manager PIN.", "ok");
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setLoadError(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-stage lg:grid lg:grid-cols-[minmax(320px,.8fr)_minmax(480px,1.2fr)]">
      <section className="relative flex flex-col justify-between overflow-hidden px-6 py-8 text-stage-ink lg:px-12 lg:py-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-20"
          style={{ backgroundImage: "radial-gradient(circle at 15% 20%, #0f6f66 0, transparent 45%), radial-gradient(circle at 85% 80%, #c2542f 0, transparent 42%)" }}
        />
        <div className="relative flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-brand-500 text-lg font-black text-white">RMS</span>
          <div><p className="text-lg font-extrabold">Restaurant Management System</p><p className="text-xs text-stage-soft">Production first-run setup</p></div>
        </div>
        <div className="relative my-10 max-w-lg lg:my-0">
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-brand-300">A clean, secure beginning</p>
          <h1 className="mt-3 text-3xl font-black leading-tight lg:text-[42px]">Your restaurant.<br /><span className="text-brand-300">No demo accounts.</span></h1>
          <p className="mt-4 text-sm leading-relaxed text-stage-soft">
            This one-time step creates your restaurant profile and first General Manager. It does not install sample staff, orders, menus or known PINs.
          </p>
          <div className="mt-7 grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            {[
              ["lock", "Token protected", "Only the deployer can initialize an empty workspace."],
              ["users", "Unique manager", "Your PIN is hashed before it is stored."],
              ["check", "One time only", "The setup closes permanently after initialization."],
            ].map(([icon, title, detail]) => (
              <div key={title} className="rounded-xl border border-stage-rule bg-stage-raised p-3">
                <Icon name={icon as "lock"} className="size-4 text-brand-300" />
                <p className="mt-2 text-[12px] font-bold">{title}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-stage-soft">{detail}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-[11px] text-stage-soft">Keep the setup token and manager PIN private. Neither value is written to the audit log.</p>
      </section>

      <section className="flex items-center justify-center bg-paper px-4 py-8 lg:px-10">
        <div className="w-full max-w-xl">
          <div className="card overflow-hidden">
            <div className="border-b border-rule px-5 py-4">
              <p className="text-[10px] font-black uppercase tracking-[0.1em] text-brand-600">Initial configuration</p>
              <h2 className="mt-1 text-xl font-black text-ink">Create your workspace</h2>
              <p className="mt-1 text-[12px] text-ink-faint">You can add staff, tables, menu items and hardware after signing in.</p>
            </div>

            {!status && !loadError ? (
              <div className="flex items-center justify-center gap-3 px-5 py-16 text-sm font-semibold text-ink-faint"><Spinner />Checking setup status…</div>
            ) : status && !status.required ? (
              <div className="px-5 py-10 text-center">
                <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-ok-soft text-ok"><Icon name="check" className="size-6" /></span>
                <h3 className="mt-4 text-lg font-extrabold text-ink">Workspace already initialized</h3>
                <p className="mx-auto mt-2 max-w-sm text-[12px] leading-relaxed text-ink-faint">Production setup is closed because an employee already exists. Continue to the staff PIN pad.</p>
                <Link href="/login" className="btn btn-primary mt-5">Go to sign in<Icon name="arrow-right" className="size-4" /></Link>
              </div>
            ) : (
              <div className="p-5">
                {!status?.tokenConfigured && (
                  <div className="mb-4 flex items-start gap-2 rounded-xl border border-warn/25 bg-warn-soft px-3 py-3 text-[11px] font-semibold leading-relaxed text-warn">
                    <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
                    <p><strong>Setup is locked by the deployer.</strong><br />Set <code>RMS_SETUP_TOKEN</code> to a random value of at least 32 characters in the runtime environment, then restart RMS.</p>
                  </div>
                )}
                {loadError && <p role="alert" className="mb-4 rounded-xl bg-late-soft px-3 py-2.5 text-[12px] font-semibold text-late">{loadError}</p>}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Restaurant name"><TextInput value={restaurantName} onChange={setRestaurantName} placeholder="Your restaurant" autoFocus /></Field>
                  <Field label="Tagline (optional)"><TextInput value={tagline} onChange={setTagline} placeholder="Cuisine · city · service style" /></Field>
                  <Field label="General Manager name" className="sm:col-span-2"><TextInput value={adminName} onChange={setAdminName} placeholder="The first administrator" /></Field>
                  <Field label="Deployment setup token" className="sm:col-span-2" hint="This is the random RMS_SETUP_TOKEN from the server, not a staff PIN.">
                    <input type="password" className="field font-mono" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} autoComplete="off" placeholder="Paste the one-time deployment token" />
                  </Field>
                  <Field label="New manager PIN" hint="Use 6 digits for a stronger production PIN.">
                    <input type="password" className="field tnum" value={adminPin} onChange={(event) => setAdminPin(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="new-password" placeholder="4 or 6 digits" />
                  </Field>
                  <Field label="Confirm manager PIN" hint={confirmPin && confirmPin !== adminPin ? "PINs do not match" : "Enter the same PIN again"}>
                    <input type="password" className="field tnum" value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="new-password" placeholder="Repeat PIN" />
                  </Field>
                </div>
                <Button variant="primary" size="lg" className="mt-5 w-full" disabled={!canSubmit} onClick={() => void initialize()}>
                  {busy ? <Spinner className="size-4" /> : <Icon name="lock" className="size-4" />}{busy ? "Creating workspace…" : "Initialize restaurant"}
                </Button>
                <p className="mt-3 text-center text-[10px] leading-relaxed text-ink-faint">After setup, remove RMS_SETUP_TOKEN from the runtime environment and restart the application.</p>
              </div>
            )}
          </div>
          <div className="mt-3 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2.5 text-[11px] leading-relaxed text-brand-800">
            <strong>Running more than one restaurant?</strong> Use the{" "}
            <Link href="/platform" className="font-bold underline">platform console</Link> instead. A platform owner
            creates each restaurant account and its administrator PIN; this page initializes one single-store install.
          </div>
          <p className="mt-4 text-center text-[11px] text-ink-faint">Already configured? <Link href="/login" className="font-bold text-brand-700 hover:underline">Return to staff sign in</Link></p>
        </div>
      </section>
    </main>
  );
}
