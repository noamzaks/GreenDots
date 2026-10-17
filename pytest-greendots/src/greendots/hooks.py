"""Hooks for customizing how tests appear in GreenDots. Implement them in a ``conftest.py``."""

from __future__ import annotations

from typing import Any

import pytest


def pytest_greendots_test(item: pytest.Item, test: dict[str, Any]) -> None:
    """Customize a test's plan entry, by mutating ``test`` in place.

    ``test`` holds ``id`` (the pytest node id - don't change it), ``name`` and ``module`` (which
    pick the matrix column and column group), ``params`` (shown as rows or columns) and ``log_file``.
    """


def pytest_greendots_plan(session: pytest.Session, plan: dict[str, Any]) -> None:
    """Customize the whole plan before it is written, e.g. ``plan["row_params"] = ["arch"]``."""
