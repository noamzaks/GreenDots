"""Writes lots of sample runs, as the plugin would, to try the web app at scale.

python example/samples.py DIR          # many projects and runs, finished, broken and huge ones
python example/samples.py DIR --live   # then keeps writing runs into DIR/live, as they happen
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
from pathlib import Path

random.seed(7)
NOW = time.time()
TRACEBACK = """    def test_{name}():
        result = run({arg!r})
>       assert result.code == 0, result.stderr
E       AssertionError: exited with {code}: {error}
E       assert {code} == 0

tests/{module}.py:{line}: AssertionError"""
ERRORS = ["timed out waiting for prompt", "connection refused", "segmentation fault", "checksum mismatch"]
LEVELS = ["DEBUG", "INFO", "INFO", "INFO", "WARNING", "ERROR"]


def log_name(test_id: str) -> str:
    return test_id.replace("/", "_") + ".log.jsonl"


def line(**event: object) -> str:
    return json.dumps(event) + "\n"


def make_tests(modules: int, per_module: int, params: dict[str, list[str]]) -> list[dict[str, object]]:
    """Tests over the product of `params`, `per_module` per module."""
    combos: list[dict[str, str]] = [{}]
    for key, values in params.items():
        combos = [{**combo, key: value} for combo in combos for value in values]
    tests: list[dict[str, object]] = []
    for m in range(modules):
        module = f"test_{['boot', 'net', 'disk', 'api', 'ui', 'auth', 'sched', 'mem'][m % 8]}{m // 8 or ''}"
        for t in range(per_module):
            name = f"test_{['start', 'stop', 'restart', 'upgrade', 'load', 'limits', 'edge', 'smoke'][t % 8]}_{t}"
            for combo in combos:
                suffix = f"[{'-'.join(combo.values())}]" if combo else ""
                test_id = f"tests/{module}.py::{name}{suffix}"
                tests.append({"id": test_id, "name": name, "module": module, "params": combo})
    return tests


def write_run(
    directory: Path,
    tests: list[dict[str, object]],
    workers: int,
    started: float,
    fail: float = 0.05,
    skip: float = 0.03,
    finished: float = 1.0,
    row_params: list[str] | None = None,
    title: str | None = None,
    log_lines: int = 3,
) -> None:
    """A run that started at `started`; `finished` of its tests are over (the rest never will be)."""
    directory.mkdir(parents=True, exist_ok=True)
    groups: dict[str, list[dict[str, object]]] = {}
    for test in tests:
        entry = {k: v for k, v in test.items() if k != "module"} | {"log_file": log_name(str(test["id"]))}
        groups.setdefault(str(test["module"]), []).append(entry)
    plan = {"version": 2, "started_at": started, "worker_count": workers, "row_params": row_params or []}
    (directory / "plan.json").write_text(json.dumps(plan | {"groups": groups, "errors": []}))
    if title:
        (directory / "metadata.toml").write_text(f'name = "{title}"\n')
    statuses: list[list[str]] = [[] for _ in range(workers)]
    clocks = [started] * workers
    over = int(len(tests) * finished)
    for index, test in enumerate(tests[: over + workers] if finished < 1 else tests):
        worker = index % workers
        test_id = str(test["id"])
        now = clocks[worker]
        events = statuses[worker]
        events.append(line(type="start", test=test_id, time=now))
        duration = random.expovariate(1 / 2)
        logs = [
            line(
                name="harness",
                level=random.choice(LEVELS),
                time=now + i * duration / log_lines,
                message=f"step {i}",
            )
            for i in range(random.randint(1, log_lines))
        ]
        (directory / log_name(test_id)).write_text("".join(logs))
        if index >= over:  # still running when the run stopped
            events.append(line(type="progress", test=test_id, percentage=random.random(), time=now + 1))
            continue
        roll = random.random()
        outcome = "failed" if roll < fail else "skipped" if roll < fail + skip else "passed"
        call: dict[str, object] = {
            "type": "call",
            "test": test_id,
            "outcome": outcome,
            "time": now + duration,
        }
        if outcome == "failed":
            call["exception"] = TRACEBACK.format(
                name=test["name"],
                arg=test_id,
                code=random.randint(1, 255),
                error=random.choice(ERRORS),
                module=test["module"],
                line=random.randint(10, 400),
            )
        if outcome == "skipped":
            call["reason"] = "not supported on this target"
        events.append(line(type="setup", test=test_id, outcome="passed", time=now + 0.01))
        events.append(line(**call))
        events.append(line(type="finish", test=test_id, outcome=outcome, time=now + duration + 0.01))
        clocks[worker] = now + duration + 0.02
    for worker, events in enumerate(statuses):
        if finished >= 1:
            events.append(line(type="session_finish", exitstatus=0, time=clocks[worker]))
        (directory / f"status.{worker}.jsonl").write_text("".join(events))
        (directory / f"session.{worker}.log.jsonl").write_text(
            line(name="session", level="INFO", time=started, message=f"worker {worker} ready")
        )
    end = max(clocks)
    for path in directory.iterdir():
        os.utime(path, (end, end))
    os.utime(directory, (end, end))


def project(
    root: Path, name: str, runs: int, spacing: float, title: str | None = None, **kwargs: object
) -> None:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    if title:
        (directory / "metadata.toml").write_text(f'name = "{title}"\n')
    for index in range(runs):
        started = NOW - (runs - index) * spacing
        options = dict(kwargs)
        if random.random() < 0.05:
            options["finished"] = random.random()  # interrupted
        write_run(directory / f"{name}-{index + 1}", started=started, **options)  # type: ignore[arg-type]
    print(f"{name}: {runs} runs")


def broken(root: Path) -> None:
    """Runs a share can hold however odd: each must show what it can, and nothing may crash."""
    base = root / "broken"
    tests = make_tests(2, 5, {})
    (base / "empty").mkdir(parents=True, exist_ok=True)
    write_run(base / "no-status", tests, 2, NOW - 9000)
    for status in (base / "no-status").glob("status.*"):
        status.unlink()
    write_run(base / "bad-plan", tests, 1, NOW - 8000)
    (base / "bad-plan" / "plan.json").write_text('{"version": 2, "groups": {')
    write_run(base / "partial-line", tests, 1, NOW - 7000)
    with (base / "partial-line" / "status.0.jsonl").open("a") as file:
        file.write('{"type": "start", "test": "tests/test_boot.py::te')
    write_run(base / "unknown-tests", tests, 1, NOW - 6000)
    with (base / "unknown-tests" / "status.0.jsonl").open("a") as file:
        file.write(line(type="finish", test="tests/nowhere.py::test_gone", outcome="failed", time=NOW))
    write_run(base / "missing-logs", tests, 1, NOW - 5000)
    for log in (base / "missing-logs").glob("tests_*.log.jsonl"):
        log.unlink()
    write_run(base / "crashed-worker", tests, 3, NOW - 4000, finished=0.5)
    write_run(base / "collect-errors", tests, 1, NOW - 3000)
    plan = json.loads((base / "collect-errors" / "plan.json").read_text())
    plan["errors"] = [{"id": "tests/test_broken.py", "exception": "ImportError: No module named 'nope'"}] * 3
    (base / "collect-errors" / "plan.json").write_text(json.dumps(plan))
    (base / "not-a-run.txt").write_text("a stray file")
    print("broken: 9 runs")


def logs(root: Path) -> None:
    """Logs that are huge, have huge lines, or aren't ours."""
    base = root / "logs"
    tests = make_tests(1, 6, {})
    write_run(base / "huge-logs", tests, 1, NOW - 3600)
    run = base / "huge-logs"
    files = [run / log_name(str(test["id"])) for test in tests]
    with files[0].open("w") as file:  # 60 MB of lines
        for i in range(600_000):
            file.write(
                line(name="spam", level=LEVELS[i % 6], time=NOW + i / 1000, message=f"line {i} " + "x" * 60)
            )
    with files[1].open("w") as file:  # one 8 MB line between small ones
        file.write(line(name="dump", level="INFO", time=NOW, message="before"))
        file.write(
            line(name="dump", level="INFO", time=NOW, message="é😀" * 1_000_000 + "end of the huge line")
        )
        file.write(line(name="dump", level="INFO", time=NOW, message="after"))
    files[2].write_text("plain text, not JSON\n\x1b[31mcolored\x1b[0m\n" + "no newline at the end")
    files[3].write_bytes(bytes(range(256)) * 100)
    files[4].write_text("")
    with files[5].open("w") as file:  # a colored terminal's output, like pytest's
        for message in [
            "\x1b[1m============ test session starts ============\x1b[0m",
            "tests/test_boot.py \x1b[32m.\x1b[0m\x1b[32m.\x1b[0m\x1b[31mF\x1b[0m\x1b[33ms\x1b[0m",
            "\x1b[31m\x1b[1mFAILED\x1b[0m tests/test_boot.py::test_edge - \x1b[1;31mAssertionError\x1b[0m",
            "\x1b[38;5;208m256 colors\x1b[0m and \x1b[38;2;120;80;220mtrue color\x1b[0m, \x1b[4munderlined\x1b[0m",
            "\x1b[2mdim\x1b[0m \x1b[3mitalic\x1b[0m \x1b[42;30m on green \x1b[0m\x1b[K",
            "\x1b[31m\x1b[1m===== 1 failed, \x1b[32m2 passed\x1b[31m, \x1b[33m1 skipped\x1b[31m in 0.12s =====\x1b[0m",
        ]:
            file.write(line(name="pytest", level="INFO", time=NOW, message=message))
    print("logs: 1 run")


