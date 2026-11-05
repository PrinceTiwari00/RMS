/**
 * QR payment payloads.
 *
 * Nepal's interoperable QR (NepalPay / Fonepay) is an EMVCo Merchant-Presented
 * Mode string: a run of TLV fields terminated by a CRC-16/CCITT-FALSE over
 * everything preceding it. A payload with a wrong CRC is silently rejected by
 * every wallet app, so the checksum is computed here rather than hardcoded.
 */

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let index = 0; index < input.length; index += 1) {
    crc ^= input.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** One EMVCo TLV field: 2-char id, 2-char zero-padded length, value. */
export function tlv(id: string, value: string): string {
  if (id.length !== 2) throw new Error(`EMV tag must be two characters, got "${id}"`);
  if (value.length > 99) throw new Error(`EMV value too long for ${id}: ${value.length} characters`);
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/** Strip anything outside the EMVCo-safe character set. */
function sanitize(value: string, limit: number): string {
  return value
    .replace(/[^A-Za-z0-9 .\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export interface EmvQrInput {
  merchantName: string;
  merchantCity: string;
  /** paisa */
  amount: number;
  /** merchant account / terminal reference shown in the wallet app */
  merchantId?: string;
  /** acquiring institution's reverse-domain GUID */
  acquiringGuid?: string;
  /** bill or reference number, echoed back by the wallet */
  reference?: string;
  /** "12" = one dynamic payment, "11" = reusable static code */
  initiation?: "11" | "12";
  /** ISO 4217 numeric; 524 is NPR */
  currency?: string;
  /** ISO 3166-1 alpha-2 */
  country?: string;
  /** ISO 18245 MCC; 5812 is eating places / restaurants */
  mcc?: string;
}

export const NPR_CURRENCY_CODE = "524";
export const RESTAURANT_MCC = "5812";
/** Fonepay/NepalPay interoperable acquiring GUID used across Nepali wallets. */
export const NEPAL_ACQUIRING_GUID = "A000000677010101";

/**
 * Build an EMVCo MPM payload string. Deterministic for identical inputs, so the
 * same check always renders the same scannable code.
 */
export function buildEmvQr(input: EmvQrInput): string {
  const amount = Math.max(0, Math.round(input.amount));
  const merchantAccount =
    tlv("00", input.acquiringGuid ?? NEPAL_ACQUIRING_GUID) +
    tlv("01", sanitize(input.merchantId ?? "TERAIKITCHEN", 24));

  const additional = input.reference
    ? tlv("62", tlv("01", sanitize(String(input.reference), 24)))
    : "";

  const body =
    tlv("00", "01") +
    tlv("01", input.initiation ?? "12") +
    tlv("30", merchantAccount) +
    tlv("52", input.mcc ?? RESTAURANT_MCC) +
    tlv("53", input.currency ?? NPR_CURRENCY_CODE) +
    // Field 54 is omitted entirely for a static (amount-less) code.
    (amount > 0 ? tlv("54", (amount / 100).toFixed(2)) : "") +
    tlv("58", input.country ?? "NP") +
    tlv("59", sanitize(input.merchantName, 25) || "RESTAURANT") +
    tlv("60", sanitize(input.merchantCity, 15) || "BIRGUNJ") +
    additional;

  // The CRC tag itself is included in the data the CRC is computed over.
  const withCrcTag = `${body}${tlv("63", "")}`;
  return `${withCrcTag}${crc16(withCrcTag)}`;
}

/** Parse a payload back into its fields — used to validate before rendering. */
export function parseEmvQr(payload: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let cursor = 0;
  while (cursor + 4 <= payload.length) {
    const id = payload.slice(cursor, cursor + 2);
    const length = Number(payload.slice(cursor + 2, cursor + 4));
    if (!Number.isFinite(length)) break;
    fields[id] = payload.slice(cursor + 4, cursor + 4 + length);
    cursor += 4 + length;
  }
  return fields;
}

/** True when the trailing CRC matches the recomputed checksum. */
export function isValidEmvQr(payload: string): boolean {
  if (!/^[0-9]+$/.test(payload) || payload.length < 8) return false;
  const body = payload.slice(0, -4);
  const declared = payload.slice(-4);
  if (!body.endsWith("6304")) return false;
  return crc16(body) === declared.toUpperCase();
}

/** The human-readable amount line a wallet app will show. */
export function emvAmountLabel(payload: string, symbol = "Rs"): string {
  const fields = parseEmvQr(payload);
  if (!fields["54"]) return "Enter amount";
  return `${symbol} ${Number(fields["54"]).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A scan URL for the table menu: what the printed QR sticker encodes. */
export function tableMenuUrl(baseUrl: string, token: string): string {
  const root = String(baseUrl ?? "").replace(/\/+$/, "");
  return `${root}/t/${token}`;
}

/**
 * A UPI-style deep link for wallets that prefer URI schemes over EMV payloads.
 * Kept separate because the two encodings are not interchangeable.
 */
export function buildUpiUri(input: { payeeVpa: string; payeeName: string; amountPaisa: number; note?: string; reference?: string }): string {
  const params = new URLSearchParams({
    pa: input.payeeVpa,
    pn: input.payeeName,
    tn: input.note ?? "Restaurant bill",
    cu: "NPR",
  });
  if (input.amountPaisa > 0) params.set("am", (input.amountPaisa / 100).toFixed(2));
  if (input.reference) params.set("tr", String(input.reference));
  return `upi://pay?${params.toString()}`;
}
