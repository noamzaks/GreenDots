# GreenDots

A live pytest matrix viewer. `pytest-greendots/` is the pytest plugin that writes run data, and `web/` is the
Next.js + Mantine app that reads it from local directories and network shares. The README explains the features, the
data layout and how the web app spares the share. Read it first.

## Commands

```bash
cd pytest-greendots && uv run pytest                     # plugin tests (pytester)
cd pytest-greendots && uv run ruff check && uv run ruff format --check && uv run mypy && uv run pyright
cd web && bun run test && bun run lint && bunx tsc --noEmit && bun run build
```

Demo data lives in the gitignored `example-data/`: run the `example/` suite with
`--greendots=example-data/local/demo/<run>` (set `DEMO_SPEED=0.5` for a slow, live run). The `web` preview in
`.claude/launch.json` serves the last build on port 3417, so rebuild and restart it after changing the web app.

## Rules

- **Compatibility.** Never break runs written by the original GreenDots plugin or by older versions of this one. New
  features go in the web app, or in optional new plan or status fields that old readers ignore.
- **Complete output.** No output may ever be missing from a test's log, however big or strange it is: lines of any
  length, raw file descriptor writes, and loggers that don't propagate.
- **Share bandwidth.** Every `ls`, `stat` and `read` on a source may be a slow network round trip.
  - Read nothing nobody is looking at.
  - Cache listings, and tail files by byte offset.
  - Read big files in `filesystem.chunk` pieces.
  - Stop polling runs that stopped changing.
  - Browsers get updates over server-sent events and never poll. Check the Activity page.
- **Configuration.** Everything configurable lives in the one JSON config (`web/src/lib/config.ts`), which is also
  editable on the Settings page. Never use environment variables or constants for settings. Per-viewer preferences
  (pins, density, layout) go in localStorage.
- **Code style.**
  - Concise code that reads like its surroundings.
  - Short comments, only where they say something the code doesn't.
  - No underscores in file or directory names.
  - Python must pass ruff, `mypy --strict` and pyright.
  - Biome formats the web app.
- **UI.**
  - Mantine components, consistent spacing and colors.
  - Client-side routing (wouter), with URLs like `/project/:project/run/:source/:run`.
  - No macOS-only shortcuts or icons: use `mod()` from `web/src/lib/platform.ts`.
  - Verify UI changes in the browser preview.
- **Commits.** Small commits with descriptive messages.

## Gotchas

- `ls` in the shell may be aliased to `eza` and hang when chained. Use `find` instead.
- If Next.js route types go stale: `rm -rf .next/types .next/dev/types && bunx next typegen`.
- Browser pane screenshots can lag the page. Confirm through the DOM before treating something as a bug.
