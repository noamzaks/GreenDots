"""Captures everything a test outputs, so no output is ever missing from GreenDots.

- log records of every logger, including ones that don't propagate to the root logger;
- writes to ``sys.stdout``/``sys.stderr``, live, the way the original plugin captured them;
- raw writes to file descriptors 1 and 2 (subprocesses, C extensions, ``os.write``), live, through a pipe
  whose reader passes the bytes on to wherever they were going (pytest's capture or the terminal).
"""

from __future__ import annotations

import codecs
import ctypes
import logging
import os
import sys
import threading
import weakref
from typing import Callable, Optional, TextIO, cast

#: Where captured output goes: ``sink(name, level, message, created)``.
Sink = Callable[[str, str, str, Optional[float]], None]

_libc: ctypes.CDLL | None
try:  # to flush C stdio buffers (e.g. printf in C extensions) before switching file descriptors
    _libc = ctypes.cdll.msvcrt if sys.platform == "win32" else ctypes.CDLL(None)
except OSError:  # pragma: no cover
    _libc = None


def flush_streams() -> None:
    for stream in (sys.stdout, sys.stderr, sys.__stdout__, sys.__stderr__):
        try:
            if stream is not None:
                stream.flush()
        except Exception:
            pass
    if _libc is not None:
        _libc.fflush(None)


def same_file(a: int, b: int) -> bool:
    try:
        first, second = os.fstat(a), os.fstat(b)
    except OSError:
        return False
    return (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)


def reaches_fd(stream: object, fd: int) -> bool:
    """Whether writing to ``stream`` ends up in ``fd`` (and so is captured at that level already)."""
    other = getattr(stream, "_other", None)  # pytest's TeeCaptureIO (--capture=tee-sys)
    if other is not None:
        return reaches_fd(other, fd)
    try:
        return bool(stream.fileno() == fd)  # type: ignore[attr-defined]
    except Exception:
        return False


class Lines:
    """Splits a stream of text into lines for the sink. Lines of any length are kept whole."""

    def __init__(self, sink: Sink, name: str, level: str) -> None:
        self.sink, self.name, self.level = sink, name, level
        self.parts: list[str] = []
        self.lock = threading.Lock()

    def feed(self, text: str) -> None:
        with self.lock:
            if "\n" not in text:
                if text:
                    self.parts.append(text)
                return
            first, *middle, last = text.split("\n")
            for line in ["".join(self.parts) + first, *middle]:
                self.sink(self.name, self.level, line.removesuffix("\r"), None)
            self.parts = [last] if last else []

    def flush(self) -> None:
        with self.lock:
            if self.parts:
                self.sink(self.name, self.level, "".join(self.parts), None)
                self.parts = []


class StreamTee:
    """Stands in for ``sys.stdout``/``sys.stderr``: writes pass through and are recorded, unless they
    reach the file descriptor that :class:`FdTee` already records (as with ``-s``)."""

    def __init__(self, stream: TextIO, lines: Lines, fd: int | None) -> None:
        # a fixture that swapped the streams (capsys) may have left one of ours behind
        while isinstance(stream, StreamTee):
            stream = stream.stream
        self.stream: TextIO = stream
        self.lines = None if fd is not None and reaches_fd(stream, fd) else lines

    def write(self, text: str) -> int:
        if self.lines is not None and isinstance(text, str):
            self.lines.feed(text)
        return self.stream.write(text)

    def writelines(self, lines: list[str]) -> None:
        for line in lines:
            self.write(line)

    def __getattr__(self, name: str) -> object:
        return getattr(self.stream, name)


class FdTee:
    """Records everything written to a file descriptor, live, while passing it on unchanged."""

    def __init__(self, fd: int, lines: Lines) -> None:
        self.fd, self.lines = fd, lines
        self.read_end, self.write_end = os.pipe()
        self.target: int | None = None
        self.marker = f"\0greendots-sync-{os.getpid()}-{id(self)}\0".encode()
        self.synced = threading.Event()
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        threading.Thread(target=self._pump, name=f"greendots-fd{fd}", daemon=True).start()

    def start(self) -> None:
        flush_streams()
        target = os.dup(self.fd)
        previous, self.target = self.target, target
        os.dup2(self.write_end, self.fd)
        if previous is not None:
            os.close(previous)

    def stop(self) -> None:
        """Waits until everything written so far was passed on and recorded, then restores the fd."""
        flush_streams()
        self.synced.clear()
        os.write(self.write_end, self.marker)
        self.synced.wait(10)
        if self.target is not None and same_file(self.fd, self.write_end):
            os.dup2(self.target, self.fd)  # unless someone else (e.g. capfd) took the fd meanwhile
        self.lines.flush()

    def close(self) -> None:
        # the pump ends once every other copy (e.g. in subprocesses) is closed too
        os.close(self.write_end)

    def _pump(self) -> None:
        buffer = b""
        while True:
            try:
                chunk = os.read(self.read_end, 1 << 16)
            except OSError:
                return
            if not chunk:
                return
            buffer += chunk
            while (index := buffer.find(self.marker)) >= 0:
                self._pass(buffer[:index])
                buffer = buffer[index + len(self.marker) :]
                self.synced.set()
            # hold back a possible start of the marker, pass on the rest
            keep = next(
                (
                    n
                    for n in range(min(len(buffer), len(self.marker) - 1), 0, -1)
                    if self.marker.startswith(buffer[-n:])
                ),
                0,
            )
            self._pass(buffer[: len(buffer) - keep])
            buffer = buffer[len(buffer) - keep :]

    def _pass(self, data: bytes) -> None:
        if not data:
            return
        view, target = memoryview(data), self.target
        while target is not None and view:
            try:
                view = view[os.write(target, view) :]
            except OSError:
                break
        self.lines.feed(self.decoder.decode(data))


