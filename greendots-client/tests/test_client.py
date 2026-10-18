import json
import os
import threading
import time
from pathlib import Path

import pytest

from greendots.client import Run, Source, Summary

ORIGINAL = Path(__file__).parent / "fixtures" / "original"

TESTS = """
import logging, pytest

@pytest.mark.slow
@pytest.mark.parametrize("arch", ["x86", "arm"])
def test_build(arch):
    print(f"building for {arch}")
    logging.getLogger("build").info("done")

def test_fail():
    assert 1 == 2

def test_skip():
    pytest.skip("not today")
"""


def record(pytester: pytest.Pytester, run: str = "run-1", *args: str) -> Path:
    """Runs pytester's tests with the plugin, into ``<pytester>/source/project/<run>``."""
    directory = pytester.path / "source" / "project" / run
    pytester.runpytest("--greendots", str(directory), *args)
    return directory


def test_lists_projects_and_runs_newest_first(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(test_a=TESTS)
    first = record(pytester, "run-9")
    second = record(pytester, "run-10")
    os.utime(first, (0, 0))
    source = Source(pytester.path / "source")
    assert [project.name for project in source.projects()] == ["project"]
    runs = source.project("project").runs()
    assert [run.name for run in runs] == ["run-10", "run-9"]
    latest = source.project("project").latest()
    assert latest is not None and latest.path == second


def test_reads_results_and_summary(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(test_a=TESTS)
    run = Run(record(pytester))
    assert run.summary == Summary(passed=2, failed=1, skipped=1, done=True)
    assert run.summary.total == 4
    failed = run.result("test_a.py::test_fail")
    assert failed.status == "failed" and failed.exception is not None and "assert 1 == 2" in failed.exception
    assert failed.duration is not None and failed.duration >= 0
    assert run.result("test_a.py::test_skip").reason == "Skipped: not today"
    assert [result.test.id for result in run.failures()] == ["test_a.py::test_fail"]
    build = run.tests["test_a.py::test_build[x86]"]
    assert (build.name, build.module, build.params) == ("test_build", "test_a", {"arch": "x86"})
    assert "slow" in build.keywords
    assert run.row_params == ["arch"] and run.started_at is not None


def test_reads_logs(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(test_a=TESTS)
    run = Run(record(pytester))
    log = run.log("test_a.py::test_build[arm]")
    entries = list(log)
    assert ("stdout", "building for arm") in [(entry.name, entry.message) for entry in entries]
    assert ("build", "INFO", "done") in [(entry.name, entry.level, entry.message) for entry in entries]
    assert "building for arm" in log.text()
    assert log.tail(1) == entries[-1:]
    assert list(run.log("test_a.py::test_build[arm]").follow()) == entries  # over: returns at once
    assert run.session_log().exists


def test_tail_reads_only_the_end(tmp_path: Path) -> None:
    lines = [{"name": "stdout", "level": "INFO", "time": i, "message": f"line {i}"} for i in range(1000)]
    (tmp_path / "test.log.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))
    from greendots.client import Log

    log = Log(tmp_path / "test.log.jsonl", chunk=100)  # many small pieces, starting mid-line
    assert [entry.message for entry in log.tail(3)] == ["line 997", "line 998", "line 999"]
    assert len(log.tail(5000)) == 1000 and log.tail(0) == []


def test_reads_runs_of_the_original_plugin() -> None:
    run = Source(ORIGINAL).project("testing").run("test1")
    summary = run.summary
    assert summary.done  # it wrote no session_finish: every test is done
    assert (summary.failed, summary.skipped, summary.total) == (1, 1, 102)
    assert run.result("test_shit.py::test_skipped").reason == "Skipped: wowza"
    assert run.tests["test_shit.py::test_something[0]"].params == {"asdf": 0}
    assert "assert False" in run.log("test_shit.py::test_failed").text()


def test_refresh_reads_only_what_was_appended(tmp_path: Path) -> None:
    test = {"id": "t.py::test", "name": "test", "params": {}, "log_file": "t.py::test.log.jsonl"}
    (tmp_path / "plan.json").write_text(
        json.dumps({"worker_count": 1, "row_params": [], "groups": {"t": [test]}})
    )
    status = tmp_path / "status.0.jsonl"
    status.write_text(json.dumps({"type": "start", "test": "t.py::test", "time": 1.0}) + "\n")
    run = Run(tmp_path)
    assert run.refresh() and not run.refresh()  # nothing new the second time
    assert run.result("t.py::test").status == "running" and not run.done
    with open(status, "a") as file:
        file.write(json.dumps({"type": "finish", "test": "t.py::test", "outcome": "passed", "time": 2.0}))
        file.flush()
        assert not run.refresh()  # a partial line waits for the rest
        file.write("\n")
    assert run.refresh() and run.result("t.py::test").status == "passed" and run.done


def test_waits_for_a_live_run_and_follows_its_logs(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(
        test_a="""
        import time

        def test_slow():
            print("one", flush=True)
            time.sleep(1.5)
            print("two", flush=True)
        """
    )
    directory = pytester.path / "source" / "project" / "live"
    thread = threading.Thread(target=lambda: pytester.runpytest_subprocess("--greendots", str(directory)))
    thread.start()
    try:
        run = Run(directory)
        with pytest.raises(TimeoutError):
            Run(pytester.path / "nowhere").wait(timeout=0.2, poll=0.05)
        while not run.planned:
            time.sleep(0.05)
        while run.result("test_a.py::test_slow").status != "running":
            time.sleep(0.05)
        followed = [entry.message for entry in run.log("test_a.py::test_slow").follow(poll=0.1)]
        assert followed[:2] == ["one", "two"]  # read live, until the test was over
        assert run.wait(timeout=60, poll=0.1) == Summary(passed=1, done=True)
    finally:
        thread.join()
