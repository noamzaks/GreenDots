import pytest


@pytest.hookimpl(optionalhook=True)  # also fine without the plugin
def pytest_greendots_test(item, test):
    # Hooks let you reshape the matrix: here "test_network.py" becomes the "network" group.
    test["module"] = test["module"].removeprefix("test_")


@pytest.fixture(scope="session")
def greendots_row_params():
    # The params shown as matrix rows (by default: the params all parametrized tests share).
    return ["arch"]


@pytest.fixture(params=["x86", "x86_64", "arm", "aarch64"])
def arch(request):
    return request.param
