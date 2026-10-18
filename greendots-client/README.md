# greendots-client

Read [GreenDots](../README.md) runs from Python: list a project's runs, get a test's result, read or follow its log,
or wait for a run to finish. It reads the run directories directly (like the web app, a local directory or a network
share), and as little as it can: the plan once, only what was appended to the status files, and logs as streams.

```python
from greendots.client import Source

project = Source("/var/opt/greendots").project("my-project")
run = project.latest()  # or project.runs(), newest first, or project.run("2026-10-18_09-00-00")

print(run.summary)  # Summary(passed=181, failed=2, skipped=7, running=3, pending=36, done=False)
summary = run.wait(timeout=3600)  # until it finishes (checks every second)

for result in run.failures():
    print(result.test.id, result.exception)

result = run.result("tests/test_net.py::test_echo[x86]")
print(result.status, result.duration, result.test.params)

log = run.log(result.test.id)
for entry in log.tail(20):  # or iterate `log`, or `log.text()`
    print(entry)
for entry in run.log("tests/test_build.py::test_compile[arm]").follow():  # live, until the test is over
    print(entry.message)
```

It reads runs written by the original GreenDots plugin too.
