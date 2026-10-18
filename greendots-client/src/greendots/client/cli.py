"""``greendots-client``: GreenDots runs in the terminal. See ``greendots-client --help``."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any, NoReturn

from .log import Entry
from .run import STATUSES, Result, Run, Summary
from .source import Source

COLORS = {"passed": 32, "failed": 31, "skipped": 33, "running": 34, "pending": 90}
LEVELS = {"DEBUG": 90, "WARNING": 33, "ERROR": 31, "CRITICAL": 31}
STALE = 3600  # seconds without updates after which an unfinished run may have stopped
MARKS = {"passed": "✓", "failed": "✗", "skipped": "-", "running": "▶", "pending": "·"}


class Fail(Exception):
    """An error for the user, shown without a traceback."""


class Style:
    """ANSI colors, only on a terminal (and not with ``NO_COLOR``)."""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def __call__(self, text: str, code: int | None, bold: bool = False) -> str:
        if not self.enabled or (code is None and not bold):
            return text
        codes = ";".join(str(c) for c in ((1,) if bold else ()) + ((code,) if code else ()))
        return f"\033[{codes}m{text}\033[0m"

    def status(self, status: str, text: str | None = None) -> str:
        return self(text if text is not None else status, COLORS[status])


# --- Finding runs ---


def config_sources(path: str | None) -> list[Source]:
    """The sources in the web app's config: ``--config``, ``$GREENDOTS_CONFIG``, the user's, or the service's."""
    paths: list[str | Path | None] = [path]
    if not path:
        xdg = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        paths = [
            os.environ.get("GREENDOTS_CONFIG"),
            xdg / "greendots" / "config.json",
            "/etc/greendots/config.json",
        ]
    for candidate in (path for path in paths if path):
        try:
            config = json.loads(Path(candidate).read_text(encoding="utf-8"))
        except FileNotFoundError:
            if path:
                raise Fail(f"no config at {path}") from None
            continue
        except (OSError, json.JSONDecodeError) as error:
            raise Fail(f"can't read {candidate}: {error}") from None
        return [Source(s["path"], s.get("name")) for s in config.get("sources", [])]
    return []


def find_sources(args: argparse.Namespace) -> list[Source]:
    sources = [Source(path) for path in args.source] if args.source else config_sources(args.config)
    if args.only:
        sources = [source for source in sources if source.name == args.only]
    if not sources:
        raise Fail("no sources: pass --source DIR, or add sources in the web app's settings")
    return sources


def find_run(sources: list[Source], target: str) -> tuple[Source, Run]:
    """``project/run``, or a project's latest run in any source."""
    project, _, name = target.partition("/")
    if name:
        found = [(source, source.project(project).run(name)) for source in sources]
        found = [(source, run) for source, run in found if run.path.is_dir()]
        if len(found) > 1:
            names = ", ".join(source.name for source, _ in found)
            raise Fail(f"{target} is in several sources ({names}): pick one with --only NAME")
    else:
        found = [(source, run) for source in sources for run in source.project(project).runs()[:1]]
        found.sort(key=lambda pair: pair[1].path.stat().st_mtime, reverse=True)
    if not found:
        raise Fail(f"no run {target}" if name else f"no runs of {project}")
    return found[0]


def find_test(run: Run, test: str) -> str:
    """A test's node id, from its id or any unique part of it."""
    tests = run.tests
    if not tests:
        raise Fail(f"{run.project}/{run.name} has no plan yet")
    if test in tests:
        return test
    matches = [id for id in tests if test.lower() in id.lower()]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise Fail(f"no test matches {test!r}")
    shown = "\n  ".join(matches[:10]) + ("\n  …" if len(matches) > 10 else "")
    raise Fail(f"{len(matches)} tests match {test!r}, e.g.:\n  {shown}")


# --- Formatting ---


