"""Sources hold projects, projects hold runs: ``<source>/<project>/<run>/``."""

from __future__ import annotations

import re
from pathlib import Path

from .run import Run


def _visible(path: Path) -> bool:
    return path.is_dir() and not path.name.startswith(".")


def _natural(name: str) -> list[object]:
    """Sorts ``run-10`` after ``run-9``."""
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name)]


class Project:
    """A project's runs in one source, e.g. ``Source("/var/opt/greendots").project("my-project")``."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.name = self.path.name

    def __repr__(self) -> str:
        return f"Project({str(self.path)!r})"

    def runs(self) -> list[Run]:
        """The runs, newest first (by when their directory last changed, then by name)."""
        try:
            dirs = [path for path in self.path.iterdir() if _visible(path)]
        except FileNotFoundError:
            return []
        stats = {path: path.stat().st_mtime for path in dirs}
        dirs.sort(key=lambda path: (stats[path], _natural(path.name)), reverse=True)
        return [Run(path) for path in dirs]

    def run(self, name: str) -> Run:
        return Run(self.path / name)

    def latest(self) -> Run | None:
        runs = self.runs()
        return runs[0] if runs else None


class Source:
    """A directory of projects, like a local one or a network share the web app reads too."""

    def __init__(self, path: str | Path, name: str | None = None) -> None:
        self.path = Path(path)
        self.name = name or self.path.name

    def __repr__(self) -> str:
        return f"Source({str(self.path)!r})"

    def projects(self) -> list[Project]:
        try:
            return sorted(
                (Project(path) for path in self.path.iterdir() if _visible(path)), key=lambda p: p.name
            )
        except FileNotFoundError:
            return []

    def project(self, name: str) -> Project:
        return Project(self.path / name)
