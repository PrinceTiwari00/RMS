/**
 * Shared API contract.
 *
 * Pure types only — no runtime imports — so both server services and client
 * components can depend on this module without dragging SQLite into the browser
 * bundle. All money fields are integer paisa unless the name says otherwise.
 */
import type { Permission } from "@/domain/permissions";
import type { TableShape, TableStatus } from "@/domain/tables";
import type { Course, KdsStatus, Urgency } from "@/domain/kds";
import type { Quadrant } from "@/domain/pmix";
import type { TenderMethod } from "@/domain/checkout";

// -------------------------------------------------------------------- settings
export interface Settings {
  restaurantName: string;
  tagline: string;
  address: string;
  phone: string;
  panVat: string;
  currency: string;
  currencySymbol: string;
  locale: string;
  vatRate: number;
  vatInclusive: boolean;
  serviceChargeRate: number;
  tipPresets: number[];
  cashFloat: number;
  businessDayRollover: number;
  kdsWarnMinutes: number;
  kdsLateMinutes: number;
  laborTargetMin: number;
  laborTargetMax: number;
  storeForwardLimit: number;
  receiptFooter: string;
  qrOrderingEnabled: boolean;
  cfdEnabled: boolean;
}

export interface StationInfo {
  id: string;
  name: string;
  color: string;
}

// ------------------------------------------------------------------------ menu
export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ModifierOption {
  id: string;
  name: string;
  price: number;
  isDefault: boolean;
  isAvailable: boolean;
  sortOrder: number;
}

export interface ModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
  sortOrder: number;
  options: ModifierOption[];
}

export interface MenuItem {
  id: string;
  categoryId: string | null;
  categoryName: string;
  name: string;
  description: string;
  price: number;
  cost: number;
  course: Course;
  station: string;
  allergens: string;
  prepMinutes: number;
  emoji: string;
  isAvailable: boolean;
  isFeatured: boolean;
  sortOrder: number;
  groups: ModifierGroup[];
  marginPercent: number;
  foodCostPercent: number;
  /** how many times this item sold in the current reporting window */
  unitsSold?: number;
}

export interface PrepStep {
  text: string;
  seconds?: number;
}

export interface PrepSheet {
  id: string;
  menuItemId: string;
  itemName: string;
  emoji: string;
  station: string;
  allergens: string;
  plating: string;
  steps: PrepStep[];
  updatedAt: string;
}

// --------------------------------------------------------------- kitchen / KDS
export interface KdsTicket {
  orderId: string;
  checkNumber: number | null;
  tableLabel: string;
  tableId: string | null;
  guests: number;
  serverName: string;
  channel: string;
  note: string;
  sentAt: string | null;
  firedAt: string | null;
  minutesElapsed: number;
  urgency: Urgency;
  lines: OrderLine[];
  allReady: boolean;
  bumped: boolean;
}

export interface KdsStationView {
  station: StationInfo;
  tickets: KdsTicket[];
  pendingCount: number;
  holdCount: number;
  readyCount: number;
  oldestMinutes: number;
  itemCount: number;
}

export interface ExpoStationBreakdown {
  station: string;
  name: string;
  color: string;
  ready: number;
  total: number;
  complete: boolean;
}

export interface ExpoTicket extends KdsTicket {
  stationBreakdown: ExpoStationBreakdown[];
  canBump: boolean;
  seats: number[];
}

export interface KdsMetrics {
  byStation: { station: StationInfo; pending: number; hold: number; ready: number; oldestMinutes: number }[];
  activeTickets: number;
  lateTickets: number;
  readyToBump: number;
  averageTicketMinutes: number;
}

// ------------------------------------------------------------------ floor plan
export interface Section {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
}

export interface TableSnapshot {
  id: string;
  label: string;
  sectionId: string | null;
  sectionName: string;
  capacity: number;
  shape: TableShape;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  status: TableStatus;
  guests: number;
  serverId: string | null;
  serverName: string;
  seatedAt: string | null;
  minutesSeated: number;
  orderId: string | null;
  orderStatus: string | null;
  checkNumber: number | null;
  totalPaisa: number;
  itemCount: number;
  oldestItemMinutes: number;
}

// ---------------------------------------------------------------------- orders
export interface OrderLineModifier {
  id: string;
  /** The chosen modifier option, so a line edit can restore the selection. */
  modifierId: string | null;
  groupName: string;
  name: string;
  price: number;
}

