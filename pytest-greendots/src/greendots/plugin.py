"""Writes GreenDots run data, in the original plugin's layout: ``plan.json``, ``status.<worker>.jsonl``,
a ``<test>.log.jsonl`` per test and a ``session.<worker>.log.jsonl`` for output outside of tests."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import operator
import os
import threading
import time
import warnings
from collections.abc import Generator, Iterable, Iterator
from pathlib import Path
from typing import Any, TypeVar

import pytest

from . import hooks
from .capture import Output, Records
from .hooks import PlanTest

T = TypeVar("T")
PLUGIN_NAME = "greendots-writer"
SEVERITY = {"passed": 0, "skipped": 1, "failed": 2}
FILENAME_SPECIAL_CHARS = '<>"/\\|?*'


def pytest_addhooks(pluginmanager: pytest.PytestPluginManager) -> None:
    pluginmanager.add_hookspecs(hooks)


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("greendots")
    group.addoption(
        "--greendots", "--livelog", dest="greendots", metavar="DIR", help="write run data to DIR."
    )
    group.addoption(
        "--greendots-worker-id",
        "--livelog-worker-id",
        dest="greendots_worker_id",
        type=int,
        default=0,
        help="index of this pytest process among those writing to DIR (default: 0).",
    )
    group.addoption(
        "--greendots-worker-count",
        "--livelog-worker-count",
        dest="greendots_worker_count",
        type=int,
        default=1,
        help="number of pytest processes writing to DIR (default: 1). Each may use xdist.",
    )
    group.addoption(
        "--greendots-skip-plan",
        "--skip-plan-creation",
        dest="greendots_skip_plan",
        action="store_true",
        help="don't write plan.json, use the existing one.",
    )
    parser.addini(
        "greendots_row_params",
        type="args",
        help="test params shown as matrix rows (default: the params all parametrized tests share).",
    )
    parser.addini("greendots_log_level", default="DEBUG", help="minimal level of logs to record.")


@pytest.hookimpl(trylast=True)
def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "greendots(name, module, params): change how a test is shown in GreenDots."
    )
    directory = config.getoption("greendots")
    if not directory:
        return
    shard: int = config.option.greendots_worker_id
    shards: int = config.option.greendots_worker_count
    xdist_worker = os.environ.get("PYTEST_XDIST_WORKER")
    # the xdist controller, when xdist really starts workers: --dist alone (e.g. in addopts) doesn't
    distributed = getattr(config.option, "dist", "no") != "no" and getattr(config.option, "tx", None)
    if xdist_worker is None and distributed and not config.option.collectonly:
        config.pluginmanager.register(CrashRecorder(Path(directory), shard), PLUGIN_NAME)
        return
    per_shard = int(os.environ.get("PYTEST_XDIST_WORKER_COUNT", "1"))
    worker = shard * per_shard + int((xdist_worker or "gw0")[2:])
    config.pluginmanager.register(Writer(config, Path(directory), worker, shards * per_shard), PLUGIN_NAME)


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


def format_param(value: Any) -> Any:
    for method in ("__greendots_format__", "__livelog_format__"):
        if hasattr(value, method):
            return getattr(value, method)()
    return value if isinstance(value, (str, int, float, bool)) else str(value)


def log_level(value: str) -> int:
    return int(value) if value.isdigit() else logging.getLevelName(value.upper())


class LogFile:
    """One log as JSON lines: ``{"name", "level", "time", "message"}``."""

    def __init__(self, path: Path, append: bool = False) -> None:
        self.file = open(path, "a" if append else "w", encoding="utf-8")  # noqa: SIM115
        self.lock = threading.Lock()

    def write(self, name: str, level: str, message: str, created: float | None = None) -> None:
        entry = {"name": name, "level": level, "time": created or time.time(), "message": message}
        line = json.dumps(entry) + "\n"
        with self.lock:
            if not self.file.closed:
                self.file.write(line)
                self.file.flush()

    def close(self) -> None:
        with self.lock:
            self.file.close()

    def __enter__(self) -> LogFile:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class Writer:
    def __init__(self, config: pytest.Config, directory: Path, worker: int, workers: int) -> None:
        self.config, self.dir, self.worker, self.workers = config, directory, worker, workers
        directory.mkdir(parents=True, exist_ok=True)
        self.status = open(directory / f"status.{worker}.jsonl", "a", encoding="utf-8")  # noqa: SIM115
        self.lock = threading.Lock()
        self.session_log = LogFile(directory / f"session.{worker}.log.jsonl", append=True)
        self.log: LogFile | None = None
        self.test: str | None = None
        self.outcome = "passed"
        self.logged: set[str] = set()  # tests whose log was started, so reruns append to it
        self.errors: list[dict[str, str]] = []
        self.row_params: list[str] | None = None
        self.records = Records(self.write, log_level(config.getini("greendots_log_level")))
        self.output = Output(self.write)

    def write(self, name: str, level: str, message: str, created: float | None = None) -> None:
        """Records output in the running test's log, or the session log outside of tests."""
        (self.log or self.session_log).write(name, level, message, created)

    def emit(self, type: str, **fields: object) -> None:
        line = json.dumps({"type": type, **fields, "time": time.time()}, default=str)
        with self.lock:
            self.status.write(line + "\n")
            self.status.flush()

    def set_row_params(self, row_params: Iterable[str] | None) -> None:
        if row_params is not None and list(row_params) != self.row_params:
            self.row_params = list(row_params)
            self.emit("plan_update", row_params=self.row_params)

    def describe(self, item: pytest.Item) -> PlanTest:
        callspec = getattr(item, "callspec", None)
        cls, module = getattr(item, "cls", None), getattr(item, "module", None)
        name = getattr(item, "originalname", item.name)
        test: PlanTest = {
            "id": item.nodeid,
            "name": f"{cls.__name__}.{name}" if cls else name,
            "module": module.__name__ if module else item.nodeid.split("::")[0],
            "params": dict(callspec.params) if callspec else {},
            "log_file": log_name(item.nodeid),
        }
        marker = item.get_closest_marker("greendots")
        if marker:
            test["name"] = marker.kwargs.get("name", test["name"])
            test["module"] = marker.kwargs.get("module", test["module"])
            test["params"].update(marker.kwargs.get("params", {}))
        self.config.hook.pytest_greendots_test(item=item, test=test)
        test["params"] = {key: format_param(value) for key, value in test["params"].items()}
        return test

    # --- Collection ---

    @pytest.hookimpl(hookwrapper=True, trylast=True)
    def pytest_make_collect_report(self) -> Generator[None, None, None]:
        with self.output:  # e.g. prints while importing test modules
            yield

    def pytest_collectreport(self, report: pytest.CollectReport) -> None:
        if report.failed:
            self.errors.append({"id": report.nodeid, "exception": report.longreprtext})
            self.write("pytest", "ERROR", f"Error collecting {report.nodeid}\n{report.longreprtext}")

    def pytest_collection_finish(self, session: pytest.Session) -> None:
        if self.worker != 0 or self.config.getoption("greendots_skip_plan"):
            return
        tests = [self.describe(item) for item in session.items]
        # rows: the params shared by all parametrized tests (GreenDots shows the rest in matrices of their own)
        parametrized = [t for t in tests if t["params"]]
        first = parametrized[0]["params"] if parametrized else {}
        shared = [p for p in first if all(p in t["params"] for t in parametrized)]
        groups: dict[str, list[dict[str, Any]]] = {}
        for test in tests:  # the original layout: tests grouped by module
            groups.setdefault(test["module"], []).append({k: v for k, v in test.items() if k != "module"})
        plan = {
            "version": 2,
            "started_at": time.time(),
            "worker_count": self.workers,
            "row_params": self.config.getini("greendots_row_params") or shared,
            "groups": groups,
            "errors": self.errors,
        }
        self.config.hook.pytest_greendots_plan(session=session, plan=plan)
        temporary = self.dir / f"plan.json.{os.getpid()}"
        temporary.write_text(json.dumps(plan, indent=1, default=str), encoding="utf-8")
        os.replace(temporary, self.dir / "plan.json")  # readers never see a partial plan

    # --- Running tests ---

    def pytest_runtest_logstart(self, nodeid: str) -> None:
        self.test, self.outcome = nodeid, "passed"
        self.log = LogFile(self.dir / log_name(nodeid), append=nodeid in self.logged)
        self.logged.add(nodeid)
        self.emit("start", test=nodeid)

    @pytest.hookimpl(hookwrapper=True, trylast=True)
    def pytest_runtest_call(self, item: pytest.Item) -> Generator[None, None, None]:
        """Innermost in each test phase, so pytest's own capturing is already set up."""
        uses_capfd = {"capfd", "capfdbinary"} & set(getattr(item, "fixturenames", ()))
        with self.output(fds=not uses_capfd):
            yield

    pytest_runtest_setup = pytest_runtest_teardown = pytest_runtest_call

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        fields = {}
        if report.failed:
            fields["exception"] = report.longreprtext
            self.write("pytest", "ERROR", report.longreprtext)
        elif report.skipped:
            longrepr = report.longrepr
            reason = longrepr[2] if isinstance(longrepr, tuple) else getattr(report, "wasxfail", "")
            fields["reason"] = reason
            self.write("pytest", "WARNING", f"skipped: {reason}")
        if SEVERITY.get(report.outcome, 0) > SEVERITY[self.outcome]:
            self.outcome = report.outcome
        self.emit(report.when, test=report.nodeid, outcome=report.outcome, **fields)

    def pytest_runtest_logfinish(self, nodeid: str) -> None:
        self.finish(nodeid, self.outcome)

    def finish(self, nodeid: str, outcome: str) -> None:
        log, self.log, self.test = self.log, None, None
        if log is not None:
            log.close()
        self.emit("finish", test=nodeid, outcome=outcome)

    def pytest_warning_recorded(self, warning_message: warnings.WarningMessage, nodeid: str) -> None:
        w = warning_message
        text = warnings.formatwarning(w.message, w.category, w.filename, w.lineno, w.line).rstrip()
        if nodeid and nodeid != self.test:  # pytest reports a test's warnings after it finished
            with LogFile(self.dir / log_name(nodeid), append=True) as log:
                log.write("warnings", "WARNING", text)
        else:
            self.write("warnings", "WARNING", text)

    def pytest_internalerror(self, excrepr: object) -> None:
        self.write("pytest", "CRITICAL", f"Internal error\n{excrepr}")

    def pytest_sessionfinish(self, exitstatus: int) -> None:
        if self.test is not None:  # interrupted mid-test, e.g. by Ctrl+C
            self.write("pytest", "CRITICAL", f"Interrupted (exit status {int(exitstatus)})")
            self.finish(self.test, "failed")
        self.emit("session_finish", exitstatus=int(exitstatus))

    def pytest_unconfigure(self) -> None:
        self.records.close()
        self.output.close()
        self.session_log.close()
        self.status.close()


