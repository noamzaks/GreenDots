"""A run: its plan, read once, and its tests' results, kept up to date by tailing the status files."""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from greendots.core import METADATA, PLAN, StatusEvent, session_log_file, status_file

from .log import Log

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

STATUSES = ("passed", "failed", "skipped", "running", "pending")


@dataclass
class Test:
    """A test of the plan: its node ``id``, and where GreenDots shows it."""

    id: str
    name: str
    module: str
    params: dict[str, Any]
    log_file: str
    keywords: list[str] = field(default_factory=list)  # markers and other keywords ``-k`` matches


@dataclass
class Result:
    """A test's latest state. ``status`` is one of ``STATUSES``; times are seconds since the epoch."""

    test: Test
    status: str = "pending"
    exception: str | None = None  # the failure, as pytest reported it
    reason: str | None = None  # why it was skipped
    progress: float | None = None  # 0 to 1, while running
    started: float | None = None
    finished: float | None = None

    @property
    def done(self) -> bool:
        return self.status not in ("pending", "running")

    @property
    def duration(self) -> float | None:
        return None if self.started is None or self.finished is None else self.finished - self.started


@dataclass(frozen=True)
class Summary:
    """How many tests have each status, and whether the run is over."""

    passed: int = 0
    failed: int = 0
    skipped: int = 0
    running: int = 0
    pending: int = 0
    done: bool = False

    @property
    def total(self) -> int:
        return self.passed + self.failed + self.skipped + self.running + self.pending


@dataclass
class _Worker:
    offset: int = 0
    rest: bytes = b""
    finished: bool = False


