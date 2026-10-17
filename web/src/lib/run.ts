import { join } from "node:path"
import { parse as parseToml } from "smol-toml"
import type { Fs } from "./fs"
import {
  normalizePlan,
  type Plan,
  type PlanTest,
  STATUSES,
  type Status,
  type StatusEvent,
  type Summary,
  type TestState,
} from "./types"

export function applyEvent(test: TestState, event: StatusEvent): TestState {
  switch (event.type) {
    case "start":
      return { status: "running", progress: 0, start: event.time }
    case "progress":
      return { ...test, progress: event.percentage }
    case "finish":
      return { ...test, status: outcome(event), progress: undefined, end: event.time }
    default:
      if (outcome(event) === "failed") {
        const exception = [test.exception, event.exception].filter(Boolean).join("\n\n")
        return { ...test, status: "failed", exception }
      }
      return event.outcome === "skipped" ? { ...test, status: "skipped", reason: event.reason } : test
  }
}

const outcome = (event: StatusEvent) => (event.outcome === "error" ? "failed" : (event.outcome ?? "passed"))

/** Reads a `metadata.toml` (as the original server did), for e.g. a display `name`. */
export async function readMetadata(fs: Fs, dir: string): Promise<Record<string, unknown> | undefined> {
  const text = await fs.readText(join(dir, "metadata.toml"))
  try {
    return text === undefined ? undefined : parseToml(text)
  } catch {
    return undefined
  }
}

const isDone = (t: TestState) => t.status !== "pending" && t.status !== "running"

/** One test run, synced incrementally: the plan is read once, status files are tailed by offset. */
export class Run {
  plan?: Plan
  readonly epoch = Math.random().toString(36).slice(2)
  readonly created = Date.now()
  version = 0
  planVersion = 0
  title?: string
  lastChange = 0 // when new status lines were last seen (not counting the first read)
  lastSync = 0
  lastAccess = Date.now()
  viewers = 0 // open streams showing this run
  planMtime?: number
  modified = 0 // the latest modification time of a status file
  private tests = new Map<string, TestState & { version: number }>()
  private index = new Map<string, PlanTest>()
  private workers: { offset: number; rest: Buffer; finished: boolean }[] = []
  syncing?: Promise<boolean>

  constructor(
    private fs: Fs,
    readonly dir: string,
    readonly project = "",
    readonly source = "",
  ) {}

  /** When the run last showed signs of life: new status lines, or its files' modification times. */
  get active() {
    return Math.max(this.lastChange, this.modified, this.planMtime ?? this.created)
  }

  get done() {
    return !!this.plan && (this.workers.every((w) => w.finished) || this.tests.values().every(isDone))
  }

  /** Syncs with the files; resolves to whether anything changed. */
  sync(): Promise<boolean> {
    this.syncing ??= this.load().finally(() => {
      this.syncing = undefined
      this.lastSync = Date.now()
    })
    return this.syncing
  }

  private async load() {
    const before = [this.version, this.planVersion, this.done]
    await this.read()
    return [this.version, this.planVersion, this.done].some((value, i) => value !== before[i])
  }

  private async read() {
    if (!this.plan) {
      this.planMtime = (await this.fs.stat(join(this.dir, "plan.json")))?.mtime
      if (this.planMtime === undefined) return
      const text = await this.fs.readText(join(this.dir, "plan.json"))
      try {
        this.plan = normalizePlan(JSON.parse(text ?? ""))
      } catch {
        return // missing or still being written
      }
      for (const test of this.plan.tests) {
        this.tests.set(test.id, { status: "pending", version: 0 })
        this.index.set(test.id, test)
      }
      this.planVersion++
      const metadata = await readMetadata(this.fs, this.dir)
      this.title = typeof metadata?.name === "string" ? metadata.name : undefined
      this.workers = Array.from({ length: this.plan.worker_count }, () => ({
        offset: 0,
        rest: Buffer.alloc(0),
        finished: false,
      }))
    }
    await Promise.all(this.workers.map((worker, index) => this.tail(worker, join(this.dir, `status.${index}.jsonl`))))
  }

  private async tail(worker: (typeof this.workers)[number], file: string) {
    if (worker.finished) return
    const stat = await this.fs.stat(file)
    this.modified = Math.max(this.modified, stat?.mtime ?? 0)
    const size = stat?.size ?? 0
    if (size <= worker.offset) return
    const bytes = await this.fs.read(file, worker.offset, size - worker.offset)
    worker.offset += bytes.length
    const chunk = Buffer.concat([worker.rest, bytes])
    const end = chunk.lastIndexOf(10) + 1
    worker.rest = chunk.subarray(end)
    for (const line of chunk.subarray(0, end).toString().split("\n")) {
      let event: StatusEvent
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      worker.finished = event.type === "session_finish" // a rerun may append to the same file
      if (event.type === "plan_update") {
        this.updatePlan(event)
        continue
      }
      const test = this.tests.get(event.test)
      if (test) this.tests.set(event.test, { ...applyEvent(test, event), version: ++this.version })
    }
    if (this.lastSync) this.lastChange = Date.now()
  }

  /** Applies a change to the plan, made while running (e.g. by the `greendots_row_params` fixture). */
  private updatePlan({ row_params, test: id, name, module, params }: StatusEvent) {
    if (!this.plan) return
    if (row_params) this.plan.row_params = row_params
    const test = id === undefined ? undefined : this.index.get(id)
    if (test)
      Object.assign(test, {
        name: name ?? test.name,
        module: module ?? test.module,
        params: { ...test.params, ...params },
      })
    this.planVersion++
  }

  summary(): Summary {
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<Status, number>
    const summary: Summary = {
      ...counts,
      total: this.tests.size,
      done: this.done,
      started: this.plan?.started_at,
      updated: this.modified || undefined,
      collectErrors: this.plan?.errors.length ?? 0,
    }
    for (const test of this.tests.values()) {
      summary[test.status]++
      if (summary.done && test.end) summary.ended = Math.max(summary.ended ?? 0, test.end)
    }
    return summary
  }

  state(id: string): TestState {
    const { version: _, ...test } = this.tests.get(id) ?? { status: "pending" }
    return test
  }

  /** Tests that changed after `version`, without their bookkeeping. */
  changes(since: number) {
    const changes: Record<string, TestState> = {}
    for (const [id, { version, ...test }] of this.tests) if (version > since) changes[id] = test
    return changes
  }
}
