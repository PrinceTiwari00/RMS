"""RMS — offline-first Restaurant Management System (per the RMS Technical Blueprint)."""

from .db import connect, init_db

__all__ = ["connect", "init_db"]
__version__ = "1.0.0"
