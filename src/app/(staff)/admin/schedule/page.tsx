"use client";

import { useState } from "react";
import { api, errorMessage, qs } from "@/lib/api";
import { usePoll } from "@/lib/store";
import { Button, Card, Empty, Field, TextInput, toast } from "@/components/ui";
import { formatClock, shiftDate, startOfWeek, today } from "@/domain/time";
import type { Shift, StaffMember, SwapRequest } from "@/types";

interface ScheduleResponse { dates: string[]; shifts: Shift[]; staff: StaffMember[]; swaps: SwapRequest[] }

export default function SchedulePage() {
  const [week, setWeek] = useState(startOfWeek(today()));
  const { data, error, pending, reload } = usePoll<ScheduleResponse>(`schedule${qs({ week })}`);
  const [busy, setBusy] = useState(false);
  const [employeeId, setEmployee] = useState("");
  const [date, setDate] = useState(today());
  const [starts, setStarts] = useState("09:00");
  const [ends, setEnds] = useState("17:00");
  const [breakMinutes, setBreak] = useState("30");
  const [note, setNote] = useState("");
  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    try { await action(); await reload(); toast(message, "ok"); }
    catch (e) { toast(errorMessage(e), "late"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5 p-4 lg:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-extrabold">Shift Scheduler</h1><p className="text-sm text-ink-faint">Plan staff coverage, publish shifts and review swap requests.</p></div>
      <div className="flex flex-wrap items-center gap-2"><Button onClick={() => setWeek(shiftDate(week, -7))}>Previous week</Button><Field label="Week of"><TextInput type="date" value={week} onChange={(v) => v && setWeek(startOfWeek(v))} /></Field><Button onClick={() => setWeek(shiftDate(week, 7))}>Next week</Button></div></header>
    {error && <p role="alert" className="text-late">{error}</p>}
    {pending && !data && <p>Loading schedule…</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy || !data} variant="primary" onClick={() => void act(() => api.post("schedule/publish", { week }), "Week published")}>Publish week</Button><Button disabled={busy || !data} onClick={() => { if (window.confirm("Copy the previous week into this week? Existing overlapping shifts are skipped.")) void act(() => api.post("schedule/copy-week", { week }), "Previous week copied"); }}>Copy previous week</Button></div>
    <Card className="p-4"><h2 className="mb-3 font-bold">Add shift</h2><form className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7" onSubmit={(e) => { e.preventDefault(); void act(() => api.post("schedule/shifts", { employeeId, date, starts, ends, breakMinutes: Number(breakMinutes), note }), "Shift added"); }}>
      <Field label="Employee"><select className="input w-full" required value={employeeId} onChange={(e) => setEmployee(e.target.value)}><option value="">Choose employee</option>{data?.staff.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Date"><TextInput type="date" value={date} onChange={setDate} /></Field><Field label="Start"><TextInput type="time" value={starts} onChange={setStarts} /></Field><Field label="End"><TextInput type="time" value={ends} onChange={setEnds} /></Field><Field label="Break (minutes)"><TextInput type="number" min={0} value={breakMinutes} onChange={setBreak} /></Field><Field label="Note"><TextInput value={note} onChange={setNote} /></Field><Button type="submit" variant="primary" disabled={busy || !employeeId || !date || !starts || !ends}>Add shift</Button>
    </form></Card>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{data?.dates.map((day) => <Card key={day} className="p-4"><h2 className="mb-3 font-bold">{day}</h2>{data.shifts.filter((s) => s.startsAt.slice(0, 10) === day).map((s) => <div key={s.id} className="space-y-1 border-t border-line py-3 text-sm"><p className="font-bold">{s.employeeName}</p><p>{formatClock(s.startsAt)} – {formatClock(s.endsAt)}</p><p className="text-ink-faint">{s.roleTitle} · {s.status} · {s.breakMinutes} min break</p>{s.note && <p>{s.note}</p>}<Button size="sm" variant="danger" disabled={busy} onClick={() => { if (window.confirm(`Delete ${s.employeeName}'s shift?`)) void act(() => api.del(`schedule/shifts/${s.id}`), "Shift deleted"); }}>Delete</Button></div>)}{!data.shifts.some((s) => s.startsAt.slice(0, 10) === day) && <p className="text-sm text-ink-faint">No shifts scheduled.</p>}</Card>)}</div>
    <Card className="p-4"><h2 className="mb-3 font-bold">Pending swap requests</h2>{data?.swaps.filter((s) => s.status === "pending").map((s) => <div key={s.id} className="flex flex-wrap items-center gap-3 border-t border-line py-3"><div className="mr-auto"><p className="font-bold">{s.requestedByName} → {s.requestedToName || "Open request"}</p><p className="text-sm">{s.shiftLabel} · {s.reason}</p></div>{(["approved", "denied"] as const).map((decision) => <Button key={decision} disabled={busy} onClick={() => void act(() => api.post(`swaps/${s.id}/decide`, { decision }), `Swap ${decision}`)}>{decision === "approved" ? "Approve" : "Deny"}</Button>)}</div>)}{data && !data.swaps.some((s) => s.status === "pending") && <Empty title="No pending swap requests" />}</Card>
  </div>;
}
