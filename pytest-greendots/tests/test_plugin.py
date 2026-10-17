import json
from pathlib import Path

import pytest

from greendots.plugin import log_name

TESTS = """
import logging, sys, pytest

@pytest.mark.parametrize("variant", [1, 2])
@pytest.mark.parametrize("arch", ["x86", "arm"])
def test_matrix(arch, variant):
    pass

@pytest.mark.parametrize("arch", ["x86"])
def test_fail(arch):
    logging.getLogger("lib").debug("about to fail")
    print("hello")
    print("oops", file=sys.stderr)
    assert 1 == 2

@pytest.mark.parametrize("arch", ["x86"])
def test_skip(arch):
    pytest.skip("not today")

class TestGroup:
    @pytest.mark.parametrize("arch", ["arm"])
    def test_method(self, arch):
        pass
"""


def jsonl(path: Path) -> list:
    return [json.loads(line) for line in path.read_text().splitlines()]


def run(pytester: pytest.Pytester, *args: str, subprocess: bool = False, out: str = "out"):
    directory = pytester.path / out
    runner = pytester.runpytest_subprocess if subprocess else pytester.runpytest
    result = runner("--greendots", str(directory), *args)
    plan_path = directory / "plan.json"
    plan = json.loads(plan_path.read_text()) if plan_path.exists() else None
    return directory, plan, result


def planned(plan: dict) -> dict:
    return {t["id"]: {**t, "module": m} for m, tests in plan["groups"].items() for t in tests}


def messages(directory: Path, nodeid: str) -> list:
    return [(e["name"], e["level"], e["message"]) for e in jsonl(directory / log_name(nodeid))]


def test_plan_has_the_original_layout(pytester):
    pytester.makepyfile(test_a=TESTS)
    directory, plan, _ = run(pytester)
    tests = planned(plan)
    assert len(tests) == 7
    assert plan["worker_count"] == 1 and plan["errors"] == []
    assert plan["row_params"] == ["arch"]  # the only param shared by all tests
    assert tests["test_a.py::test_matrix[x86-1]"] == {
        "id": "test_a.py::test_matrix[x86-1]",
        "name": "test_matrix",
        "module": "test_a",
        "params": {"arch": "x86", "variant": 1},
        "log_file": "test_a.py::test_matrix[x86-1].log.jsonl",
    }
    assert tests["test_a.py::TestGroup::test_method[arm]"]["name"] == "TestGroup.test_method"
    assert all((directory / t["log_file"]).exists() for t in tests.values())


def test_log_names_match_the_original_plugin():
    assert log_name("t.py::test") == "t.py::test.log.jsonl"
    assert log_name("dir/t.py::test").startswith("dir_t.py::test-")
    long = log_name("t.py::test[" + "x" * 200 + "]")
    assert len(long) < 130 and long.endswith("x].log.jsonl")


def test_statuses(pytester):
    pytester.makepyfile(test_a=TESTS)
    directory, _, result = run(pytester)
    result.assert_outcomes(passed=5, failed=1, skipped=1)
    events = jsonl(directory / "status.0.jsonl")
    passing = [e["type"] for e in events if e.get("test") == "test_a.py::test_matrix[x86-1]"]
    assert passing == ["start", "setup", "call", "teardown", "finish"]
    assert events[-1]["type"] == "session_finish" and events[-1]["exitstatus"] == 1
    finishes = {e["test"]: e["outcome"] for e in events if e["type"] == "finish"}
    assert finishes["test_a.py::test_fail[x86]"] == "failed"
    assert finishes["test_a.py::test_skip[x86]"] == "skipped"
    failure = next(e for e in events if e["type"] == "call" and e["outcome"] == "failed")
    assert "assert 1 == 2" in failure["exception"]
    assert next(e for e in events if e.get("outcome") == "skipped")["reason"] == "Skipped: not today"


def test_logs(pytester):
    pytester.makepyfile(test_a=TESTS)
    directory, _, _ = run(pytester)
    logged = messages(directory, "test_a.py::test_fail[x86]")
    assert logged[:3] == [
        ("lib", "DEBUG", "about to fail"),
        ("stdout", "INFO", "hello"),
        ("stderr", "ERROR", "oops"),
    ]
    assert logged[3][0] == "pytest" and "assert 1 == 2" in logged[3][2]


EVERYTHING = r"""
import logging, os, subprocess, sys, warnings

def test_everything():
    quiet = logging.getLogger("quiet")
    quiet.propagate = False
    quiet.addHandler(logging.NullHandler())
    quiet.warning("not propagated")
    logging.getLogger("app").info("with %s", "args", exc_info=ValueError("bad"))
    os.write(1, b"raw fd write\n")
    os.write(2, b"\xff not utf-8\n")
    subprocess.run([sys.executable, "-c", "print('from a subprocess')"], check=True)
    sys.stdout.write("x" * 3_000_000 + "\n")
    print("no newline at the end", end="")
    warnings.warn("careful")
"""


