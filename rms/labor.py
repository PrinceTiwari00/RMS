"""Labor scheduling & cost calculations (blueprint §11).

Labor Cost % target is 25-35%. When an employee clocks in via PIN, the active
hourly_rate is copied from the role into the time_clock_entries ledger so
historical reports are insulated against future wage increases.
"""

from datetime import datetime

from .db import new_uuid, money

BURDEN_FACTOR = 1.18          # taxes/benefits
OVERTIME_MULTIPLIER = 1.5
DAILY_OT_THRESHOLD_HRS = 8.0  # hours beyond this per shift are overtime


def add_role(conn, name: str, hourly_rate: float) -> str:
    role_id = new_uuid()
    conn.execute("INSERT INTO roles (id, name, hourly_rate) VALUES (?, ?, ?)",
                 (role_id, name, money(hourly_rate)))
    conn.commit()
    return role_id


def add_employee(conn, name: str, role_id: str, pin: str) -> str:
    emp_id = new_uuid()
    conn.execute("INSERT INTO employees (id, name, role_id, pin) VALUES (?, ?, ?, ?)",
                 (emp_id, name, role_id, pin))
    conn.commit()
    return emp_id


def clock_in(conn, employee_id: str, pin: str, at: datetime | None = None) -> str:
    emp = conn.execute("SELECT * FROM employees WHERE id = ?", (employee_id,)).fetchone()
    if emp is None or emp["pin"] != pin:
        raise ValueError("invalid PIN")
    role = conn.execute("SELECT hourly_rate FROM roles WHERE id = ?", (emp["role_id"],)).fetchone()
    entry_id = new_uuid()
    conn.execute(
        "INSERT INTO time_clock_entries (id, employee_id, clock_in, hourly_rate)"
        " VALUES (?, ?, ?, ?)",
        (entry_id, employee_id, (at or datetime.now()).isoformat(), money(role["hourly_rate"])),
    )
    conn.commit()
    return entry_id


def clock_out(conn, entry_id: str, at: datetime) -> dict:
    entry = conn.execute("SELECT * FROM time_clock_entries WHERE id = ?", (entry_id,)).fetchone()
    if entry is None or entry["clock_out"] is not None:
        raise ValueError("entry not open")
    start = datetime.fromisoformat(entry["clock_in"])
    hours = max(0.0, (at - start).total_seconds() / 3600.0)
    regular = min(hours, DAILY_OT_THRESHOLD_HRS)
    overtime = max(0.0, hours - DAILY_OT_THRESHOLD_HRS)
    conn.execute(
        "UPDATE time_clock_entries SET clock_out = ?, regular_hours = ?, overtime_hours = ?"
        " WHERE id = ?",
        (at.isoformat(), round(regular, 4), round(overtime, 4), entry_id))
    conn.commit()
    return {"regular_hours": regular, "overtime_hours": overtime,
            "hourly_rate": entry["hourly_rate"]}


def gross_pay(regular_hours: float, overtime_hours: float, hourly_rate: float) -> float:
    """Gross Pay = (Reg Hrs x Rate) + (OT Hrs x Rate x 1.5)"""
    return money(regular_hours * hourly_rate + overtime_hours * hourly_rate * OVERTIME_MULTIPLIER)


def total_labor_cost(gross: float) -> float:
    """Total Labor Cost = Gross Pay x 1.18 (burden factor)"""
    return money(gross * BURDEN_FACTOR)


def labor_cost_pct(total_labor: float, gross_sales: float) -> float:
    """Labor Cost % = (Total Labor Cost / Total Gross Sales) x 100"""
    if gross_sales == 0:
        raise ValueError("gross sales must be non-zero")
    return round(total_labor / gross_sales * 100, 2)
