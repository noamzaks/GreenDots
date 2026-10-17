import logging
import os
import random
import time

import pytest

log = logging.getLogger("build")
SPEED = float(os.environ.get("DEMO_SPEED", "0"))  # seconds per step, try 0.05


def step(n=1):
    time.sleep(SPEED * n * random.random())


def test_compile(arch, greendots_progress):
    for unit in greendots_progress.track(range(20)):
        log.debug("compiling unit %d for %s", unit, arch)
        step()
        print(f"[{unit + 1}/20] compiled unit {unit}")


@pytest.mark.parametrize("opt", ["O0", "O2", "Os"])
def test_optimize(arch, opt):
    step(10)
    log.info("optimized with -%s", opt)
    if arch == "arm" and opt == "Os":
        raise RuntimeError("register allocation failed")


def test_link(arch):
    step(5)
    print(f"linking {arch}")
    if arch.startswith("x86"):
        pytest.skip("linker not available on x86 runners")


@pytest.mark.greendots(name="size check")
def test_binary_size_is_small_enough(arch):
    step(3)
    assert len(arch) < 7, f"{arch} binary too big"
