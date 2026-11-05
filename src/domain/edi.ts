/**
 * ANSI X12 EDI 850 (Purchase Order) generation for broadline distributors,
 * transmitted over SFTP. Vendors without EDI get a PDF email instead; both
 * channels are recorded in `po_transmissions` so the admin portal can show a
 * real delivery log.
 */
import { toRupees } from "./money";

export interface Edi850Item {
  qty: number;
  /** paisa */
  price: number;
  sku: string;
}

export interface Edi850Input {
  poNumber: string;
  sender: string;
  receiver: string;
  items: Edi850Item[];
  now?: Date;
}

export function buildEdi850(input: Edi850Input): string {
  const now = input.now ?? new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;

  const lines: string[] = [];
  lines.push(
    `ISA*00*          *00*          *ZZ*${input.sender.padEnd(15).slice(0, 15)}` +
      `*ZZ*${input.receiver.padEnd(15).slice(0, 15)}*${date.slice(2)}*${time}*U*00401*000000001*0*P*>~`,
  );
  lines.push(`GS*PO*${input.sender}*${input.receiver}*${date}*${time}*1*X*004010~`);
  lines.push(`ST*850*${input.poNumber}~`);
  lines.push(`BEG*00*NE*${input.poNumber}**${date}~`);
  lines.push(`CUR*1*USD~`);

  let total = 0;
  input.items.forEach((item, index) => {
    const price = toRupees(item.price).toFixed(2);
    total += item.price * item.qty;
    lines.push(`PO1*${String(index + 1).padStart(3, "0")}*${item.qty}*CA*${price}*PE**VN*${item.sku}~`);
  });

  lines.push(`CTT*${input.items.length}~`);
  lines.push(`AMT*1*${toRupees(total).toFixed(2)}~`);
  lines.push(`SE*${input.items.length + 6}*${input.poNumber}~`);
  lines.push(`GE*1*1~`);
  lines.push(`IEA*1*000000001~`);

  return lines.join("\n");
}

/** Human-readable PDF-style text used for non-EDI vendors. */
export function buildPoDocument(input: {
  poNumber: string;
  vendorName: string;
  restaurantName: string;
  expectedDate: string;
  lines: { name: string; unit: string; packs: number; units: number; unitPrice: number }[];
}): string {
  const rows = input.lines
    .map(
      (line) =>
        `  ${line.name.padEnd(28).slice(0, 28)} ${String(line.packs).padStart(4)} ${line.unit.padEnd(6)} ` +
        `${String(line.units).padStart(8)}  Rs ${toRupees(line.unitPrice).toFixed(2).padStart(9)}`,
    )
    .join("\n");
  const total = input.lines.reduce((sum, line) => sum + line.unitPrice * line.packs, 0);
  return [
    "PURCHASE ORDER",
    `PO #:      ${input.poNumber}`,
    `Vendor:    ${input.vendorName}`,
    `Deliver to:${input.restaurantName}`,
    `Expected:  ${input.expectedDate}`,
    "",
    "  ITEM                            PACKS  UNIT     UNITS      PRICE",
    "  " + "-".repeat(70),
    rows,
    "  " + "-".repeat(70),
    `  TOTAL: Rs ${toRupees(total).toFixed(2)}`,
  ].join("\n");
}