def ago(seconds: float | None) -> str:
    if seconds is None:
        return "never"
    elapsed = time.time() - seconds
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if elapsed >= size:
            count = int(elapsed // size)
            return f"{count} {unit}{'s' if count > 1 else ''} ago"
    return "just now"


def took(seconds: float | None) -> str:
    if seconds is None:
        return "–"
    seconds = round(seconds)
    if seconds < 60:
        return f"{seconds}s"
    minutes, seconds = divmod(seconds, 60)
    return f"{minutes}m {seconds}s" if minutes < 60 else f"{minutes // 60}h {minutes % 60}m"


def headline(exception: str | None) -> str:
    """A pytest failure's first ``E ...`` line, or else its last line (as the web app groups errors)."""
    lines = [line for line in (exception or "").splitlines() if line.strip()]
    line = next((line for line in lines if line.startswith("E ")), lines[-1] if lines else "")
    return line.removeprefix("E").strip()


def bar(summary: Summary, style: Style, width: int = 30) -> str:
    total = summary.total or 1
    parts, used = [], 0
    for status in STATUSES:
        count = getattr(summary, status)
        cells = round(count / total * width) if count else 0
        cells = min(max(cells, 1 if count else 0), width - used)
        used += cells
        if cells:
            parts.append(style.status(status, ("█" if status != "pending" else "░") * cells))
    return "".join(parts) + (style.status("pending", "░" * (width - used)) if used < width else "")


def counts(summary: Summary, style: Style) -> str:
    shown = [
        style.status(status, f"{getattr(summary, status)} {status}")
        for status in STATUSES
        if getattr(summary, status)
    ]
    return " · ".join(shown) or style("no tests", 90)


def state(run: Run, summary: Summary) -> str:
    if summary.done:
        return f"took {took(run_duration(run))}"
    if not run.planned:
        return "waiting for its plan"
    updated = run.updated
    if updated is not None and time.time() - updated > STALE:  # as the web app stops checking it
        return f"no updates for {ago(updated).removesuffix(' ago')}"
    return "running"


def run_duration(run: Run) -> float | None:
    ends = [result.finished for result in run.results().values() if result.finished]
    return max(ends) - run.started_at if ends and run.started_at else None


def entry_line(entry: Entry, style: Style) -> str:
    stamp = style(f"{entry.datetime:%H:%M:%S.%f}"[:-3], 90)
    return f"{stamp} {style(f'{entry.level:<8}', LEVELS.get(entry.level))} {style(entry.name, 90)}  {entry.message}"


def summary_json(source: Source, run: Run, summary: Summary) -> dict[str, Any]:
    return {
        "project": run.project,
        "run": run.name,
        "source": source.name,
        "started_at": run.started_at,
        **asdict(summary),
    }


def result_json(result: Result) -> dict[str, Any]:
    return {**asdict(result), "duration": result.duration}


# --- Commands ---


def projects(args: argparse.Namespace, style: Style) -> int:
    rows = []
    for source in find_sources(args):
        for project in source.projects():
            latest = project.latest()
            summary = latest.summary if latest else None
            rows.append((project.name, source, latest, summary))
    if args.json:
        print(
            json.dumps(
                [
                    {
                        "project": name,
                        "source": source.name,
                        "latest": latest and latest.name,
                        "summary": summary and asdict(summary),
                    }
                    for name, source, latest, summary in rows
                ],
                indent=2,
            )
        )
        return 0
    width = max((len(name) for name, *_ in rows), default=0)
    for name, source, latest, summary in rows:
        line = f"{style(name.ljust(width), None, bold=True)}  {style(source.name, 90)}"
        if latest and summary:
            line += f"  {latest.name}  {bar(summary, style, 20)}  {counts(summary, style)}"
        print(line)
    return 0


def runs(args: argparse.Namespace, style: Style) -> int:
    found = [(source, run) for source in find_sources(args) for run in source.project(args.project).runs()]
    found.sort(key=lambda pair: pair[1].path.stat().st_mtime, reverse=True)
    found = found[: args.limit] if args.limit else found
    if not found:
        raise Fail(f"no runs of {args.project}")
    if args.json:
        print(json.dumps([summary_json(source, run, run.summary) for source, run in found], indent=2))
        return 0
    width = max(len(run.name) for _, run in found)
    for source, run in found:
        summary = run.summary
        print(
            f"{style(run.name.ljust(width), None, bold=True)}  {style(source.name, 90)}  {bar(summary, style, 20)}  "
            f"{counts(summary, style)}  {style(f'{ago(run.started_at)}, {state(run, summary)}', 90)}"
        )
    return 0


def header(source: Source, run: Run, summary: Summary, style: Style) -> str:
    title = style(f"{run.project}/{run.name}", None, bold=True)
    return f"{title} {style(f'({source.name}) · started {ago(run.started_at)} · {state(run, summary)}', 90)}"


def status(args: argparse.Namespace, style: Style) -> int:
    source, run = find_run(find_sources(args), args.run)
    summary = run.summary
    failures = run.failures()
    if args.json:
        print(
            json.dumps(
                {**summary_json(source, run, summary), "failures": [result_json(f) for f in failures]},
                indent=2,
            )
        )
    else:
        print(header(source, run, summary, style))
        print(f"{bar(summary, style)}  {counts(summary, style)}")
        for result in failures:
            print(
                f"{style.status('failed', MARKS['failed'])} {result.test.id}  {style(headline(result.exception), 90)}"
            )
    return 1 if failures else 0


def wait(args: argparse.Namespace, style: Style) -> int:
    sources = find_sources(args)
    live = style.enabled and not args.json
    deadline = None if args.timeout is None else time.monotonic() + args.timeout

    def timed_out() -> bool:
        if deadline is None or time.monotonic() < deadline:
            return False
        print(f"{args.run} didn't finish within {args.timeout:g}s", file=sys.stderr)
        return True

    while True:  # the run may not have started yet
        try:
            source, run = find_run(sources, args.run)
            break
        except Fail:
            if timed_out():
                return 2
            time.sleep(args.poll)
    if live:
        print(header(source, run, run.summary, style))
    while not run.done:
        if live:
            summary = run.summary
            print(f"\r\033[K{bar(summary, style)}  {counts(summary, style)}", end="", flush=True)
        if timed_out():
            if live:
                print()  # under the progress line
            return 2
        time.sleep(args.poll)
    if live:
        print("\r\033[K", end="")
    return status(args, style)


def failures(args: argparse.Namespace, style: Style) -> int:
    _, run = find_run(find_sources(args), args.run)
    failed = run.failures()
    if args.json:
        print(json.dumps([result_json(result) for result in failed], indent=2))
        return 1 if failed else 0
    for result in failed:
        print(style.status("failed", f"{MARKS['failed']} {result.test.id}"))
        print((result.exception or "").rstrip(), end="\n\n")
    if not failed:
        print(style.status("passed", "no failures"))
    return 1 if failed else 0


def result(args: argparse.Namespace, style: Style) -> int:
    _, run = find_run(find_sources(args), args.run)
    found = run.result(find_test(run, args.test))
    if args.json:
        print(json.dumps(result_json(found), indent=2))
        return 0
    test = found.test
    print(
        f"{style.status(found.status, MARKS[found.status] + ' ' + found.status)}  {style(test.id, None, bold=True)}"
    )
    fields = {
        "name": f"{test.module} · {test.name}",
        "params": " ".join(f"{key}={value}" for key, value in test.params.items()) or "–",
        "took": took(found.duration)
        if found.done
        else f"running for {took(time.time() - found.started)}"
        if found.started
        else "–",
        "progress": f"{found.progress:.0%}" if found.progress is not None else None,
        "reason": found.reason,
        "log": str(run.path / test.log_file),
    }
    for key, value in fields.items():
        if value:
            print(f"{style(f'{key:>8}', 90)}  {value}")
    if found.exception:
        print(f"\n{found.exception.rstrip()}")
    return 0


def log(args: argparse.Namespace, style: Style) -> int:
    _, run = find_run(find_sources(args), args.run)
    file = run.session_log(args.session) if args.test is None else run.log(find_test(run, args.test))
    if not file.exists:
        raise Fail(f"no log at {file.path}")

    def show(entry: Entry) -> None:
        print(json.dumps(asdict(entry)) if args.json else entry_line(entry, style))

    if args.follow:  # the last entries (or all), then new ones until the test is over
        first = max(0, sum(1 for _ in file) - args.lines) if args.lines else 0
        for index, entry in enumerate(file.follow(poll=args.poll)):
            if index >= first:
                show(entry)
        return 0
    for entry in file.tail(args.lines) if args.lines else file:
        show(entry)
    return 0


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(
        prog="greendots-client",
        description="GreenDots runs in the terminal. RUN is PROJECT/RUN, or PROJECT for its latest run; TEST is a "
        "test's node id, or any unique part of it.",
    )
    main.add_argument(
        "--source",
        action="append",
        metavar="DIR",
        help="read runs from DIR (repeatable); by default, the sources in the web app's config",
    )
    main.add_argument(
        "--config",
        metavar="FILE",
        help="the web app's config to take sources from (default: $GREENDOTS_CONFIG, ~/.config/greendots/config.json, /etc/greendots/config.json)",
    )
    main.add_argument("--only", metavar="NAME", help="only use the source named NAME")
    main.add_argument("--json", action="store_true", help="print JSON, for scripts")
    main.add_argument("--color", choices=["auto", "always", "never"], default="auto")
    commands = main.add_subparsers(dest="command", required=True, metavar="COMMAND")

    def command(name: str, help: str) -> argparse.ArgumentParser:
        return commands.add_parser(name, help=help, description=help)

    command("projects", "list the projects, with their latest run")
    runs_ = command("runs", "list a project's runs, newest first")
    runs_.add_argument("project")
    runs_.add_argument(
        "-n", "--limit", type=int, default=10, help="show this many runs (0: all; default: 10)"
    )
    status_ = command("status", "show a run's counts and failures (exits with 1 if any test failed)")
    status_.add_argument("run")
    wait_ = command(
        "wait",
        "wait for a run (to start, then) to finish, and show its status (exits with 1 on failures, 2 on timeout)",
    )
    wait_.add_argument("run")
    wait_.add_argument("--timeout", type=float, metavar="SECONDS")
    wait_.add_argument(
        "--poll", type=float, default=1.0, metavar="SECONDS", help="check every SECONDS (default: 1)"
    )
    failures_ = command("failures", "show the failed tests with their tracebacks")
    failures_.add_argument("run")
    result_ = command("result", "show a test's result")
    result_.add_argument("run")
    result_.add_argument("test")
    log_ = command("log", "show a test's log, or a worker's session log")
    log_.add_argument("run")
    log_.add_argument("test", nargs="?", help="the test (default: the session log)")
    log_.add_argument(
        "--session", type=int, default=0, metavar="WORKER", help="the worker of the session log (default: 0)"
    )
    log_.add_argument("-n", "--lines", type=int, default=0, help="only the last N entries")
    log_.add_argument(
        "-f", "--follow", action="store_true", help="keep showing new entries until the test is over"
    )
    log_.add_argument("--poll", type=float, default=0.5, metavar="SECONDS", help=argparse.SUPPRESS)
    return main


COMMANDS = {
    "projects": projects,
    "runs": runs,
    "status": status,
    "wait": wait,
    "failures": failures,
    "result": result,
    "log": log,
}


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    color = args.color == "always" or (
        args.color == "auto" and sys.stdout.isatty() and not os.environ.get("NO_COLOR")
    )
    try:
        return COMMANDS[args.command](args, Style(color))
    except Fail as error:
        print(f"greendots-client: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:  # e.g. piped into head
        sys.stderr.close()
        return 0


def run() -> NoReturn:
    sys.exit(main())
