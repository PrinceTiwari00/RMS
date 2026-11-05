/**
 * Operational seed: what the restaurant looks like *right now*.
 *
 * Live tickets across the floor and the kitchen (covering every table status and
 * every KDS urgency bucket), a working waitlist, tonight's reservations, this
 * week's published schedule, recent waste and counts, and purchase orders in
 * each state of the draft → approved → sent → received pipeline.
 */
import { all, get, run, uuid } from "@/db/client";
import type { Random } from "@/lib/rng";
import { zoned, shiftDate, today, atClock, businessDateNow, pad, weekdayName } from "@/domain/time";
import { initialKdsStatus } from "@/domain/kds";
import { percentOf, vatAmount } from "@/domain/money";

interface TableRef {
  id: string;
  label: string;
}
interface StaffRef {
  id: string;
  name: string;
  role: string;
}
interface StockRef {
  id: string;
  name: string;
  unit: string;
}

function stampMinutesAgo(minutes: number): string {
  const now = zoned();
  const epoch = Date.parse(`${now.stamp.replace(" ", "T")}Z`) - minutes * 60_000;
  const shifted = new Date(epoch);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.RMS_TZ ?? "Asia/Kathmandu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(shifted);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  let hour = Number(read("hour"));
  if (hour === 24) hour = 0;
  return `${read("year")}-${read("month")}-${read("day")} ${pad(hour)}:${read("minute")}:${read("second")}`;
}

function tableByLabel(tables: TableRef[], label: string): TableRef | undefined {
  return tables.find((table) => table.label === label);
}

function staffByName(staff: Map<string, StaffRef>, name: string): StaffRef | undefined {
  return staff.get(name);
}

interface MenuItemRow {
  id: string;
  name: string;
  price: number;
  course: string;
  station: string;
}

function loadMenuRows(): Map<string, MenuItemRow> {
  const rows = all<MenuItemRow>("SELECT id, name, price, course, station FROM menu_items");
  return new Map(rows.map((row) => [row.name, row]));
}

let checkCounter = 1000;
function nextCheckNumber(): number {
  checkCounter += 1;
  return checkCounter;
}

interface LiveTicketSpec {
  table: string;
  status: "seated" | "ordered" | "billed";
  guests: number;
  server: string;
  channel?: string;
  /** minutes since the ticket was sent to the kitchen */
  sentMinutesAgo?: number;
  items: { name: string; qty?: number; seat?: number; note?: string; ready?: boolean; modifiers?: string[] }[];
}

