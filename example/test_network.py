import logging

import pytest

log = logging.getLogger("network")


@pytest.mark.parametrize("protocol", ["tcp", "udp", "quic"])
def test_echo(arch, protocol):
    log.info("echo over %s on %s", protocol, arch)
    assert not (protocol == "quic" and arch == "aarch64"), "timed out waiting for echo"


@pytest.mark.xfail(reason="flaky upstream")
def test_dns(arch):
    assert arch == "x86"