def live(root: Path) -> None:
    """Writes runs into DIR/live forever, as a real one would: tests take a while and log as they go."""
    base = root / "live"
    for number in range(len(list(base.glob("live-*"))) + 1, 1_000_000):
        directory = base / f"live-{number}"
        directory.mkdir(parents=True, exist_ok=True)
        tests = make_tests(4, 6, {"arch": ["x86", "arm"]})
        workers = 4
        groups: dict[str, list[dict[str, object]]] = {}
        for test in tests:
            entry = {k: v for k, v in test.items() if k != "module"} | {"log_file": log_name(str(test["id"]))}
            groups.setdefault(str(test["module"]), []).append(entry)
        plan = {"version": 2, "started_at": time.time(), "worker_count": workers, "row_params": ["arch"]}
        (directory / "plan.json").write_text(json.dumps(plan | {"groups": groups, "errors": []}))
        queues = [tests[w::workers] for w in range(workers)]
        status = [(directory / f"status.{w}.jsonl").open("a", buffering=1) for w in range(workers)]
        running: list[tuple[str, int, int] | None] = [None] * workers  # test, steps done, steps
        while any(queues) or any(running):
            for worker in range(workers):
                if running[worker] is None and queues[worker]:
                    test_id = str(queues[worker].pop(0)["id"])
                    status[worker].write(line(type="start", test=test_id, time=time.time()))
                    running[worker] = (test_id, 0, random.randint(4, 30))
                current = running[worker]
                if current is None:
                    continue
                test_id, done, steps = current
                with (directory / log_name(test_id)).open("a") as log:
                    for _ in range(random.randint(1, 4)):
                        level = random.choice(LEVELS)
                        message = (
                            f"\x1b[36mstep {done}\x1b[0m: {random.choice(ERRORS)}"
                            if level == "ERROR"
                            else f"step {done}"
                        )
                        log.write(line(name="live", level=level, time=time.time(), message=message))
                status[worker].write(
                    line(type="progress", test=test_id, percentage=(done + 1) / steps, time=time.time())
                )
                if done + 1 < steps:
                    running[worker] = (test_id, done + 1, steps)
                    continue
                outcome = "failed" if random.random() < 0.1 else "passed"
                exception = TRACEBACK.format(
                    name="test", arg=test_id, code=1, error=random.choice(ERRORS), module="live", line=42
                )
                extra = (
                    {"exception": "\n".join([exception] * 20)} if outcome == "failed" else {}
                )  # a long one
                status[worker].write(
                    line(type="call", test=test_id, outcome=outcome, time=time.time(), **extra)
                )
                status[worker].write(line(type="finish", test=test_id, outcome=outcome, time=time.time()))
                running[worker] = None
            time.sleep(0.5)
        for file in status:
            file.write(line(type="session_finish", exitstatus=0, time=time.time()))
            file.close()
        print(f"live: live-{number} done")
        time.sleep(120)


