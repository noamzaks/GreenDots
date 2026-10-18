"""Writes what pytest's own -k makes of these expressions to keywords.json, for the tests of the web app's port.

Run from pytest-greendots: uv run python ../web/test/fixtures/keywords.py ../web/test/fixtures/keywords.json
"""
import json
import sys

from _pytest.mark.expression import Expression

names = ["tests", "libvirt", "test_machine.py", "TestGroup", "test_run[ppc64le-ssh]", "slow", "parametrize"]
expressions = [
    "", "run", "RUN", "ssh", "telnet", "not ssh", "run and ssh", "run and telnet", "run or telnet",
    "not run or slow", "not (run or telnet)", "(run or telnet) and not ssh", "not not run", "run and not slow",
    "test_machine.py", "ppc64le-ssh", "run[ppc64le", "libvirt/test", "tests/libvirt", "Test", "group",
    "test_machine.py::test_run", "True", "None", "False", "-ssh", "a.b+c\\\\d/e:f",
    "run and", "and run", "(run", "run)", "run telnet", "run ssh", "not", "()", "run or or telnet",
    "run(x=1)", "run(x=\"a\")", "'run'", "run$", "run & ssh", "run(x=1", "\"unclosed",
]
cases = []
for e in expressions:
    try:
        compiled = Expression.compile(e)
    except SyntaxError as error:
        cases.append({"expression": e, "error": f"at column {error.offset}: {error.msg}"})
        continue
    def match(sub, **kwargs):
        if kwargs:
            raise ValueError("Keyword expressions do not support call parameters.")
        return any(sub.lower() in n.lower() for n in names)
    try:
        cases.append({"expression": e, "matches": compiled.evaluate(match)})
    except ValueError as error:
        cases.append({"expression": e, "error": str(error)})
comment = "Written by pytest's own -k (_pytest.mark.expression) with keywords.py: regenerate rather than edit."
with open(sys.argv[1], "w") as file:
    json.dump({"_comment": comment, "names": names, "cases": cases}, file, indent=1)
    file.write("\n")
