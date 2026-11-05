"use client";

import { useState } from "react";
import { Button, Icon, Modal, toast } from "@/components/ui";
import type { Permission } from "@/domain/permissions";
import type { RoleInfo } from "@/types";
import { Notice, Panel, Segmented, SelectField, TextField, type SettingsSectionProps } from "./controls";

export interface PermissionCatalogueGroup {
  label: string;
  permissions: { key: Permission; label: string }[];
}

interface SecuritySectionProps extends SettingsSectionProps {
  roles: RoleInfo[];
  catalogue: PermissionCatalogueGroup[];
  canManageRoles: boolean;
  onTogglePermission: (roleId: string, permission: Permission) => void;
  onCreateRole: (input: { title: string; hourlyRate: number; permissions: string[] }) => Promise<void>;
}

export function SecuritySection({
  draft,
  onChange,
  canEdit,
  roles,
  catalogue,
  canManageRoles,
  onTogglePermission,
  onCreateRole,
}: SecuritySectionProps) {
  const [creating, setCreating] = useState(false);
  const activeStaff = roles.reduce((sum, role) => sum + role.headcount, 0);
  const permissionCount = catalogue.reduce((sum, group) => sum + group.permissions.length, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Access roles", value: roles.length, detail: `${roles.filter((role) => !role.isSystem).length} custom`, icon: "users" as const },
          { label: "Active employees", value: activeStaff, detail: "Across all roles", icon: "host" as const },
          { label: "Capabilities", value: permissionCount, detail: "Individually assignable", icon: "lock" as const },
          { label: "PIN policy", value: `${draft.pin_length} digits`, detail: draft.auto_lock_seconds === "0" ? "Auto-lock disabled" : `${draft.auto_lock_seconds}s auto-lock`, icon: "settings" as const },
        ].map((stat) => (
          <div key={stat.label} className="card p-3.5">
            <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-ink-faint"><Icon name={stat.icon} className="size-3.5" />{stat.label}</span>
            <p className="tnum mt-2 text-xl font-black leading-none text-ink">{stat.value}</p>
            <p className="mt-1.5 text-[10px] text-ink-faint">{stat.detail}</p>
          </div>
        ))}
      </div>

      <Panel
        title="Role permission matrix"
        description="Grant or revoke each capability by role. Changes apply to active sessions on their next API request."
        icon="users"
        action={<Button variant="soft" size="sm" disabled={!canManageRoles} onClick={() => setCreating(true)}><Icon name="plus" className="size-3.5" />New role</Button>}
      >
        {!canManageRoles ? (
          <Notice tone="warn">You can change session security, but the role matrix requires the <strong>admin.users</strong> permission.</Notice>
        ) : roles.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-ink-faint">Loading roles and permissions…</p>
        ) : (
          <>
            <div className="scroll-y max-h-[620px] overflow-x-auto rounded-xl border border-rule">
              <table className="w-full border-collapse text-left">
                <thead className="sticky top-0 z-20 bg-paper-sunken shadow-[0_1px_0_var(--color-rule)]">
                  <tr>
                    <th className="sticky left-0 z-30 min-w-[270px] bg-paper-sunken px-3 py-3 text-[10px] font-bold uppercase tracking-wider text-ink-faint">Capability</th>
                    {roles.map((role) => (
                      <th key={role.id} className="min-w-[128px] border-l border-rule px-3 py-2.5 align-top">
                        <p className="truncate text-[11px] font-extrabold text-ink">{role.title}</p>
                        <p className="mt-0.5 text-[9px] font-semibold text-ink-faint">{role.headcount} active · {role.permissions.length} granted</p>
                        {!role.isSystem && <span className="mt-1 inline-block rounded-full bg-brand-50 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-brand-700">Custom</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {catalogue.map((group) => (
                    <PermissionGroupRows key={group.label} group={group} roles={roles} onToggle={onTogglePermission} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-ink-faint">Scroll horizontally to compare roles. General Manager's two administration permissions are locked to prevent lockout.</p>
              <span className="text-[11px] font-bold text-brand-700">Save changes above to apply the matrix</span>
            </div>
          </>
        )}
      </Panel>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,.8fr)]">
        <Panel title="Session & terminal security" description="Set the inactivity lock and the PIN standard used when staff credentials are created or reset." icon="lock">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Auto-lock after inactivity"
              value={draft.auto_lock_seconds}
              onChange={(value) => onChange("auto_lock_seconds", value)}
              options={[
                { value: "0", label: "Never auto-lock" },
                { value: "30", label: "30 seconds" },
                { value: "60", label: "1 minute" },
                { value: "300", label: "5 minutes" },
                { value: "600", label: "10 minutes" },
                { value: "900", label: "15 minutes" },
                { value: "1800", label: "30 minutes" },
              ]}
              hint="Any pointer or keyboard activity resets the terminal timer."
              disabled={!canEdit}
            />
            <div>
              <span className="label">Staff PIN length</span>
              <Segmented
                label="Staff PIN length"
                value={draft.pin_length}
                onChange={(value) => onChange("pin_length", value)}
                options={[{ value: "4", label: "4 digits" }, { value: "6", label: "6 digits" }]}
                disabled={!canEdit}
              />
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">New and reset PINs must use this length. Existing staff can still sign in until their PIN is reset.</p>
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {[
              ["Signed sessions", "HTTP-only, SameSite cookies"],
              ["Mutation protection", "CSRF header required"],
              ["Live authorization", "Permissions read per request"],
            ].map(([title, detail]) => (
              <div key={title} className="rounded-xl bg-paper-sunken p-3">
                <p className="flex items-center gap-1.5 text-[11px] font-extrabold text-ink"><Icon name="check" className="size-3.5 text-ok" />{title}</p>
                <p className="mt-1 text-[10px] text-ink-faint">{detail}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Security guardrails" description="Recommended controls for a shared restaurant terminal." icon="settings">
          <ul className="flex flex-col gap-3">
            {[
              ["Use a unique PIN per employee", "Never share a manager PIN across the shift."],
              ["Keep manager-only approvals on", "Voids, comps and discounts stay attributable in the audit trail."],
              ["Review custom roles regularly", "Grant only the capabilities needed for that job."],
              ["Lock the screen when unattended", "A 30–60 second timeout works well on the floor."],
            ].map(([title, detail], index) => (
              <li key={title} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[10px] font-black text-brand-700">{index + 1}</span>
                <div><p className="text-[12px] font-bold text-ink">{title}</p><p className="mt-0.5 text-[10px] leading-relaxed text-ink-faint">{detail}</p></div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {creating && (
        <RoleEditor
          roles={roles}
          onClose={() => setCreating(false)}
          onSave={async (input) => {
            await onCreateRole(input);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function PermissionGroupRows({ group, roles, onToggle }: { group: PermissionCatalogueGroup; roles: RoleInfo[]; onToggle: (roleId: string, permission: Permission) => void }) {
  return (
    <>
      <tr>
        <td colSpan={roles.length + 1} className="sticky left-0 border-y border-rule bg-paper px-3 py-2 text-[9px] font-black uppercase tracking-[0.1em] text-brand-700">{group.label}</td>
      </tr>
      {group.permissions.map((permission) => (
        <tr key={permission.key} className="group hover:bg-paper">
          <td className="sticky left-0 z-10 border-b border-rule bg-white px-3 py-2.5 group-hover:bg-paper">
            <p className="text-[11px] font-bold text-ink">{permission.label}</p>
            <code className="mt-0.5 block text-[9px] text-ink-faint">{permission.key}</code>
          </td>
          {roles.map((role) => {
            const checked = role.permissions.includes(permission.key) || role.permissions.includes("*");
            const managerLock = role.name === "manager" && (permission.key === "admin.users" || permission.key === "admin.settings");
            return (
              <td key={role.id} className="border-b border-l border-rule px-3 py-2.5 text-center">
                <label className={`inline-flex size-7 items-center justify-center rounded-lg ${managerLock ? "cursor-not-allowed" : "cursor-pointer hover:bg-brand-50"}`} title={managerLock ? "Required to prevent manager lockout" : `${checked ? "Revoke" : "Grant"} ${permission.label} for ${role.title}`}>
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer accent-[var(--color-brand-500)] disabled:cursor-not-allowed disabled:opacity-50"
                    checked={checked}
                    disabled={managerLock}
                    onChange={() => onToggle(role.id, permission.key)}
                    aria-label={`${role.title}: ${permission.label}`}
                  />
                </label>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function RoleEditor({
  roles,
  onClose,
  onSave,
}: {
  roles: RoleInfo[];
  onClose: () => void;
  onSave: (input: { title: string; hourlyRate: number; permissions: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [hourlyRate, setHourlyRate] = useState("0");
  const [copyFrom, setCopyFrom] = useState(roles.find((role) => role.name === "server")?.id ?? roles[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const source = roles.find((role) => role.id === copyFrom);

  return (
    <Modal
      open
      onClose={onClose}
      title="Create a custom role"
      subtitle="Start from an existing permission set, then adjust it in the matrix before saving."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !title.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave({ title: title.trim(), hourlyRate: Number(hourlyRate) || 0, permissions: source?.permissions ?? [] });
                toast(`${title.trim()} role created`, "ok");
              } catch (error) {
                toast(error instanceof Error ? error.message : "Could not create role", "late");
                setBusy(false);
              }
            }}
          >
            {busy ? "Creating…" : "Create role"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Role title" value={title} onChange={setTitle} placeholder="e.g. Shift Supervisor" className="sm:col-span-2" />
        <TextField label="Default hourly rate" type="number" value={hourlyRate} onChange={setHourlyRate} hint="Major currency units per hour" />
        <SelectField
          label="Copy permissions from"
          value={copyFrom}
          onChange={setCopyFrom}
          options={[{ value: "", label: "Start with no permissions" }, ...roles.map((role) => ({ value: role.id, label: role.title }))]}
        />
      </div>
      <div className="mt-3 rounded-xl bg-paper-sunken p-3 text-[11px] text-ink-soft">
        This role will start with <strong>{source?.permissions.length ?? 0} capabilities</strong>{source ? ` copied from ${source.title}` : ""}. You can refine every checkbox after it is created.
      </div>
    </Modal>
  );
}