export interface OrderLine {
  id: string;
  orderId: string;
  menuItemId: string | null;
  name: string;
  quantity: number;
  /** locked price_at_time, paisa */
  unitPrice: number;
  /** unit price including modifiers, paisa */
  effectiveUnitPrice: number;
  lineTotal: number;
  course: Course;
  station: string;
  stationName: string;
  seat: number;
  note: string;
  kdsStatus: KdsStatus;
  urgency: Urgency;
  isVoid: boolean;
  voidReason: string | null;
  createdAt: string;
  sentAt: string | null;
  readyAt: string | null;
  bumpedAt: string | null;
  minutesElapsed: number;
  modifiers: OrderLineModifier[];
}

export interface OrderTotals {
  subtotal: number;
  discount: number;
  taxable: number;
  vat: number;
  serviceCharge: number;
  tip: number;
  total: number;
  grandTotal: number;
  itemCount: number;
}

export interface OrderSnapshot extends OrderTotals {
  id: string;
  checkNumber: number | null;
  tableId: string | null;
  tableLabel: string;
  terminalId: string | null;
  serverId: string | null;
  serverName: string;
  status: "open" | "sent" | "closed" | "voided";
  channel: "dine_in" | "takeout" | "delivery" | "qr";
  guests: number;
  qrToken: string | null;
  guestName: string;
  note: string;
  businessDate: string | null;
  createdAt: string;
  sentAt: string | null;
  firedAt: string | null;
  closedAt: string | null;
  items: OrderLine[];
  activeItems: OrderLine[];
  allReady: boolean;
  canBump: boolean;
  hasHold: boolean;
  minutesOpen: number;
  oldestItemMinutes: number;
  tenders: Tender[];
  discounts: DiscountRecord[];
}

export interface Tender {
  id?: string;
  method: TenderMethod;
  amount: number;
  tip: number;
  label: string;
  authCode?: string | null;
  last4?: string | null;
  status?: string;
  createdAt?: string;
}

export interface DiscountRecord {
  id: string;
  kind: "amount" | "percent";
  value: number;
  amount: number;
  reason: string;
  approvedBy: string;
  createdAt: string;
}

// ----------------------------------------------------------------------- staff
export interface StaffMember {
  id: string;
  name: string;
  initials: string;
  color: string;
  role: string;
  roleTitle: string;
  phone: string;
  isActive: boolean;
  hourlyRate: number;
  hireDate: string | null;
  /** only exposed in demo mode, for the PIN pad hint */
  pin?: string;
  permissions?: Permission[];
  clockedIn?: boolean;
  currentEntryId?: string | null;
}

export interface RoleInfo {
  id: string;
  name: string;
  title: string;
  hourlyRate: number;
  isSystem: boolean;
  permissions: string[];
  headcount: number;
}

export interface SessionUser {
  id: string;
  name: string;
  initials: string;
  color: string;
  role: string;
  roleTitle: string;
  permissions: Permission[];
}

// ------------------------------------------------------------- host / waitlist
export interface WaitlistParty {
  id: string;
  guestName: string;
  phone: string;
  partySize: number;
  status: "waiting" | "notified" | "seated" | "no_show" | "cancelled";
  quotedMinutes: number;
  notes: string;
  tableId: string | null;
  tableLabel: string;
  createdAt: string;
  notifiedAt: string | null;
  seatedAt: string | null;
  waitedMinutes: number;
  position: number;
}

export interface Reservation {
  id: string;
  guestName: string;
  phone: string;
  partySize: number;
  reservationAt: string;
  status: "confirmed" | "seated" | "cancelled" | "no_show";
  tableId: string | null;
  tableLabel: string;
  source: string;
  notes: string;
  minutesUntil: number;
}

export interface GuestAlert {
  id: string;
  partyId: string;
  channel: string;
  message: string;
  status: string;
  createdAt: string;
}

// ------------------------------------------------------------------- inventory
export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  currentStock: number;
  unitCost: number;
  storageLocation: string;
  avgDailyUsage: number;
  maxDailyUsage: number;
  leadTimeDays: number;
  maxLeadTimeDays: number;
  parLevel: number;
  packSize: number;
  lowStockThreshold: number;
  vendorId: string | null;
  vendorName: string;
  isActive: boolean;
  safetyStock: number;
  reorderPoint: number;
  daysOfCover: number;
  orderPacks: number;
  health: "out" | "low" | "watch" | "ok";
  stockValue: number;
  recipesUsedIn: number;
}

export interface RecipeComponent {
  menuItemId: string;
  inventoryItemId: string;
  itemName: string;
  unit: string;
  quantityRequired: number;
  unitCost: number;
  lineCost: number;
  isModifier: boolean;
  modifierId: string;
}

