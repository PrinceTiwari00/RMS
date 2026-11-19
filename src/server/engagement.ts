/**
 * Guest engagement, table sessions, service requests, loyalty, quiz, receipts, and reviews.
 */
import { all, get, run, tx, uuid } from "@/db/client";
import { badRequest, notFound } from "@/server/router";
import { audit } from "@/server/audit";
import { emitEvent } from "@/server/events";
import { getSettings } from "@/server/settings";
import { nowStamp } from "@/domain/time";
import { formatMoney } from "@/domain/money";
import type {
  GuestReviewInfo,
  LoyaltyAccountInfo,
  OrderSnapshot,
  QuizMatchView,
  QuizQuestionView,
  ServiceRequestInfo,
  ServiceRequestType,
  SessionUser,
  TableGuest,
  TableSessionInfo,
} from "@/types";

const GUEST_COLORS = ["#e85a2a", "#3d6ea8", "#0f6f66", "#8a5aa8", "#c98a1e", "#bd594b"];

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "G"
  );
}

function secondsSince(stamp: string): number {
  const iso = stamp.includes("T") ? stamp : `${stamp.replace(" ", "T")}Z`;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

// ---------------------------------------------------------------- Table Sessions
export function getActiveSession(tableId: string): TableSessionInfo | null {
  const session = get<{
    id: string;
    table_id: string;
    qr_token: string | null;
    status: string;
    opened_at: string;
    closed_at: string | null;
    table_label: string | null;
  }>(
    `SELECT ts.*, t.label AS table_label
       FROM table_sessions ts
       LEFT JOIN tables t ON t.id = ts.table_id
      WHERE ts.table_id = ? AND ts.status = 'active'
      ORDER BY ts.opened_at DESC LIMIT 1`,
    tableId,
  );
  if (!session) return null;
  const guests = all<{
    id: string;
    session_id: string;
    name: string;
    initials: string;
    color: string;
    loyalty_account_id: string | null;
    joined_at: string;
    last_seen_at: string;
  }>("SELECT * FROM table_guests WHERE session_id = ? ORDER BY joined_at ASC", session.id);

  return {
    id: session.id,
    tableId: session.table_id,
    tableLabel: session.table_label ?? "Table",
    qrToken: session.qr_token,
    status: session.status as "active" | "closed",
    openedAt: session.opened_at,
    closedAt: session.closed_at,
    guests: guests.map(mapGuest),
  };
}

function mapGuest(row: {
  id: string;
  session_id: string;
  name: string;
  initials: string;
  color: string;
  loyalty_account_id: string | null;
  joined_at: string;
  last_seen_at: string;
}): TableGuest {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    initials: row.initials,
    color: row.color,
    loyaltyAccountId: row.loyalty_account_id,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function ensureActiveSession(tableId: string, qrToken: string | null): TableSessionInfo {
  const existing = getActiveSession(tableId);
  if (existing) return existing;
  const id = uuid();
  const stamp = nowStamp();
  run(
    "INSERT INTO table_sessions (id, table_id, qr_token, status, opened_at) VALUES (?, ?, ?, 'active', ?)",
    id,
    tableId,
    qrToken,
    stamp,
  );
  return getActiveSession(tableId)!;
}

export function joinTableGuest(
  tableId: string,
  qrToken: string | null,
  input: { name: string; guestId?: string | null },
): { session: TableSessionInfo; guest: TableGuest } {
  const cleanName = String(input.name ?? "").trim().slice(0, 40);
  if (!cleanName) throw badRequest("Enter your name to join the table");
  const session = ensureActiveSession(tableId, qrToken);
  const stamp = nowStamp();

  const existingById = input.guestId
    ? session.guests.find((guest) => guest.id === input.guestId)
    : undefined;
  const existingByName = !existingById
    ? session.guests.find((guest) => guest.name.toLowerCase() === cleanName.toLowerCase())
    : undefined;

  const target = existingById ?? existingByName;
  if (target) {
    run(
      "UPDATE table_guests SET name = ?, initials = ?, last_seen_at = ? WHERE id = ?",
      cleanName,
      initialsOf(cleanName),
      stamp,
      target.id,
    );
    const updated = getActiveSession(tableId)!;
    emitEvent("session.updated", { tableId, sessionId: updated.id });
    return { session: updated, guest: updated.guests.find((g) => g.id === target.id)! };
  }

  const guestId = uuid();
  const color = GUEST_COLORS[session.guests.length % GUEST_COLORS.length];
  run(
    `INSERT INTO table_guests (id, session_id, name, initials, color, joined_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    guestId,
    session.id,
    cleanName,
    initialsOf(cleanName),
    color,
    stamp,
    stamp,
  );
  const updated = getActiveSession(tableId)!;
  emitEvent("session.updated", { tableId, sessionId: updated.id });
  return { session: updated, guest: updated.guests.find((g) => g.id === guestId)! };
}

export function closeTableSession(tableId: string): void {
  const stamp = nowStamp();
  run("UPDATE table_sessions SET status = 'closed', closed_at = ? WHERE table_id = ? AND status = 'active'", stamp, tableId);
  run("UPDATE service_requests SET status = 'resolved', resolved_at = COALESCE(resolved_at, ?) WHERE table_id = ? AND status != 'resolved'", stamp, tableId);
  emitEvent("session.updated", { tableId });
}

// ---------------------------------------------------------------- Service Requests
interface ServiceRequestRow {
  id: string;
  table_id: string;
  table_label: string | null;
  session_id: string | null;
  guest_id: string | null;
  guest_name: string;
  request_type: string;
  note: string;
  status: string;
  assigned_waiter_id: string | null;
  assigned_waiter_name: string | null;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

const REQUEST_SELECT = `
  SELECT sr.*, t.label AS table_label, e.name AS assigned_waiter_name
    FROM service_requests sr
    LEFT JOIN tables t ON t.id = sr.table_id
    LEFT JOIN employees e ON e.id = sr.assigned_waiter_id`;

function mapServiceRequest(row: ServiceRequestRow): ServiceRequestInfo {
  return {
    id: row.id,
    tableId: row.table_id,
    tableLabel: row.table_label ?? "Table",
    sessionId: row.session_id,
    guestId: row.guest_id,
    guestName: row.guest_name,
    requestType: row.request_type as ServiceRequestType,
    note: row.note,
    status: row.status as ServiceRequestInfo["status"],
    assignedWaiterId: row.assigned_waiter_id,
    assignedWaiterName: row.assigned_waiter_name ?? "On-duty waiter",
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    elapsedSeconds: secondsSince(row.created_at),
  };
}

export function getActiveServiceRequests(): ServiceRequestInfo[] {
  return all<ServiceRequestRow>(
    `${REQUEST_SELECT} WHERE sr.status IN ('open','acknowledged') ORDER BY sr.created_at ASC`,
  ).map(mapServiceRequest);
}

export function getTableServiceRequests(tableId: string): ServiceRequestInfo[] {
  return all<ServiceRequestRow>(
    `${REQUEST_SELECT} WHERE sr.table_id = ? AND sr.status IN ('open','acknowledged') ORDER BY sr.created_at DESC`,
    tableId,
  ).map(mapServiceRequest);
}

const VALID_REQUEST_TYPES: ServiceRequestType[] = ["call_waiter", "water", "napkins", "bill", "cutlery", "other"];

export function createServiceRequest(input: {
  tableId: string;
  sessionId?: string | null;
  guestId?: string | null;
  guestName?: string;
  requestType?: string;
  note?: string;
}): ServiceRequestInfo {
  const table = get<{ id: string; label: string; server_id: string | null; status: string }>(
    "SELECT id, label, server_id, status FROM tables WHERE id = ?",
    input.tableId,
  );
  if (!table) throw notFound("Table not found");

  const requestType: ServiceRequestType = VALID_REQUEST_TYPES.includes(input.requestType as ServiceRequestType)
    ? (input.requestType as ServiceRequestType)
    : "call_waiter";

  // Pick assigned server or an active floor server.
  let waiterId = table.server_id;
  if (!waiterId) {
    const fallback = get<{ id: string }>(
      `SELECT e.id FROM employees e
         LEFT JOIN roles r ON r.id = e.role_id
        WHERE e.is_active = 1 AND r.name IN ('server','manager','host')
        ORDER BY CASE WHEN r.name = 'server' THEN 0 ELSE 1 END, e.name LIMIT 1`,
    );
    waiterId = fallback?.id ?? null;
  }

  const id = uuid();
  const stamp = nowStamp();
  tx(() => {
    run(
      `INSERT INTO service_requests (id, table_id, session_id, guest_id, guest_name, request_type, note, status, assigned_waiter_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      id,
      table.id,
      input.sessionId ?? null,
      input.guestId ?? null,
      String(input.guestName ?? "").trim().slice(0, 60),
      requestType,
      String(input.note ?? "").trim().slice(0, 200),
      waiterId,
      stamp,
    );
    if (requestType === "bill" && table.status === "ordered") {
      run("UPDATE tables SET status = 'billed' WHERE id = ?", table.id);
    }
  });

  const created = mapServiceRequest(get<ServiceRequestRow>(`${REQUEST_SELECT} WHERE sr.id = ?`, id)!);
  emitEvent("service_request.created", { tableId: table.id, sessionId: input.sessionId ?? null });
  emitEvent("floor.updated", { tableId: table.id });
  return created;
}

export function acknowledgeServiceRequest(id: string, actor: SessionUser | null): ServiceRequestInfo {
  const existing = get<ServiceRequestRow>(`${REQUEST_SELECT} WHERE sr.id = ?`, id);
  if (!existing) throw notFound("Service request not found");
  const stamp = nowStamp();
  run(
    "UPDATE service_requests SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, ?), assigned_waiter_id = COALESCE(assigned_waiter_id, ?) WHERE id = ?",
    stamp,
    actor?.id ?? null,
    id,
  );
  const updated = mapServiceRequest(get<ServiceRequestRow>(`${REQUEST_SELECT} WHERE sr.id = ?`, id)!);
  emitEvent("service_request.updated", { tableId: updated.tableId });
  emitEvent("floor.updated", { tableId: updated.tableId });
  return updated;
}

export function resolveServiceRequest(id: string, actor: SessionUser | null): ServiceRequestInfo {
  const existing = get<ServiceRequestRow>(`${REQUEST_SELECT} WHERE sr.id = ?`, id);
  if (!existing) throw notFound("Service request not found");
  const stamp = nowStamp();
  run(
    "UPDATE service_requests SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?",
    stamp,
    actor?.id ?? null,
    id,
  );
  audit(actor, "floor.help.resolve", "service_request", id, `${existing.table_label ?? ""} · ${existing.request_type}`);
  const updated = mapServiceRequest(get<ServiceRequestRow>(`${REQUEST_SELECT} WHERE sr.id = ?`, id)!);
  emitEvent("service_request.updated", { tableId: updated.tableId });
  emitEvent("floor.updated", { tableId: updated.tableId });
  return updated;
}

// ---------------------------------------------------------------- Loyalty
function formatLoyalty(row: {
  id: string;
  phone: string;
  email: string;
  name: string;
  points: number;
  lifetime_points: number;
}): LoyaltyAccountInfo {
  const settings = getSettings();
  return {
    id: row.id,
    phone: row.phone,
    email: row.email,
    name: row.name,
    points: row.points,
    lifetimePoints: row.lifetime_points,
    rewardName: settings.loyaltyRewardName,
    rewardPoints: settings.loyaltyRewardPoints,
  };
}

export function lookupOrLinkLoyalty(input: {
  phone?: string;
  email?: string;
  name?: string;
  guestId?: string | null;
}): LoyaltyAccountInfo {
  const phone = String(input.phone ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase();
  const name = String(input.name ?? "").trim();
  if (!phone && !email) throw badRequest("Enter a phone number or email address");

  let row = phone
    ? get<{ id: string; phone: string; email: string; name: string; points: number; lifetime_points: number }>(
        "SELECT * FROM loyalty_accounts WHERE phone = ? LIMIT 1",
        phone,
      )
    : undefined;
  if (!row && email) {
    row = get<{ id: string; phone: string; email: string; name: string; points: number; lifetime_points: number }>(
      "SELECT * FROM loyalty_accounts WHERE LOWER(email) = ? LIMIT 1",
      email,
    );
  }

  const stamp = nowStamp();
  if (!row) {
    const id = uuid();
    run(
      `INSERT INTO loyalty_accounts (id, phone, email, name, points, lifetime_points, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
      id,
      phone,
      email,
      name || "Guest",
      stamp,
      stamp,
    );
    row = get("SELECT * FROM loyalty_accounts WHERE id = ?", id)!;
  } else if (name && !row.name) {
    run("UPDATE loyalty_accounts SET name = ?, updated_at = ? WHERE id = ?", name, stamp, row.id);
    row.name = name;
  }

  if (input.guestId) {
    run("UPDATE table_guests SET loyalty_account_id = ? WHERE id = ?", row.id, input.guestId);
  }
  return formatLoyalty(row);
}

export function getLoyaltyAccount(id: string): LoyaltyAccountInfo | null {
  const row = get<{ id: string; phone: string; email: string; name: string; points: number; lifetime_points: number }>(
    "SELECT * FROM loyalty_accounts WHERE id = ?",
    id,
  );
  return row ? formatLoyalty(row) : null;
}

export function awardPointsForOrder(orderId: string, paidPaisa: number, guestId?: string | null): number {
  const settings = getSettings();
  const points = Math.max(0, Math.floor((paidPaisa / 10000) * settings.loyaltyPointsPer100));
  if (!points) return 0;

  let accountId: string | null = null;
  if (guestId) {
    accountId =
      get<{ loyalty_account_id: string | null }>("SELECT loyalty_account_id FROM table_guests WHERE id = ?", guestId)
        ?.loyalty_account_id ?? null;
  }
  if (!accountId) {
    const order = get<{ session_id: string | null }>("SELECT session_id FROM orders WHERE id = ?", orderId);
    if (order?.session_id) {
      accountId =
        get<{ loyalty_account_id: string | null }>(
          "SELECT loyalty_account_id FROM table_guests WHERE session_id = ? AND loyalty_account_id IS NOT NULL LIMIT 1",
          order.session_id,
        )?.loyalty_account_id ?? null;
    }
  }
  if (!accountId) return points;

  const already = get<{ id: string }>(
    "SELECT id FROM loyalty_ledger WHERE order_id = ? AND points_delta > 0 LIMIT 1",
    orderId,
  );
  if (already) return points;

  const stamp = nowStamp();
  tx(() => {
    run(
      "UPDATE loyalty_accounts SET points = points + ?, lifetime_points = lifetime_points + ?, updated_at = ? WHERE id = ?",
      points,
      points,
      stamp,
      accountId,
    );
    run(
      "INSERT INTO loyalty_ledger (id, account_id, order_id, points_delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      uuid(),
      accountId,
      orderId,
      points,
      "Meal order earned points",
      stamp,
    );
  });
  return points;
}

export function redeemLoyaltyReward(accountId: string): LoyaltyAccountInfo {
  const settings = getSettings();
  const row = get<{ id: string; phone: string; email: string; name: string; points: number; lifetime_points: number }>(
    "SELECT * FROM loyalty_accounts WHERE id = ?",
    accountId,
  );
  if (!row) throw notFound("Loyalty account not found");
  if (row.points < settings.loyaltyRewardPoints) {
    throw badRequest(`Need ${settings.loyaltyRewardPoints - row.points} more points to unlock ${settings.loyaltyRewardName}`);
  }
  const stamp = nowStamp();
  tx(() => {
    run("UPDATE loyalty_accounts SET points = points - ?, updated_at = ? WHERE id = ?", settings.loyaltyRewardPoints, stamp, accountId);
    run(
      "INSERT INTO loyalty_ledger (id, account_id, order_id, points_delta, reason, created_at) VALUES (?, ?, NULL, ?, ?, ?)",
      uuid(),
      accountId,
      -settings.loyaltyRewardPoints,
      `Redeemed: ${settings.loyaltyRewardName}`,
      stamp,
    );
  });
  return getLoyaltyAccount(accountId)!;
}

// ---------------------------------------------------------------- Reviews & Receipts
export function getReviewForOrder(orderId: string): GuestReviewInfo | null {
  const row = get<{
    id: string;
    order_id: string | null;
    table_id: string | null;
    table_label: string | null;
    guest_name: string;
    rating: number;
    tags: string;
    comment: string;
    created_at: string;
  }>(
    `SELECT gr.*, t.label AS table_label
       FROM guest_reviews gr
       LEFT JOIN tables t ON t.id = gr.table_id
      WHERE gr.order_id = ? LIMIT 1`,
    orderId,
  );
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    tableId: row.table_id,
    tableLabel: row.table_label ?? "Table",
    guestName: row.guest_name,
    rating: row.rating,
    tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
    comment: row.comment,
    createdAt: row.created_at,
  };
}

export function getRecentReviews(limit = 12): { avgRating: number; count: number; reviews: GuestReviewInfo[] } {
  const stats = get<{ avg_rating: number | null; count: number }>(
    "SELECT AVG(rating) AS avg_rating, COUNT(*) AS count FROM guest_reviews",
  );
  const rows = all<{
    id: string;
    order_id: string | null;
    table_id: string | null;
    table_label: string | null;
    guest_name: string;
    rating: number;
    tags: string;
    comment: string;
    created_at: string;
  }>(
    `SELECT gr.*, t.label AS table_label
       FROM guest_reviews gr
       LEFT JOIN tables t ON t.id = gr.table_id
      ORDER BY gr.created_at DESC LIMIT ?`,
    limit,
  );
  return {
    avgRating: stats?.avg_rating ? Math.round(Number(stats.avg_rating) * 10) / 10 : 0,
    count: Number(stats?.count ?? 0),
    reviews: rows.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      tableId: row.table_id,
      tableLabel: row.table_label ?? "Table",
      guestName: row.guest_name,
      rating: row.rating,
      tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
      comment: row.comment,
      createdAt: row.created_at,
    })),
  };
}

export function submitGuestReview(input: {
  orderId: string;
  sessionId?: string | null;
  tableId?: string | null;
  guestName?: string;
  rating: number;
  tags?: string[];
  comment?: string;
}): GuestReviewInfo {
  const rating = Math.round(Number(input.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw badRequest("Rating must be between 1 and 5 stars");
  }
  const existing = getReviewForOrder(input.orderId);
  const stamp = nowStamp();
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 6).join(",");
  if (existing) {
    run(
      "UPDATE guest_reviews SET rating = ?, tags = ?, comment = ?, guest_name = ? WHERE id = ?",
      rating,
      tags,
      String(input.comment ?? "").trim().slice(0, 400),
      String(input.guestName ?? existing.guestName).trim().slice(0, 60),
      existing.id,
    );
    emitEvent("review.created", { orderId: input.orderId, tableId: input.tableId ?? null });
    return getReviewForOrder(input.orderId)!;
  }

  const id = uuid();
  run(
    `INSERT INTO guest_reviews (id, order_id, session_id, table_id, guest_name, rating, tags, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.orderId,
    input.sessionId ?? null,
    input.tableId ?? null,
    String(input.guestName ?? "Guest").trim().slice(0, 60),
    rating,
    tags,
    String(input.comment ?? "").trim().slice(0, 400),
    stamp,
  );
  emitEvent("review.created", { orderId: input.orderId, tableId: input.tableId ?? null });
  return getReviewForOrder(input.orderId)!;
}

export function dispatchEmailReceipt(
  order: OrderSnapshot,
  recipientEmail: string,
  demoMode: boolean,
): { id: string; recipientEmail: string; status: string; subject: string } {
  const cleanEmail = String(recipientEmail ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw badRequest("Enter a valid email address for the digital receipt");
  }
  const settings = getSettings();
  const subject = `${settings.restaurantName} · Digital Receipt #${order.checkNumber ?? "—"} (PAID)`;
  const itemsHtml = order.activeItems
    .map(
      (line) =>
        `<tr><td style="padding:6px 0">${line.quantity} × ${escapeHtml(line.name)}</td><td style="text-align:right;padding:6px 0">${escapeHtml(formatMoney(line.lineTotal))}</td></tr>`,
    )
    .join("");
  const htmlBody = `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e0dbd4;border-radius:12px">
      <h2 style="margin:0 0 4px">${escapeHtml(settings.restaurantName)}</h2>
      <p style="margin:0 0 16px;color:#555;font-size:13px">${escapeHtml(order.tableLabel)} · Check #${order.checkNumber ?? "—"} · <strong>PAID</strong></p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">${itemsHtml}</table>
      <hr style="border:none;border-top:1px solid #e0dbd4;margin:12px 0" />
      <p style="display:flex;justify-content:space-between;font-weight:700;font-size:16px;margin:0">
        <span>Total Paid</span><span>${escapeHtml(formatMoney(order.grandTotal))}</span>
      </p>
      <p style="margin:16px 0 0;font-size:12px;color:#777">${escapeHtml(settings.receiptFooter)}</p>
    </div>`.trim();

  const id = uuid();
  const status = demoMode ? "demo" : "sent";
  run(
    `INSERT INTO email_receipts (id, order_id, recipient_email, subject, html_body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    order.id,
    cleanEmail,
    subject,
    htmlBody,
    status,
    nowStamp(),
  );
  return { id, recipientEmail: cleanEmail, status, subject };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------- Spice Quiz Game
interface QuizItem {
  id: string;
  category: string;
  question: string;
  options: string[];
  correctIndex: number;
}

const QUIZ_BANK: QuizItem[] = [
  { id: "q1", category: "Spices", question: "Which spice gives butter chicken & tandoori dishes their vibrant golden-red warmth?", options: ["Cardamom", "Kashmiri Chilli", "Clove", "Fennel"], correctIndex: 1 },
  { id: "q2", category: "Himalayan", question: "What is the traditional Nepali dipping sauce served with steamed momos?", options: ["Achar", "Raita", "Chutney", "Sambar"], correctIndex: 0 },
  { id: "q3", category: "Spices", question: "Which spice is famously called the 'Queen of Spices'?", options: ["Cinnamon", "Black Pepper", "Cardamom", "Turmeric"], correctIndex: 2 },
  { id: "q4", category: "Kitchen", question: "At roughly what temperature does a charcoal clay tandoor oven bake naan?", options: ["180°C", "260°C", "480°C", "120°C"], correctIndex: 2 },
  { id: "q5", category: "Drinks", question: "What are the two main ingredients in a classic Mango Lassi?", options: ["Milk & Tea", "Yoghurt & Mango", "Coconut & Lime", "Cream & Rose"], correctIndex: 1 },
  { id: "q6", category: "Spices", question: "Which golden root gives curries their yellow hue and earthy aroma?", options: ["Saffron", "Turmeric", "Mustard", "Nutmeg"], correctIndex: 1 },
  { id: "q7", category: "Street Food", question: "What spice blend literally translates to 'hot spice mix' in South Asia?", options: ["Garam Masala", "Chaat Masala", "Panch Phoron", "Sambar Powder"], correctIndex: 0 },
  { id: "q8", category: "Himalayan", question: "In Nepali Thakali meals, which herb/spice is tempered in ghee to top dal?", options: ["Jimbu", "Oregano", "Sage", "Dill"], correctIndex: 0 },
  { id: "q9", category: "Tea", question: "What whole spice is crushed fresh into Nepali Masala Chiya for citrusy warmth?", options: ["Star Anise", "Green Cardamom", "Caraway", "Sumac"], correctIndex: 1 },
  { id: "q10", category: "Spices", question: "Which is the world's most expensive spice by weight?", options: ["Vanilla", "Cardamom", "Saffron", "Cinnamon"], correctIndex: 2 },
];

export function getQuizMatchView(matchId: string, viewerParticipantId?: string | null): QuizMatchView | null {
  const match = get<{
    id: string;
    mode: string;
    session_id: string | null;
    challenger_table_id: string | null;
    opponent_table_id: string | null;
    status: string;
    current_round: number;
    total_rounds: number;
    question_ids: string;
    challenger_label: string | null;
    opponent_label: string | null;
  }>(
    `SELECT qm.*, t1.label AS challenger_label, t2.label AS opponent_label
       FROM quiz_matches qm
       LEFT JOIN tables t1 ON t1.id = qm.challenger_table_id
       LEFT JOIN tables t2 ON t2.id = qm.opponent_table_id
      WHERE qm.id = ?`,
    matchId,
  );
  if (!match) return null;

  const qIds = JSON.parse(match.question_ids || "[]") as string[];
  const currentQId = qIds[match.current_round - 1];
  const rawQ = QUIZ_BANK.find((q) => q.id === currentQId) ?? QUIZ_BANK[0];

  const participants = all<{
    id: string;
    guest_id: string | null;
    table_id: string | null;
    table_label: string | null;
    display_name: string;
    avatar_color: string;
    score: number;
  }>(
    `SELECT qp.*, t.label AS table_label
       FROM quiz_participants qp
       LEFT JOIN tables t ON t.id = qp.table_id
      WHERE qp.match_id = ?
      ORDER BY qp.score DESC, qp.joined_at ASC`,
    match.id,
  );

  const answersThisRound = all<{ participant_id: string }>(
    "SELECT participant_id FROM quiz_answers WHERE match_id = ? AND round_number = ?",
    match.id,
    match.current_round,
  );
  const answeredSet = new Set(answersThisRound.map((a) => a.participant_id));
  const viewerAnswered = viewerParticipantId ? answeredSet.has(viewerParticipantId) : false;

  const question: QuizQuestionView | null =
    match.status === "finished"
      ? null
      : {
          id: rawQ.id,
          category: rawQ.category,
          question: rawQ.question,
          options: rawQ.options,
          correctIndex: viewerAnswered ? rawQ.correctIndex : undefined,
        };

  const tableMap = new Map<string, { tableId: string; tableLabel: string; score: number }>();
  for (const p of participants) {
    const tId = p.table_id ?? "table";
    const entry = tableMap.get(tId) ?? { tableId: tId, tableLabel: p.table_label ?? "Table", score: 0 };
    entry.score += p.score;
    tableMap.set(tId, entry);
  }

  return {
    id: match.id,
    mode: match.mode as QuizMatchView["mode"],
    status: match.status as QuizMatchView["status"],
    currentRound: match.current_round,
    totalRounds: match.total_rounds,
    challengerTableLabel: match.challenger_label ?? "Table",
    opponentTableLabel: match.opponent_label,
    question,
    participants: participants.map((p) => ({
      id: p.id,
      guestId: p.guest_id,
      tableId: p.table_id,
      tableLabel: p.table_label ?? "Table",
      displayName: p.display_name,
      avatarColor: p.avatar_color,
      score: p.score,
      answeredCurrentRound: answeredSet.has(p.id),
    })),
    tableScores: [...tableMap.values()].sort((a, b) => b.score - a.score),
  };
}

export function activeQuizForTable(tableId: string, sessionId: string | null): QuizMatchView | null {
  const row = get<{ id: string }>(
    `SELECT id FROM quiz_matches
      WHERE status != 'finished'
        AND (session_id = ? OR challenger_table_id = ? OR opponent_table_id = ?)
      ORDER BY created_at DESC LIMIT 1`,
    sessionId ?? "",
    tableId,
    tableId,
  );
  return row ? getQuizMatchView(row.id) : null;
}

export function startOrJoinQuiz(input: {
  mode: "in_table" | "table_vs_table";
  tableId: string;
  sessionId: string | null;
  guestId?: string | null;
  displayName: string;
  avatarColor?: string;
  opponentTableId?: string | null;
  forceNew?: boolean;
}): { match: QuizMatchView; participantId: string } {
  const stamp = nowStamp();
  let matchRow = !input.forceNew
    ? get<{ id: string }>(
        input.mode === "in_table"
          ? "SELECT id FROM quiz_matches WHERE mode = 'in_table' AND session_id = ? AND status != 'finished' ORDER BY created_at DESC LIMIT 1"
          : "SELECT id FROM quiz_matches WHERE mode = 'table_vs_table' AND status != 'finished' AND (challenger_table_id = ? OR opponent_table_id = ? OR opponent_table_id IS NULL) ORDER BY created_at DESC LIMIT 1",
        ...(input.mode === "in_table" ? [input.sessionId ?? ""] : [input.tableId, input.tableId]),
      )
    : undefined;

  let matchId = matchRow?.id;
  if (!matchId) {
    matchId = uuid();
    const shuffled = [...QUIZ_BANK].sort(() => Math.random() - 0.5).slice(0, 5).map((q) => q.id);
    // Find another active table if table_vs_table and no opponent explicitly chosen.
    let opponentId = input.opponentTableId ?? null;
    if (input.mode === "table_vs_table" && !opponentId) {
      const other = get<{ id: string }>(
        "SELECT id FROM tables WHERE id != ? AND status != 'available' ORDER BY sort_order LIMIT 1",
        input.tableId,
      ) ?? get<{ id: string }>("SELECT id FROM tables WHERE id != ? ORDER BY sort_order LIMIT 1", input.tableId);
      opponentId = other?.id ?? null;
    }
    run(
      `INSERT INTO quiz_matches (id, mode, session_id, challenger_table_id, opponent_table_id, status, current_round, total_rounds, question_ids, round_started_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', 1, 5, ?, ?, ?)`,
      matchId,
      input.mode,
      input.sessionId,
      input.tableId,
      opponentId,
      JSON.stringify(shuffled),
      stamp,
      stamp,
    );
  } else if (input.mode === "table_vs_table") {
    run(
      "UPDATE quiz_matches SET opponent_table_id = COALESCE(opponent_table_id, ?) WHERE id = ? AND challenger_table_id != ?",
      input.tableId,
      matchId,
      input.tableId,
    );
  }

  let participant = input.guestId
    ? get<{ id: string }>("SELECT id FROM quiz_participants WHERE match_id = ? AND guest_id = ?", matchId, input.guestId)
    : undefined;
  if (!participant) {
    participant = get<{ id: string }>(
      "SELECT id FROM quiz_participants WHERE match_id = ? AND table_id = ? AND LOWER(display_name) = LOWER(?)",
      matchId,
      input.tableId,
      input.displayName.trim(),
    );
  }

  let participantId = participant?.id;
  if (!participantId) {
    participantId = uuid();
    run(
      `INSERT INTO quiz_participants (id, match_id, guest_id, table_id, display_name, avatar_color, score, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      participantId,
      matchId,
      input.guestId ?? null,
      input.tableId,
      input.displayName.trim() || "Player",
      input.avatarColor ?? "#e85a2a",
      stamp,
    );
  }

  emitEvent("quiz.updated", { matchId, tableId: input.tableId, sessionId: input.sessionId });
  return { match: getQuizMatchView(matchId, participantId)!, participantId };
}

export function submitQuizAnswer(input: {
  matchId: string;
  participantId: string;
  roundNumber: number;
  selectedIndex: number;
}): { match: QuizMatchView; isCorrect: boolean; pointsEarned: number } {
  const match = get<{
    id: string;
    status: string;
    current_round: number;
    total_rounds: number;
    question_ids: string;
    challenger_table_id: string | null;
  }>("SELECT * FROM quiz_matches WHERE id = ?", input.matchId);
  if (!match) throw notFound("Quiz match not found");
  if (match.status === "finished") throw badRequest("This quiz has already finished");

  const qIds = JSON.parse(match.question_ids || "[]") as string[];
  const qId = qIds[input.roundNumber - 1];
  const question = QUIZ_BANK.find((q) => q.id === qId) ?? QUIZ_BANK[0];
  const isCorrect = Number(input.selectedIndex) === question.correctIndex;
  const pointsEarned = isCorrect ? 1 : 0;
  const stamp = nowStamp();

  const already = get<{ id: string; is_correct: number; points_earned: number }>(
    "SELECT id, is_correct, points_earned FROM quiz_answers WHERE match_id = ? AND round_number = ? AND participant_id = ?",
    input.matchId,
    input.roundNumber,
    input.participantId,
  );
  if (already) {
    return {
      match: getQuizMatchView(input.matchId, input.participantId)!,
      isCorrect: Boolean(already.is_correct),
      pointsEarned: already.points_earned,
    };
  }

  tx(() => {
    run(
      `INSERT INTO quiz_answers (id, match_id, round_number, participant_id, selected_index, is_correct, points_earned, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      uuid(),
      input.matchId,
      input.roundNumber,
      input.participantId,
      Math.round(Number(input.selectedIndex)),
      isCorrect ? 1 : 0,
      pointsEarned,
      stamp,
    );
    if (pointsEarned > 0) {
      run("UPDATE quiz_participants SET score = score + ? WHERE id = ?", pointsEarned, input.participantId);
    }
  });

  emitEvent("quiz.updated", { matchId: input.matchId, tableId: match.challenger_table_id });
  return {
    match: getQuizMatchView(input.matchId, input.participantId)!,
    isCorrect,
    pointsEarned,
  };
}

export function advanceQuizRound(matchId: string, participantId?: string | null): QuizMatchView {
  const match = get<{ id: string; current_round: number; total_rounds: number; challenger_table_id: string | null }>(
    "SELECT id, current_round, total_rounds, challenger_table_id FROM quiz_matches WHERE id = ?",
    matchId,
  );
  if (!match) throw notFound("Quiz match not found");
  if (match.current_round >= match.total_rounds) {
    run("UPDATE quiz_matches SET status = 'finished' WHERE id = ?", matchId);
  } else {
    run(
      "UPDATE quiz_matches SET current_round = current_round + 1, round_started_at = ? WHERE id = ?",
      nowStamp(),
      matchId,
    );
  }
  emitEvent("quiz.updated", { matchId, tableId: match.challenger_table_id });
  return getQuizMatchView(matchId, participantId)!;
}
