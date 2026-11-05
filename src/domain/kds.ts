/**
 * Kitchen Display System rules.
 *
 * A guest ticket is split into per-station work. Appetizers, drinks and desserts
 * release immediately; entrees sit on HOLD until the server taps "Fire". Cooks
 * mark single items READY; the Expo master screen only lets a ticket bump once
 * every line is READY. Elapsed-time colours give the line a shared sense of
 * urgency without anybody having to read a clock.
 */

export type KdsStatus = "PENDING" | "HOLD" | "READY";

export const KDS_STATUSES: KdsStatus[] = ["PENDING", "HOLD", "READY"];

export type Course = "appetizer" | "entree" | "drink" | "dessert";

export const COURSES: Course[] = ["appetizer", "entree", "drink", "dessert"];

export const COURSE_LABEL: Record<Course, string> = {
  appetizer: "Appetizer",
  entree: "Entree",
  drink: "Drink",
  dessert: "Dessert",
};

export interface Station {
  id: string;
  name: string;
  color: string;
}

export const DEFAULT_STATIONS: Station[] = [
  { id: "grill", name: "Grill", color: "#c2542f" },
  { id: "fry", name: "Fry", color: "#c98a1e" },
  { id: "pantry", name: "Salad / Pantry", color: "#3f8f5f" },
  { id: "bar", name: "Bar", color: "#3d6ea8" },
  { id: "dessert", name: "Dessert", color: "#8a5aa8" },
];

export function stationMeta(id: string): Station {
  return DEFAULT_STATIONS.find((station) => station.id === id) ?? { id, name: id, color: "#5a6b78" };
}

/** Entrees are held so the whole table lands together; everything else fires now. */
export function initialKdsStatus(course: string): KdsStatus {
  return course === "entree" ? "HOLD" : "PENDING";
}

export interface AgeThresholds {
  /** minutes before a ticket turns amber */
  warn: number;
  /** minutes before a ticket turns red */
  late: number;
}

export const DEFAULT_THRESHOLDS: Record<Course, AgeThresholds> = {
  appetizer: { warn: 6, late: 12 },
  entree: { warn: 10, late: 18 },
  drink: { warn: 3, late: 6 },
  dessert: { warn: 6, late: 12 },
};

export type Urgency = "hold" | "ok" | "warn" | "late" | "ready";

/** Colour/urgency bucket for a KDS card, driven by elapsed minutes since release. */
export function urgency(status: KdsStatus, course: string, elapsedMinutes: number): Urgency {
  if (status === "READY") return "ready";
  if (status === "HOLD") return "hold";
  const thresholds = DEFAULT_THRESHOLDS[(course as Course) in DEFAULT_THRESHOLDS ? (course as Course) : "entree"];
  if (elapsedMinutes >= thresholds.late) return "late";
  if (elapsedMinutes >= thresholds.warn) return "warn";
  return "ok";
}

/**
 * Routing map produced when a ticket is sent: {station: [orderItemId, ...]}.
 * Mirrors the blueprint's ORDER_FIRED event.
 */
export function routeItems(items: { id: string; station: string }[]): Record<string, string[]> {
  const routing: Record<string, string[]> = {};
  for (const item of items) {
    (routing[item.station] ??= []).push(item.id);
  }
  return routing;
}

/** Expo gate: a ticket may only bump when it has lines and all of them are READY. */
export function canBump(statuses: KdsStatus[]): boolean {
  return statuses.length > 0 && statuses.every((status) => status === "READY");
}

/** Items a station still owes, ordered oldest-first so the line works in sequence. */
export function stationQueue<T extends { kds_status: string; sent_at: string | null; created_at: string }>(
  items: T[],
): T[] {
  return [...items].sort((left, right) => {
    const leftKey = left.sent_at ?? left.created_at;
    const rightKey = right.sent_at ?? right.created_at;
    return leftKey.localeCompare(rightKey);
  });
}

/** Aggregated station load shown in the KDS header. */
export interface StationLoad {
  station: string;
  pending: number;
  hold: number;
  ready: number;
  oldestMinutes: number;
}

export function stationLoads(
  items: { station: string; kds_status: KdsStatus; minutes: number }[],
): StationLoad[] {
  const byStation = new Map<string, StationLoad>();
  for (const item of items) {
    const load =
      byStation.get(item.station) ??
      ({ station: item.station, pending: 0, hold: 0, ready: 0, oldestMinutes: 0 } as StationLoad);
    if (item.kds_status === "PENDING") {
      load.pending += 1;
      load.oldestMinutes = Math.max(load.oldestMinutes, item.minutes);
    } else if (item.kds_status === "HOLD") load.hold += 1;
    else load.ready += 1;
    byStation.set(item.station, load);
  }
  return DEFAULT_STATIONS.map(
    (station) => byStation.get(station.id) ?? { station: station.id, pending: 0, hold: 0, ready: 0, oldestMinutes: 0 },
  );
}
