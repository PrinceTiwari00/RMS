/**
 * Real-time in-process event bus scoped by tenant, table, station, and quiz match.
 *
 * SSE listeners subscribe here and immediately push updates to connected guests,
 * floor tablets, staff consoles, KDS boards, and the manager overview.
 */
import { EventEmitter } from "node:events";
import { currentTenantScope } from "@/db/client";

export type RmsEventType =
  | "session.updated"
  | "order.created"
  | "order.approved"
  | "order.updated"
  | "kds.updated"
  | "floor.updated"
  | "service_request.created"
  | "service_request.updated"
  | "payment.updated"
  | "review.created"
  | "quiz.updated";

export interface RmsEvent {
  tenantId: string;
  type: RmsEventType;
  tableId?: string | null;
  sessionId?: string | null;
  station?: string | null;
  orderId?: string | null;
  matchId?: string | null;
  ts: number;
}

const globalBus = globalThis as unknown as { __rmsEventBus?: EventEmitter };

function bus(): EventEmitter {
  if (!globalBus.__rmsEventBus) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(500);
    globalBus.__rmsEventBus = emitter;
  }
  return globalBus.__rmsEventBus;
}

export function emitEvent(
  type: RmsEventType,
  meta: Omit<RmsEvent, "tenantId" | "type" | "ts"> = {},
): void {
  const tenantId = currentTenantScope()?.tenantId ?? "default";
  const payload: RmsEvent = {
    tenantId,
    type,
    ...meta,
    ts: Date.now(),
  };
  bus().emit(`tenant:${tenantId}`, payload);
}

export function subscribeTenantEvents(
  tenantId: string,
  handler: (event: RmsEvent) => void,
): () => void {
  const channel = `tenant:${tenantId}`;
  const emitter = bus();
  emitter.on(channel, handler);
  return () => {
    emitter.off(channel, handler);
  };
}