function createLiveTicket(spec: LiveTicketSpec, tables: TableRef[], staff: Map<string, StaffRef>, menu: Map<string, MenuItemRow>): string | null {
  const table = tableByLabel(tables, spec.table);
  if (!table) return null;
  const server = staffByName(staff, spec.server);
  const businessDate = businessDateNow();
  const orderId = uuid();
  const createdAt = spec.sentMinutesAgo ? stampMinutesAgo(spec.sentMinutesAgo + 4) : stampMinutesAgo(6);
  const seatedAt = stampMinutesAgo((spec.sentMinutesAgo ?? 0) + 12);

  run(
    `INSERT INTO orders (id, check_number, table_id, terminal_id, server_id, status, channel, guests,
       qr_token, guest_name, note, business_date, created_at, sent_at, fired_at)
     VALUES (?, ?, ?, 'term-pos-1', ?, ?, ?, ?, NULL, '', '', ?, ?, ?, ?)`,
    orderId,
    nextCheckNumber(),
    table.id,
    server?.id ?? null,
    spec.status === "seated" ? "open" : "sent",
    spec.channel ?? "dine_in",
    spec.guests,
    businessDate,
    createdAt,
    spec.sentMinutesAgo ? stampMinutesAgo(spec.sentMinutesAgo) : null,
    spec.sentMinutesAgo ? stampMinutesAgo(Math.max(0, spec.sentMinutesAgo - 3)) : null,
  );

  let subtotal = 0;
  spec.items.forEach((line, index) => {
    const item = menu.get(line.name);
    if (!item) return;
    const quantity = line.qty ?? 1;
    const orderItemId = uuid();
    const kdsStatus = line.ready ? "READY" : initialKdsStatus(item.course);
    const sentAt = spec.sentMinutesAgo ? stampMinutesAgo(spec.sentMinutesAgo) : null;
    run(
      `INSERT INTO order_items (id, order_id, menu_item_id, name_snapshot, quantity, price_at_time,
         course, station, seat, note, kds_status, is_void, created_at, sent_at, ready_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      orderItemId,
      orderId,
      item.id,
      item.name,
      quantity,
      item.price,
      item.course,
      item.station,
      line.seat ?? (index % Math.max(1, spec.guests)) + 1,
      line.note ?? "",
      kdsStatus,
      createdAt,
      sentAt,
      line.ready ? stampMinutesAgo(Math.max(1, (spec.sentMinutesAgo ?? 4) - 2)) : null,
    );
    for (const modifierName of line.modifiers ?? []) {
      const modifier = get<{ id: string; price: number; group_name: string; name: string }>(
        `SELECT m.id, m.price, g.name AS group_name, m.name
           FROM modifiers m JOIN modifier_groups g ON g.id = m.group_id
          WHERE m.name = ? AND m.menu_item_id = ?`,
        modifierName,
        item.id,
      );
      if (!modifier) continue;
      run(
        `INSERT INTO order_item_modifiers (id, order_item_id, modifier_id, group_name, name_snapshot, price_at_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
        uuid(),
        orderItemId,
        modifier.id,
        modifier.group_name,
        modifier.name,
        modifier.price,
      );
      subtotal += modifier.price * quantity;
    }
    subtotal += item.price * quantity;
  });

  if (spec.status === "billed") {
    const discount = 0;
    const vat = vatAmount(subtotal - discount, 13, false);
    const service = percentOf(subtotal - discount, 10);
    const total = subtotal - discount + vat + service;
    run(
      `UPDATE orders SET subtotal = ?, discount = ?, vat = ?, service_charge = ?, total = ? WHERE id = ?`,
      subtotal,
      discount,
      vat,
      service,
      total,
      orderId,
    );
  }

  const tableStatus = spec.status;
  run(
    `UPDATE tables SET status = ?, guests = ?, server_id = ?, seated_at = ? WHERE id = ?`,
    tableStatus,
    spec.guests,
    server?.id ?? null,
    seatedAt,
    table.id,
  );
  return orderId;
}

