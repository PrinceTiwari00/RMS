"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Button, Chip, Modal, Spinner, toast } from "@/components/ui";
import type { ServiceRequestInfo, ServiceRequestType, TableGuest } from "@/types";

const QUICK_REQUESTS: { type: ServiceRequestType; label: string; icon: string }[] = [
  { type: "water", label: "Water", icon: "💧" },
  { type: "napkins", label: "Napkins", icon: "🧻" },
  { type: "bill", label: "Bill", icon: "🧾" },
  { type: "cutlery", label: "Cutlery", icon: "🍴" },
];

export function NeedSomethingModal({
  open,
  onClose,
  token,
  tableLabel,
  currentGuest,
  activeRequests,
  onRequested,
}: {
  open: boolean;
  onClose: () => void;
  token: string;
  tableLabel: string;
  currentGuest: TableGuest | null;
  activeRequests: ServiceRequestInfo[];
  onRequested: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!open || !activeRequests.length) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [open, activeRequests.length]);

  async function sendHelp(requestType: ServiceRequestType) {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`guest/${token}/help`, {
        requestType,
        guestId: currentGuest?.id ?? null,
        guestName: currentGuest?.name ?? "",
      });
      toast("Staff notified! Your waiter is on the way.", "ok");
      onRequested();
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Need something?" subtitle={tableLabel} width="max-w-sm">
      <div className="flex flex-col items-center py-3 text-center">
        <button
          type="button"
          disabled={busy}
          onClick={() => void sendHelp("call_waiter")}
          className="group relative flex size-36 flex-col items-center justify-center rounded-full bg-gradient-to-br from-ember-400 to-ember-600 text-white shadow-lg ring-8 ring-ember-100 transition-transform active:scale-95 disabled:opacity-60"
        >
          {busy ? <Spinner className="size-7 text-white" /> : <span className="text-3xl" aria-hidden="true">🔔</span>}
          <span className="mt-1.5 text-sm font-black">Call waiter</span>
        </button>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {QUICK_REQUESTS.map((req) => (
            <Button
              key={req.type}
              variant="soft"
              size="sm"
              disabled={busy}
              onClick={() => void sendHelp(req.type)}
            >
              <span aria-hidden="true">{req.icon}</span>
              {req.label}
            </Button>
          ))}
        </div>

        {activeRequests.length > 0 && (
          <div className="mt-5 w-full space-y-2 border-t border-rule pt-4 text-left">
            <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Active requests</p>
            {activeRequests.map((req) => {
              const sec = req.elapsedSeconds + tick;
              const mm = String(Math.floor(sec / 60)).padStart(2, "0");
              const ss = String(sec % 60).padStart(2, "0");
              return (
                <div
                  key={req.id}
                  className="flex items-center justify-between rounded-xl border border-ember-200 bg-ember-50/70 px-3 py-2 text-xs"
                >
                  <div>
                    <p className="font-extrabold capitalize text-ink">{req.requestType.replace("_", " ")}</p>
                    <p className="text-[11px] text-ink-soft">→ {req.assignedWaiterName} notified</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Chip tone={req.status === "acknowledged" ? "ok" : "ember"}>
                      {req.status === "acknowledged" ? "On the way" : `WAITER · ${mm}:${ss}`}
                    </Chip>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
