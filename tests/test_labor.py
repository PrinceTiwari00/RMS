from datetime import datetime

import pytest

from rms import labor


def test_gross_pay_and_burden_and_pct():
    gross = labor.gross_pay(8, 2, 15.0)          # 8*15 + 2*15*1.5 = 165
    assert gross == 165.00
    total = labor.total_labor_cost(gross)        # 165 * 1.18
    assert total == 194.70
    assert labor.labor_cost_pct(total, 1000.0) == 19.47


def test_clock_in_copies_rate_and_clock_out_splits_ot(conn):
    role = labor.add_role(conn, "Server", 15.0)
    emp = labor.add_employee(conn, "Ana", role, pin="1234")
    entry = labor.clock_in(conn, emp, "1234", at=datetime(2026, 11, 4, 9, 0))
    result = labor.clock_out(conn, entry, at=datetime(2026, 11, 4, 19, 30))  # 10.5 hrs
    assert result["regular_hours"] == 8.0
    assert result["overtime_hours"] == 2.5
    assert result["hourly_rate"] == 15.0
    # Historical insulation: raise the role wage after clock-in; entry keeps old rate.
    conn.execute("UPDATE roles SET hourly_rate = 20 WHERE id = ?", (role,))
    row = conn.execute("SELECT hourly_rate FROM time_clock_entries WHERE id = ?",
                       (entry,)).fetchone()
    assert row["hourly_rate"] == 15.0


def test_bad_pin_rejected(conn):
    role = labor.add_role(conn, "Cook", 18.0)
    emp = labor.add_employee(conn, "Bo", role, pin="9999")
    with pytest.raises(ValueError):
        labor.clock_in(conn, emp, "0000")