def test_no_output_is_missing(pytester):
    pytester.makepyfile(test_a=EVERYTHING)
    for args in [(), ("-s",), ("--capture=sys",), ("--capture=tee-sys",)]:
        directory, _, result = run(pytester, *args, out=f"out{''.join(args)}")
        result.assert_outcomes(passed=1)
        logged = messages(directory, "test_a.py::test_everything")
        assert logged[0] == ("quiet", "WARNING", "not propagated")
        assert logged[1][:2] == ("app", "INFO") and "ValueError: bad" in logged[1][2]
        assert logged[1][2].startswith("with args")
        rest = sorted(message for _, _, message in logged[2:])
        assert ("stdout", "INFO", "raw fd write") in logged, args
        assert ("stderr", "ERROR", "� not utf-8") in logged, args
        assert ("stdout", "INFO", "from a subprocess") in logged, args
        assert ("stdout", "INFO", "x" * 3_000_000) in logged, args
        assert ("stdout", "INFO", "no newline at the end") in logged, args
        assert any(name == "warnings" and "UserWarning: careful" in m for name, _, m in logged)
        assert len(rest) == len(set(rest)), f"duplicated output with {args}"


def test_capture_fixtures_keep_working(pytester):
    pytester.makepyfile(
        test_a="""
        import os, sys

        def test_capsys(capsys):
            print("captured")
            assert capsys.readouterr().out == "captured\\n"
            print("after")

        def test_capfd(capfd):
            os.write(1, b"fd\\n")
            assert capfd.readouterr().out == "fd\\n"

        def test_next():
            print("still fine")
        """
    )
    for args in [(), ("-s",)]:
        directory, _, result = run(pytester, *args, out=f"out{''.join(args)}")
        result.assert_outcomes(passed=3)
        assert ("stdout", "INFO", "captured") in messages(directory, "test_a.py::test_capsys")
        assert ("stdout", "INFO", "after") in messages(directory, "test_a.py::test_capsys")
        assert messages(directory, "test_a.py::test_next") == [("stdout", "INFO", "still fine")]


def test_output_outside_tests_goes_to_the_session_log(pytester):
    pytester.makepyfile(test_a="print('importing')\ndef test_a():\n    pass")
    pytester.makepyfile(test_b="raise RuntimeError('broken module')")
    directory, plan, _ = run(pytester, "--continue-on-collection-errors")
    session = [e["message"] for e in jsonl(directory / "session.0.log.jsonl")]
    assert "importing" in session
    assert any("broken module" in message for message in session)
    assert plan["errors"][0]["id"] == "test_b.py" and "broken module" in plan["errors"][0]["exception"]


def test_interrupted_test_is_finished(pytester):
    pytester.makepyfile(test_a="def test_a():\n    print('working')\n    raise KeyboardInterrupt")
    directory, _, _ = run(pytester, subprocess=True)
    events = jsonl(directory / "status.0.jsonl")
    assert [e["type"] for e in events][-2:] == ["finish", "session_finish"]
    assert events[-2]["outcome"] == "failed"
    assert messages(directory, "test_a.py::test_a")[-1][2].startswith("Interrupted")


def test_default_row_params_ignore_unparametrized_tests(pytester):
    pytester.makepyfile(test_a=TESTS + "\ndef test_plain():\n    pass\n")
    _, plan, _ = run(pytester)
    assert plan["row_params"] == ["arch"]


def test_row_params_ini(pytester):
    pytester.makepyfile(test_a=TESTS)
    pytester.makeini("[pytest]\ngreendots_row_params = variant arch")
    _, plan, _ = run(pytester)
    assert plan["row_params"] == ["variant", "arch"]


def test_row_params_fixture_updates_the_plan(pytester):
    pytester.makeconftest(
        """
        import pytest

        @pytest.fixture(scope="session")
        def greendots_row_params():
            return ["variant"]
        """
    )
    pytester.makepyfile(test_a=TESTS)
    directory, _, _ = run(pytester)
    updates = [e for e in jsonl(directory / "status.0.jsonl") if e["type"] == "plan_update"]
    assert updates == [{"type": "plan_update", "row_params": ["variant"], "time": updates[0]["time"]}]


def test_greendots_fixture_updates_a_test(pytester):
    pytester.makepyfile(
        test_a="""
        def test_a(greendots):
            greendots.update(name="nicer", module="suite", params={"board": "rpi"})
            greendots.set_row_params("board")
        """
    )
    directory, _, _ = run(pytester)
    updates = [e for e in jsonl(directory / "status.0.jsonl") if e["type"] == "plan_update"]
    assert [{k: v for k, v in e.items() if k != "time"} for e in updates] == [
        {
            "type": "plan_update",
            "test": "test_a.py::test_a",
            "name": "nicer",
            "module": "suite",
            "params": {"board": "rpi"},
        },
        {"type": "plan_update", "row_params": ["board"]},
    ]


