"""A log: JSON lines of records and output, read as a stream (logs can be huge) or followed live."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from greendots.core import LogRecord


@dataclass(frozen=True)
class Entry:
    """A logger's record, or output: ``name`` is then ``stdout``, ``stderr``, ``warnings`` or ``pytest``."""

    name: str
    level: str
    time: float
    message: str

    @property
    def datetime(self) -> datetime:
        return datetime.fromtimestamp(self.time)

    def __str__(self) -> str:
        return f"{self.datetime:%H:%M:%S.%f} {self.level:<8} {self.name}: {self.message}"


def _entry(line: bytes) -> Entry | None:
    try:
        record: LogRecord = json.loads(line)
        return Entry(record["name"], record["level"], record["time"], record["message"])
    except (json.JSONDecodeError, KeyError, TypeError):  # e.g. a line still being written
        return None


class Log:
    """Iterate it for its entries, ``tail(n)`` for the last ones, or ``follow()`` it while it's written."""

    def __init__(
        self, path: Path, finished: Callable[[], bool] = lambda: True, chunk: int = 1024 * 1024
    ) -> None:
        self.path, self._finished, self._chunk = path, finished, chunk

    def __repr__(self) -> str:
        return f"Log({str(self.path)!r})"

    @property
    def exists(self) -> bool:
        return self.path.exists()

    def __iter__(self) -> Iterator[Entry]:
        try:
            with open(self.path, "rb") as file:
                for line in file:
                    if (entry := _entry(line)) is not None:
                        yield entry
        except FileNotFoundError:
            return

    def text(self) -> str:
        """The messages, one after the other: what the test printed and logged."""
        return "\n".join(entry.message for entry in self)

    def tail(self, count: int = 20) -> list[Entry]:
        """The last ``count`` entries, read backwards from the end of the file."""
        if count <= 0:
            return []
        try:
            with open(self.path, "rb") as file:
                start = file.seek(0, 2)
                data = b""
                while start > 0 and data.count(b"\n") <= count:
                    end, start = start, max(0, start - self._chunk)
                    file.seek(start)
                    data = file.read(end - start) + data
        except FileNotFoundError:
            return []
        lines = data.splitlines()[1 if start > 0 else 0 :]  # the first line may be cut
        return [entry for entry in map(_entry, lines) if entry is not None][-count:]

    def follow(self, poll: float = 0.5) -> Iterator[Entry]:
        """Yields the entries, then new ones as they're written, until the test (or run) is over."""
        offset, rest = 0, b""
        while True:
            over = self._finished()  # checked first, so what was written before it finished is still read
            try:
                with open(self.path, "rb") as file:
                    file.seek(offset)
                    while chunk := file.read(self._chunk):
                        offset += len(chunk)
                        data = rest + chunk
                        end = data.rfind(b"\n") + 1
                        rest = data[end:]
                        for line in data[:end].splitlines():
                            if (entry := _entry(line)) is not None:
                                yield entry
            except FileNotFoundError:
                pass
            if over:
                return
            time.sleep(poll)
