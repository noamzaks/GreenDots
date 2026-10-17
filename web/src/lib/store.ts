import { join, resolve, sep } from "node:path"
import { ActivityLog } from "./activity"
import { Config } from "./config"
import { type FsOptions, nodeFs } from "./fs"
import { LogReader } from "./logs"
import { Run, readMetadata } from "./run"
import { loadConfig, saveConfig } from "./settings"
import { Signal } from "./signal"
import type { Polling, ProjectInfo, Projects, RunInfo } from "./types"

const MINUTE = 60_000
const isName = (name: string) => !!name && !name.startsWith(".") && !/[\\/]/.test(name)
export type LogTarget = { test?: string; session?: number }
type Entry = { at: number; value?: unknown; error?: string; loading?: Promise<void> }

/**
 * An in-memory mirror of the sources' `<project>/<run>/` directories, made for slow network shares:
 * - listings are served from cache and refreshed in the background (stale-while-revalidate);
 * - only what someone looks at (an open stream) or syncs (the latest runs of synced projects) is read;
 * - runs are polled while they change, more slowly once they don't, and not at all after a while.
 */
export class Store {
  readonly changed = new Signal() // something clients may be waiting for changed
  readonly activity: ActivityLog
  readonly fs: ReturnType<typeof nodeFs>
  readonly logs: LogReader
  private runs = new Map<string, Run>() // by `source/project/run`
  private viewers = new Map<string, number>() // open streams, by project ("" for the projects list)
  private cache = new Map<string, Entry>()
  private mtimes = new Map<string, number>()
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    public config: Config,
    private save: (config: Config) => void = () => {},
    fs: FsOptions = {},
  ) {
    this.activity = fs.activity ?? new ActivityLog(config.activity)
    this.fs = nodeFs({ ...fs, activity: this.activity })
    this.logs = new LogReader(this.fs)
    this.configure(config)
  }

  configure(config: Config) {
    if (JSON.stringify(config.sources) !== JSON.stringify(this.config.sources)) {
      this.runs.clear()
      this.cache.clear()
    }
    this.config = config
    this.fs.concurrency = config.filesystem.concurrency
    this.fs.timeout = config.filesystem.timeout * 1000
    this.logs.window = config.logs.window * 1024
    this.logs.preview = config.logs.preview * 1024
    this.activity.capacity = config.activity
    this.changed.notify()
  }

  update(change: (config: Config) => Config) {
    const config = Config.parse(change(structuredClone(this.config)))
    this.save(config)
    this.configure(config)
  }

  private ms(setting: keyof Omit<Config["polling"], "recentRuns">) {
    return this.config.polling[setting] * 1000
  }

  /** The cached value of `key`, refreshed in the background once older than `maxAge`. */
  private peek<T>(key: string, maxAge: number, load: () => Promise<T>): { value?: T; error?: string } {
    const entry = this.cache.get(key) ?? { at: 0 }
    if (Date.now() - entry.at >= maxAge && !entry.loading) {
      entry.loading = load().then(
        (value) => {
          const changed = JSON.stringify(value) !== JSON.stringify(entry.value) || entry.error !== undefined
          Object.assign(entry, { value, error: undefined, at: Date.now(), loading: undefined })
          if (changed) this.changed.notify()
        },
        (error) => {
          Object.assign(entry, { error: String(error?.message ?? error), at: Date.now(), loading: undefined })
          this.changed.notify()
        },
      )
      this.cache.set(key, entry)
    }
    return { value: entry.value as T | undefined, error: entry.error }
  }

  /** Resolves once nothing is loading (for tests). */
  async settled() {
    for (;;) {
      const loads = [...this.cache.values()].map((entry) => entry.loading)
      const pending = [...loads, ...[...this.runs.values()].map((run) => run.syncing)].filter(Boolean)
      if (!pending.length) return
      await Promise.allSettled(pending)
    }
  }

  private viewed(project: string) {
    return (this.viewers.get(project) ?? 0) > 0
  }

  /** Marks a project ("" for the projects list) as shown by an open stream; call the result when it closes. */
  view(project: string) {
    this.viewers.set(project, (this.viewers.get(project) ?? 0) + 1)
    return () => this.viewers.set(project, (this.viewers.get(project) ?? 1) - 1)
  }

  private sourceProjects(source: Config["sources"][number]) {
    const maxAge = this.viewed("") ? this.ms("list") : this.ms("browse")
    return this.peek(`source:${source.name}`, maxAge, () => this.fs.list(source.path))
  }

  projectTitle = (project: string) => {
    const source = this.config.sources.find((source) => this.sourceProjects(source).value?.includes(project))
    if (!source) return undefined
    return this.peek(`title:${project}`, 10 * MINUTE, async () => {
      const name = (await readMetadata(this.fs, join(source.path, project)))?.name
      return typeof name === "string" ? name : undefined
    }).value
  }

  /** A project's runs in every source, newest first. Each run directory is stat-ed once, for sorting. */
  listRuns(project: string): { runs: RunInfo[]; loading: boolean } {
    if (!isName(project)) return { runs: [], loading: false }
    const busy = this.viewed(project) || this.active(project) // else new runs show up within `browse`
    let loading = false
    const runs = this.config.sources.flatMap((source) => {
      if (!this.sourceProjects(source).value?.includes(project)) return []
      const { value } = this.peek(`runs:${source.name}/${project}`, this.ms(busy ? "list" : "browse"), () =>
        this.listSource(source.path, project),
      )
      loading ||= value === undefined
      return (value ?? []).map((run) => ({ ...run, source: source.name }))
    })
    runs.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name, undefined, { numeric: true }))
    return { runs, loading }
  }

  private async listSource(path: string, project: string) {
    const names = await this.fs.list(join(path, project))
    return Promise.all(
      names.map(async (name) => {
        const dir = join(path, project, name)
        if (!this.mtimes.has(dir)) this.mtimes.set(dir, (await this.fs.stat(dir))?.mtime ?? 0)
        return { name, mtime: this.mtimes.get(dir) ?? 0 }
      }),
    )
  }

  /** Whether a project has a run in memory that is still being checked for updates. */
  private active(project: string) {
    for (const run of this.runs.values())
      if (run.project === project && ["live", "slow"].includes(this.polling(run))) return true
    return false
  }

  /** A run, loaded in the background the first time; `touch` marks it as viewed so it keeps syncing. */
  run(project: string, source: string, name: string, touch = true): Run | undefined {
    const path = this.config.sources.find((s) => s.name === source)?.path
    if (!path || !isName(project) || !isName(name)) return undefined
    const key = `${source}/${project}/${name}`
    let run = this.runs.get(key)
    if (!run) {
      run = new Run(this.fs, join(path, project, name), project, source)
      this.runs.set(key, run)
      this.sync(run)
    }
    if (touch) run.lastAccess = Date.now()
    return run
  }

  /** Syncs a run, letting clients know when something changed. */
  sync(run: Run) {
    return run.sync().then(
      (changed) => {
        if (!changed) return
        this.activity.add({ kind: "sync", path: run.dir, detail: `version ${run.version}${run.done ? ", done" : ""}` })
        this.changed.notify()
      },
      (error) => this.activity.add({ kind: "sync", path: run.dir, error: String(error?.message ?? error) }),
    )
  }

  /** Checks a run right away, and keeps checking it as if it just changed. */
  check(run: Run) {
    run.lastChange = Date.now()
    this.changed.notify()
    return this.sync(run)
  }

  polling(run: Run): Polling {
    const idle = Date.now() - run.active
    return run.done ? "done" : idle > this.ms("stopAfter") ? "stopped" : idle > this.ms("slowAfter") ? "slow" : "live"
  }

  /** A project's runs, with summaries of the first `count` (which get loaded). */
  runInfos = (project: string, count: number, touch: boolean): { runs: RunInfo[]; loading: boolean } => {
    const { runs, loading } = this.listRuns(project)
    return {
      loading,
      runs: runs.map((info, index) => {
        const key = `${info.source}/${project}/${info.name}`
        const run = index < count ? this.run(project, info.source, info.name, touch) : this.runs.get(key)
        return { ...info, title: run?.title, summary: run?.plan && run.summary(), polling: run && this.polling(run) }
      }),
    }
  }

  /** Every project in every source, with its latest runs (summarized for synced projects). */
  projects(): Projects {
    const errors: Projects["errors"] = []
    const names = new Set<string>()
    let loading = false
    for (const source of this.config.sources) {
      const { value, error } = this.sourceProjects(source)
      if (error) errors.push({ source: source.name, error })
      loading ||= value === undefined && !error
      for (const name of value ?? []) names.add(name)
    }
    const projects = [...names].map((name): ProjectInfo => {
      const synced = this.config.synced.includes(name)
      const { runs } = this.runInfos(name, synced ? this.config.polling.recentRuns : 0, false)
      const shown = Math.max(this.config.polling.recentRuns, 3)
      return {
        name,
        title: this.projectTitle(name),
        synced,
        pinned: this.config.pinned.includes(name),
        runs: runs.slice(0, shown),
      }
    })
    return { projects, errors, loading }
  }

  setProject(project: string, change: { synced?: boolean; pinned?: boolean }) {
    if (!isName(project)) return
    const toggle = (list: string[], on?: boolean) =>
      on === undefined ? list : on ? [...new Set([...list, project])] : list.filter((name) => name !== project)
    this.update((config) => ({
      ...config,
      synced: toggle(config.synced, change.synced),
      pinned: toggle(config.pinned, change.pinned),
    }))
  }

  /** The path of a test's log, or of a worker's session log (output outside of tests). */
  async logFile(run: Run, { test, session }: LogTarget) {
    if (!run.plan) await run.sync()
    if (!run.plan) return undefined
    const file = session !== undefined ? `session.${session}.log.jsonl` : run.plan.tests.find((t) => t.id === test)?.log
    const path = file && resolve(run.dir, file)
    return path?.startsWith(run.dir + sep) ? path : undefined
  }

  /** A log's size, stat-ed at most once per poll interval however many clients follow it. */
  async logSize(path: string) {
    const entry = this.cache.get(`size:${path}`)
    if (entry && Date.now() - entry.at < this.ms("run")) return entry.value as number
    const size = (await this.fs.stat(path))?.size ?? 0
    this.cache.set(`size:${path}`, { at: Date.now(), value: size })
    return size
  }

  /** One background round: refreshes what's synced or viewed, and polls runs as their activity warrants. */
  tick() {
    const now = Date.now()
    for (const [key, entry] of this.cache)
      if (!entry.loading && now - entry.at > 2 * this.ms("browse")) this.cache.delete(key)
    if (this.viewed("")) this.projects()
    const synced = new Set<Run>()
    for (const project of new Set([...this.config.synced, ...this.viewers.keys()])) {
      if (!project || !(this.viewed(project) || this.config.synced.includes(project))) continue
      const { runs } = this.listRuns(project)
      if (!this.config.synced.includes(project)) continue
      for (const { source, name } of runs.slice(0, this.config.polling.recentRuns)) {
        const run = this.run(project, source, name, false)
        if (run) synced.add(run)
      }
    }
    for (const [key, run] of this.runs) {
      const interested = synced.has(run) || run.viewers > 0 || now - run.lastAccess < 2 * MINUTE
      if (!interested) {
        if (now - run.lastAccess > 10 * MINUTE) this.runs.delete(key)
        continue
      }
      const since = now - run.lastSync
      const polling = this.polling(run)
      if (polling === "done") {
        // a finished run's directory may be reused for a new run: check while someone looks at it
        if (run.viewers > 0 && since > this.ms("slowRun")) this.replaceIfRerun(key, run)
      } else if (polling !== "stopped" && since >= this.ms(polling === "slow" ? "slowRun" : "run")) this.sync(run)
    }
  }

  private async replaceIfRerun(key: string, run: Run) {
    run.lastSync = Date.now()
    const mtime = (await this.fs.stat(join(run.dir, "plan.json")))?.mtime
    if (mtime === run.planMtime) return
    const replacement = new Run(this.fs, run.dir, run.project, run.source)
    Object.assign(replacement, { lastAccess: run.lastAccess, viewers: run.viewers })
    this.runs.set(key, replacement)
    this.sync(replacement)
  }

  start() {
    const sources = this.config.sources.map((s) => `${s.name} (${s.path})`).join(", ")
    console.log(`GreenDots is serving ${sources || "no sources yet: add some on the settings page"}`)
    const loop = () => {
      try {
        this.tick()
      } catch (error) {
        console.error(error)
      }
      this.timer = setTimeout(loop, this.ms("run"))
    }
    loop()
  }

  stop() {
    clearTimeout(this.timer)
  }
}

const global = globalThis as { greendots?: Store }
export const store = () => {
  global.greendots ??= new Store(loadConfig(), saveConfig)
  return global.greendots
}
