"use client";

import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Button, Chip, Empty, Icon, Modal, TextInput, Toggle, toast } from "@/components/ui";
import {
  DEFAULT_KDS_ROUTING,
  DEFAULT_PAYMENT_TERMINALS,
  DEFAULT_PRINTERS,
  boolValue,
  localId,
  parseJsonSetting,
  type PaymentTerminalConfig,
  type PrinterConfig,
} from "@/domain/settings";
import {
  AddRowButton,
  Notice,
  Panel,
  SelectField,
  Status,
  TextField,
  ToggleRow,
  type SettingsSectionProps,
} from "./controls";

interface ConnectionResult {
  host: string;
  port: number;
  reachable: boolean;
  latencyMs: number;
  message: string;
}

export function HardwareSection({ draft, onChange, categories, stations, canEdit }: SettingsSectionProps) {
  const printers = parseJsonSetting<PrinterConfig[]>(draft.printers, DEFAULT_PRINTERS);
  const terminals = parseJsonSetting<PaymentTerminalConfig[]>(draft.payment_terminals, DEFAULT_PAYMENT_TERMINALS);
  const routing = parseJsonSetting<Record<string, string>>(draft.kds_routing, DEFAULT_KDS_ROUTING);
  const [editingPrinter, setEditingPrinter] = useState<PrinterConfig | null>(null);
  const [editingTerminal, setEditingTerminal] = useState<PaymentTerminalConfig | null>(null);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ConnectionResult>>({});

  const savePrinters = (next: PrinterConfig[]) => onChange("printers", JSON.stringify(next));
  const saveTerminals = (next: PaymentTerminalConfig[]) => onChange("payment_terminals", JSON.stringify(next));

  async function checkConnection(device: { id: string; host?: string; address?: string; port: number }) {
    const host = device.host ?? device.address ?? "";
    setChecking(device.id);
    try {
      const response = await api.post<{ result: ConnectionResult }>("settings/hardware/check", { host, port: device.port });
      setResults((current) => ({ ...current, [device.id]: response.result }));
      toast(response.result.reachable ? `${host} is reachable on port ${device.port}` : response.result.message, response.result.reachable ? "ok" : "warn");
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setChecking(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Network printers", value: printers.length, detail: `${printers.filter((printer) => printer.enabled).length} enabled`, icon: "print" as const },
          { label: "KDS category routes", value: Object.values(routing).filter(Boolean).length, detail: `${stations.length} station screens`, icon: "kitchen" as const },
          { label: "Payment readers", value: terminals.length, detail: `${terminals.filter((terminal) => terminal.enabled).length} enabled`, icon: "card" as const },
          { label: "ESC/POS port", value: "9100", detail: "Raw TCP · no cloud relay", icon: "settings" as const },
        ].map((stat) => (
          <div key={stat.label} className="card flex items-center gap-3 p-3.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-paper-sunken text-ink-soft"><Icon name={stat.icon} className="size-[18px]" /></span>
            <div className="min-w-0">
              <p className="truncate text-[10px] font-bold uppercase tracking-wider text-ink-faint">{stat.label}</p>
              <p className="tnum mt-0.5 text-xl font-black leading-none text-ink">{stat.value}</p>
              <p className="mt-1 truncate text-[10px] text-ink-faint">{stat.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <Panel
        title="Printer management"
        description="Bind ESC/POS thermal printers by local IP. Connection checks open a TCP socket only; no test print is sent."
        icon="print"
        action={
          <div className="flex gap-2">
            <Button variant="soft" size="sm" onClick={() => setDiscoveryOpen(true)} disabled={!canEdit}><Icon name="search" className="size-3.5" />Discover</Button>
            <AddRowButton
              disabled={!canEdit}
              onClick={() =>
                setEditingPrinter({ id: localId("printer"), name: "", kind: "receipt", host: "", port: 9100, paperWidth: "80", codePage: "CP437", enabled: true })
              }
            >
              Add printer
            </AddRowButton>
          </div>
        }
      >
        {printers.length === 0 ? (
          <Empty title="No printers configured" hint="Add a printer by IP or discover listeners on port 9100." icon="print" />
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[850px]">
              <div className="grid grid-cols-[minmax(170px,1.1fr)_minmax(160px,1fr)_100px_110px_90px_130px_36px] items-center gap-3 border-b border-rule px-2 pb-2 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
                <span>Printer</span><span>Network address</span><span>Paper</span><span>Code page</span><span>Status</span><span>Connection</span><span />
              </div>
              {printers.map((printer) => {
                const result = results[printer.id];
                return (
                  <div key={printer.id} className="grid grid-cols-[minmax(170px,1.1fr)_minmax(160px,1fr)_100px_110px_90px_130px_36px] items-center gap-3 border-b border-rule px-2 py-3 last:border-0">
                    <button type="button" disabled={!canEdit} onClick={() => setEditingPrinter(printer)} className="flex min-w-0 items-center gap-2.5 text-left">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-paper-sunken text-ink-soft"><Icon name="print" className="size-4" /></span>
                      <span className="min-w-0"><span className="block truncate text-[12px] font-extrabold text-ink hover:text-brand-700">{printer.name || "Unnamed printer"}</span><span className="block text-[10px] capitalize text-ink-faint">{printer.kind} station</span></span>
                    </button>
                    <code className="truncate rounded-md bg-paper-sunken px-2 py-1 text-[11px] text-ink-soft">{printer.host || "Not set"}:{printer.port}</code>
                    <span className="text-[12px] font-semibold text-ink-soft">{printer.paperWidth} mm</span>
                    <span className="font-mono text-[11px] text-ink-soft">{printer.codePage}</span>
                    <Status tone={printer.enabled ? "ok" : "neutral"}>{printer.enabled ? "Enabled" : "Disabled"}</Status>
                    <div className="flex items-center gap-1.5">
                      <Button variant="ghost" size="sm" disabled={checking !== null || !printer.host} onClick={() => void checkConnection(printer)}>
                        <Icon name="refresh" className={`size-3.5 ${checking === printer.id ? "animate-spin" : ""}`} />{checking === printer.id ? "Checking" : "Check"}
                      </Button>
                      {result && <span title={result.message} className={`size-2 rounded-full ${result.reachable ? "bg-ok" : "bg-late"}`} />}
                    </div>
                    <button type="button" disabled={!canEdit} onClick={() => savePrinters(printers.filter((entry) => entry.id !== printer.id))} className="rounded-lg p-1.5 text-ink-faint hover:bg-late-soft hover:text-late" aria-label={`Delete ${printer.name}`}><Icon name="trash" className="size-4" /></button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="mt-3">
          <Notice tone="neutral" icon="print">A green check confirms a TCP listener, not ESC/POS compatibility. Use your printer vendor's utility for a physical test page.</Notice>
        </div>
      </Panel>

      <Panel title="KDS routing rules" description="Map menu categories to a station screen. New order lines snapshot this route; existing tickets stay where they were sent." icon="kitchen">
        <div className="grid gap-2 md:grid-cols-2">
          {categories.map((category) => {
            const station = stations.find((entry) => entry.id === routing[category.id]);
            return (
              <div key={category.id} className="flex items-center gap-3 rounded-xl border border-rule p-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-sunken text-lg">{category.icon || "🍽"}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-[12px] font-extrabold text-ink">{category.name}</p><p className="text-[10px] text-ink-faint">{routing[category.id] ? `Routes to ${station?.name ?? routing[category.id]}` : "Uses each dish's station"}</p></div>
                <Icon name="arrow-right" className="size-4 shrink-0 text-ink-faint" />
                <div className="flex min-w-0 items-center gap-2">
                  {station && <span className="size-2 shrink-0 rounded-full" style={{ background: station.color }} />}
                  <select
                    aria-label={`KDS station for ${category.name}`}
                    className="field !w-[145px] !py-1.5 !text-[11px]"
                    value={routing[category.id] ?? ""}
                    disabled={!canEdit}
                    onChange={(event) => {
                      const next = { ...routing };
                      if (event.target.value) next[category.id] = event.target.value;
                      else delete next[category.id];
                      onChange("kds_routing", JSON.stringify(next));
                    }}
                  >
                    <option value="">Dish station</option>
                    {stations.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} KDS</option>)}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,.75fr)]">
        <Panel
          title="Payment terminals (EMV)"
          description="Pair semi-integrated readers by local IP or save their Bluetooth SDK identifier."
          icon="card"
          action={
            <AddRowButton
              disabled={!canEdit}
              onClick={() => setEditingTerminal({ id: localId("emv"), name: "", model: "Semi-integrated EMV", connection: "ip", address: "", port: 8080, enabled: true })}
            >
              Add reader
            </AddRowButton>
          }
        >
          <div className="flex flex-col gap-2">
            {terminals.map((terminal) => {
              const result = results[terminal.id];
              return (
                <div key={terminal.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-rule p-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-sunken text-ink-soft"><Icon name="card" className="size-[18px]" /></span>
                  <button type="button" disabled={!canEdit} onClick={() => setEditingTerminal(terminal)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-[12px] font-extrabold text-ink">{terminal.name || "Unnamed reader"}</p>
                    <p className="truncate font-mono text-[10px] text-ink-faint">{terminal.connection === "ip" ? `${terminal.address || "No IP"}:${terminal.port}` : `Bluetooth · ${terminal.address || "No SDK identifier"}`}</p>
                  </button>
                  <Status tone={terminal.enabled ? "info" : "neutral"}>{terminal.enabled ? terminal.connection === "ip" ? "IP reader" : "Bluetooth" : "Disabled"}</Status>
                  {terminal.connection === "ip" && (
                    <Button variant="ghost" size="sm" disabled={checking !== null || !terminal.address} onClick={() => void checkConnection(terminal)}>
                      <Icon name="refresh" className={`size-3.5 ${checking === terminal.id ? "animate-spin" : ""}`} />Check
                    </Button>
                  )}
                  {result && <span title={result.message} className={`size-2 rounded-full ${result.reachable ? "bg-ok" : "bg-late"}`} />}
                  <button type="button" disabled={!canEdit} onClick={() => saveTerminals(terminals.filter((entry) => entry.id !== terminal.id))} className="rounded-lg p-1.5 text-ink-faint hover:bg-late-soft hover:text-late" aria-label={`Delete ${terminal.name}`}><Icon name="trash" className="size-4" /></button>
                </div>
              );
            })}
          </div>
          <div className="mt-3"><Notice>Saving a reader configures the connection only. Live EMV settlement still requires your payment provider's certified semi-integrated SDK.</Notice></div>
        </Panel>

        <Panel title="Cash drawer controls" description="Set when the receipt printer may kick the drawer open." icon="cash">
          <div className="divide-y divide-rule">
            <ToggleRow title="Open on cash sale" description="Kick the drawer after a cash tender is captured." checked={boolValue(draft.cash_drawer_cash_sale, true)} onChange={(value) => onChange("cash_drawer_cash_sale", value)} disabled={!canEdit} />
            <ToggleRow title="Open on shift close" description="Kick the drawer when the shift cash count begins." checked={boolValue(draft.cash_drawer_shift_close)} onChange={(value) => onChange("cash_drawer_shift_close", value)} disabled={!canEdit} />
            <ToggleRow title="Manager PIN for manual open" description="Require approval for a no-sale drawer opening." checked={boolValue(draft.cash_drawer_manual_pin, true)} onChange={(value) => onChange("cash_drawer_manual_pin", value)} disabled={!canEdit} />
          </div>
          <div className="mt-3 rounded-xl bg-paper-sunken p-3 text-[11px] leading-relaxed text-ink-soft">
            <strong className="text-ink">Drawer connection:</strong> RJ11/RJ12 through the enabled receipt printer using its ESC/POS kick command.
          </div>
        </Panel>
      </div>

      {editingPrinter && (
        <PrinterEditor
          printer={editingPrinter}
          onClose={() => setEditingPrinter(null)}
          onSave={(printer) => {
            const exists = printers.some((entry) => entry.id === printer.id);
            savePrinters(exists ? printers.map((entry) => (entry.id === printer.id ? printer : entry)) : [...printers, printer]);
            setEditingPrinter(null);
          }}
        />
      )}
      {editingTerminal && (
        <TerminalEditor
          terminal={editingTerminal}
          onClose={() => setEditingTerminal(null)}
          onSave={(terminal) => {
            const exists = terminals.some((entry) => entry.id === terminal.id);
            saveTerminals(exists ? terminals.map((entry) => (entry.id === terminal.id ? terminal : entry)) : [...terminals, terminal]);
            setEditingTerminal(null);
          }}
        />
      )}
      <DiscoveryModal
        open={discoveryOpen}
        onClose={() => setDiscoveryOpen(false)}
        onAdd={(host, port) => {
          savePrinters([
            ...printers,
            { id: localId("printer"), name: `ESC/POS · ${host}`, kind: "other", host, port, paperWidth: "80", codePage: "CP437", enabled: true },
          ]);
          toast(`${host} added — choose its station and save changes`, "ok");
        }}
      />
    </div>
  );
}

function PrinterEditor({ printer, onClose, onSave }: { printer: PrinterConfig; onClose: () => void; onSave: (printer: PrinterConfig) => void }) {
  const [form, setForm] = useState(printer);
  const patch = (value: Partial<PrinterConfig>) => setForm((current) => ({ ...current, ...value }));
  return (
    <Modal
      open
      onClose={onClose}
      title={printer.name ? `Edit ${printer.name}` : "Add network printer"}
      subtitle="ESC/POS thermal printer connection and character rendering."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!form.name.trim() || !form.host.trim()} onClick={() => onSave(form)}>Save printer</Button></>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Printer name" value={form.name} onChange={(name) => patch({ name })} placeholder="e.g. Kitchen Grill" />
        <SelectField label="Printer / station" value={form.kind} onChange={(kind) => patch({ kind: kind as PrinterConfig["kind"] })} options={[
          { value: "receipt", label: "Receipt printer" }, { value: "grill", label: "Kitchen Grill" }, { value: "fry", label: "Fry Station" }, { value: "bar", label: "Bar Printer" }, { value: "other", label: "Other station" },
        ]} />
        <TextField label="IP address or hostname" value={form.host} onChange={(host) => patch({ host })} placeholder="192.168.1.201" className="sm:col-span-2" />
        <TextField label="TCP port" type="number" value={form.port} onChange={(value) => patch({ port: Number(value) })} />
        <SelectField label="Paper width" value={form.paperWidth} onChange={(paperWidth) => patch({ paperWidth: paperWidth as PrinterConfig["paperWidth"] })} options={[{ value: "80", label: "80 mm · 48 columns" }, { value: "58", label: "58 mm · 32 columns" }]} />
        <SelectField label="Character code page" value={form.codePage} onChange={(codePage) => patch({ codePage: codePage as PrinterConfig["codePage"] })} options={[
          { value: "CP437", label: "CP437 · US / Europe" }, { value: "CP858", label: "CP858 · Multilingual" }, { value: "WPC1252", label: "Windows-1252" }, { value: "UTF8", label: "UTF-8 (if supported)" },
        ]} />
        <div className="flex items-end pb-2"><Toggle checked={form.enabled} onChange={(enabled) => patch({ enabled })} label="Printer enabled" /></div>
      </div>
    </Modal>
  );
}

function TerminalEditor({ terminal, onClose, onSave }: { terminal: PaymentTerminalConfig; onClose: () => void; onSave: (terminal: PaymentTerminalConfig) => void }) {
  const [form, setForm] = useState(terminal);
  const patch = (value: Partial<PaymentTerminalConfig>) => setForm((current) => ({ ...current, ...value }));
  return (
    <Modal
      open
      onClose={onClose}
      title={terminal.name ? `Edit ${terminal.name}` : "Add payment reader"}
      subtitle="Semi-integrated EMV connection details. Card data never enters RMS."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!form.name.trim() || !form.address.trim()} onClick={() => onSave(form)}>Save reader</Button></>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Reader name" value={form.name} onChange={(name) => patch({ name })} placeholder="Register 1 · EMV" />
        <TextField label="Make / model" value={form.model} onChange={(model) => patch({ model })} placeholder="Provider and model" />
        <SelectField label="Connection" value={form.connection} onChange={(connection) => patch({ connection: connection as PaymentTerminalConfig["connection"] })} options={[{ value: "ip", label: "Local IP" }, { value: "bluetooth", label: "Bluetooth SDK" }]} />
        <TextField label={form.connection === "ip" ? "IP address or hostname" : "Bluetooth SDK identifier"} value={form.address} onChange={(address) => patch({ address })} placeholder={form.connection === "ip" ? "192.168.1.211" : "Reader serial / SDK ID"} />
        {form.connection === "ip" && <TextField label="TCP port" type="number" value={form.port} onChange={(value) => patch({ port: Number(value) })} />}
        <div className="flex items-end pb-2"><Toggle checked={form.enabled} onChange={(enabled) => patch({ enabled })} label="Reader enabled" /></div>
      </div>
    </Modal>
  );
}

function DiscoveryModal({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (host: string, port: number) => void }) {
  const [subnet, setSubnet] = useState("192.168.1");
  const [port, setPort] = useState("9100");
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [devices, setDevices] = useState<ConnectionResult[]>([]);
  const [added, setAdded] = useState<string[]>([]);

  async function discover() {
    setBusy(true);
    setScanned(false);
    try {
      const result = await api.post<{ scanned: number; devices: ConnectionResult[] }>("settings/hardware/discover", { subnet, port: Number(port) });
      setDevices(result.devices);
      setScanned(true);
      if (!result.devices.length) toast("No port 9100 listeners found in that range", "neutral");
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Discover network printers" subtitle="Scan one local /24 range for TCP listeners. No ESC/POS data is sent." footer={<Button onClick={onClose}>Done</Button>}>
      <div className="grid grid-cols-[minmax(0,1fr)_100px_auto] items-end gap-2">
        <TextField label="Network range (first 3 octets)" value={subnet} onChange={setSubnet} placeholder="192.168.1" />
        <TextField label="Port" type="number" value={port} onChange={setPort} />
        <Button variant="primary" disabled={busy} onClick={() => void discover()} className="mb-px"><Icon name="search" className={`size-4 ${busy ? "animate-pulse" : ""}`} />{busy ? "Scanning" : "Scan"}</Button>
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">The scan checks {subnet}.1 through {subnet}.254 and is bounded to 254 addresses.</p>
      <div className="mt-4">
        {busy ? (
          <div className="py-8 text-center text-[12px] font-semibold text-ink-faint">Listening for printers on port {port}…</div>
        ) : scanned && devices.length === 0 ? (
          <Empty title="No listeners found" hint="Confirm the printer and RMS server share a network, then check the port and subnet." icon="print" />
        ) : (
          <div className="flex flex-col gap-2">
            {devices.map((device) => (
              <div key={device.host} className="flex items-center gap-3 rounded-xl border border-rule p-3">
                <span className="flex size-8 items-center justify-center rounded-lg bg-ok-soft text-ok"><Icon name="print" className="size-4" /></span>
                <div className="flex-1"><p className="font-mono text-[12px] font-bold text-ink">{device.host}:{device.port}</p><p className="text-[10px] text-ink-faint">TCP listener · {device.latencyMs} ms</p></div>
                <Button size="sm" variant={added.includes(device.host) ? "soft" : "primary"} disabled={added.includes(device.host)} onClick={() => { onAdd(device.host, device.port); setAdded((current) => [...current, device.host]); }}>
                  {added.includes(device.host) ? <><Icon name="check" className="size-3.5" />Added</> : <><Icon name="plus" className="size-3.5" />Add</>}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
