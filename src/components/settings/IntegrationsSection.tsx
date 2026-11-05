"use client";

import { boolValue } from "@/domain/settings";
import { Notice, Panel, SecretField, Status, TextField, ToggleRow, type SettingsSectionProps } from "./controls";

export function IntegrationsSection({ draft, onChange, canEdit }: SettingsSectionProps) {
  const smtpReady = Boolean(draft.smtp_host && draft.smtp_from_email);
  const sftpReady = Boolean(draft.sftp_host && draft.sftp_username && draft.sftp_private_key);
  const twilioReady = Boolean(draft.twilio_account_sid && draft.twilio_auth_token && draft.twilio_from_number);
  const sendgridReady = Boolean(draft.sendgrid_api_key && draft.sendgrid_from_email);

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="neutral" icon="lock">
        Saved secrets are masked in API responses and are never written to the audit log. For a live deployment, use HTTPS, a protected database and your hosting provider's secret manager.
      </Notice>

      <Panel
        title="Vendor & EDI gateway"
        description="Dispatch purchase-order PDFs by SMTP and configure the SFTP channel used for vendor EDI 850 documents."
        icon="vendor"
        action={<Status tone={smtpReady || sftpReady ? "ok" : "neutral"}>{smtpReady || sftpReady ? "Gateway configured" : "Not configured"}</Status>}
      >
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <section className="rounded-xl border border-rule p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div><h3 className="text-[13px] font-extrabold text-ink">SMTP purchase orders</h3><p className="mt-0.5 text-[11px] text-ink-faint">Automated PDF delivery to vendor order desks.</p></div>
              <Status tone={boolValue(draft.smtp_enabled) ? smtpReady ? "ok" : "warn" : "neutral"}>{boolValue(draft.smtp_enabled) ? smtpReady ? "Ready" : "Needs details" : "Off"}</Status>
            </div>
            <div className="mb-3 border-b border-rule pb-3">
              <ToggleRow title="Enable SMTP dispatch" description="Queue approved purchase orders for email delivery." checked={boolValue(draft.smtp_enabled)} onChange={(value) => onChange("smtp_enabled", value)} disabled={!canEdit} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="SMTP host" value={draft.smtp_host} onChange={(value) => onChange("smtp_host", value)} placeholder="smtp.example.com" disabled={!canEdit} />
              <TextField label="Port" type="number" value={draft.smtp_port} onChange={(value) => onChange("smtp_port", value)} placeholder="587" disabled={!canEdit} />
              <TextField label="Username" value={draft.smtp_username} onChange={(value) => onChange("smtp_username", value)} disabled={!canEdit} />
              <SecretField label="Password / app password" value={draft.smtp_password} onChange={(value) => onChange("smtp_password", value)} disabled={!canEdit} />
              <TextField label="From email" value={draft.smtp_from_email} onChange={(value) => onChange("smtp_from_email", value)} inputMode="email" placeholder="purchasing@restaurant.com" disabled={!canEdit} />
              <TextField label="From name" value={draft.smtp_from_name} onChange={(value) => onChange("smtp_from_name", value)} placeholder="Restaurant Purchasing" disabled={!canEdit} />
            </div>
          </section>

          <section className="rounded-xl border border-rule p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div><h3 className="text-[13px] font-extrabold text-ink">SFTP / EDI 850</h3><p className="mt-0.5 text-[11px] text-ink-faint">Structured purchase orders for EDI-enabled vendors.</p></div>
              <Status tone={boolValue(draft.sftp_enabled) ? sftpReady ? "ok" : "warn" : "neutral"}>{boolValue(draft.sftp_enabled) ? sftpReady ? "Ready" : "Needs details" : "Off"}</Status>
            </div>
            <div className="mb-3 border-b border-rule pb-3">
              <ToggleRow title="Enable vendor SFTP" description="Allow EDI 850 transmissions to this gateway." checked={boolValue(draft.sftp_enabled)} onChange={(value) => onChange("sftp_enabled", value)} disabled={!canEdit} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="SFTP host" value={draft.sftp_host} onChange={(value) => onChange("sftp_host", value)} placeholder="edi.vendor.com" disabled={!canEdit} />
              <TextField label="Port" type="number" value={draft.sftp_port} onChange={(value) => onChange("sftp_port", value)} placeholder="22" disabled={!canEdit} />
              <TextField label="Username" value={draft.sftp_username} onChange={(value) => onChange("sftp_username", value)} disabled={!canEdit} />
              <TextField label="Remote directory" value={draft.sftp_path} onChange={(value) => onChange("sftp_path", value)} placeholder="/incoming/edi850" disabled={!canEdit} />
              <label className="block sm:col-span-2">
                <span className="label">Private key / API credential</span>
                <textarea
                  className="field min-h-20 resize-y font-mono !text-[11px]"
                  value={draft.sftp_private_key}
                  disabled={!canEdit}
                  placeholder="Paste a new private key to replace the saved credential"
                  spellCheck={false}
                  onChange={(event) => onChange("sftp_private_key", event.target.value)}
                />
                <span className="mt-1 block text-[11px] text-ink-faint">Leave the mask unchanged to keep the current key. Clear it to remove the credential.</span>
              </label>
            </div>
          </section>
        </div>
      </Panel>

      <Panel title="SMS & email gateway" description="Customer waitlist alerts and digital receipts use the provider configured for each channel." icon="phone">
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <section className="rounded-xl border border-rule p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div><h3 className="text-[13px] font-extrabold text-ink">Twilio SMS</h3><p className="mt-0.5 text-[11px] text-ink-faint">Waitlist notifications and table-ready alerts.</p></div>
              <Status tone={boolValue(draft.twilio_enabled) ? twilioReady ? "ok" : "warn" : "neutral"}>{boolValue(draft.twilio_enabled) ? twilioReady ? "Ready" : "Needs details" : "Off"}</Status>
            </div>
            <div className="mb-3 border-b border-rule pb-3">
              <ToggleRow title="Enable Twilio" description="Send customer-facing SMS through this account." checked={boolValue(draft.twilio_enabled)} onChange={(value) => onChange("twilio_enabled", value)} disabled={!canEdit} />
            </div>
            <div className="flex flex-col gap-3">
              <TextField label="Account SID" value={draft.twilio_account_sid} onChange={(value) => onChange("twilio_account_sid", value)} placeholder="AC…" disabled={!canEdit} />
              <SecretField label="Auth token" value={draft.twilio_auth_token} onChange={(value) => onChange("twilio_auth_token", value)} disabled={!canEdit} />
              <TextField label="From number" value={draft.twilio_from_number} onChange={(value) => onChange("twilio_from_number", value)} inputMode="tel" placeholder="+977…" disabled={!canEdit} />
            </div>
          </section>

          <section className="rounded-xl border border-rule p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div><h3 className="text-[13px] font-extrabold text-ink">SendGrid email</h3><p className="mt-0.5 text-[11px] text-ink-faint">Branded digital receipts and customer invoices.</p></div>
              <Status tone={boolValue(draft.sendgrid_enabled) ? sendgridReady ? "ok" : "warn" : "neutral"}>{boolValue(draft.sendgrid_enabled) ? sendgridReady ? "Ready" : "Needs details" : "Off"}</Status>
            </div>
            <div className="mb-3 border-b border-rule pb-3">
              <ToggleRow title="Enable SendGrid" description="Send transactional email through this account." checked={boolValue(draft.sendgrid_enabled)} onChange={(value) => onChange("sendgrid_enabled", value)} disabled={!canEdit} />
            </div>
            <div className="flex flex-col gap-3">
              <SecretField label="API key" value={draft.sendgrid_api_key} onChange={(value) => onChange("sendgrid_api_key", value)} disabled={!canEdit} />
              <TextField label="Verified sender email" value={draft.sendgrid_from_email} onChange={(value) => onChange("sendgrid_from_email", value)} inputMode="email" placeholder="receipts@restaurant.com" disabled={!canEdit} />
            </div>
          </section>
        </div>

        <div className="mt-4 grid gap-2 border-t border-rule pt-3 md:grid-cols-3">
          <ToggleRow title="Waitlist SMS alerts" description="Notify waiting guests when their table is ready." checked={boolValue(draft.notify_waitlist_sms, true)} onChange={(value) => onChange("notify_waitlist_sms", value)} disabled={!canEdit} />
          <ToggleRow title="Digital receipts" description="Offer email delivery after guest checkout." checked={boolValue(draft.notify_digital_receipts, true)} onChange={(value) => onChange("notify_digital_receipts", value)} disabled={!canEdit} />
          <ToggleRow title="Purchase-order dispatch" description="Automatically queue approved vendor orders." checked={boolValue(draft.notify_purchase_orders, true)} onChange={(value) => onChange("notify_purchase_orders", value)} disabled={!canEdit} />
        </div>
      </Panel>

      <Panel title="Third-party delivery" description="Store marketplace credentials for orders that flow directly into the POS and KDS queue." icon="qr" action={<Status tone={boolValue(draft.doordash_enabled) || boolValue(draft.ubereats_enabled) ? "info" : "neutral"}>{[boolValue(draft.doordash_enabled), boolValue(draft.ubereats_enabled)].filter(Boolean).length} channels on</Status>}>
        <div className="grid gap-3 lg:grid-cols-2">
          <DeliveryChannel
            name="DoorDash"
            description="Marketplace orders, store mapping and menu webhooks."
            enabled={boolValue(draft.doordash_enabled)}
            onEnabled={(value) => onChange("doordash_enabled", value)}
            storeId={draft.doordash_store_id}
            onStoreId={(value) => onChange("doordash_store_id", value)}
            apiKey={draft.doordash_api_key}
            onApiKey={(value) => onChange("doordash_api_key", value)}
            canEdit={canEdit}
            color="#eb1700"
          />
          <DeliveryChannel
            name="Uber Eats"
            description="Direct order injection with store-level credentials."
            enabled={boolValue(draft.ubereats_enabled)}
            onEnabled={(value) => onChange("ubereats_enabled", value)}
            storeId={draft.ubereats_store_id}
            onStoreId={(value) => onChange("ubereats_store_id", value)}
            apiKey={draft.ubereats_api_key}
            onApiKey={(value) => onChange("ubereats_api_key", value)}
            canEdit={canEdit}
            color="#06c167"
          />
        </div>
        <div className="mt-3 border-t border-rule pt-3">
          <ToggleRow title="Auto-accept confirmed marketplace orders" description="Inject confirmed orders directly into the KDS queue instead of waiting for a host to accept them." checked={boolValue(draft.delivery_auto_accept)} onChange={(value) => onChange("delivery_auto_accept", value)} disabled={!canEdit} />
        </div>
        <div className="mt-3"><Notice tone="warn">Provider credentials alone do not activate order ingestion. Complete the marketplace developer onboarding and configure its webhook to your deployed RMS endpoint.</Notice></div>
      </Panel>
    </div>
  );
}

