"""Hooks for customizing how tests appear in GreenDots. Implement them in a ``conftest.py``."""

from __future__ import annotations

from typing import Any, TypedDict

import pytest


class PlanTest(TypedDict):
    """A test's entry in the plan."""

    id: str  # the pytest node id: don't change it
    name: str  # the matrix column...
    module: str  # ... and column group
    params: dict[str, Any]  # shown as rows or columns
    log_file: str


def pytest_greendots_test(item: pytest.Item, test: PlanTest) -> None:
    """Customize a test's plan entry, by changing ``test`` in place."""


def pytest_greendots_plan(session: pytest.Session, plan: dict[str, Any]) -> None:
    """Customize the whole plan before it is written, e.g. ``plan["row_params"] = ["arch"]``."""