class CrashRecorder:
    """On the xdist controller: records the tests whose worker crashed, since the worker can't."""

    def __init__(self, directory: Path, shard: int) -> None:
        self.dir, self.shard = directory, shard

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        node, when = getattr(report, "node", None), str(report.when)
        if when != "???" or node is None:  # xdist's report for a crashed worker's test
            return
        info = node.workerinput
        worker = self.shard * int(info["workercount"]) + int(info["workerid"][2:])
        events = [
            {"type": "call", "outcome": "failed", "exception": report.longreprtext},
            {"type": "finish", "outcome": "failed"},
        ]
        with open(self.dir / f"status.{worker}.jsonl", "a", encoding="utf-8") as status:
            status.writelines(
                json.dumps({**event, "test": report.nodeid, "time": time.time()}) + "\n" for event in events
            )
        with LogFile(self.dir / log_name(report.nodeid), append=True) as log:
            log.write("pytest", "CRITICAL", report.longreprtext)


# --- Fixtures ---


class Progress:
    """Reports a running test's progress (0 to 1), throttled to 1% steps."""

    def __init__(
        self,
        writer: Writer | None,
        test: str,
        parent: Progress | None = None,
        base: float = 0.0,
        span: float = 1.0,
    ) -> None:
        self._writer, self._test, self._parent = writer, test, parent
        self._base, self._span = base, span
        self._last: float | None = None

    def __call__(self, fraction: float) -> None:
        fraction = min(max(float(fraction), 0.0), 1.0)
        if self._parent is not None:
            self._parent(self._base + fraction * self._span)
        elif (
            self._writer is not None
            and fraction != self._last
            and (self._last is None or fraction == 1.0 or abs(fraction - self._last) >= 0.01)
        ):
            self._last = fraction
            self._writer.emit("progress", test=self._test, percentage=fraction)

    def split(self, count: int) -> list[Progress]:
        """Splits into ``count`` equally weighted parts, each reporting from 0 to 1."""
        return [Progress(self._writer, self._test, self, i / count, 1 / count) for i in range(count)]

    def track(self, iterable: Iterable[T], total: int | None = None) -> Iterator[T]:
        """Yields from ``iterable`` while reporting progress, like ``tqdm``."""
        total = total or operator.length_hint(iterable)  # 0 when unknown, e.g. for generators
        for index, item in enumerate(iterable):
            if total:
                self(index / total)
            yield item
        self(1.0)

    def sleep(self, seconds: float) -> None:
        """Sleeps for ``seconds``, filling the progress meanwhile."""
        start = time.monotonic()
        while (elapsed := time.monotonic() - start) < seconds:
            self(elapsed / seconds)
            time.sleep(min(seconds / 100, seconds - elapsed))
        self(1.0)

    def done(self) -> None:
        self(1.0)


