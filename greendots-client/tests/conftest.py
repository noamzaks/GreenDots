"""Runs recorded by the plugin, for the client to read."""

from collections.abc import Callable
from pathlib import Path

import pytest

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

Record = Callable[..., Path]


@pytest.fixture
def record(pytester: pytest.Pytester) -> Record:
    """Runs ``TESTS`` with the plugin into ``<pytester>/source/project/<run>``, returning that directory."""
    pytester.makepyfile(test_a=TESTS)

    def record(run: str = "run-1", source: str = "source") -> Path:
        directory = pytester.path / source / "project" / run
        pytester.runpytest("--greendots", str(directory), "-p", "no:cacheprovider")
        return directory

    return record