def test_marker_overrides(pytester):
    pytester.makepyfile(
        test_a="""
        import pytest

        @pytest.mark.greendots(name="pretty", module="suite", params={"board": "rpi"})
        @pytest.mark.parametrize("arch", ["arm"])
        def test_ugly_name(arch):
            pass
        """
    )
    _, plan, _ = run(pytester)
    (test,) = planned(plan).values()
    assert (test["name"], test["module"]) == ("pretty", "suite")
    assert test["params"] == {"arch": "arm", "board": "rpi"}


def test_hook_overrides(pytester):
    pytester.makeconftest(
        """
        def pytest_greendots_test(item, test):
            test["module"] = test["module"].removeprefix("test_")
            test["params"].pop("variant", None)

        def pytest_greendots_plan(session, plan):
            plan["row_params"] = []
        """
    )
    pytester.makepyfile(test_a=TESTS)
    _, plan, _ = run(pytester)
    assert plan["row_params"] == [] and list(plan["groups"]) == ["a"]
    assert all("variant" not in t["params"] for t in planned(plan).values())


def test_param_formatting(pytester):
    pytester.makepyfile(
        test_a="""
        import enum, pytest

        class Color(enum.Enum):
            RED = 1

        class Board:
            def __livelog_format__(self):
                return "rpi"

        @pytest.mark.parametrize("value", [Color.RED, None, Board()])
        def test_value(value):
            pass
        """
    )
    _, plan, _ = run(pytester)
    assert [t["params"]["value"] for t in plan["groups"]["test_a"]] == ["Color.RED", "None", "rpi"]


def test_progress(pytester):
    pytester.makepyfile(
        test_a="""
        def test_track(greendots_progress):
            for _ in greendots_progress.track(range(1000)):
                pass

        def test_generator(greendots_progress):
            assert list(greendots_progress.track(x for x in "ab")) == ["a", "b"]

        def test_split(live_progress):
            first, second = live_progress.split(2)
            first.done()
            second(0.5)

        def test_sleep(live_progress):
            live_progress.sleep(0.05)
        """
    )
    directory, _, result = run(pytester)
    result.assert_outcomes(passed=4)
    progress: dict[str, list] = {}
    for event in jsonl(directory / "status.0.jsonl"):
        if event["type"] == "progress":
            progress.setdefault(event["test"].split("::")[1], []).append(event["percentage"])
    assert progress["test_track"][0] == 0.0 and progress["test_track"][-1] == 1.0
    assert 90 <= len(progress["test_track"]) <= 102
    assert progress["test_generator"] == [1.0]
    assert progress["test_split"] == [1.0 / 2, 0.75]
    assert progress["test_sleep"][-1] == 1.0


def test_disabled_without_option(pytester):
    pytester.makepyfile(
        test_a="""
        def test_progress(greendots_progress, greendots):
            greendots_progress(0.5)
            greendots.update(name="x")
        """
    )
    pytester.runpytest().assert_outcomes(passed=1)
    assert not list(pytester.path.glob("**/*.jsonl"))


def test_xdist(pytester):
    pytest.importorskip("xdist")
    pytester.makepyfile(test_a=TESTS)
    directory, plan, result = run(pytester, "-n", "2", subprocess=True)
    result.assert_outcomes(passed=5, failed=1, skipped=1)
    assert plan["worker_count"] == 2
    finished = []
    for worker in range(2):
        events = jsonl(directory / f"status.{worker}.jsonl")
        assert events[-1]["type"] == "session_finish"
        finished += [e["test"] for e in events if e["type"] == "finish"]
    assert sorted(finished) == sorted(planned(plan))


def test_xdist_crash_is_recorded(pytester):
    pytest.importorskip("xdist")
    pytester.makepyfile(test_a="import os\ndef test_crash():\n    print('bye')\n    os._exit(3)")
    directory, _, _ = run(pytester, "-n", "1", subprocess=True)
    events = jsonl(directory / "status.0.jsonl")
    assert [(e["type"], e.get("outcome")) for e in events if e["type"] != "setup"][-2:] == [
        ("call", "failed"),
        ("finish", "failed"),
    ]
    logged = messages(directory, "test_a.py::test_crash")
    assert ("stdout", "INFO", "bye") in logged and "crashed" in logged[-1][2]


def test_original_options(pytester):
    pytester.makepyfile(test_a=TESTS)
    directory = pytester.path / "out"
    args = ["--livelog", str(directory), "--livelog-worker-id", "1", "--livelog-worker-count", "3"]
    pytester.runpytest(*args)
    assert (directory / "status.1.jsonl").exists() and not (directory / "plan.json").exists()
    pytester.runpytest("--livelog", str(directory), "--livelog-worker-count", "3")
    assert json.loads((directory / "plan.json").read_text())["worker_count"] == 3
    (directory / "plan.json").write_text("{}")
    pytester.runpytest("--livelog", str(directory), "--skip-plan-creation")
    assert (directory / "plan.json").read_text() == "{}"