class TestInfo:
    """Changes how the running test is shown, e.g. ``greendots.update(params={"board": board})``."""

    __test__ = False  # not a test class

    def __init__(self, writer: Writer | None, test: str) -> None:
        self._writer, self._test = writer, test

    def update(
        self, *, name: str | None = None, module: str | None = None, params: dict[str, Any] | None = None
    ) -> None:
        """Renames the test, moves it to another column group, or merges ``params`` into its params."""
        fields: dict[str, Any] = {"name": name, "module": module}
        if params:
            fields["params"] = {key: format_param(value) for key, value in params.items()}
        fields = {key: value for key, value in fields.items() if value is not None}
        if self._writer is not None and fields:
            self._writer.emit("plan_update", test=self._test, **fields)

    def set_row_params(self, *params: str) -> None:
        """Changes which params are shown as matrix rows, for the whole run."""
        if self._writer is not None:
            self._writer.set_row_params(params)


def _writer(request: pytest.FixtureRequest) -> Writer | None:
    plugin = request.config.pluginmanager.get_plugin(PLUGIN_NAME)
    return plugin if isinstance(plugin, Writer) else None


def _progress(request: pytest.FixtureRequest) -> Progress:
    """Report the test's progress: ``greendots_progress(0.5)``, ``.track(xs)``, ``.split(n)``..."""
    return Progress(_writer(request), request.node.nodeid)


greendots_progress = pytest.fixture(_progress, name="greendots_progress")
live_progress = pytest.fixture(_progress, name="live_progress")  # the original plugin's name


@pytest.fixture
def greendots(request: pytest.FixtureRequest) -> TestInfo:
    """Change how the running test is shown: ``greendots.update(name=..., module=..., params=...)``."""
    return TestInfo(_writer(request), request.node.nodeid)


@pytest.fixture(scope="session")
def greendots_row_params() -> Iterable[str] | None:
    """Override this fixture (e.g. in a conftest.py) to choose the params shown as matrix rows."""
    return None


@pytest.fixture(autouse=True)
def _greendots_row_params(request: pytest.FixtureRequest) -> None:
    writer = _writer(request)
    if writer is not None:
        writer.set_row_params(request.getfixturevalue("greendots_row_params"))