class Run:
    """A run's directory, ``<source>/<project>/<run>/``. Call ``refresh()`` (or ``wait()``) to see what changed
    since: only the new part of each status file is read, so following a run on a network share is cheap."""

    def __init__(self, path: str | Path, chunk: int = 1024 * 1024) -> None:
        self.path = Path(path)
        self.name, self.project = self.path.name, self.path.parent.name
        self._chunk = chunk
        self._plan: dict[str, Any] | None = None
        self._results: dict[str, Result] = {}
        self._workers: list[_Worker] = []
        self.row_params: list[str] = []
        self.started_at: float | None = None
        self.collect_errors: list[dict[str, str]] = []

    def __repr__(self) -> str:
        return f"Run({str(self.path)!r})"

    # --- The plan ---

    @property
    def planned(self) -> bool:
        """Whether the plan was written (it is once collection finishes)."""
        return self._load_plan()

    def _load_plan(self) -> bool:
        if self._plan is None:
            try:
                plan: dict[str, Any] = json.loads((self.path / PLAN).read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError):  # not yet, or still being written
                return False
            self._plan = plan
            # the original plugin's plans group tests by module and name logs `log_file`, some list them flat
            raw = [
                *plan.get("tests", []),
                *([{**t, "module": m} for m, ts in plan.get("groups", {}).items() for t in ts]),
            ]
            for t in raw:
                test = Test(
                    id=t["id"],
                    name=t.get("name", t["id"]),
                    module=t.get("module") or t["id"].split("::")[0],
                    params=t.get("params") or {},
                    log_file=t.get("log_file") or t.get("log", ""),
                    keywords=t.get("keywords", []),
                )
                self._results[test.id] = Result(test)
            self.row_params = plan.get("row_params", [])
            self.started_at = plan.get("started_at")
            self.collect_errors = plan.get("errors", [])
            self._workers = [_Worker() for _ in range(plan.get("worker_count", 1))]
        return True

    @property
    def title(self) -> str | None:
        """The run's display name, from its ``metadata.toml`` (as the original server read it)."""
        try:
            name = tomllib.loads((self.path / METADATA).read_text(encoding="utf-8")).get("name")
        except (OSError, tomllib.TOMLDecodeError):
            return None
        return name if isinstance(name, str) else None

    @property
    def tests(self) -> dict[str, Test]:
        """The planned tests, by node id (empty until the plan is written)."""
        self._load_plan()
        return {id: result.test for id, result in self._results.items()}

    # --- Results ---

    def refresh(self) -> bool:
        """Reads what the status files gained since the last call; returns whether anything did."""
        if not self._load_plan():
            return False
        changed = False
        for index, worker in enumerate(self._workers):
            if worker.finished:
                continue
            try:
                with open(self.path / status_file(index), "rb") as file:
                    file.seek(worker.offset)
                    while chunk := file.read(self._chunk):
                        worker.offset += len(chunk)
                        changed |= self._parse(worker, chunk)
            except FileNotFoundError:  # the worker didn't start yet
                continue
        return changed

    def _parse(self, worker: _Worker, chunk: bytes) -> bool:
        data = worker.rest + chunk
        end = data.rfind(b"\n") + 1
        worker.rest = data[end:]
        changed = False
        for line in data[:end].splitlines():
            try:
                event: StatusEvent = json.loads(line)
            except json.JSONDecodeError:
                continue
            worker.finished = event["type"] == "session_finish"  # a rerun may append to the same file
            changed = True
            if event["type"] == "plan_update":
                self._update_plan(event)
            elif (result := self._results.get(event.get("test", ""))) is not None:
                self._results[result.test.id] = apply(result, event)
        return changed

    def _update_plan(self, event: StatusEvent) -> None:
        if "row_params" in event:
            self.row_params = event["row_params"]
        result = self._results.get(event.get("test", ""))
        if result is not None:
            test = result.test
            test.name, test.module = event.get("name", test.name), event.get("module", test.module)
            test.params = {**test.params, **event.get("params", {})}

    def result(self, test: str) -> Result:
        """A test's latest result, by node id (``KeyError`` if it isn't in the plan)."""
        self.refresh()
        return self._results[test]

    def results(self) -> dict[str, Result]:
        """Every test's latest result, by node id."""
        self.refresh()
        return dict(self._results)

    def failures(self) -> list[Result]:
        return [result for result in self.results().values() if result.status == "failed"]

    @property
    def summary(self) -> Summary:
        results = self.results()
        counts = {status: 0 for status in STATUSES}
        for result in results.values():
            counts[result.status] += 1
        return Summary(**counts, done=self._done())

    @property
    def done(self) -> bool:
        self.refresh()
        return self._done()

    def _done(self) -> bool:
        if self._plan is None:
            return False
        return all(w.finished for w in self._workers) or all(r.done for r in self._results.values())

    def wait(self, timeout: float | None = None, poll: float = 1.0) -> Summary:
        """Waits for the run to finish (for its plan first, if it wasn't written yet), checking every ``poll``
        seconds, and returns its summary; raises ``TimeoutError`` after ``timeout`` seconds."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while not self.done:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"{self.path} didn't finish within {timeout} seconds")
            time.sleep(poll if deadline is None else max(0.0, min(poll, deadline - time.monotonic())))
        return self.summary

    # --- Logs ---

    def log(self, test: str) -> Log:
        """A test's log, by node id: everything it logged or printed."""
        file = self.tests[test].log_file
        return Log(self.path / file, finished=lambda: self.result(test).done)

    def session_log(self, worker: int = 0) -> Log:
        """A worker's output outside of tests."""
        return Log(self.path / session_log_file(worker), finished=lambda: self.done)


def apply(result: Result, event: StatusEvent) -> Result:
    """A test's result after one of its status events (as the web app applies them)."""
    kind, outcome = event["type"], event.get("outcome")
    status = "failed" if outcome == "error" else (outcome or "passed")
    if kind == "start":
        return Result(result.test, "running", progress=0.0, started=event.get("time"))
    if kind == "progress":
        return replace(result, progress=event.get("percentage"))
    if kind == "finish":
        return replace(result, status=status, progress=None, finished=event.get("time"))
    if status == "failed":
        exception = "\n\n".join(e for e in (result.exception, event.get("exception")) if e)
        return replace(result, status="failed", exception=exception)
    if status == "skipped":
        return replace(result, status="skipped", reason=event.get("reason"))
    return result
