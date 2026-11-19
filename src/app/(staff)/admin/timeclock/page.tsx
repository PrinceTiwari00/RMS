"use client";

import { useState } from "react";
import { api, errorMessage, qs } from "@/lib/api";
import { usePoll } from "@/lib/store";
import { Button, Card, Empty, Field, TextInput, toast } from "@/components/ui";
import { businessDateNow, formatClock } from "@/domain/time";
import { formatMoney } from "@/domain/money";
import type { StaffMember, TimeEntry } from "@/types";

interface ClockResponse { entries: TimeEntry[]; clockedIn: TimeEntry[]; staff: StaffMember[] }

export default function TimeClockPage() {
  const [date, setDate] = useState(businessDateNow());
  const { data, error, pending, reload } = usePoll<ClockResponse>(`timeclock${qs({ date })}`);
  const [employeeId, setEmployee] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [breakMinutes, setBreak] = useState("0");
  const [reason, setReason] = useState("");
  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    try { await action(); await reload(); toast(message, "ok"); }
    catch (e) { toast(errorMessage(e), "late"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5 p-4 lg:p-6"><header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-extrabold">Time Clock</h1><p className="text-sm text-ink-faint">Manage attendance and audited payroll corrections.</p></div><Field label="Business date"><TextInput type="date" value={date} onChange={(v) => v && setDate(v)} /></Field></header>
    {error && <p role="alert" className="text-late">{error}</p>}{pending && !data && <p>Loading attendance…</p>}
    <Card className="p-4"><h2 className="mb-3 font-bold">Manager punch</h2><div className="flex flex-wrap items-end gap-3"><Field label="Employee"><select className="input" value={employeeId} onChange={(e) => setEmployee(e.target.value)}><option value="">Choose employee</option>{data?.staff.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>{["clock-in", "clock-out"].map((action) => <Button key={action} disabled={busy || !employeeId} variant="soft" onClick={() => void act(() => api.post(`timeclock/${action}`, { employeeId }), action === "clock-in" ? "Employee clocked in" : "Employee clocked out")}>{action === "clock-in" ? "Clock in" : "Clock out"}</Button>)}</div><p className="mt-3 text-sm text-ink-faint">Currently working: {data?.clockedIn.map((e) => e.employeeName).join(", ") || "None"}. Punches apply to the current time, not the selected report date.</p></Card>
    {editing && <Card className="p-4"><h2 className="mb-3 font-bold">Correct entry · {editing.employeeName}</h2><form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.patch(`timeclock/entries/${editing.id}`, { clockIn: `${clockIn.replace("T", " ")}:00`, ...(clockOut ? { clockOut: `${clockOut.replace("T", " ")}:00` } : {}), breakMinutes: Number(breakMinutes), reason }); setEditing(null); }, "Time entry corrected"); }}><Field label="Clock in (restaurant time)"><TextInput type="datetime-local" value={clockIn} onChange={setClockIn} /></Field><Field label="Clock out (restaurant time)"><TextInput type="datetime-local" value={clockOut} onChange={setClockOut} /></Field><Field label="Break minutes"><TextInput type="number" min={0} value={breakMinutes} onChange={setBreak} /></Field><Field label="Reason (required)"><TextInput value={reason} onChange={setReason} /></Field><div className="flex items-end gap-2"><Button type="submit" variant="primary" disabled={busy || !reason.trim() || !clockIn}>Save correction</Button><Button onClick={() => setEditing(null)}>Cancel</Button></div></form></Card>}
    <Card className="overflow-x-auto p-4"><h2 className="mb-3 font-bold">Attendance · {date}</h2>{data?.entries.length ? <table className="w-full text-left text-sm"><thead><tr>{["Employee", "In", "Out", "Break", "Hours", "Gross pay", "Audit / actions"].map((h) => <th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{data.entries.map((entry) => <tr key={entry.id} className="border-t border-line"><td className="p-2 font-bold">{entry.employeeName}</td><td className="p-2">{formatClock(entry.clockIn)}</td><td className="p-2">{entry.clockOut ? formatClock(entry.clockOut) : "Working"}</td><td className="p-2">{entry.breakMinutes}m</td><td className="p-2">{(entry.open ? entry.liveHours : entry.regularHours + entry.overtimeHours).toFixed(2)}</td><td className="p-2">{formatMoney(entry.grossPay)}</td><td className="p-2"><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => { setEditing(entry); setClockIn(localInput(entry.clockIn)); setClockOut(entry.clockOut ? localInput(entry.clockOut) : ""); setBreak(String(entry.breakMinutes)); setReason(""); }}>Correct</Button>{!entry.open && entry.overtimeHours > 0 && !entry.otApproved && <Button size="sm" disabled={busy} onClick={() => void act(() => api.post(`timeclock/entries/${entry.id}/overtime`), "Overtime approved")}>Approve overtime</Button>}</div>{entry.edited && <p className="mt-1 text-xs text-ink-faint">Edited: {entry.editReason}</p>}</td></tr>)}</tbody></table> : data && <Empty title="No time entries for this date" hint="Clock employees in when their shift begins." />}</Card>
  </div>;
}

function localInput(value: string): string {
  return value.replace(" ", "T").slice(0, 16);
}
