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

## In the terminal

`greendots-client` (or `python -m greendots.client`) takes its sources from the web app's config (`--config`,
`$GREENDOTS_CONFIG`, `~/.config/greendots/config.json`, then the service's `/etc/greendots/config.json`), or from
`--source DIR`. A run is `PROJECT/RUN`, or `PROJECT` for its latest run, and a test is its node id or any unique part
of it.

```bash
greendots-client projects                        # each project's latest run
greendots-client runs my-project                 # its runs, newest first
greendots-client status my-project               # counts and failures; exits with 1 if a test failed
greendots-client wait my-project/ci-123 --timeout 3600   # a live progress bar, then the status (2 on timeout)
greendots-client failures my-project             # with their tracebacks
greendots-client result my-project "test_echo[x86]"
greendots-client log my-project "test_echo[x86]" -n 50 -f  # the last 50 entries, then live
greendots-client --json status my-project | jq .failed
```

If two sources have a run of the same name, pick one with `--only NAME`. Colors show on a terminal, unless
`NO_COLOR` is set.