/** Tickets live on the floor right now. Covers every table status and KDS age bucket. */
export function seedLiveService(tables: TableRef[], _menu: Map<string, { id: string; name: string; price: number }>, staff: Map<string, StaffRef>, _rnd: Random): void {
  const menu = loadMenuRows();

  const tickets: LiveTicketSpec[] = [
    {
      table: "M2",
      status: "seated",
      guests: 4,
      server: "Anil Prasad Gupta",
      items: [
        { name: "Masala Chiya", qty: 2 },
        { name: "Soft Drink", qty: 2 },
      ],
    },
    {
      table: "M4",
      status: "ordered",
      guests: 6,
      server: "Pooja Kumari Singh",
      sentMinutesAgo: 6,
      items: [
        { name: "Chicken Momo (Steamed)", qty: 2, seat: 1, modifiers: ["Jumbo plate · 15 pcs", "Extra hot chilli achar"] },
        { name: "Paneer Pakoda", qty: 1, seat: 2 },
        { name: "Thakali Set (Chicken)", qty: 3, seat: 3, note: "One without achar" },
        { name: "Butter Chicken", qty: 2, seat: 5 },
        { name: "Butter Naan", qty: 4, seat: 5 },
        { name: "Fresh Lime Soda", qty: 3, seat: 6, modifiers: ["Salted"] },
      ],
    },
    {
      table: "B1",
      status: "ordered",
      guests: 2,
      server: "Mohammad Irfan Ansari",
      sentMinutesAgo: 17,
      items: [
        { name: "Chilli Chicken", qty: 1, seat: 1, ready: true, modifiers: ["Hot"] },
        { name: "Crispy Fries", qty: 1, seat: 2, ready: true },
        { name: "House Burger", qty: 1, seat: 1, note: "Allergy: no sesame seeds on bun", modifiers: ["Medium", "Add cheese", "Coleslaw"] },
        { name: "Chicken Tikka Pizza", qty: 1, seat: 2, ready: true },
        { name: "Nepal Lager", qty: 2, seat: 1, ready: true },
      ],
    },
    {
      table: "T2",
      status: "ordered",
      guests: 4,
      server: "Anil Prasad Gupta",
      sentMinutesAgo: 3,
      items: [
        { name: "Chicken Chowmein", qty: 2, seat: 1, modifiers: ["Extra hot"] },
        { name: "Egg Fried Rice", qty: 1, seat: 3 },
        { name: "Chicken Wings", qty: 1, seat: 4, modifiers: ["Medium"] },
        { name: "Mango Lassi", qty: 2, seat: 2, ready: true },
      ],
    },
    {
      table: "M8",
      status: "billed",
      guests: 8,
      server: "Pooja Kumari Singh",
      sentMinutesAgo: 52,
      items: [
        { name: "Tandoori Chicken (Half)", qty: 2, seat: 1, ready: true, modifiers: ["Medium"] },
        { name: "Mutton Curry", qty: 1, seat: 4, ready: true },
        { name: "Dal Bhat Tarkari", qty: 3, seat: 5, ready: true },
        { name: "Tandoori Roti", qty: 6, seat: 2, ready: true },
        { name: "Gulab Jamun (2 pcs)", qty: 3, seat: 7, ready: true },
        { name: "Masala Chiya", qty: 4, seat: 3, ready: true },
      ],
    },
    {
      table: "BR",
      status: "ordered",
      guests: 3,
      server: "Nisha Khatun",
      sentMinutesAgo: 9,
      channel: "dine_in",
      items: [
        { name: "House Cocktail", qty: 2, seat: 1, ready: true },
        { name: "Nepal Lager", qty: 3, seat: 2, ready: true },
        { name: "Virgin Mocktail", qty: 1, seat: 3 },
        { name: "Cheesy Garlic Bread", qty: 1, seat: 2 },
      ],
    },
    {
      table: "L1",
      status: "seated",
      guests: 2,
      server: "Mohammad Irfan Ansari",
      items: [],
    },
  ];

  for (const ticket of tickets) {
    if (ticket.items.length === 0 && ticket.status === "seated") {
      // Seated but not yet ordering — just flip the table state.
      const table = tableByLabel(tables, ticket.table);
      const server = staffByName(staff, ticket.server);
      if (table) {
        run(
          `UPDATE tables SET status = 'seated', guests = ?, server_id = ?, seated_at = ? WHERE id = ?`,
          ticket.guests,
          server?.id ?? null,
          stampMinutesAgo(4),
          table.id,
        );
      }
      continue;
    }
    createLiveTicket(ticket, tables, staff, menu);
  }

  // A table that has been cleared but not yet reset.
  const dirty = tableByLabel(tables, "M7");
  if (dirty) run(`UPDATE tables SET status = 'dirty', guests = 0, server_id = NULL, seated_at = ? WHERE id = ?`, stampMinutesAgo(9), dirty.id);
}

