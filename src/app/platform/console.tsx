"use client";

/**
 * Super-admin console.
 *
 * One screen for the whole platform: create a restaurant, hand the owner their
 * sign-in details, suspend an account that has not paid, or reset a restaurant
 * administrator's PIN. It renders registry metadata and aggregate counts only —
 * opening a restaurant's orders, staff or money is a separate staff session with
 * that restaurant's PIN.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { platformApi, platformErrorMessage } from "@/lib/platform-api";
import { Chip, Empty, Field, Icon, Spinner, TextInput, toast } from "@/components/ui";
import { formatMoneyShort } from "@/domain/money";

export interface PlatformAccount {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  lastSigninAt: string | null;
}

export interface TenantStats {
  staff: number;
  managers: number;
  menuItems: number;
  tables: number;
  openOrders: number;
  ordersToday: number;
  salesToday: number;
  lastActivityAt: string | null;
  dbBytes: number;
  healthy: boolean;
}

export interface TenantRow {
  id: string;
  code: string;
  name: string;
  tagline: string;
  status: "active" | "suspended";
  plan: "free" | "standard" | "pro";
  planName: string;
  staffLimit: number | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  adminName: string;
  pinLength: 4 | 6;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  stats: TenantStats;
}

interface AuditRow {
  id: string;
  actorEmail: string;
  action: string;
  tenantCode: string;
  detail: string;
  createdAt: string;
}

interface Handoff {
  restaurantCode: string;
  signInUrl: string;
  adminName: string;
  note: string;
  adminPin: string;
  restaurantName: string;
}

type Tab = "restaurants" | "operators" | "activity";

const PLANS: { value: TenantRow["plan"]; label: string }[] = [
  { value: "free", label: "Free — 1 store, setup only" },
  { value: "standard", label: "Standard — full back office" },
  { value: "pro", label: "Pro — multi-terminal / reporting" },
];

export function PlatformConsole({
  account,
  demoMode,
  demoCredentials,
  onSignOut,
}: {
  account: PlatformAccount;
  demoMode: boolean;
  demoCredentials: { email: string; password: string } | null;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>("restaurants");
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [tenantResult, accountResult, auditResult] = await Promise.all([
        platformApi.get<{ tenants: TenantRow[] }>("tenants"),
        platformApi.get<{ accounts: PlatformAccount[] }>("accounts"),
        platformApi.get<{ entries: AuditRow[] }>("audit?limit=40"),
      ]);
      setTenants(tenantResult.tenants);
      setAccounts(accountResult.accounts);
      setAudit(auditResult.entries);
      setError(null);
    } catch (caught) {
      setError(platformErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summary = useMemo(() => {
    const active = tenants.filter((tenant) => tenant.status === "active");
    return {
      total: tenants.length,
      active: active.length,
      suspended: tenants.length - active.length,
      staff: tenants.reduce((sum, tenant) => sum + tenant.stats.staff, 0),
      openOrders: tenants.reduce((sum, tenant) => sum + tenant.stats.openOrders, 0),
    };
  }, [tenants]);

  const setStatus = async (tenant: TenantRow, status: "active" | "suspended") => {
    setBusyId(tenant.id);
    try {
      const result = await platformApi.patch<{ tenant: TenantRow }>(`tenants/${tenant.id}`, { status });
      setTenants((current) => current.map((entry) => (entry.id === tenant.id ? result.tenant : entry)));
      toast(
        status === "suspended"
          ? `${tenant.name} is suspended — staff sign-in is blocked`
          : `${tenant.name} is active again`,
        status === "suspended" ? "warn" : "ok",
      );
      void refresh();
    } catch (caught) {
      toast(platformErrorMessage(caught), "late");
    } finally {
      setBusyId(null);
    }
  };

  const updateDetails = async (
    tenant: TenantRow,
    patch: { name: string; tagline: string; plan: TenantRow["plan"]; contactName: string; contactEmail: string; contactPhone: string },
  ) => {
    setBusyId(tenant.id);
    try {
      const result = await platformApi.patch<{ tenant: TenantRow }>(`tenants/${tenant.id}`, patch);
      setTenants((current) => current.map((entry) => (entry.id === tenant.id ? result.tenant : entry)));
      toast(`${result.tenant.name} updated`, "ok");
      void refresh();
    } catch (caught) {
      toast(platformErrorMessage(caught), "late");
    } finally {
      setBusyId(null);
    }
  };

  const resetAdminPin = async (tenant: TenantRow, pin: string, reason: string) => {
    setBusyId(tenant.id);
    try {
      const result = await platformApi.post<{ adminPin: string; handoff: Omit<Handoff, "adminPin" | "restaurantName"> }>(
        `tenants/${tenant.id}/reset-admin`,
        { pin, reason },
      );
      setHandoff({
        ...result.handoff,
        adminPin: result.adminPin,
        restaurantName: tenant.name,
      });
      toast(`New admin PIN set for ${tenant.name}`, "ok");
      void refresh();
    } catch (caught) {
      toast(platformErrorMessage(caught), "late");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-rule bg-stage text-stage-ink">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand-500 text-sm font-black text-white">
            RMS
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-extrabold leading-tight">Platform console</p>
            <p className="text-[11px] text-stage-soft">Super admin · restaurant registry</p>
          </div>
          <div className="flex items-center gap-2">
            {demoMode && <Chip tone="warn">Demo mode</Chip>}
            <div className="text-right">
              <p className="text-[12px] font-bold text-stage-ink">{account.name}</p>
              <p className="text-[10px] text-stage-soft">{account.email}</p>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              className="rounded-lg border border-stage-rule px-2.5 py-1.5 text-[11px] font-bold text-stage-soft transition-colors hover:text-stage-ink"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          <SummaryTile label="Restaurants" value={summary.total} />
          <SummaryTile label="Active" value={summary.active} tone="ok" />
          <SummaryTile label="Suspended" value={summary.suspended} tone={summary.suspended ? "warn" : "neutral"} />
          <SummaryTile label="Restaurant staff" value={summary.staff} />
          <SummaryTile label="Open tickets" value={summary.openOrders} />
        </div>

        {error && (
          <p role="alert" className="mb-4 rounded-xl bg-late-soft px-3 py-2.5 text-[12px] font-semibold text-late">
            {error}
          </p>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {(
            [
              ["restaurants", "Restaurants", tenants.length],
              ["operators", "Operators", accounts.length],
              ["activity", "Activity", audit.length],
            ] as [Tab, string, number][]
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-bold transition-colors ${
                tab === key ? "bg-brand-500 text-white" : "bg-paper-raised text-ink-soft hover:text-ink"
              }`}
            >
              {label}
              <span className={`ml-1.5 rounded px-1 text-[10px] ${tab === key ? "bg-white/20" : "bg-paper-sunken"}`}>
                {count}
              </span>
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-lg px-2 py-1.5 text-[11px] font-bold text-ink-faint hover:text-ink"
            >
              Refresh
            </button>
            {tab === "restaurants" && (
              <button
                type="button"
                onClick={() => {
                  setCreating(true);
                  setHandoff(null);
                }}
                className="btn btn-primary !px-3 !py-1.5 !text-xs"
              >
                <Icon name="plus" className="size-4" /> New restaurant
              </button>
            )}
          </div>
        </div>

        {handoff && <HandoffCard handoff={handoff} onClose={() => setHandoff(null)} />}

        {creating && tab === "restaurants" && (
          <CreateRestaurantForm
            demoMode={demoMode}
            onCancel={() => setCreating(false)}
            onCreated={(created) => {
              setCreating(false);
              setHandoff(created);
              setTab("restaurants");
              void refresh();
            }}
          />
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm font-semibold text-ink-faint">
            <Spinner /> Loading registry…
          </div>
        ) : tab === "restaurants" ? (
          tenants.length === 0 ? (
            <div className="card">
              <Empty
                icon="inventory"
                title="No restaurants yet"
                hint="Create the first restaurant. You will get a restaurant code, a sign-in link and the admin PIN to hand over."
              />
            </div>
          ) : (
            <div className="grid gap-3">
              {tenants.map((tenant) => (
                <RestaurantCard
                  key={tenant.id}
                  tenant={tenant}
                  busy={busyId === tenant.id}
                  onStatus={(status) => void setStatus(tenant, status)}
                  onResetPin={(pin, reason) => void resetAdminPin(tenant, pin, reason)}
                  onUpdate={(patch) => void updateDetails(tenant, patch)}
                />
              ))}
            </div>
          )
        ) : tab === "operators" ? (
          <OperatorsPanel accounts={accounts} onChanged={() => void refresh()} currentId={account.id} />
        ) : (
          <ActivityPanel entries={audit} />
        )}

        {demoMode && demoCredentials && (
          <p className="mt-6 text-center text-[11px] text-ink-faint">
            Demo platform account: <span className="font-mono font-bold text-ink-soft">{demoCredentials.email}</span> /{" "}
            <span className="font-mono font-bold text-ink-soft">{demoCredentials.password}</span>
          </p>
        )}
        <p className="mt-2 text-center text-[11px] text-ink-faint">
          <Link href="/login" className="font-bold text-brand-700 hover:underline">
            Restaurant staff sign-in →
          </Link>
        </p>
      </main>
    </div>
  );
}

function SummaryTile({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "ok" | "warn" }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="card px-3 py-2.5">
      <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">{label}</p>
      <p className={`tnum mt-0.5 text-xl font-black ${color}`}>{value}</p>
    </div>
  );
}

function RestaurantCard({
  tenant,
  busy,
  onStatus,
  onResetPin,
  onUpdate,
}: {
  tenant: TenantRow;
  busy: boolean;
  onStatus: (status: "active" | "suspended") => void;
  onResetPin: (pin: string, reason: string) => void;
  onUpdate: (patch: {
    name: string;
    tagline: string;
    plan: TenantRow["plan"];
    contactName: string;
    contactEmail: string;
    contactPhone: string;
  }) => void;
}) {
  const [resetting, setResetting] = useState(false);
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    name: tenant.name,
    tagline: tenant.tagline,
    plan: tenant.plan,
    contactName: tenant.contactName,
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
  });
  const suspended = tenant.status === "suspended";
  const validPin = /^\d{4}(\d{2})?$/.test(pin);

  const copyLink = async () => {
    const url = `${window.location.origin}/login?restaurant=${encodeURIComponent(tenant.code)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Sign-in link copied", "ok");
    } catch {
      toast(url, "neutral");
    }
  };

  return (
    <article className={`card ${suspended ? "opacity-80" : ""}`}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-sm font-black text-white">
          {tenant.name.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[15px] font-extrabold text-ink">{tenant.name}</h3>
            <span className="rounded bg-paper-sunken px-1.5 py-0.5 font-mono text-[10px] font-bold text-ink-soft">
              {tenant.code}
            </span>
            <Chip tone={suspended ? "late" : "ok"} dot>
              {suspended ? "Suspended" : "Active"}
            </Chip>
            <Chip tone="neutral">{tenant.planName}</Chip>
            {tenant.staffLimit !== null && tenant.stats.staff >= tenant.staffLimit && (
              <Chip tone="warn">At seat limit</Chip>
            )}
            {!tenant.stats.healthy && <Chip tone="warn">Database unreadable</Chip>}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-ink-faint">
            {tenant.tagline || "No tagline"} · admin {tenant.adminName || "—"} · PIN {tenant.pinLength} digits · created{" "}
            {tenant.createdAt.slice(0, 10)}
          </p>
          {tenant.contactEmail && (
            <p className="truncate text-[11px] text-ink-faint">
              {tenant.contactName || "Owner"} · {tenant.contactEmail}
              {tenant.contactPhone ? ` · ${tenant.contactPhone}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => void copyLink()} className="btn btn-ghost !px-2.5 !py-1.5 !text-[11px]">
            <Icon name="qr" className="size-3.5" /> Sign-in link
          </button>
          <button
            type="button"
            onClick={() => setResetting((current) => !current)}
            className="btn btn-ghost !px-2.5 !py-1.5 !text-[11px]"
          >
            <Icon name="lock" className="size-3.5" /> Reset admin PIN
          </button>
          <button
            type="button"
            onClick={() => setEditing((current) => !current)}
            className="btn btn-ghost !px-2.5 !py-1.5 !text-[11px]"
          >
            <Icon name="edit" className="size-3.5" /> Details
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onStatus(suspended ? "active" : "suspended")}
            className={`btn !px-2.5 !py-1.5 !text-[11px] ${suspended ? "btn-primary" : "btn-danger"}`}
          >
            {busy ? <Spinner className="size-3.5" /> : <Icon name={suspended ? "check" : "alert"} className="size-3.5" />}
            {suspended ? "Reactivate" : "Suspend"}
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-rule pt-3 sm:grid-cols-6">
        <Metric
          label="Staff"
          value={tenant.staffLimit === null ? String(tenant.stats.staff) : `${tenant.stats.staff}/${tenant.staffLimit}`}
        />
        <Metric label="Managers" value={String(tenant.stats.managers)} />
        <Metric label="Menu items" value={String(tenant.stats.menuItems)} />
        <Metric label="Tables" value={String(tenant.stats.tables)} />
        <Metric label="Open tickets" value={String(tenant.stats.openOrders)} />
        <Metric label="Sales today" value={formatMoneyShort(tenant.stats.salesToday)} />
      </div>

      {editing && (
        <div className="mt-3 rounded-xl border border-rule bg-paper-sunken p-3">
          <p className="text-[11px] font-bold text-ink">Restaurant details</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Field label="Name">
              <TextInput value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} />
            </Field>
            <Field label="Plan">
              <select
                className="field"
                value={draft.plan}
                onChange={(event) => setDraft({ ...draft, plan: event.target.value as TenantRow["plan"] })}
              >
                {PLANS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tagline" className="sm:col-span-2">
              <TextInput value={draft.tagline} onChange={(value) => setDraft({ ...draft, tagline: value })} />
            </Field>
            <Field label="Contact name">
              <TextInput value={draft.contactName} onChange={(value) => setDraft({ ...draft, contactName: value })} />
            </Field>
            <Field label="Contact email">
              <TextInput value={draft.contactEmail} onChange={(value) => setDraft({ ...draft, contactEmail: value })} />
            </Field>
            <Field label="Contact phone">
              <TextInput value={draft.contactPhone} onChange={(value) => setDraft({ ...draft, contactPhone: value })} />
            </Field>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button type="button" className="btn btn-ghost !px-3 !py-1.5 !text-[11px]" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !draft.name.trim()}
              className="btn btn-primary !px-3 !py-1.5 !text-[11px]"
              onClick={() => {
                onUpdate(draft);
                setEditing(false);
              }}
            >
              Save details
            </button>
          </div>
        </div>
      )}

      {resetting && (
        <div className="mt-3 rounded-xl border border-rule bg-paper-sunken p-3">
          <p className="text-[11px] font-bold text-ink">Set a new restaurant admin PIN</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
            The owner signs in with this PIN. It is hashed in the restaurant database and shown once here — nothing
            else in the restaurant is changed.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-[140px_1fr_auto]">
            <TextInput
              value={pin}
              onChange={(value) => setPin(value.replace(/\D/g, "").slice(0, 6))}
              placeholder="4 or 6 digits"
              inputMode="numeric"
              className="tnum"
            />
            <TextInput value={reason} onChange={setReason} placeholder="Reason (optional, audited)" />
            <button
              type="button"
              disabled={!validPin || busy}
              onClick={() => {
                onResetPin(pin, reason);
                setPin("");
                setReason("");
                setResetting(false);
              }}
              className="btn btn-primary !px-3 !py-2 !text-xs"
            >
              Set PIN
            </button>
          </div>
        </div>
      )}

      {tenant.notes && <p className="mt-2 text-[11px] italic text-ink-faint">{tenant.notes}</p>}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] font-bold uppercase tracking-[0.07em] text-ink-faint">{label}</p>
      <p className="tnum text-[13px] font-extrabold text-ink">{value}</p>
    </div>
  );
}

function CreateRestaurantForm({
  demoMode,
  onCancel,
  onCreated,
}: {
  demoMode: boolean;
  onCancel: () => void;
  onCreated: (handoff: Handoff) => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeEdited, setCodeEdited] = useState(false);
  const [tagline, setTagline] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminPin, setAdminPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [plan, setPlan] = useState<TenantRow["plan"]>("standard");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [starter, setStarter] = useState<"blank" | "demo">("blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

  const effectiveCode = codeEdited ? code : slug(name);
  const validPin = /^\d{4}(\d{2})?$/.test(adminPin);
  const canSubmit =
    Boolean(name.trim() && adminName.trim() && effectiveCode.length >= 3) && validPin && adminPin === confirmPin && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await platformApi.post<{
        tenant: TenantRow;
        adminPin: string;
        handoff: { restaurantCode: string; signInUrl: string; adminName: string; note: string };
      }>("tenants", {
        name,
        code: effectiveCode,
        tagline,
        adminName,
        adminPin,
        plan,
        contactName,
        contactEmail,
        contactPhone,
        notes,
        starter,
      });
      toast(`${result.tenant.name} created`, "ok");
      onCreated({
        ...result.handoff,
        adminPin: result.adminPin,
        restaurantName: result.tenant.name,
      });
    } catch (caught) {
      setError(platformErrorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <section className="card mb-4 border-brand-200">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.09em] text-brand-600">Provision a restaurant</p>
          <h2 className="text-lg font-black text-ink">Create a restaurant account</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            This creates an isolated database, installs the role matrix and creates the restaurant administrator.
          </p>
        </div>
        <button type="button" onClick={onCancel} aria-label="Close" className="rounded-lg p-1.5 text-ink-faint hover:bg-paper-sunken">
          <Icon name="close" className="size-4" />
        </button>
      </div>

      {error && <p role="alert" className="mb-3 rounded-xl bg-late-soft px-3 py-2 text-[12px] font-semibold text-late">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Restaurant name" hint="Shown on the shell, receipts and reports.">
          <TextInput value={name} onChange={setName} placeholder="e.g. Himalayan Grill" autoFocus />
        </Field>
        <Field label="Restaurant code" hint="The owner's sign-in code. Letters, digits and dashes.">
          <TextInput
            value={effectiveCode}
            onChange={(value) => {
              setCodeEdited(true);
              setCode(slug(value));
            }}
            placeholder="himalayan-grill"
            className="font-mono"
          />
        </Field>
        <Field label="Tagline (optional)" className="sm:col-span-2">
          <TextInput value={tagline} onChange={setTagline} placeholder="Cuisine · city · service style" />
        </Field>
        <Field label="Restaurant admin name" hint="The manager role already holds every restaurant permission.">
          <TextInput value={adminName} onChange={setAdminName} placeholder="Owner / general manager" />
        </Field>
        <Field label="Plan">
          <select className="field" value={plan} onChange={(event) => setPlan(event.target.value as TenantRow["plan"])}>
            {PLANS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Admin PIN" hint="4 or 6 digits. Hashed — you will see it once.">
          <input
            className="field tnum"
            value={adminPin}
            onChange={(event) => setAdminPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            placeholder="4 or 6 digits"
            type="password"
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm admin PIN" hint={confirmPin && confirmPin !== adminPin ? "PINs do not match" : "Repeat the PIN"}>
          <input
            className="field tnum"
            value={confirmPin}
            onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            placeholder="Repeat PIN"
            type="password"
            autoComplete="new-password"
          />
        </Field>
        <Field label="Contact name (optional)">
          <TextInput value={contactName} onChange={setContactName} placeholder="Billing contact" />
        </Field>
        <Field label="Contact email (optional)">
          <TextInput value={contactEmail} onChange={setContactEmail} placeholder="owner@restaurant.com" inputMode="email" />
        </Field>
        <Field label="Contact phone (optional)">
          <TextInput value={contactPhone} onChange={setContactPhone} placeholder="+977 …" inputMode="tel" />
        </Field>
        <Field label="Starting workspace">
          <select
            className="field"
            value={starter}
            onChange={(event) => setStarter(event.target.value === "demo" ? "demo" : "blank")}
          >
            <option value="blank">Blank — roles, stations and admin only</option>
            {demoMode && <option value="demo">Demo — sample menu, floor, staff and history</option>}
          </select>
        </Field>
        <Field label="Internal notes (optional)" className="sm:col-span-2">
          <TextInput value={notes} onChange={setNotes} placeholder="Trial account, go-live date, anything the next operator should know" />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-ink-faint">
          A blank workspace starts with no menu or floor. The owner builds those from <code>/admin/menu</code>.
        </p>
        <button type="button" disabled={!canSubmit} onClick={() => void submit()} className="btn btn-primary">
          {busy ? <Spinner className="size-4" /> : <Icon name="plus" className="size-4" />}
          {busy ? "Provisioning…" : "Create restaurant"}
        </button>
      </div>
    </section>
  );
}

function HandoffCard({ handoff, onClose }: { handoff: Handoff; onClose: () => void }) {
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied`, "ok");
    } catch {
      toast("Copy failed — select the text manually", "warn");
    }
  };

  return (
    <section className="card mb-4 border-ok/40 bg-ok-soft/40">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[12px] font-extrabold text-ok">
            <Icon name="check" className="size-4" /> {handoff.restaurantName} is ready
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-soft">{handoff.note}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Dismiss" className="rounded-lg p-1.5 text-ink-faint hover:bg-paper-sunken">
          <Icon name="close" className="size-4" />
        </button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <HandoffValue label="Restaurant code" value={handoff.restaurantCode} mono onCopy={() => void copy("Code", handoff.restaurantCode)} />
        <HandoffValue label="Admin PIN" value={handoff.adminPin} mono sensitive onCopy={() => void copy("PIN", handoff.adminPin)} />
        <HandoffValue
          label="Sign-in link"
          value={handoff.signInUrl}
          mono
          onCopy={() => void copy("Link", `${window.location.origin}${handoff.signInUrl}`)}
        />
      </div>
      <p className="mt-2 text-[11px] font-semibold text-warn">
        This PIN is shown once. Give it to {handoff.adminName || "the owner"} and ask them to change it in Users &amp; Permissions.
      </p>
    </section>
  );
}

function HandoffValue({
  label,
  value,
  onCopy,
  mono,
  sensitive,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  mono?: boolean;
  sensitive?: boolean;
}) {
  return (
    <div className="rounded-xl border border-rule bg-paper-raised px-2.5 py-2">
      <p className="text-[9px] font-bold uppercase tracking-[0.08em] text-ink-faint">{label}</p>
      <div className="flex items-center gap-1.5">
        <p className={`min-w-0 flex-1 truncate text-[12px] font-bold text-ink ${mono ? "font-mono" : ""} ${sensitive ? "tnum" : ""}`}>
          {value}
        </p>
        <button type="button" onClick={onCopy} className="rounded p-1 text-ink-faint hover:bg-paper-sunken hover:text-ink" aria-label={`Copy ${label}`}>
          <Icon name="receipt" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function OperatorsPanel({
  accounts,
  onChanged,
  currentId,
}: {
  accounts: PlatformAccount[];
  onChanged: () => void;
  currentId: string;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = Boolean(name.trim() && email.trim() && password.length >= 10 && !busy);

  async function add() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await platformApi.post("accounts", { name, email, password });
      toast("Platform operator added", "ok");
      setName("");
      setEmail("");
      setPassword("");
      onChanged();
    } catch (caught) {
      setError(platformErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[1.2fr_.8fr]">
      <div className="card">
        <h3 className="text-[15px] font-bold text-ink">Platform operators</h3>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          Operators can create and suspend restaurants. They cannot open a restaurant&apos;s orders without that
          restaurant&apos;s staff PIN.
        </p>
        <ul className="mt-3 divide-y divide-rule">
          {accounts.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2 py-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-paper-sunken text-[11px] font-black text-ink-soft">
                {entry.name.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-bold text-ink">
                  {entry.name} {entry.id === currentId && <span className="text-[10px] font-bold text-brand-600">(you)</span>}
                </p>
                <p className="truncate text-[11px] text-ink-faint">{entry.email}</p>
              </div>
              <div className="text-right">
                <Chip tone={entry.isActive ? "ok" : "neutral"}>{entry.isActive ? "Active" : "Disabled"}</Chip>
                <p className="mt-0.5 text-[10px] text-ink-faint">
                  {entry.lastSigninAt ? `seen ${entry.lastSigninAt.slice(0, 16)}` : "never signed in"}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3 className="text-[15px] font-bold text-ink">Add an operator</h3>
        <p className="mt-0.5 text-[11px] text-ink-faint">Minimum 10 characters. Use a password manager.</p>
        {error && <p className="mt-2 rounded-lg bg-late-soft px-2.5 py-2 text-[11px] font-semibold text-late">{error}</p>}
        <div className="mt-3 grid gap-2">
          <Field label="Name">
            <TextInput value={name} onChange={setName} placeholder="Ops lead" />
          </Field>
          <Field label="Email">
            <TextInput value={email} onChange={setEmail} placeholder="ops@yourplatform.com" inputMode="email" />
          </Field>
          <Field label="Password" hint="At least 10 characters.">
            <input
              className="field"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••••"
              autoComplete="new-password"
            />
          </Field>
          <button type="button" disabled={!canSubmit} onClick={() => void add()} className="btn btn-primary mt-1">
            {busy ? <Spinner className="size-4" /> : <Icon name="plus" className="size-4" />} Add operator
          </button>
        </div>
      </div>
    </div>
  );
}

function ActivityPanel({ entries }: { entries: AuditRow[] }) {
  if (!entries.length) {
    return (
      <div className="card">
        <Empty icon="report" title="No platform activity yet" hint="Creating, suspending and resetting restaurants is recorded here." />
      </div>
    );
  }
  return (
    <div className="card overflow-hidden !p-0">
      <table className="w-full text-left text-[12px]">
        <thead className="border-b border-rule bg-paper-sunken text-[10px] uppercase tracking-[0.07em] text-ink-faint">
          <tr>
            <th className="px-3 py-2 font-bold">When</th>
            <th className="px-3 py-2 font-bold">Operator</th>
            <th className="px-3 py-2 font-bold">Action</th>
            <th className="px-3 py-2 font-bold">Restaurant</th>
            <th className="px-3 py-2 font-bold">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="whitespace-nowrap px-3 py-2 tnum text-ink-faint">{entry.createdAt.slice(0, 16)}</td>
              <td className="px-3 py-2 text-ink-soft">{entry.actorEmail}</td>
              <td className="px-3 py-2 font-mono text-[11px] font-bold text-ink">{entry.action.replace("platform.", "")}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-soft">{entry.tenantCode || "—"}</td>
              <td className="px-3 py-2 text-ink-faint">{entry.detail || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
