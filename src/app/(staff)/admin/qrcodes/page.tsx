"use client";

import { useState } from "react";
import Link from "next/link";
import { api, errorMessage } from "@/lib/api";
import { usePoll } from "@/lib/store";
import { Button, Card, Chip, Empty, Icon, toast } from "@/components/ui";
import type { QrTokenInfo } from "@/types";

interface QrStickerItem {
  token: string;
  tableLabel: string;
  url: string;
  dataUrl: string;
}

interface QrTokensResponse {
  tokens: QrTokenInfo[];
  stickers: QrStickerItem[];
  enabled: boolean;
}

export default function QrCodesPage() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const { data, reload } = usePoll<QrTokensResponse>(
    origin ? `qr-tokens?stickers=1&baseUrl=${encodeURIComponent(origin)}` : "qr-tokens?stickers=1",
    { interval: 10000 },
  );
  const [busyToken, setBusyToken] = useState<string | null>(null);

  const tokens = data?.tokens ?? [];
  const stickerMap = new Map((data?.stickers ?? []).map((s) => [s.token, s]));

  async function toggleActive(row: QrTokenInfo) {
    setBusyToken(row.token);
    try {
      await api.patch(`qr-tokens/${row.token}`, { isActive: !row.isActive });
      toast(`${row.tableLabel} QR ${row.isActive ? "paused" : "activated"}`, "ok");
      await reload();
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusyToken(null);
    }
  }

  async function rotate(row: QrTokenInfo) {
    setBusyToken(row.token);
    try {
      await api.post(`qr-tokens/${row.token}/rotate`);
      toast(`Rotated QR token for ${row.tableLabel}`, "ok");
      await reload();
    } catch (error) {
      toast(errorMessage(error), "late");
    } finally {
      setBusyToken(null);
    }
  }

  async function copyLink(path: string) {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      toast(`Copied ${path}`, "ok");
    } catch {
      toast(url, "neutral");
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-black text-ink">Table QR Codes</h1>
          <p className="text-xs text-ink-soft">
            Guests scan these stickers to open the live menu, join their table session, call a waiter, and split the bill.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone={data?.enabled ? "ok" : "warn"}>
            {data?.enabled ? "QR Ordering Active" : "QR Ordering Paused"}
          </Chip>
          <Button variant="soft" onClick={() => window.print()}>
            <Icon name="print" className="size-4" />
            Print stickers
          </Button>
        </div>
      </div>

      {!data ? (
        <Empty title="Loading table QR codes…" icon="qr" />
      ) : tokens.length === 0 ? (
        <Empty title="No QR codes generated yet" icon="qr" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {tokens.map((row) => {
            const sticker = stickerMap.get(row.token);
            const directPath = `/t/${row.token}`;
            const shortPath = `/t/${row.tableLabel.toLowerCase()}`;
            return (
              <Card key={row.token} className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-base font-black text-ink">{row.tableLabel}</p>
                    <p className="text-[11px] font-semibold text-ink-faint">Table sticker</p>
                  </div>
                  <Chip tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? "Active" : "Paused"}</Chip>
                </div>

                {sticker ? (
                  <div className="mx-auto rounded-xl border border-rule bg-white p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={sticker.dataUrl} alt={`QR code for ${row.tableLabel}`} className="size-36" />
                  </div>
                ) : (
                  <div className="mx-auto flex size-40 items-center justify-center rounded-xl border border-dashed border-rule bg-paper-sunken text-xs text-ink-faint">
                    Paused
                  </div>
                )}

                <div className="space-y-1 text-[11px] text-ink-soft">
                  <div className="flex items-center justify-between">
                    <span>Direct URL</span>
                    <button type="button" onClick={() => void copyLink(directPath)} className="font-mono font-bold text-brand-600 hover:underline">
                      {directPath}
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Short URL</span>
                    <button type="button" onClick={() => void copyLink(shortPath)} className="font-mono font-bold text-brand-600 hover:underline">
                      {shortPath}
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Scans</span>
                    <span className="tnum font-bold text-ink">{row.scans}</span>
                  </div>
                </div>

                <div className="mt-auto flex flex-wrap gap-1.5 border-t border-rule pt-3">
                  <Link href={directPath} target="_blank" className="btn btn-primary !px-2.5 !py-1.5 !text-xs flex-1">
                    Open menu
                  </Link>
                  <Button
                    variant="soft"
                    size="sm"
                    disabled={busyToken === row.token}
                    onClick={() => void toggleActive(row)}
                  >
                    {row.isActive ? "Pause" : "Enable"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyToken === row.token}
                    onClick={() => void rotate(row)}
                  >
                    Rotate
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
