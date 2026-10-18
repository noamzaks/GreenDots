import json
from pathlib import Path

import pytest
from conftest import Record

from greendots.client.cli import main


def cli(capsys: pytest.CaptureFixture[str], *args: str) -> tuple[int, str, str]:
    capsys.readouterr()  # e.g. what recording a run printed
    code = main(list(args))
    out, err = capsys.readouterr()
    return code, out, err


def test_lists_projects_and_runs(record: Record, capsys: pytest.CaptureFixture[str]) -> None:
    source = str(record().parent.parent)
    code, out, _ = cli(capsys, "--source", source, "projects")
    assert code == 0 and out.startswith("project  source  run-1  ")
    assert "2 passed · 1 failed · 1 skipped" in out and "\033[" not in out  # no colors off a terminal
    code, out, _ = cli(capsys, "--source", source, "runs", "project")
    assert code == 0 and out.startswith("run-1  source  ") and "took" in out


def test_status_exits_with_1_on_failures(record: Record, capsys: pytest.CaptureFixture[str]) -> None:
    source = str(record().parent.parent)
    code, out, _ = cli(capsys, "--source", source, "status", "project")  # its latest run
    assert code == 1
    assert out.splitlines()[0].startswith("project/run-1 (source) · started just now · took")
    assert "✗ test_a.py::test_fail  assert 1 == 2" in out
    code, out, _ = cli(capsys, "--source", source, "--json", "status", "project/run-1")
    status = json.loads(out)
    assert (code, status["passed"], status["failed"], status["done"]) == (1, 2, 1, True)
    assert status["failures"][0]["test"]["id"] == "test_a.py::test_fail"


def test_shows_a_test_by_any_unique_part_of_its_id(
    record: Record, capsys: pytest.CaptureFixture[str]
) -> None:
    source = str(record().parent.parent)
    code, out, _ = cli(capsys, "--source", source, "result", "project", "fail")
    assert code == 0 and out.startswith("✗ failed  test_a.py::test_fail") and "assert 1 == 2" in out
    code, out, _ = cli(capsys, "--source", source, "result", "project", "test_build[x86]")
    assert "params  arch=x86" in out
    code, _, err = cli(capsys, "--source", source, "result", "project", "build")
    assert code == 2 and "2 tests match 'build'" in err and "test_a.py::test_build[arm]" in err


def test_failures_show_tracebacks(record: Record, capsys: pytest.CaptureFixture[str]) -> None:
    source = str(record().parent.parent)
    code, out, _ = cli(capsys, "--source", source, "failures", "project/run-1")
    assert code == 1 and out.startswith("✗ test_a.py::test_fail\n") and "def test_fail():" in out


def test_logs(record: Record, capsys: pytest.CaptureFixture[str]) -> None:
    source = str(record().parent.parent)
    code, out, _ = cli(capsys, "--source", source, "log", "project", "test_build[arm]")
    assert code == 0 and "stdout  building for arm" in out and "INFO     build  done" in out
    code, out, _ = cli(capsys, "--source", source, "log", "project", "test_build[arm]", "-n", "1")
    assert len(out.splitlines()) == 1 and "build  done" in out
    code, followed, _ = cli(capsys, "--source", source, "log", "project", "test_build[arm]", "-f", "-n", "1")
    assert followed == out  # the test is over: what tail shows, then nothing
    code, out, _ = cli(capsys, "--source", source, "--json", "log", "project", "test_build[arm]", "-n", "1")
    assert json.loads(out)["message"] == "done"


def test_same_run_in_two_sources(record: Record, capsys: pytest.CaptureFixture[str]) -> None:
    first, second = record(source="local").parent.parent, record(source="network").parent.parent
    code, _, err = cli(capsys, "--source", str(first), "--source", str(second), "status", "project/run-1")
    assert code == 2 and "project/run-1 is in several sources (local, network): pick one with --only" in err
    code, out, _ = cli(
        capsys,
        "--source",
        str(first),
        "--source",
        str(second),
        "--only",
        "network",
        "status",
        "project/run-1",
    )
    assert code == 1 and "(network)" in out


def test_takes_sources_from_the_web_apps_config(
    record: Record, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"sources": [{"name": "ci", "path": str(record().parent.parent)}]}))
    code, out, _ = cli(capsys, "--config", str(config), "status", "project")
    assert code == 1 and "(ci)" in out
    code, _, err = cli(capsys, "--config", str(tmp_path / "missing.json"), "projects")
    assert code == 2 and "no config at" in err


def test_wait_times_out_on_a_run_that_doesnt_finish(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    run = tmp_path / "project" / "run"
    run.mkdir(parents=True)
    test = {"id": "t.py::test", "name": "test", "params": {}, "log_file": "t.py::test.log.jsonl"}
    (run / "plan.json").write_text(json.dumps({"worker_count": 1, "row_params": [], "groups": {"t": [test]}}))
    code, _, err = cli(
        capsys, "--source", str(tmp_path), "wait", "project/run", "--timeout", "0.2", "--poll", "0.05"
    )
    assert code == 2 and "didn't finish within 0.2s" in err
    (run / "status.0.jsonl").write_text(
        json.dumps({"type": "finish", "test": "t.py::test", "time": 1.0}) + "\n"
    )
    code, out, _ = cli(capsys, "--source", str(tmp_path), "wait", "project/run", "--timeout", "5")
    assert code == 0 and "1 passed" in out


def test_wait_for_a_run_that_doesnt_exist_yet(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, _, err = cli(
        capsys, "--source", str(tmp_path), "wait", "project/later", "--timeout", "0.2", "--poll", "0.05"
    )
    assert code == 2 and "didn't finish within 0.2s" in err  # waited for it, rather than failing at once
