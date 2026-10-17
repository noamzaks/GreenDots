"""Extreme output, to check that GreenDots shows everything."""

import logging
import os
import subprocess
import sys


def test_huge_line():
    print("before the huge line")
    print("x" * 5_000_000 + " <- the end of a 5 MB line")
    print("after the huge line")


def test_many_lines():
    log = logging.getLogger("chatty")
    for i in range(100_000):
        log.debug("line %d of a long log", i)


def test_raw_output():
    os.write(1, b"written straight to file descriptor 1\n")
    subprocess.run([sys.executable, "-c", "print('printed by a subprocess')"], check=True)
    logging.getLogger("quiet").propagate = False
    logging.getLogger("quiet").warning("from a logger that doesn't propagate")
