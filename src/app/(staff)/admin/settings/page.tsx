"use client";

/**
 * Settings & Configuration Portal.
 *
 * One draft spans every section so a manager can move between business profile,
 * taxes, workflow and hardware without losing work. Settings and role changes
 * are saved together; integration masks are preserved by the server. Hardware
 * checks and custom-role creation are explicit actions of their own.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { usePoll, useStore } from "@/lib/store";
import { Button, Chip, Empty, Icon, Spinner, toast, type IconName } from "@/components/ui";
import type { RoleInfo, Settings, StationInfo } from "@/types";
import type { Permission } from "@/domain/permissions";
import { StoreSection } from "@/components/settings/StoreSection";
import { TaxSection } from "@/components/settings/TaxSection";
import { WorkflowSection } from "@/components/settings/WorkflowSection";
import { HardwareSection } from "@/components/settings/HardwareSection";
import { SecuritySection, type PermissionCatalogueGroup } from "@/components/settings/SecuritySection";
import { IntegrationsSection } from "@/components/settings/IntegrationsSection";
import type { SettingsDraft, SettingsSectionProps } from "@/components/settings/controls";

type SectionId = "store" | "tax" | "workflow" | "hardware" | "security" | "integrations";

const SECTIONS: { id: SectionId; label: string; short: string; description: string; icon: IconName; step: string }[] = [
  { id: "store", label: "Store & system profile", short: "Store profile", description: "Identity, hours & localization", icon: "vendor", step: "01" },
  { id: "tax", label: "Taxes, charges & gratuity", short: "Taxes & gratuity", description: "VAT, tips, fees & surcharges", icon: "report", step: "02" },
  { id: "workflow", label: "Order workflow & POS", short: "Order workflow", description: "Service style & terminal rules", icon: "pos", step: "03" },
  { id: "hardware", label: "Hardware & routing", short: "Hardware & routing", description: "Printers, KDS, EMV & drawer", icon: "print", step: "04" },
  { id: "security", label: "Security, roles & access", short: "Security & roles", description: "RBAC, sessions & PIN policy", icon: "users", step: "05" },
  { id: "integrations", label: "Integrations & notifications", short: "Integrations", description: "EDI, messaging & delivery", icon: "qr", step: "06" },
];

interface SettingsResponse {
  settings: Settings;
  raw: SettingsDraft;
  stations: StationInfo[];
}

interface RolesResponse {
  roles: RoleInfo[];
  catalogue: PermissionCatalogueGroup[];
}

export default function SettingsPage() {
  const { state, allowed, refresh } = useStore();
  const canEdit = allowed("admin.settings");
  const canManageRoles = allowed("admin.users");
  const [section, setSection] = useState<SectionId>("store");
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [saved, setSaved] = useState<SettingsDraft>({});
  const [initialized, setInitialized] = useState(false);
  const [roleDraft, setRoleDraft] = useState<RoleInfo[]>([]);
  const [saving, setSaving] = useState(false);

  const { data, error, reload } = usePoll<SettingsResponse>(canEdit ? "settings" : null);
  const { data: roleData, reload: reloadRoles } = usePoll<RolesResponse>(canManageRoles ? "roles" : null);

  useEffect(() => {
    if (!data?.raw || initialized) return;
    setDraft(data.raw);
    setSaved(data.raw);
    setInitialized(true);
  }, [data, initialized]);

  // Merge newly loaded/custom roles without discarding checkbox edits already
  // made to other roles in this portal session.
  useEffect(() => {
    if (!roleData?.roles) return;
    setRoleDraft((current) => {
      if (!current.length) return roleData.roles;
      return roleData.roles.map((role) => {
        const edited = current.find((entry) => entry.id === role.id);
        return edited ? { ...role, permissions: edited.permissions } : role;
      });
    });
  }, [roleData]);

  const settingsDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const changedRoles = useMemo(() => {
    const original = roleData?.roles ?? [];
    return roleDraft.filter((role) => {
      const before = original.find((entry) => entry.id === role.id);
      if (!before) return false;
      return JSON.stringify([...before.permissions].sort()) !== JSON.stringify([...role.permissions].sort());
    });
  }, [roleDraft, roleData]);
  const dirty = settingsDirty || changedRoles.length > 0;

  const onChange = useCallback((key: string, value: string | number | boolean) => {
    setDraft((current) => ({ ...current, [key]: typeof value === "boolean" ? (value ? "1" : "0") : String(value) }));
  }, []);

  const onChangeMany = useCallback((patch: Record<string, string | number | boolean>) => {
    setDraft((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(patch)) next[key] = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
      return next;
    });
  }, []);

  const togglePermission = useCallback((roleId: string, permission: Permission) => {
    setRoleDraft((current) =>
      current.map((role) => {
        if (role.id !== roleId) return role;
        const has = role.permissions.includes(permission);
        return { ...role, permissions: has ? role.permissions.filter((entry) => entry !== permission) : [...role.permissions, permission] };
      }),
    );
  }, []);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    let nextRaw = draft;
    try {
      if (settingsDirty) {
        const patch = Object.fromEntries(Object.keys(draft).filter((key) => draft[key] !== saved[key]).map((key) => [key, draft[key]]));
        const response = await api.patch<SettingsResponse>("settings", patch);
        nextRaw = response.raw;
        setDraft(nextRaw);
        setSaved(nextRaw);
      }
      for (const role of changedRoles) {
        await api.put(`roles/${role.id}/permissions`, { permissions: role.permissions });
      }
      await Promise.all([refresh(), reload(), reloadRoles()]);
      toast(changedRoles.length ? `Settings and ${changedRoles.length} role${changedRoles.length === 1 ? "" : "s"} saved` : "Configuration saved", "ok");
    } catch (caught) {
      // Settings may have committed before a role update failed. Keep the raw
      // response as the new baseline rather than offering a misleading retry.
      if (nextRaw !== draft) {
        setDraft(nextRaw);
        setSaved(nextRaw);
      }
      toast(errorMessage(caught), "late");
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, settingsDirty, draft, saved, changedRoles, refresh, reload, reloadRoles]);

  const discard = useCallback(() => {
    setDraft(saved);
    setRoleDraft(roleData?.roles ?? []);
    toast("Unsaved changes discarded", "neutral");
  }, [saved, roleData]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("keydown", keyboard);
    };
  }, [dirty, save]);

  if (!canEdit) {
    return (
      <div className="p-6">
        <Empty title="Settings are manager-only" hint="Ask a user with admin.settings permission to configure this restaurant." icon="lock" />
      </div>
    );
  }

  if (!initialized || !data) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-ink-faint">
        <Spinner />
        <p className="text-sm font-semibold">Loading restaurant configuration…</p>
        {error && <p className="text-xs text-late">{error}</p>}
      </div>
    );
  }

  const current = SECTIONS.find((entry) => entry.id === section)!;
  const common: SettingsSectionProps = {
    draft,
    onChange,
    onChangeMany,
    categories: state?.categories ?? [],
    stations: data.stations,
    canEdit,
  };
  const modeLabel = draft.operating_mode === "quick_service" ? "Quick service" : draft.operating_mode === "bar_nightclub" ? "Bar & nightclub" : "Full service";

  return (
    <div className="flex flex-col gap-4 p-4 pb-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-2xl bg-brand-500 text-white shadow-sm">
          <Icon name="settings" className="size-[22px]" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[21px] font-black tracking-tight text-ink">Settings & configuration</h1>
            <Chip tone="brand">{modeLabel}</Chip>
          </div>
          <p className="mt-0.5 text-[12px] text-ink-faint">Shape RMS around your restaurant — no code deploy required.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={`mr-1 hidden items-center gap-1.5 text-[11px] font-semibold sm:flex ${dirty ? "text-warn" : "text-ok"}`}>
            <span className={`size-1.5 rounded-full ${dirty ? "bg-warn" : "bg-ok"}`} />
            {dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          {dirty && <Button variant="ghost" disabled={saving} onClick={discard}>Discard</Button>}
          <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Spinner className="size-3.5" /> : <Icon name="check" className="size-4" />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </header>

      <div className="grid items-start gap-4 xl:grid-cols-[242px_minmax(0,1fr)]">
        <aside className="card overflow-hidden xl:sticky xl:top-[66px]">
          <div className="border-b border-rule bg-paper-sunken/60 px-3 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.1em] text-ink-faint">Configuration workspace</p>
            <p className="mt-1 text-[11px] text-ink-soft">Six connected areas, one restaurant profile.</p>
          </div>
          <nav className="no-scrollbar flex overflow-x-auto p-2 xl:flex-col xl:overflow-visible" aria-label="Settings sections">
            {SECTIONS.map((entry) => {
              const active = entry.id === section;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSection(entry.id)}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex min-w-[210px] items-center gap-2.5 rounded-xl px-3 py-3 text-left transition-colors xl:min-w-0 ${
                    active ? "bg-brand-50 text-brand-800" : "text-ink-soft hover:bg-paper-sunken hover:text-ink"
                  }`}
                >
                  {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand-500" />}
                  <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${active ? "bg-brand-500 text-white" : "bg-paper-sunken text-ink-faint"}`}>
                    <Icon name={entry.icon} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-extrabold leading-tight">{entry.label}</span>
                    <span className={`mt-0.5 block text-[10px] ${active ? "text-brand-700/70" : "text-ink-faint"}`}>{entry.description}</span>
                  </span>
                  <span className={`tnum hidden text-[9px] font-bold xl:block ${active ? "text-brand-500" : "text-ink-faint/60"}`}>{entry.step}</span>
                </button>
              );
            })}
          </nav>
          <div className="hidden border-t border-rule bg-paper-sunken/40 px-4 py-3 xl:block">
            <div className="flex items-center gap-2 text-[11px] font-bold text-ink-soft"><Icon name="lock" className="size-3.5 text-ok" />Manager-only workspace</div>
            <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">Every saved change is written to the audit trail with your staff identity.</p>
          </div>
        </aside>

        <main className="min-w-0">
          <div className="mb-3 flex items-end justify-between gap-3 px-1">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.1em] text-brand-600">{current.step} · Configuration</p>
              <h2 className="mt-0.5 text-[17px] font-extrabold text-ink">{current.label}</h2>
            </div>
            <span className="hidden text-[11px] text-ink-faint md:block">Ctrl / ⌘ + S to save</span>
          </div>

          {section === "store" && <StoreSection {...common} />}
          {section === "tax" && <TaxSection {...common} />}
          {section === "workflow" && <WorkflowSection {...common} />}
          {section === "hardware" && <HardwareSection {...common} />}
          {section === "security" && (
            <SecuritySection
              {...common}
              roles={roleDraft}
              catalogue={roleData?.catalogue ?? []}
              canManageRoles={canManageRoles}
              onTogglePermission={togglePermission}
              onCreateRole={async (input) => {
                await api.post("roles", input);
                await reloadRoles();
              }}
            />
          )}
          {section === "integrations" && <IntegrationsSection {...common} />}

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const index = SECTIONS.findIndex((entry) => entry.id === section);
                setSection(SECTIONS[(index + SECTIONS.length - 1) % SECTIONS.length].id);
              }}
            >
              <Icon name="arrow-left" className="size-3.5" />Previous
            </Button>
            <span className="text-[11px] font-semibold text-ink-faint">{current.short}</span>
            <Button
              variant="soft"
              size="sm"
              onClick={() => {
                const index = SECTIONS.findIndex((entry) => entry.id === section);
                setSection(SECTIONS[(index + 1) % SECTIONS.length].id);
              }}
            >
              Next section<Icon name="arrow-right" className="size-3.5" />
            </Button>
          </div>
        </main>
      </div>

      {dirty && (
        <div className="sticky bottom-3 z-30 mx-auto flex w-full max-w-2xl items-center gap-3 rounded-2xl border border-brand-200 bg-white/95 px-4 py-3 shadow-xl backdrop-blur">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-warn-soft text-warn"><Icon name="edit" className="size-4" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-extrabold text-ink">You have unsaved configuration</p>
            <p className="truncate text-[10px] text-ink-faint">{settingsDirty ? "Restaurant settings" : ""}{settingsDirty && changedRoles.length ? " + " : ""}{changedRoles.length ? `${changedRoles.length} role${changedRoles.length === 1 ? "" : "s"}` : ""}</p>
          </div>
          <Button variant="ghost" size="sm" disabled={saving} onClick={discard}>Discard</Button>
          <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save all"}</Button>
        </div>
      )}
    </div>
  );
}
