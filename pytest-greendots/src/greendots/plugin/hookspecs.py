"""Hooks for customizing how tests appear in GreenDots. Implement them in a ``conftest.py``."""

from __future__ import annotations

import pytest
from greendots.core import Plan, PlanTest


def pytest_greendots_test(item: pytest.Item, test: PlanTest) -> None:
    """Customize a test's plan entry, by changing ``test`` in place."""


def pytest_greendots_plan(session: pytest.Session, plan: Plan) -> None:
    """Customize the whole plan before it is written, e.g. ``plan["row_params"] = ["arch"]``."""
