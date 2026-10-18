"""Where a run's files are: ``<source>/<project>/<run>/`` holds its plan, a status stream and a session log per
worker, and a log per test, named as the original plugin named them."""

from __future__ import annotations

import base64
import hashlib

PLAN = "plan.json"
METADATA = "metadata.toml"  # optional, e.g. a display ``name``
FILENAME_SPECIAL_CHARS = '<>"/\\|?*'


def status_file(worker: int) -> str:
    """A worker's append-only stream of status events."""
    return f"status.{worker}.jsonl"


def session_log_file(worker: int) -> str:
    """A worker's output outside of tests."""
    return f"session.{worker}.log.jsonl"


def log_name(nodeid: str) -> str:
    """A test's log file name, the same as the original plugin's."""
    special = any(char in nodeid for char in FILENAME_SPECIAL_CHARS)
    digest = base64.b32encode(hashlib.blake2b(nodeid.encode(), digest_size=5).digest()).decode()
    name = nodeid
    if len(nodeid) + (9 if special else 0) > 110:
        name = f"{nodeid[:50]}-{digest}-{nodeid[-50:]}"
    elif special:
        name = f"{nodeid}-{digest}"
    if special:
        for char in FILENAME_SPECIAL_CHARS:
            name = name.replace(char, "_")
    return name + ".log.jsonl"
