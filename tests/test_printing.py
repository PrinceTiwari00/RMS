import pytest

from rms import printing


def test_ticket_buffer_is_escpos_with_cut():
    buf = printing.build_ticket(["1x Burger $10.00"], 10.00)
    assert buf.startswith(printing.INIT)
    assert b"1x Burger $10.00" in buf and b"TOTAL $10.00" in buf
    assert buf.endswith(printing.CUT)


def test_print_routes_to_backup_when_out_of_paper():
    printers = {
        "expo": {"paper": False, "received": []},
        "kitchen_backup": {"paper": True, "received": []},
    }
    agent = printing.PrintAgent(printers)
    agent.set_backup("kitchen_backup")
    buf = printing.build_ticket(["1x Fries"], 4.50)
    used = agent.print_ticket(buf, "expo")
    assert used == "kitchen_backup"
    assert printers["kitchen_backup"]["received"] == [buf]
    assert printers["expo"]["received"] == []


def test_print_fails_when_no_printer_reachable():
    agent = printing.PrintAgent({"expo": {"paper": False, "received": []}})
    agent.set_backup("missing")
    with pytest.raises(ConnectionError):
        agent.print_ticket(b"\x1b@", "expo")
