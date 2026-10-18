export const STATUSES = ["passed", "failed", "skipped", "running", "pending"] as const
export type Status = (typeof STATUSES)[number]

export type Param = string | number | boolean
export type PlanTest = {
  id: string
  name: string
  module: string
  params: Record<string, Param>
  log: string
  keywords?: string[] // what pytest -k matches besides the names in the id (markers...), from newer plugins
}
export type Plan = {
  started_at?: number
  worker_count: number
  row_params: string[]
  tests: PlanTest[]
  errors: { id: string; exception: string }[] // collection errors
}

export type TestState = {
  status: Status
  progress?: number
  exception?: string
  reason?: string
  start?: number
  end?: number
}

export type StatusEvent = {
  type: "start" | "setup" | "call" | "teardown" | "finish" | "progress" | "session_finish" | "plan_update"
  test: string
  time: number
  outcome?: "passed" | "failed" | "skipped" | "error"
  exception?: string
  reason?: string
  percentage?: number
  // plan_update
  row_params?: string[]
  name?: string
  module?: string
  params?: Record<string, Param>
}

export type Summary = Record<Status, number> & {
  total: number
  done: boolean
  started?: number
  ended?: number
  updated?: number // when the run's files last changed (ms)
  collectErrors: number
}
/** How a run is checked for updates: often, rarely (no recent changes), not anymore, or not needed. */
export type Polling = "live" | "slow" | "stopped" | "done"
export type RunInfo = {
  source: string
  name: string
  title?: string
  mtime: number
  summary?: Summary
  polling?: Polling
}
export type ProjectInfo = { name: string; title?: string; synced: boolean; runs: RunInfo[] }
export type Projects = { projects: ProjectInfo[]; errors: { source: string; error: string }[]; loading: boolean }
export type ProjectRuns = {
  name: string
  title?: string
  synced: boolean
  runs: RunInfo[]
  loading: boolean
}
/** A run stream's messages: everything first (and after reconnecting), then what changed. */
export type RunUpdate = {
  version: number
  planVersion: number
  title?: string
  plan?: Plan
  summary: Summary
  polling: Polling
  tests: Record<string, TestState>
  full: boolean
}

/** A log line. Messages longer than a preview are cut, with `truncated` set; fetch the rest separately. */
export type LogLine = {
  offset: number // of the line in the log file
  length: number // of the line, in bytes
  name: string
  level: string
  time: number
  message: string
  truncated?: boolean
}
export type LogChunk = { lines: LogLine[]; start: number; end: number; size: number; test?: TestState }
/** A log stream's messages: the end of the log first, then lines as they're written. */
export type LogUpdate = LogChunk & { full: boolean }
export type MessageChunk = { text: string; start: number; next: number; done: boolean; total: number }

type RawTest = Omit<PlanTest, "module" | "log"> & { log?: string; log_file?: string; module?: string }

/** Accepts the original plugin's plan (tests grouped by module, `log_file`) and a flat list of tests. */
export function normalizePlan(raw: {
  tests?: RawTest[]
  groups?: Record<string, RawTest[]>
  worker_count?: number
  row_params?: string[]
  started_at?: number
  errors?: Plan["errors"]
}): Plan {
  const grouped = Object.entries(raw.groups ?? {}).flatMap(([module, tests]) => tests.map((t) => ({ ...t, module })))
  const tests = [...(raw.tests ?? []), ...grouped].map(({ log_file, log, module, ...test }) => ({
    ...test,
    params: test.params ?? {},
    module: module ?? test.id.split("::")[0],
    log: log ?? log_file ?? "",
  }))
  return {
    started_at: raw.started_at,
    worker_count: raw.worker_count ?? 1,
    row_params: raw.row_params ?? [],
    tests,
    errors: raw.errors ?? [],
  }
}