export interface RecipeCosting {
  menuItemId: string;
  itemName: string;
  emoji: string;
  price: number;
  theoreticalCost: number;
  storedCost: number;
  margin: number;
  marginPercent: number;
  foodCostPercent: number;
  components: RecipeComponent[];
  missing: string[];
}

export interface WasteEntry {
  id: string;
  inventoryItemId: string;
  itemName: string;
  unit: string;
  quantity: number;
  reason: string;
  notes: string;
  loggedBy: string;
  createdAt: string;
  businessDate: string | null;
  value: number;
}

export interface CountRecord {
  id: string;
  inventoryItemId: string;
  itemName: string;
  unit: string;
  expected: number;
  counted: number;
  variance: number;
  countedBy: string;
  applied: boolean;
  createdAt: string;
  businessDate: string | null;
  varianceValue: number;
}

// ------------------------------------------------------------------ purchasing
export interface Vendor {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  accountNumber: string;
  paymentTerms: string;
  minOrder: number;
  leadTimeDays: number;
  ediEnabled: boolean;
  cutoffTime: string;
  preferred: boolean;
  isActive: boolean;
  itemCount: number;
  openPoCount: number;
  spend30d: number;
}

export interface PurchaseOrderLine {
  id: string;
  inventoryItemId: string;
  itemName: string;
  unit: string;
  sku: string;
  quantityPacks: number;
  packSize: number;
  units: number;
  unitPrice: number;
  lineTotal: number;
  currentStock: number;
  parLevel: number;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  status: "draft" | "approved" | "sent" | "received" | "cancelled";
  expectedDate: string | null;
  notes: string;
  total: number;
  createdAt: string;
  approvedAt: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  lines: PurchaseOrderLine[];
  transmissions: PoTransmission[];
  ediEnabled: boolean;
  pastCutoff: boolean;
}

export interface PoTransmission {
  id: string;
  channel: "pdf_email" | "edi_sftp";
  destination: string;
  status: "queued" | "sent" | "failed" | "dead";
  attempts: number;
  reference: string;
  payload: string;
  createdAt: string;
}

// ----------------------------------------------------------------------- labour
export interface Shift {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeColor: string;
  initials: string;
  roleTitle: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  note: string;
  station: string;
  status: "scheduled" | "published" | "cancelled" | "completed";
  hours: number;
  laborCost: number;
  swap?: SwapRequest | null;
}

export interface AvailabilityWindow {
  id: string;
  employeeId: string;
  weekday: number;
  starts: string;
  ends: string;
  unavailable: boolean;
}

export interface SwapRequest {
  id: string;
  shiftId: string;
  requestedBy: string;
  requestedByName: string;
  requestedTo: string;
  requestedToName: string;
  reason: string;
  status: "pending" | "approved" | "denied";
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  shiftLabel: string;
}

export interface TimeEntry {
  id: string;
  employeeId: string;
  employeeName: string;
  initials: string;
  color: string;
  roleTitle: string;
  clockIn: string;
  clockOut: string | null;
  breakMinutes: number;
  regularHours: number;
  overtimeHours: number;
  hourlyRate: number;
  businessDate: string | null;
  edited: boolean;
  editReason: string | null;
  editedBy: string | null;
  otApproved: boolean;
  grossPay: number;
  burdened: number;
  open: boolean;
  liveHours: number;
}

// --------------------------------------------------------------------- reports
export interface MetricCard {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "warn" | "bad" | "neutral";
  delta?: number | null;
}

export interface SalesPoint {
  date: string;
  label: string;
  netSales: number;
  checks: number;
  guests: number;
  laborCost: number;
  laborPercent: number;
  foodCost: number;
  foodCostPercent: number;
}

export interface ExecutiveReport {
  range: { from: string; to: string; label: string; days: number };
  kpis: {
    netSales: number;
    grossSales: number;
    checks: number;
    guests: number;
    averageCheck: number;
    coversPerDay: number;
    vat: number;
    serviceCharge: number;
    tips: number;
    discounts: number;
    voids: number;
    voidAmount: number;
    laborCost: number;
    laborHours: number;
    laborPercent: number;
    laborHealth: "under" | "target" | "over";
    foodCost: number;
    foodCostPercent: number;
    primeCost: number;
    primeCostPercent: number;
    salesPerLaborHour: number;
  };
  previous: { netSales: number; checks: number; averageCheck: number; laborPercent: number; foodCostPercent: number };
  series: SalesPoint[];
  hourOfDay: { hour: number; sales: number; checks: number }[];
  channelMix: { channel: string; label: string; sales: number; checks: number; percent: number }[];
  tenderMix: { method: string; label: string; amount: number; count: number; percent: number }[];
  topItems: { id: string; name: string; units: number; revenue: number; margin: number }[];
  laborByRole: { role: string; hours: number; cost: number }[];
}

