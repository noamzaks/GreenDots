"""The JSON in a run's files, as written by pytest-greendots and the original GreenDots plugin."""

import sys
from typing import Any, Literal

if sys.version_info >= (3, 11):
    from typing import NotRequired, TypedDict
else:  # whose TypedDict knows NotRequired
    from typing_extensions import NotRequired, TypedDict

Outcome = Literal["passed", "failed", "skipped"]
Phase = Literal["setup", "call", "teardown"]
Status = Literal["passed", "failed", "skipped", "running", "pending"]


class PlanTest(TypedDict):
    """A test's entry in the plan (``module`` is the key of its group in ``plan.json``)."""

    id: str  # the pytest node id
    name: str  # the matrix column...
    module: str  # ... and column group
    params: dict[str, Any]  # shown as rows or columns
    log_file: str
    keywords: NotRequired[list[str]]  # what ``-k`` matches besides the names in the id: markers...


class CollectError(TypedDict):
    id: str
    exception: str


class Plan(TypedDict):
    """``plan.json``: written once, when collection finishes."""

    version: NotRequired[int]  # missing in the original plugin's plans
    started_at: NotRequired[float]
    worker_count: int
    row_params: list[str]
    groups: dict[str, list[dict[str, Any]]]  # tests by module, without their ``module``
    errors: NotRequired[list[CollectError]]


class StatusEvent(TypedDict):
    """A line of ``status.<worker>.jsonl``. Which fields it has depends on its ``type``:

    - ``start`` and ``finish`` (with the test's ``outcome``) bracket a test, ``setup``, ``call`` and ``teardown``
      report its phases (``outcome``, and ``exception`` or ``reason``), ``progress`` its ``percentage`` (0 to 1);
    - ``plan_update`` changes the plan: ``row_params``, or a ``test``'s ``name``, ``module`` and ``params``;
    - ``session_finish`` ends the worker's session (a rerun may append another one), with its ``exitstatus``.
    """

    type: str
    time: float
    test: NotRequired[str]
    outcome: NotRequired[str]  # an Outcome, or "error" in the original plugin's
    exception: NotRequired[str]
    reason: NotRequired[str]
    percentage: NotRequired[float]
    exitstatus: NotRequired[int]
    row_params: NotRequired[list[str]]
    name: NotRequired[str]
    module: NotRequired[str]
    params: NotRequired[dict[str, Any]]


class LogRecord(TypedDict):
    """A line of a log: a logger's record, or output (``name`` is then e.g. ``stdout``)."""

    name: str
    level: str
    time: float
    message: str