function DeliveryChannel({
  name,
  description,
  enabled,
  onEnabled,
  storeId,
  onStoreId,
  apiKey,
  onApiKey,
  canEdit,
  color,
}: {
  name: string;
  description: string;
  enabled: boolean;
  onEnabled: (value: boolean) => void;
  storeId: string;
  onStoreId: (value: string) => void;
  apiKey: string;
  onApiKey: (value: string) => void;
  canEdit: boolean;
  color: string;
}) {
  const ready = Boolean(storeId && apiKey);
  return (
    <section className="rounded-xl border border-rule p-4">
      <div className="mb-3 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-xl text-sm font-black text-white" style={{ background: color }}>{name.slice(0, 1)}</span>
        <div className="min-w-0 flex-1"><h3 className="text-[13px] font-extrabold text-ink">{name}</h3><p className="truncate text-[10px] text-ink-faint">{description}</p></div>
        <Status tone={enabled ? ready ? "ok" : "warn" : "neutral"}>{enabled ? ready ? "Ready" : "Needs details" : "Off"}</Status>
      </div>
      <div className="mb-3 border-b border-rule pb-3">
        <ToggleRow title={`Enable ${name}`} description="Allow this marketplace connector when provider onboarding is complete." checked={enabled} onChange={onEnabled} disabled={!canEdit} />
      </div>
      <div className="flex flex-col gap-3">
        <TextField label="Store / location ID" value={storeId} onChange={onStoreId} placeholder={`${name} store identifier`} disabled={!canEdit} />
        <SecretField label="API key / client secret" value={apiKey} onChange={onApiKey} disabled={!canEdit} />
      </div>
    </section>
  );
}
