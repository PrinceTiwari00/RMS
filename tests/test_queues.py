from rms import queues


def test_exponential_backoff_5_10_20_40():
    q = queues.JobQueue("po-dispatch")
    job = q.add("j1", {"po": "PO-1"})
    delays = []
    for _ in range(4):
        q.process("j1", lambda p: False)
        delays.append(job.backoff_delay())
    assert delays == [5.0, 10.0, 20.0, 40.0]


def test_dead_letter_after_5_attempts_then_manual_retry():
    q = queues.JobQueue("edi-850-sftp")
    q.add("j1", {"edi": "..."})
    for _ in range(queues.MAX_ATTEMPTS):
        q.process("j1", lambda p: False)  # SFTP keeps timing out
    assert q.jobs["j1"].status == "dead"
    assert len(q.dead_letter) == 1

    q.retry_dead("j1", lambda p: True)  # admin manual retry via Bull-Board
    assert q.jobs["j1"].status == "completed"
    assert q.dead_letter == []


def test_queue_health_counts():
    q = queues.JobQueue("po-dispatch")
    q.add("a", {})
    q.add("b", {})
    q.process("a", lambda p: True)
    q.process("b", lambda p: False)
    health = q.health()
    assert health["counts"] == {"completed": 1, "waiting": 1}
