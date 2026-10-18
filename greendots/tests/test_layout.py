from greendots.core import log_name, session_log_file, status_file


def test_log_names_match_the_original_plugin() -> None:
    assert log_name("t.py::test") == "t.py::test.log.jsonl"
    assert log_name("dir/t.py::test").startswith("dir_t.py::test-")
    long = log_name("t.py::test[" + "x" * 200 + "]")
    assert len(long) < 130 and long.endswith("x].log.jsonl")


def test_worker_files() -> None:
    assert status_file(3) == "status.3.jsonl"
    assert session_log_file(3) == "session.3.log.jsonl"