export interface PmixRowView {
  id: string;
  name: string;
  emoji: string;
  category: string;
  unitsSold: number;
  revenue: number;
  cost: number;
  price: number;
  contributionMargin: number;
  marginPercent: number;
  menuMixPercent: number;
  foodCostPercent: number;
  popular: boolean;
  profitable: boolean;
  quadrant: Quadrant;
}

export interface PmixReport {
  range: { from: string; to: string; label: string };
  rows: PmixRowView[];
  totals: { units: number; revenue: number; cost: number; contribution: number; marginPercent: number; foodCostPercent: number };
  thresholds: { popularityPercent: number; contributionMargin: number };
  quadrants: Record<Quadrant, { count: number; rows: PmixRowView[] }>;
}

export interface ZReport {
  businessDate: string;
  businessDayId: string | null;
  status: "open" | "closed";
  generatedAt: string | null;
  openedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  checks: number;
  guests: number;
  averageCheck: number;
  grossSales: number;
  netSales: number;
  vat: number;
  serviceCharge: number;
  discounts: number;
  voids: number;
  voidAmount: number;
  tips: number;
  laborCost: number;
  laborHours: number;
  laborPercent: number;
  foodCost: number;
  foodCostPercent: number;
  tenders: { method: string; label: string; amount: number; tips: number; count: number }[];
  cash: {
    openingFloat: number;
    expectedCash: number;
    countedCash: number | null;
    variance: number | null;
    notes: string;
    counts: { denomination: string; expectedCount: number; countedCount: number; value: number }[];
  };
  discountDetail: { reason: string; amount: number; count: number }[];
  voidDetail: { reason: string; amount: number; count: number }[];
  tipPayout: { employeeId: string; name: string; tips: number; checks: number }[];
  byServer: { id: string; name: string; checks: number; sales: number; averageCheck: number; tips: number }[];
  byHour: { hour: number; sales: number; checks: number }[];
  topItems: { name: string; units: number; revenue: number }[];
}

export interface BusinessDay {
  id: string;
  businessDate: string;
  openedAt: string;
  closedAt: string | null;
  openingFloat: number;
  status: "open" | "closed";
  notes: string;
  liveSales: number;
  liveChecks: number;
}

// -------------------------------------------------------------------- customer
export interface QrTokenInfo {
  token: string;
  tableId: string | null;
  tableLabel: string;
  isActive: boolean;
  scans: number;
  url: string;
}

export interface GuestOrderView {
  token: string;
  tableLabel: string;
  restaurantName: string;
  tagline: string;
  address: string;
  phone: string;
  categories: Category[];
  menu: MenuItem[];
  settings: Settings;
  order: OrderSnapshot | null;
  paymentQr: string;
}

export interface CfdView {
  terminalId: string;
  restaurantName: string;
  tagline: string;
  settings: Settings;
  order: OrderSnapshot | null;
  promotions: { emoji: string; name: string; price: number; description: string }[];
  cashierName: string;
}

// ------------------------------------------------------------------ bootstrap
export interface Metrics {
  salesToday: number;
  netSalesToday: number;
  checksToday: number;
  guestsToday: number;
  averageCheck: number;
  openOrders: number;
  sentOrders: number;
  occupiedTables: number;
  totalTables: number;
  dirtyTables: number;
  occupancy: number;
  lowStock: number;
  outOfStock: number;
  pendingKds: number;
  lateKds: number;
  waitlistCount: number;
  reservationsToday: number;
  laborHoursToday: number;
  laborCostToday: number;
  laborPercentToday: number;
  staffClockedIn: number;
  openPoCount: number;
  wasteToday: number;
}

export interface AuditEntry {
  id: string;
  actorName: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  detail: string | null;
  createdAt: string;
}

export interface BootstrapState {
  user: SessionUser;
  demoMode: boolean;
  csrfToken: string | null;
  restaurant: { name: string; tagline: string; address: string; phone: string; panVat: string };
  settings: Settings;
  stations: StationInfo[];
  categories: Category[];
  menu: MenuItem[];
  sections: Section[];
  tables: TableSnapshot[];
  orders: OrderSnapshot[];
  staff: StaffMember[];
  businessDay: BusinessDay | null;
  metrics: Metrics;
  now: string;
}