def main() -> None:
    root = Path(sys.argv[1])
    if "--live" in sys.argv:
        live(root)
        return
    arch = {"arch": ["x86", "arm", "riscv"]}
    project(
        root,
        "kernel",
        300,
        3600,
        "Linux kernel",
        tests=make_tests(5, 8, arch),
        workers=4,
        row_params=["arch"],
    )
    boards = {"board": ["rpi4", "rpi5", "jetson", "imx8"], "variant": ["debug", "release"]}
    firmware = make_tests(8, 9, boards)
    project(root, "firmware", 80, 6 * 3600, "Firmware", tests=firmware, workers=8, row_params=["board"])
    project(root, "web-e2e", 150, 1800, tests=make_tests(4, 10, {}), workers=2, fail=0.15)
    project(root, "nightly", 400, 86400, "Nightly", tests=make_tests(1, 10, {}), workers=1)
    giant = make_tests(16, 25, {"target": [f"t{i}" for i in range(10)], "mode": ["a", "b", "c", "d", "e"]})
    project(
        root, "giant", 3, 86400, "Giant matrix", tests=giant, workers=32, row_params=["target"], log_lines=1
    )
    for team in range(1, 31):
        tests = make_tests(random.randint(1, 4), random.randint(2, 8), {})
        project(
            root,
            f"team-{team:02}",
            random.randint(3, 25),
            random.randint(1, 48) * 3600,
            tests=tests,
            workers=2,
        )
    broken(root)
    logs(root)


if __name__ == "__main__":
    main()