/** Waitlist parties and tonight's reservations. */
export function seedHosting(tables: TableRef[], rnd: Random): void {
  const businessDate = businessDateNow();
  interface WaitlistSeed {
    name: string;
    phone: string;
    size: number;
    status: string;
    quoted: number;
    minutesAgo: number;
    notes?: string;
    table?: string;
  }
  const parties: WaitlistSeed[] = [
    { name: "Shrestha family", phone: "+977 984 552 1180", size: 5, status: "waiting", quoted: 25, minutesAgo: 22, notes: "High chair needed" },
    { name: "Birendra Chaurasia", phone: "+977 980 664 7712", size: 2, status: "notified", quoted: 10, minutesAgo: 34, notes: "" },
    { name: "Office party — Nepal Bank", phone: "+977 985 118 9090", size: 9, status: "waiting", quoted: 40, minutesAgo: 12, notes: "Wants the private room" },
    { name: "Farhana Begum", phone: "+977 982 771 3345", size: 3, status: "seated", quoted: 15, minutesAgo: 48, table: "T3" },
    { name: "Prakash Jaiswal", phone: "+977 981 220 6677", size: 4, status: "no_show", quoted: 20, minutesAgo: 66, notes: "Called twice, no answer" },
  ];
  for (const party of parties) {
    const id = uuid();
    const table = party.table ? tableByLabel(tables, party.table) : undefined;
    run(
      `INSERT INTO waitlist_parties (id, guest_name, phone, party_size, status, quoted_minutes, notes,
         table_id, business_date, created_at, notified_at, seated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      party.name,
      party.phone,
      party.size,
      party.status,
      party.quoted,
      party.notes ?? "",
      table?.id ?? null,
      businessDate,
      stampMinutesAgo(party.minutesAgo),
      party.status === "notified" || party.status === "seated" ? stampMinutesAgo(Math.max(1, party.minutesAgo - 8)) : null,
      party.status === "seated" ? stampMinutesAgo(Math.max(1, party.minutesAgo - 12)) : null,
    );
    if (party.status === "notified" || party.status === "seated") {
      run(
        `INSERT INTO guest_alerts (id, party_id, channel, message, status, created_at)
         VALUES (?, ?, 'sms', ?, 'sent', ?)`,
        uuid(),
        id,
        `Terai Kitchen: your table for ${party.size} is ready. Please see the host stand within 10 minutes.`,
        stampMinutesAgo(Math.max(1, party.minutesAgo - 8)),
      );
    }
    if (party.status === "seated" && table) {
      run(`UPDATE tables SET status = 'ordered', guests = ?, seated_at = ? WHERE id = ?`, party.size, stampMinutesAgo(10), table.id);
    }
  }

  const base = today();
  interface ReservationSeed {
    name: string;
    phone: string;
    size: number;
    day: number;
    time: string;
    status: string;
    table: string;
    source: string;
    notes: string;
  }
  const reservations: ReservationSeed[] = [
    { name: "Amit & Roshni (anniversary)", phone: "+977 984 118 2200", size: 2, day: 0, time: "19:30", status: "confirmed", table: "B2", source: "phone", notes: "Cake to follow, candle on request" },
    { name: "Madhesh Trading dinner", phone: "+977 985 601 4477", size: 10, day: 0, time: "20:00", status: "confirmed", table: "P1", source: "email", notes: "Set menu, one veg guest" },
    { name: "Kavita Ranjan", phone: "+977 980 442 8899", size: 4, day: 0, time: "21:00", status: "cancelled", table: "", source: "phone", notes: "Cancelled — rescheduled" },
    { name: "Family lunch — Ansari", phone: "+977 981 909 3344", size: 6, day: 1, time: "13:00", status: "confirmed", table: "M8", source: "phone", notes: "" },
    { name: "Rotary Club meet", phone: "+977 985 220 7788", size: 14, day: 2, time: "18:30", status: "confirmed", table: "P1", source: "email", notes: "Needs projector" },
    { name: "Suman Verma", phone: "+977 984 700 1234", size: 2, day: -1, time: "20:00", status: "seated", table: "M1", source: "phone", notes: "" },
  ];
  for (const reservation of reservations) {
    const date = shiftDate(base, reservation.day);
    const table = reservation.table ? tableByLabel(tables, reservation.table) : undefined;
    run(
      `INSERT INTO reservations (id, guest_name, phone, party_size, reservation_at, status, table_id, source, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uuid(),
      reservation.name,
      reservation.phone,
      reservation.size,
      atClock(date, reservation.time),
      reservation.status,
      table?.id ?? null,
      reservation.source,
      reservation.notes,
      stampMinutesAgo(rnd.int(200, 3000)),
    );
  }
}

/** This week's published schedule, availability, plus pending swap requests. */
export function seedScheduling(staff: Map<string, StaffRef>, rnd: Random): void {
  const monday = shiftDate(today(), -((zoned().weekday + 6) % 7));
  const patterns: Record<string, { days: number[]; start: string; end: string; station: string }> = {
    "Rajesh Kumar Sah": { days: [1, 2, 3, 4, 5], start: "10:00", end: "19:00", station: "Office" },
    "Sunita Devi Yadav": { days: [3, 4, 5, 6, 0], start: "14:00", end: "23:00", station: "Floor" },
    "Anil Prasad Gupta": { days: [0, 1, 2, 4, 5, 6], start: "11:00", end: "20:00", station: "Main dining" },
    "Pooja Kumari Singh": { days: [0, 2, 3, 5, 6], start: "12:00", end: "21:30", station: "Terrace" },
    "Mohammad Irfan Ansari": { days: [1, 2, 3, 4, 6], start: "16:00", end: "23:30", station: "Main dining" },
    "Bikash Chaudhary": { days: [0, 1, 3, 4, 5], start: "10:00", end: "18:00", station: "Register" },
    "Sita Ram Mishra": { days: [0, 1, 2, 3, 5, 6], start: "09:00", end: "18:00", station: "Grill" },
    "Deepak Thakur": { days: [0, 2, 3, 4, 5, 6], start: "13:00", end: "22:30", station: "Fry / wok" },
    "Kiran Patel": { days: [1, 2, 4, 5, 6], start: "15:00", end: "23:00", station: "Expo" },
    "Nisha Khatun": { days: [0, 1, 4, 5, 6], start: "16:00", end: "23:30", station: "Bar" },
    "Aarati Sharma": { days: [0, 1, 2, 5, 6], start: "11:00", end: "19:00", station: "Host stand" },
  };

  const shiftIds: string[] = [];
  // Upcoming (not yet worked) shifts per employee — swap requests must target a
  // shift the requester actually owns.
  const futureByEmployee = new Map<string, string[]>();
  for (const [name, pattern] of Object.entries(patterns)) {
    const member = staff.get(name);
    if (!member) continue;
    for (let offset = 0; offset < 7; offset += 1) {
      const date = shiftDate(monday, offset);
      if (!pattern.days.includes(new Date(`${date}T00:00:00Z`).getUTCDay())) continue;
      const id = uuid();
      const past = date < today();
      run(
        `INSERT INTO shifts (id, employee_id, starts_at, ends_at, break_minutes, note, station, status, created_at)
         VALUES (?, ?, ?, ?, 45, '', ?, ?, ?)`,
        id,
        member.id,
        atClock(date, pattern.start),
        atClock(date, pattern.end),
        pattern.station,
        past ? "completed" : "published",
        stampMinutesAgo(rnd.int(2000, 6000)),
      );
      if (!past) {
        shiftIds.push(id);
        const bucket = futureByEmployee.get(member.id) ?? [];
        bucket.push(id);
        futureByEmployee.set(member.id, bucket);
      }
    }

    // Availability windows + one blocked day per person.
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const unavailable = pattern.days.includes(weekday) ? 0 : 1;
      run(
        `INSERT INTO availability (id, employee_id, weekday, starts, ends, unavailable)
         VALUES (?, ?, ?, ?, ?, ?)`,
        uuid(),
        member.id,
        weekday,
        pattern.start,
        pattern.end,
        unavailable,
      );
    }
  }

  // Two swap requests for the manager to approve.
  const swapPairs: [string, string, string][] = [
    ["Anil Prasad Gupta", "Mohammad Irfan Ansari", "Family function in Janakpur"],
    ["Nisha Khatun", "Pooja Kumari Singh", "Feeling unwell, can work Sunday instead"],
  ];
  for (const [from, to, reason] of swapPairs) {
    const requester = staff.get(from);
    const recipient = staff.get(to);
    if (!requester || !recipient) continue;
    const owned = futureByEmployee.get(requester.id) ?? [];
    if (!owned.length) continue;
    const shiftId = owned[rnd.int(0, owned.length - 1)];
    run(
      `INSERT INTO shift_swaps (id, shift_id, requested_by, requested_to, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      uuid(),
      shiftId,
      requester.id,
      recipient.id,
      reason,
      stampMinutesAgo(rnd.int(60, 900)),
    );
  }
}

/** Waste entries, reconciliation counts and a sample of ledger movements. */
export function seedInventoryOps(inventory: Map<string, StockRef>, staff: Map<string, StaffRef>, rnd: Random): void {
  const wasteEntries: [string, number, string, string, string, number][] = [
    ["Chicken breast", 1.4, "spoiled", "Freezer A door left open overnight", "Sita Ram Mishra", 26],
    ["Tomatoes", 2.2, "spoiled", "Bruised on delivery, rejected at goods-in", "Rajesh Kumar Sah", 50],
    ["Full cream milk", 1.0, "expired", "Use-by passed during slow Tuesday service", "Nisha Khatun", 74],
    ["Brioche burger buns", 6, "stale", "Bakery delivery short-dated", "Deepak Thakur", 98],
    ["Mozzarella", 0.4, "dropped", "Tray dropped on the line", "Kiran Patel", 122],
    ["Basmati rice", 0.9, "overcook", "Biryani batch scorched, remade", "Sita Ram Mishra", 146],
    ["Paneer", 0.5, "spoiled", "Delivered warm, discarded", "Sunita Devi Yadav", 170],
    ["Potatoes", 3.1, "spoiled", "Sprouted stock from the cool room", "Deepak Thakur", 194],
    ["Nepal lager 330ml", 2, "expired", "Bottles past best-before during stock take", "Nisha Khatun", 218],
    ["Dark chocolate", 0.2, "other", "Used for staff tasting / QC", "Kiran Patel", 242],
  ];

  for (const [name, quantity, reason, notes, actor, minutesAgo] of wasteEntries) {
    const item = inventory.get(name);
    if (!item) continue;
    const stamp = stampMinutesAgo(minutesAgo);
    run(
      `INSERT INTO waste_log (id, inventory_item_id, quantity, reason, notes, logged_by, created_at, business_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      uuid(),
      item.id,
      quantity,
      reason,
      notes,
      actor,
      stamp,
      stamp.slice(0, 10),
    );
    run(
      `INSERT INTO inventory_transactions (id, inventory_item_id, delta, reason, reference_id, actor, created_at, business_date)
       VALUES (?, ?, ?, 'waste', NULL, ?, ?, ?)`,
      uuid(),
      item.id,
      -quantity,
      actor,
      stamp,
      stamp.slice(0, 10),
    );
  }

  // Aggregate daily "sale" movements so the ledger has a realistic trail.
  const movers = ["Chicken breast", "Basmati rice", "Potatoes", "Flour (maida)", "Full cream milk", "Cooking oil"];
  for (let daysAgo = 13; daysAgo >= 1; daysAgo -= 1) {
    const date = shiftDate(today(), -daysAgo);
    for (const name of movers) {
      const item = inventory.get(name);
      if (!item) continue;
      const delta = -Math.round(rnd.float(4, 16, 2) * 100) / 100;
      run(
        `INSERT INTO inventory_transactions (id, inventory_item_id, delta, reason, reference_id, actor, created_at, business_date)
         VALUES (?, ?, ?, 'sale', 'daily-aggregate', 'system', ?, ?)`,
        uuid(),
        item.id,
        delta,
        atClock(date, "23:30"),
        date,
      );
    }
  }

  // Reconciliation counts: yesterday's stock take.
  const countDate = shiftDate(today(), -1);
  const counted: [string, number, number][] = [
    ["Chicken breast", 18.5, 17.9],
    ["Basmati rice", 55, 54.2],
    ["Cooking oil", 31, 30.4],
    ["Eggs", 96, 94],
    ["Mozzarella", 6.5, 6.5],
    ["Brioche burger buns", 22, 20],
    ["Nepal lager 330ml", 48, 47],
    ["Blended whisky", 4.2, 4.05],
  ];
  for (const [name, expected, actual] of counted) {
    const item = inventory.get(name);
    if (!item) continue;
    run(
      `INSERT INTO inventory_counts (id, inventory_item_id, expected, counted, variance, counted_by, applied, created_at, business_date)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      uuid(),
      item.id,
      expected,
      actual,
      Math.round((actual - expected) * 100) / 100,
      staff.get("Sunita Devi Yadav")?.name ?? "Manager",
      atClock(countDate, "23:45"),
      countDate,
    );
  }
}

/** Purchase orders across the whole draft → approved → sent → received pipeline. */
export function seedPurchasing(vendors: Map<string, string>, inventory: Map<string, StockRef>, rnd: Random): void {
  const vendorByStockName = (name: string): string | null => {
    const item = inventory.get(name);
    if (!item) return null;
    const row = get<{ vendor_id: string | null }>("SELECT vendor_id FROM inventory_items WHERE id = ?", item.id);
    return row?.vendor_id ?? null;
  };

  let poSequence = 1040;
  const makePo = (
    vendorId: string,
    status: string,
    daysAgo: number,
    lines: [string, number, number][],
    expectedOffset = 2,
  ): string => {
    poSequence += 1;
    const id = uuid();
    const createdAt = atClock(shiftDate(today(), -daysAgo), "09:15");
    const total = lines.reduce((sum, [, packs, unitPrice]) => sum + packs * unitPrice, 0);
    run(
      `INSERT INTO purchase_orders (id, po_number, vendor_id, status, expected_date, notes, total, created_at, approved_at, sent_at, received_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
      id,
      `PO-${poSequence}`,
      vendorId,
      status,
      shiftDate(today(), expectedOffset),
      Math.round(total),
      createdAt,
      status === "draft" ? null : atClock(shiftDate(today(), -daysAgo), "11:40"),
      status === "draft" || status === "approved" ? null : atClock(shiftDate(today(), -daysAgo), "12:05"),
      status === "received" ? atClock(shiftDate(today(), -daysAgo + expectedOffset), "08:20") : null,
    );
    for (const [name, packs, unitPrice] of lines) {
      const item = inventory.get(name);
      if (!item) continue;
      run(
        `INSERT INTO po_items (id, po_id, inventory_item_id, quantity_packs, unit_price) VALUES (?, ?, ?, ?, ?)`,
        uuid(),
        id,
        item.id,
        packs,
        Math.round(unitPrice),
      );
    }
    return id;
  };

  const meat = vendors.get("v-meat");
  const produce = vendors.get("v-produce");
  const dairy = vendors.get("v-dairy");
  const dry = vendors.get("v-dry");
  const beverage = vendors.get("v-bev");

  if (meat) {
    const draft = makePo(meat, "draft", 0, [
      ["Chicken breast", 2, 4650000],
      ["Chicken leg quarters", 2, 3650000],
      ["Mutton (bone-in)", 1, 7100000],
    ], 1);
    void draft;
    const approved = makePo(meat, "approved", 1, [["Ground beef", 2, 4450000]], 1);
    run(
      `INSERT INTO po_transmissions (id, po_id, channel, destination, status, attempts, reference, payload, created_at)
       VALUES (?, ?, 'pdf_email', 'sales@nepalcoldstorage.np', 'queued', 0, '', 'PO document queued for email dispatch', ?)`,
      uuid(),
      approved,
      atClock(today(), "09:30"),
    );
    const received = makePo(meat, "received", 5, [["Chicken breast", 3, 4650000]], -3);
    run(
      `INSERT INTO po_transmissions (id, po_id, channel, destination, status, attempts, reference, payload, created_at)
       VALUES (?, ?, 'edi_sftp', 'sftp://edi.nepalcoldstorage.np/inbox', 'sent', 1, 'EDI-850-4471', 'ISA/GS/ST 850 envelope transmitted', ?)`,
      uuid(),
      received,
      atClock(shiftDate(today(), -5), "12:10"),
    );
  }

  if (produce) {
    makePo(produce, "sent", 2, [
      ["Potatoes", 2, 118000],
      ["Onions", 2, 128000],
      ["Tomatoes", 1, 105000],
      ["Eggs", 1, 270000],
      ["Brioche burger buns", 3, 78000],
    ], 0);
    makePo(produce, "received", 8, [["Lemons", 1, 84000], ["Cabbage", 1, 48000]], -6);
  }

  if (dairy) {
    makePo(dairy, "draft", 0, [
      ["Paneer", 1, 375000],
      ["Mozzarella", 1, 550000],
      ["Full cream milk", 2, 178000],
      ["Vanilla ice cream", 1, 295000],
    ], 2);
  }

  if (dry) {
    makePo(dry, "sent", 3, [["House masala mix", 2, 118000], ["Flour (maida)", 1, 205000], ["Pizza bases 10in", 2, 148000]], 1);
  }

  if (beverage) {
    makePo(beverage, "received", 10, [["Nepal lager 330ml", 4, 640000], ["Cola 330ml", 3, 138000]], -8);
  }

  void vendorByStockName;
  void rnd;
}

/** Convenience export used by the Z-report screen's "most recent closed day". */
export function latestClosedBusinessDate(): string | null {
  const row = get<{ business_date: string }>(
    "SELECT business_date FROM business_days WHERE status = 'closed' ORDER BY business_date DESC LIMIT 1",
  );
  return row?.business_date ?? null;
}

export function weekdayLabels(from: string): { date: string; label: string }[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(from, index);
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return { date, label: weekdayName(day).slice(0, 3) };
  });
}
