# greendots

The files a [GreenDots](../README.md) run is made of, as typed models and their layout, shared by
[pytest-greendots](../pytest-greendots) (which writes them) and [greendots-client](../greendots-client) (which reads
them). A run is a directory, `<source>/<project>/<run>/`:

| File | What's in it |
| --- | --- |
| `plan.json` | `Plan`: the tests, grouped by module, written once collection finishes |
| `status.<worker>.jsonl` | `StatusEvent`s, appended as tests start, pass their phases, report progress and finish |
| `<test>.log.jsonl` | `LogRecord`s: everything the test logged or printed (`log_name` gives the file name) |
| `session.<worker>.log.jsonl` | `LogRecord`s of output outside of tests |

```python
from greendots.core import PLAN, Plan, log_name
```
