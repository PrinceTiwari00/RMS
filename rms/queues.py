"""Event-driven background job queues (blueprint §12, §13).

Non-blocking operations (PO emails, EDI 850 over SFTP, daily sales reports) run
on a Redis-backed-style queue with 5 attempts and exponential backoff
(5s, 10s, 20s, 40s) before the job moves to a dead-letter state. Admins monitor
queue health and trigger manual retries (Bull-Board style).
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone

BASE_DELAY_S = 5.0
MAX_ATTEMPTS = 5


@dataclass
class Job:
    job_id: str
    queue: str
    payload: dict
    attempts: int = 0
    status: str = "waiting"            # waiting | active | completed | failed | dead
    next_attempt_at: str | None = None
    error: str | None = None
    history: list = field(default_factory=list)

    def backoff_delay(self) -> float:
        """Exponential backoff: 5s, 10s, 20s, 40s (blueprint §13)."""
        return BASE_DELAY_S * (2 ** (self.attempts - 1))  # attempt 1 -> 5s


class JobQueue:
    """In-memory stand-in for a BullMQ/Celery queue with the same semantics:
    attempts=5, exponential backoff starting at 5000ms, dead-letter on exhaustion."""

    def __init__(self, name: str):
        self.name = name
        self.jobs: dict[str, Job] = {}
        self.dead_letter: list[Job] = []

    def add(self, job_id: str, payload: dict) -> Job:
        job = Job(job_id=job_id, queue=self.name, payload=payload)
        self.jobs[job_id] = job
        return job

    def process(self, job_id: str, handler) -> Job:
        """Run one attempt. `handler(payload)` returns True on success.
        On failure the job is retried with exponential backoff and finally
        moved to the dead-letter state after MAX_ATTEMPTS."""
        job = self.jobs[job_id]
        job.attempts += 1
        job.status = "active"
        try:
            if handler(job.payload):
                job.status = "completed"
                job.history.append((job.attempts, "completed", None))
            else:
                raise ConnectionError("endpoint rejected job")
        except Exception as exc:  # e.g. SFTP timeout
            job.error = str(exc)
            job.history.append((job.attempts, "failed", str(exc)))
            if job.attempts >= MAX_ATTEMPTS:
                job.status = "dead"
                self.dead_letter.append(job)
            else:
                job.status = "waiting"
                job.next_attempt_at = str(job.backoff_delay())
        return job

    def retry_dead(self, job_id: str, handler) -> Job:
        """Manual retry from dead-letter (Bull-Board style)."""
        job = next(j for j in self.dead_letter if j.job_id == job_id)
        self.dead_letter.remove(job)
        job.status = "waiting"
        job.attempts = 0
        return self.process(job_id, handler)

    def health(self) -> dict:
        counts = {}
        for j in self.jobs.values():
            counts[j.status] = counts.get(j.status, 0) + 1
        return {"queue": self.name, "counts": counts, "dead_letter": len(self.dead_letter)}
