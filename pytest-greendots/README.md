# pytest-greendots

The pytest plugin of [GreenDots](../README.md): records each run's plan, a live status stream per worker and complete
per-test logs, for the GreenDots web app to show as a live test matrix.

```bash
pip install ./greendots ./pytest-greendots
pytest --greendots=/var/opt/greendots/my-project/$(date +%Y-%m-%d_%H-%M-%S)
```
