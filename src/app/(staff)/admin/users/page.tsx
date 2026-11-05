"use client";

/**
 * Users & Permissions — the restaurant administrator's team screen.
 *
 * The platform super admin creates the restaurant and its first administrator;
 * from there this page is where the restaurant is staffed. Every change is a
 * restaurant-scoped API call: a manager here can only ever touch employees and
 * roles inside their own tenant database.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { api, errorMessage } from "@/lib/api";
import { Avatar, Button, Card, Chip, Empty, Field, Icon, Spinner, TextInput, toast } from "@/components/ui";
import { formatMoney } from "@/domain/money";
import type { AuditEntry, RoleInfo, StaffMember } from "@/types";
import type { Permission } from "@/domain/permissions";

interface CatalogueGroup {
  label: string;
  permissions: { key: Permission; label: string }[];
}

interface RolesResponse {
  roles: RoleInfo[];
  catalogue: CatalogueGroup[];
}

interface PlanResponse {
  plan: { plan: { id: string; name: string; summary: string }; activeStaff: number; staffLimit: number | null } | null;
}

export default function UsersPage() {
  const { allowed, loading: storeLoading, state } = useStore();
  const [tab, setTab] = useState<"team" | "roles" | "activity">("team");
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [catalogue, setCatalogue] = useState<CatalogueGroup[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [plan, setPlan] = useState<PlanResponse["plan"]>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const canManage = allowed("admin.users");
  const demoMode = state?.demoMode ?? false;

  const refresh = useCallback(async () => {
    try {
      const [staffResult, roleResult, auditResult, planResult] = await Promise.all([
        api.get<{ staff: StaffMember[]; roles: RoleInfo[] }>("staff?includeInactive=1"),
        api.get<RolesResponse>("roles"),
        api.get<{ entries: AuditEntry[] }>("audit?limit=40"),
        api.get<PlanResponse>("plan").catch(() => ({ plan: null })),
      ]);
      setStaff(staffResult.staff);
      setRoles(roleResult.roles);
      setCatalogue(roleResult.catalogue);
      setAudit(auditResult.entries);
      setPlan(planResult.plan);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canManage) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [canManage, refresh]);

  const active = useMemo(() => staff.filter((member) => member.isActive), [staff]);
  const atSeatLimit = Boolean(plan && plan.staffLimit !== null && plan.activeStaff >= plan.staffLimit);

  if (storeLoading) {
    return (
      <div className="flex items-center justify-center gap-3 py-20 text-sm font-semibold text-ink-faint">
        <Spinner /> Loading the team…
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="page">
        <Card>
          <Empty
            icon="lock"
            title="Manager access required"
            hint="Employee and permission administration needs the admin.users permission. Ask your General Manager."
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.09em] text-brand-600">Restaurant administration</p>
          <h1 className="text-2xl font-black text-ink">Users &amp; Permissions</h1>
          <p className="mt-0.5 text-[12px] text-ink-faint">
            {active.length} active employee{active.length === 1 ? "" : "s"} · {roles.length} roles · PINs are hashed and
            never shown again
            {state?.tenant ? ` · ${state.tenant.name}` : ""}
          </p>
          {plan && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
              <Chip tone="neutral">{plan.plan.name} plan</Chip>
              <span className="tnum font-semibold text-ink-soft">
                {plan.activeStaff}
                {plan.staffLimit === null ? " active staff · unlimited seats" : `/${plan.staffLimit} seats used`}
              </span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {(
            [
              ["team", "Team"],
              ["roles", "Roles & permissions"],
              ["activity", "Activity"],
            ] as [typeof tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-bold transition-colors ${
                tab === key ? "bg-brand-500 text-white" : "bg-paper-raised text-ink-soft hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
          {tab === "team" && (
            <Button
              variant="primary"
              size="sm"
              disabled={atSeatLimit}
              title={atSeatLimit ? "The plan's seat limit is reached. Deactivate someone or upgrade the plan." : undefined}
              onClick={() => setAdding((current) => !current)}
            >
              <Icon name="plus" className="size-4" /> Add employee
            </Button>
          )}
        </div>
      </header>

      {error && (
        <p role="alert" className="mb-3 rounded-xl bg-late-soft px-3 py-2.5 text-[12px] font-semibold text-late">
          {error}
        </p>
      )}

      {atSeatLimit && (
        <p className="mb-3 rounded-xl border border-warn/25 bg-warn-soft px-3 py-2.5 text-[12px] font-semibold text-warn">
          This restaurant has reached the {plan?.plan.name} plan&apos;s seat limit of {plan?.staffLimit} active staff.
          Deactivate someone you no longer schedule, or ask your platform administrator to change the plan.
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-3 py-16 text-sm font-semibold text-ink-faint">
          <Spinner /> Loading…
        </div>
      ) : tab === "team" ? (
        <div className="grid gap-3">
          {adding && (
            <AddEmployee
              roles={roles}
              onCancel={() => setAdding(false)}
              onCreated={() => {
                setAdding(false);
                void refresh();
              }}
            />
          )}
          <TeamTable
            staff={staff}
            roles={roles}
            demoMode={demoMode}
            currentUserId={state?.user.id ?? ""}
            onChanged={() => void refresh()}
          />
        </div>
      ) : tab === "roles" ? (
        <RolesPanel roles={roles} catalogue={catalogue} onChanged={() => void refresh()} />
      ) : (
        <ActivityPanel entries={audit} />
      )}
    </div>
  );
}

function AddEmployee({
  roles,
  onCancel,
  onCreated,
}: {
  roles: RoleInfo[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [pin, setPin] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validPin = /^\d{4}(\d{2})?$/.test(pin);
  const canSubmit = Boolean(name.trim() && roleId && validPin && !busy);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("staff", { name, roleId, pin, phone });
      toast(`${name.trim()} added`, "ok");
      onCreated();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <Card title="New employee" icon="users" className="border-brand-200">
      {error && <p className="mb-3 rounded-lg bg-late-soft px-3 py-2 text-[12px] font-semibold text-late">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <TextInput value={name} onChange={setName} placeholder="Full name" autoFocus />
        </Field>
        <Field label="Role">
          <select className="field" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sign-in PIN" hint="4 or 6 digits, unique in this restaurant.">
          <input
            className="field tnum"
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            type="password"
            autoComplete="new-password"
            placeholder="••••"
          />
        </Field>
        <Field label="Phone (optional)">
          <TextInput value={phone} onChange={setPhone} placeholder="+977 …" inputMode="tel" />
        </Field>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? <Spinner className="size-4" /> : <Icon name="plus" className="size-4" />} Add employee
        </Button>
      </div>
    </Card>
  );
}

function TeamTable({
  staff,
  roles,
  demoMode,
  currentUserId,
  onChanged,
}: {
  staff: StaffMember[];
  roles: RoleInfo[];
  demoMode: boolean;
  currentUserId: string;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const patch = async (member: StaffMember, body: Record<string, unknown>) => {
    setBusyId(member.id);
    try {
      await api.patch(`staff/${member.id}`, body);
      toast(`${member.name} updated`, "ok");
      setEditingId(null);
      onChanged();
    } catch (caught) {
      toast(errorMessage(caught), "late");
    } finally {
      setBusyId(null);
    }
  };

  const deactivate = async (member: StaffMember) => {
    setBusyId(member.id);
    try {
      await api.post(`staff/${member.id}/deactivate`);
      toast(`${member.name} deactivated — history keeps their name`, "ok");
      onChanged();
    } catch (caught) {
      toast(errorMessage(caught), "late");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card title="Team" subtitle="Clock someone out before deactivating them." icon="users" className="overflow-hidden">
      <table className="w-full text-left text-[12px]">
        <thead className="border-b border-rule text-[10px] uppercase tracking-[0.07em] text-ink-faint">
          <tr>
            <th className="px-2 py-2 font-bold">Employee</th>
            <th className="px-2 py-2 font-bold">Role</th>
            <th className="px-2 py-2 font-bold">Rate</th>
            <th className="px-2 py-2 font-bold">Status</th>
            <th className="px-2 py-2 font-bold">Permissions</th>
            <th className="px-2 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {staff.map((member) => (
            <tr key={member.id} className={member.isActive ? "" : "opacity-60"}>
              <td className="px-2 py-2">
                <div className="flex items-center gap-2">
                  <Avatar name={member.name} initials={member.initials} color={member.color} size={28} />
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-bold text-ink">
                      {member.name}
                      {member.id === currentUserId && <span className="ml-1 text-[10px] text-brand-600">(you)</span>}
                    </p>
                    <p className="truncate text-[10px] text-ink-faint">
                      {member.phone || member.hireDate || "—"}
                      {demoMode && member.pin ? ` · PIN ${member.pin}` : ""}
                    </p>
                  </div>
                </div>
              </td>
              <td className="px-2 py-2 text-ink-soft">{member.roleTitle}</td>
              <td className="px-2 py-2 tnum text-ink-soft">{formatMoney(member.hourlyRate)}/h</td>
              <td className="px-2 py-2">
                <div className="flex flex-wrap gap-1">
                  <Chip tone={member.isActive ? "ok" : "neutral"}>{member.isActive ? "Active" : "Inactive"}</Chip>
                  {member.clockedIn && <Chip tone="brand">On shift</Chip>}
                </div>
              </td>
              <td className="px-2 py-2 tnum text-ink-faint">{member.permissions?.length ?? 0}</td>
              <td className="px-2 py-2 text-right">
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => setEditingId(editingId === member.id ? null : member.id)}
                    className="btn btn-ghost !px-2 !py-1 !text-[11px]"
                  >
                    <Icon name="edit" className="size-3.5" /> Edit
                  </button>
                  {member.isActive && member.id !== currentUserId && (
                    <button
                      type="button"
                      disabled={busyId === member.id}
                      onClick={() => void deactivate(member)}
                      className="btn btn-ghost !px-2 !py-1 !text-[11px] text-late"
                    >
                      {busyId === member.id ? <Spinner className="size-3.5" /> : <Icon name="close" className="size-3.5" />}
                      Deactivate
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editingId && (
        <EditEmployee
          member={staff.find((entry) => entry.id === editingId)!}
          roles={roles}
          busy={busyId === editingId}
          onCancel={() => setEditingId(null)}
          onSave={(body) => {
            const member = staff.find((entry) => entry.id === editingId);
            if (member) void patch(member, body);
          }}
        />
      )}
    </Card>
  );
}

function EditEmployee({
  member,
  roles,
  busy,
  onCancel,
  onSave,
}: {
  member: StaffMember;
  roles: RoleInfo[];
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(member.name);
  const [roleId, setRoleId] = useState(roles.find((role) => role.name === member.role)?.id ?? "");
  const [pin, setPin] = useState("");
  const [phone, setPhone] = useState(member.phone);
  const [isActive, setIsActive] = useState(member.isActive);

  const pinValid = pin === "" || /^\d{4}(\d{2})?$/.test(pin);

  return (
    <div className="mt-3 rounded-xl border border-rule bg-paper-sunken p-3">
      <p className="text-[12px] font-bold text-ink">Edit {member.name}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <TextInput value={name} onChange={setName} />
        </Field>
        <Field label="Role">
          <select className="field" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="New PIN" hint={pinValid ? "Blank keeps the current PIN." : "4 or 6 digits"}>
          <input
            className="field tnum"
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            type="password"
            autoComplete="new-password"
            placeholder="Leave blank to keep"
          />
        </Field>
        <Field label="Phone">
          <TextInput value={phone} onChange={setPhone} />
        </Field>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-[12px] font-semibold text-ink-soft">
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
          Active (can sign in)
        </label>
        <div className="flex gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim() || !pinValid}
            onClick={() => onSave({ name, roleId, phone, isActive, ...(pin ? { pin } : {}) })}
          >
            {busy ? <Spinner className="size-4" /> : <Icon name="check" className="size-4" />} Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}

function RolesPanel({
  roles,
  catalogue,
  onChanged,
}: {
  roles: RoleInfo[];
  catalogue: CatalogueGroup[];
  onChanged: () => void;
}) {
  const [selectedId, setSelectedId] = useState(roles[0]?.id ?? "");
  const selected = roles.find((role) => role.id === selectedId) ?? roles[0];
  const [draft, setDraft] = useState<Set<string>>(new Set(selected?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setDraft(new Set(selected?.permissions ?? []));
  }, [selected?.id, selected?.permissions]);

  const toggle = (permission: string) => {
    setDraft((current) => {
      const next = new Set(current);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  };

  async function save() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.put(`roles/${selected.id}/permissions`, { permissions: [...draft] });
      toast(`${selected.title}: ${draft.size} permission(s)`, "ok");
      onChanged();
    } catch (caught) {
      toast(errorMessage(caught), "late");
    } finally {
      setBusy(false);
    }
  }

  if (!selected) return <Empty icon="users" title="No roles yet" hint="Create a role to start assigning permissions." />;

  const locked = selected.name === "manager";

  return (
    <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
      <Card title="Roles" icon="users">
        <ul className="grid gap-1">
          {roles.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                onClick={() => setSelectedId(role.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-semibold transition-colors ${
                  role.id === selected.id ? "bg-brand-500 text-white" : "text-ink-soft hover:bg-paper-sunken"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{role.title}</span>
                <span className="tnum text-[10px] opacity-80">{role.headcount}</span>
                <span className="tnum rounded bg-black/10 px-1 text-[10px]">{role.permissions.length}</span>
              </button>
            </li>
          ))}
        </ul>
        {creating ? (
          <CreateRole
            catalogue={catalogue}
            onCancel={() => setCreating(false)}
            onCreated={() => {
              setCreating(false);
              onChanged();
            }}
          />
        ) : (
          <Button className="mt-3 w-full" onClick={() => setCreating(true)}>
            <Icon name="plus" className="size-4" /> New role
          </Button>
        )}
      </Card>

      <Card
        title={selected.title}
        subtitle={`${selected.permissions.length} of ${catalogue.reduce((total, group) => total + group.permissions.length, 0)} permissions · ${selected.headcount} employee(s)`}
        icon="lock"
        action={
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner className="size-4" /> : <Icon name="check" className="size-4" />} Save matrix
          </Button>
        }
      >
        {locked && (
          <p className="mb-3 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-[11px] font-semibold leading-relaxed text-warn">
            The General Manager must keep user and settings administration. Removing either is blocked by the server to
            prevent locking the restaurant administrator out.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {catalogue.map((group) => (
            <div key={group.label}>
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">{group.label}</p>
              <ul className="grid gap-1">
                {group.permissions.map((permission) => (
                  <li key={permission.key}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 hover:bg-paper-sunken">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={draft.has(permission.key)}
                        onChange={() => toggle(permission.key)}
                      />
                      <span className="min-w-0">
                        <span className="block text-[12px] font-semibold text-ink">{permission.label}</span>
                        <span className="block font-mono text-[10px] text-ink-faint">{permission.key}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function CreateRole({
  catalogue,
  onCancel,
  onCreated,
}: {
  catalogue: CatalogueGroup[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [permissions, setPermissions] = useState<Set<string>>(new Set(["pos.open", "kds.view"]));
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post("roles", {
        title,
        hourlyRate: Number(hourlyRate || 0),
        permissions: [...permissions],
      });
      toast(`Role ${title} created`, "ok");
      onCreated();
    } catch (caught) {
      toast(errorMessage(caught), "late");
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-rule bg-paper-sunken p-2.5">
      <Field label="Role title">
        <TextInput value={title} onChange={setTitle} placeholder="e.g. Barista" />
      </Field>
      <Field label="Hourly rate (Rs)" className="mt-2">
        <TextInput value={hourlyRate} onChange={setHourlyRate} placeholder="0" inputMode="decimal" />
      </Field>
      <div className="mt-2 max-h-40 overflow-y-auto">
        {catalogue.map((group) => (
          <div key={group.label} className="mb-1.5">
            <p className="text-[9px] font-bold uppercase tracking-wide text-ink-faint">{group.label}</p>
            {group.permissions.map((permission) => (
              <label key={permission.key} className="flex items-center gap-1.5 text-[11px] text-ink-soft">
                <input
                  type="checkbox"
                  checked={permissions.has(permission.key)}
                  onChange={() =>
                    setPermissions((current) => {
                      const next = new Set(current);
                      if (next.has(permission.key)) next.delete(permission.key);
                      else next.add(permission.key);
                      return next;
                    })
                  }
                />
                <span className="truncate">{permission.key}</span>
              </label>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
          {busy ? <Spinner className="size-3.5" /> : null} Create
        </Button>
      </div>
    </div>
  );
}

function ActivityPanel({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) {
    return <Card><Empty icon="report" title="No activity yet" /></Card>;
  }
  return (
    <Card title="Recent administrative activity" icon="report" className="overflow-hidden">
      <table className="w-full text-left text-[12px]">
        <thead className="border-b border-rule text-[10px] uppercase tracking-[0.07em] text-ink-faint">
          <tr>
            <th className="px-2 py-2 font-bold">When</th>
            <th className="px-2 py-2 font-bold">Actor</th>
            <th className="px-2 py-2 font-bold">Action</th>
            <th className="px-2 py-2 font-bold">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="whitespace-nowrap px-2 py-2 tnum text-ink-faint">{entry.createdAt.slice(0, 16)}</td>
              <td className="px-2 py-2 text-ink-soft">{entry.actorName}</td>
              <td className="px-2 py-2 font-mono text-[11px] font-bold text-ink">{entry.action}</td>
              <td className="px-2 py-2 text-ink-faint">{entry.detail || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
