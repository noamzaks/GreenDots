import os
import time

import pytest

BOARDS = ["rpi4", "rpi5", "beaglebone", "jetson"]


@pytest.mark.parametrize("image", ["minimal", "desktop"])
@pytest.mark.parametrize("board", BOARDS)
def test_boot(board, image):
    # These tests have no "arch": GreenDots shows them in a matrix of their own, with a row per board.
    time.sleep(float(os.environ.get("DEMO_SPEED", "0")))
    assert not (board == "jetson" and image == "desktop"), "kernel panic: no display found"


@pytest.mark.parametrize("board", BOARDS)
def test_flash(board):
    time.sleep(float(os.environ.get("DEMO_SPEED", "0")))