class Output:
    """Captures stdout and stderr, at both the ``sys`` and the file descriptor level, around a block."""

    def __init__(self, sink: Sink) -> None:
        self.sys_lines = Lines(sink, "stdout", "INFO"), Lines(sink, "stderr", "ERROR")
        self.fds: list[FdTee] = []
        for fd, level in ((1, "INFO"), (2, "ERROR")):
            try:
                os.fstat(fd)
                self.fds.append(FdTee(fd, Lines(sink, "stdout" if fd == 1 else "stderr", level)))
            except OSError:  # pragma: no cover - no such fd, e.g. a windowed process
                pass
        self.active = self.fds

    def __call__(self, fds: bool = True) -> Output:
        """``with output(fds=False):`` leaves the file descriptors alone, for capfd: it reads them while
        the test runs, before the pipe could pass the bytes on."""
        self.active = self.fds if fds else []
        return self

    def __enter__(self) -> Output:
        for fd in self.active:
            fd.start()
        captured = {fd.fd for fd in self.active}
        self.tees = (
            StreamTee(sys.stdout, self.sys_lines[0], 1 if 1 in captured else None),
            StreamTee(sys.stderr, self.sys_lines[1], 2 if 2 in captured else None),
        )
        sys.stdout, sys.stderr = (cast(TextIO, tee) for tee in self.tees)
        return self

    def __exit__(self, *_: object) -> None:
        out, err = self.tees
        if sys.stdout is out:  # unless the test swapped them itself (e.g. capsys)
            sys.stdout = out.stream
        if sys.stderr is err:
            sys.stderr = err.stream
        for lines in self.sys_lines:
            lines.flush()
        for fd in self.active:
            fd.stop()
        self.active = self.fds

    def close(self) -> None:
        for fd in self.fds:
            fd.close()


def format_record(record: logging.LogRecord) -> str:
    try:
        message = record.getMessage()
    except Exception as error:  # a broken format string: keep what's there
        message = f"{record.msg!r} % {record.args!r} ({error})"
    if record.exc_info:
        message += "\n" + logging.Formatter().formatException(record.exc_info)
    elif record.exc_text:
        message += "\n" + record.exc_text
    if record.stack_info:
        message += "\n" + record.stack_info
    return message


class Records:
    """Captures log records as they're created, which also covers loggers that don't propagate, and,
    through a root handler, records that are only handled here (e.g. from a ``QueueListener``)."""

    def __init__(self, sink: Sink, level: int) -> None:
        self.sink, self.level = sink, level
        self.seen: weakref.WeakSet[logging.LogRecord] = weakref.WeakSet()
        self.previous_factory = logging.getLogRecordFactory()
        logging.setLogRecordFactory(self._factory)
        self.handler = _Handler(self)
        root = logging.getLogger()
        self.previous_level = root.level
        root.addHandler(self.handler)
        if root.level > level:  # NOTSET (0) already lets everything through
            root.setLevel(level)

    def _factory(self, *args: object, **kwargs: object) -> logging.LogRecord:
        record = self.previous_factory(*args, **kwargs)
        self.record(record)
        return record

    def record(self, record: logging.LogRecord) -> None:
        if record.levelno < self.level or record in self.seen:
            return
        self.seen.add(record)
        try:
            self.sink(record.name, record.levelname, format_record(record), record.created)
        except Exception:  # never break the code under test
            pass

    def close(self) -> None:
        if logging.getLogRecordFactory() == self._factory:
            logging.setLogRecordFactory(self.previous_factory)
        root = logging.getLogger()
        root.removeHandler(self.handler)
        root.setLevel(self.previous_level)


class _Handler(logging.Handler):
    def __init__(self, records: Records) -> None:
        super().__init__()
        self.records = records

    def emit(self, record: logging.LogRecord) -> None:
        self.records.record(record)
