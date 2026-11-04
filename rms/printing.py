"""Local TCP receipt & kitchen printing (blueprint §8).

Browsers cannot open raw TCP sockets, so a local agent streams ESC/POS bytes to
thermal printers on JetDirect port 9100. Before streaming, the gateway polls the
printer status (0x10 0x04 0x02); if out of paper or unreachable, the payload is
rerouted to a designated backup printer.
"""

# ESC/POS control bytes
ESC = b"\x1b"
GS = b"\x1d"
DLE = b"\x10"
REAL_TIME_STATUS = DLE + b"\x04" + b"\x02"  # 0x10 0x04 0x02 printer status poll
INIT = ESC + b"@"
CUT = GS + b"V" + b"\x00"                   # auto-cutter

JETDIRECT_PORT = 9100

# Bit 3 of the status response byte = paper out (simplified real-time status).
PAPER_OUT_BIT = 0x08


def build_ticket(order_lines: list, total: float) -> bytes:
    """Build a minimal ESC/POS ticket buffer: init, lines, total, auto-cut."""
    buf = bytearray(INIT)
    for line in order_lines:
        buf += line.encode("ascii") + b"\n"
    buf += f"TOTAL ${total:.2f}\n".encode("ascii")
    buf += CUT
    return bytes(buf)


class PrintAgent:
    """Simulated local Node.js/Go-style agent. In production this opens a raw
    TCP socket via net.connect(9100, printerIp); here printers are injected."""

    def __init__(self, printers: dict):
        # printers: {name: {"paper": bool, "received": list}}
        self.printers = printers
        self.backup = None

    def set_backup(self, name: str) -> None:
        self.backup = name

    def _status_ok(self, printer) -> bool:
        # Poll via 0x10 0x04 0x02: bit set means out of paper.
        return printer["paper"]

    def print_ticket(self, esc_pos_buffer: bytes, printer: str) -> str:
        """Stream bytes to a printer; on error/unreachable reroute to backup.
        Returns the name of the printer that received the job."""
        target = printer
        p = self.printers.get(printer)
        if p is None or not self._status_ok(p):
            if self.backup and self.backup in self.printers and self._status_ok(self.printers[self.backup]):
                target = self.backup  # reroute to designated backup printer
            else:
                raise ConnectionError(f"no reachable printer for job (tried {printer})")
        self.printers[target]["received"].append(esc_pos_buffer)
        return target
