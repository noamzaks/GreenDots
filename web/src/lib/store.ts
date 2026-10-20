import { join, resolve, sep } from "node:path"
import { ActivityLog } from "./activity"
import { cachedFs, DiskCache, defaultCacheDir } from "./cache"
import { Config } from "./config"
import { background, type Fs, type FsOptions, nodeFs } from "./fs"
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
 * - runs are polled while they change, more slowly once they don't, and not at all after a while;
 * - finished runs are cached on disk, whole;
 * - what nobody waits for (prefetching, runs that aren't open) is read in the background, after the rest.
 */
export class Store {
  readonly changed = new Signal() // something clients may be waiting for changed
  readonly activity: ActivityLog
  readonly fs: ReturnType<typeof nodeFs> // the share itself: what `ops` counts
  readonly disk: DiskCache
  readonly files: Fs // the share through the disk cache, for reading logs
  readonly logs: LogReader
  private runs = new Map<string, Run>() // by `source/project/run`
  private viewers = new Map<string, number>() // open streams, by project ("" for the projects list)
  private cache = new Map<string, Entry>()
  private syncs = new Set<Promise<void>>() // syncs and what follows them (caching runs that finished)
  private queue: { project: string; source: string; name: string }[] = [] // runs to prefetch, one at a time
  private prefetching = false
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    public config: Config,
    private save: (config: Config) => void = () => {},
    fs: FsOptions = {},
  ) {
    this.activity = fs.activity ?? new ActivityLog(config.activity)
    this.fs = nodeFs({ ...fs, activity: this.activity })
    this.disk = new DiskCache(config.cache.dir || defaultCacheDir(), config.cache.size * 1024 * 1024)
    this.files = cachedFs(this.fs, this.disk)
    this.logs = new LogReader(this.files)
    void this.disk.loaded.then(() => this.changed.notify()) // to show cached summaries
    this.configure(config)
  }

  configure(config: Config) {
    if (JSON.stringify(config.sources) !== JSON.stringify(this.config.sources)) {
      this.runs.clear()
      this.cache.clear()
    }
    this.config = config
    this.fs.concurrency = config.filesystem.concurrency
    this.fs.rate = config.filesystem.rate
    this.fs.timeout = config.filesystem.timeout * 1000
    this.fs.chunk = config.filesystem.chunk * 1024
    this.logs.window = config.logs.window * 1024
    this.logs.preview = config.logs.preview * 1024
    this.activity.capacity = config.activity
    this.disk.limit = config.cache.size * 1024 * 1024
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
    const entry = this.cache.get(key) ?? { at: Number.NEGATIVE_INFINITY }
    if (Date.now() - entry.at >= maxAge && !entry.loading) {
      entry.loading = load().then(
        (value) => {
          const changed = JSON.stringify(value) !== JSON.stringify(entry.value) || entry.error !== undefined
          Object.assign(entry, { value, error: undefined, at: Date.now(), loading: undefined })
          if (changed && key.startsWith("runs:")) this.cache.delete(`title:${key.slice(key.indexOf("/") + 1)}`)
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

  /** How many runs are loaded in memory. */
  get loaded() {
    return this.runs.size
  }

  /** Resolves once nothing is loading (for tests). */
  async settled() {
    for (;;) {
      const loads = [...this.cache.values()].map((entry) => entry.loading)
      const pending = [...loads, ...this.syncs].filter(Boolean)
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
    // read once its listing shows a metadata.toml, and again only when that listing changes
    const listing = this.cache.get(`runs:${source.name}/${project}`) as { value?: { metadata?: boolean } } | undefined
    if (!listing?.value?.metadata) return undefined
    return this.peek(`title:${project}`, Number.POSITIVE_INFINITY, async () => {
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
      return (value?.runs ?? []).map((run) => ({ ...run, source: source.name }))
    })
    runs.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name, undefined, { numeric: true }))
    return { runs, loading }
  }

  private async listSource(path: string, project: string) {
    const { dirs: names, files } = await this.fs.entries(join(path, project))
    await this.disk.loaded
    const runs = await Promise.all(
      names.map(async (name) => {
        const dir = join(path, project, name)
        let mtime = this.disk.mtime(dir)
        if (mtime === undefined) {
          mtime = (await this.fs.stat(dir))?.mtime
          if (mtime === undefined) return { name, mtime: 0 } // unreadable for now: stat-ed again next time
          this.disk.setMtime(dir, mtime)
        }
        return { name, mtime }
      }),
    )
    return { runs, metadata: files.includes("metadata.toml") }
  }

  private runDir(source: string, project: string, name: string) {
    const path = this.config.sources.find((s) => s.name === source)?.path
    return path && isName(project) && isName(name) ? join(path, project, name) : undefined
  }

  /** Whether a project has a run in memory that is still being checked for updates. */
  private active(project: string) {
    for (const run of this.runs.values())
      if (run.project === project && ["live", "slow"].includes(this.polling(run))) return true
    return false
  }

  /**
   * A run, loaded the first time (from the disk cache if it finished, else from the share). `touch` means someone
   * is looking at it: it's read right away, and kept up to date for a while. Otherwise it's read in the background.
   */
  run(project: string, source: string, name: string, touch = true): Run | undefined {
    const dir = this.runDir(source, project, name)
    if (!dir) return undefined
    const key = `${source}/${project}/${name}`
    let run = this.runs.get(key)
    if (!run) {
      run = this.load(dir, project, source)
      this.runs.set(key, run)
      this.sync(run, touch)
    }
    if (touch) run.lastAccess = Date.now()
    return run
  }

  private load(dir: string, project: string, source: string) {
    const run: Run = new Run(this.fs, dir, project, source, async (version) => {
      const snapshot = await this.disk.snapshot(dir, version)
      if (snapshot) this.kept.set(run, 1) // as it's restored
      return snapshot
    })
    run.created = this.disk.mtime(dir) ?? run.created // so an old directory without a plan isn't polled as new
    return run
  }

  private kept = new WeakMap<Run, number>() // the version of each run that was cached

  /** Caches a run once it finished or stopped: whole, and its summary for lists. */
  private async keep(run: Run) {
    const final = run.settled(this.ms("slowAfter"))
    if (this.kept.get(run) === run.version || !(final || this.polling(run) === "stopped")) return
    const snapshot = run.snapshot(final)
    if (!snapshot) return
    this.kept.set(run, run.version)
    await this.disk.save(run.dir, snapshot, { version: snapshot.version, summary: run.summary(), title: run.title })
  }

  /** Syncs a run, letting clients know when something changed; in the background unless someone has it open. */
  sync(run: Run, now = run.viewers > 0) {
    const synced = now
      ? run.sync()
      : background(
          () => run.sync(),
          () => run.viewers === 0,
        )
    const done = synced.then(
      async (changed) => {
        if (changed) {
          this.activity.add({
            kind: "sync",
            path: run.dir,
            detail: `version ${run.version}${run.done ? ", done" : ""}`,
          })
          this.changed.notify()
        }
        await this.keep(run)
      },
      (error) => this.activity.add({ kind: "sync", path: run.dir, error: String(error?.message ?? error) }),
    )
    return this.track(done)
  }

  /** Keeps track of work that `settled` and `stop` wait for. */
  private track(work: Promise<void>) {
    this.syncs.add(work)
    void work.finally(() => this.syncs.delete(work))
    return work
  }

  /** Checks a run right away, and keeps checking it as if it just changed. */
  check(run: Run) {
    run.lastChange = Date.now()
    this.changed.notify()
    return this.sync(run, true)
  }

  polling(run: Run): Polling {
    const idle = Date.now() - run.active
    return run.done ? "done" : idle > this.ms("stopAfter") ? "stopped" : idle > this.ms("slowAfter") ? "slow" : "live"
  }

  /**
   * A project's runs, newest first. The first `count` are loaded and kept up to date; the
   * others show what's known of them, in memory or cached on disk, and the first `prefetch` of them that
   * aren't known yet are summarized in the background, slowly.
   */
  runInfos = (project: string, count: number, touch: boolean, prefetch = 0): { runs: RunInfo[]; loading: boolean } => {
    const { runs, loading } = this.listRuns(project)
    return {
      loading,
      runs: runs.map((info, index): RunInfo => {
        let run = this.runs.get(`${info.source}/${project}/${info.name}`)
        if (index < count) run = this.run(project, info.source, info.name, touch)
        else if (run && touch) run.lastAccess = Date.now()
        if (run) return { ...info, title: run.title, summary: run.plan && run.summary(), polling: this.polling(run) }
        const dir = this.runDir(info.source, project, info.name)
        const cached = dir === undefined ? undefined : this.disk.summary(dir)
        if (!cached && index < prefetch) this.prefetch(project, info.source, info.name)
        const polling = cached && (cached.summary.done ? "done" : "stopped")
        return { ...info, title: cached?.title, summary: cached?.summary, polling }
      }),
    }
  }

  /** Queues a run to be summarized in the background, unless nobody looks at its project by its turn. */
  private prefetch(project: string, source: string, name: string) {
    if (this.queue.some((q) => q.project === project && q.source === source && q.name === name)) return
    this.queue.push({ project, source, name })
    if (!this.prefetching) void this.drain()
  }

  /**
   * Reads the queued runs in the background, one at a time and `prefetch.interval` apart, so a project page can't
   * flood a share. A finished one is cached on disk and dropped from memory; one in progress is kept up to date.
   */
  private async drain() {
    this.prefetching = true
    try {
      await this.disk.loaded
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        const { project, source, name } = item
        const dir = this.runDir(source, project, name)
        const key = `${source}/${project}/${name}`
        if (!dir || !this.viewed(project) || this.runs.has(key) || this.disk.summary(dir)) continue
        const run = this.run(project, source, name, false)
        await run?.syncing
        if (run && this.kept.has(run) && run.viewers === 0) this.runs.delete(key) // only its summary is shown
        this.activity.add({ kind: "sync", path: dir, detail: `prefetched${run?.done ? ", done" : ""}` })
        await new Promise((resolve) => setTimeout(resolve, this.config.prefetch.interval * 1000))
      }
    } finally {
      this.prefetching = false
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
      const recent = synced ? this.config.polling.recentRuns : 0
      const { runs } = this.runInfos(name, recent, false)
      const shown = Math.max(this.config.polling.recentRuns, 3)
      return {
        name,
        title: this.projectTitle(name),
        synced,
        runs: runs.slice(0, shown),
      }
    })
    return { projects, errors, loading }
  }

  setSynced(project: string, synced: boolean) {
    if (!isName(project)) return
    this.update((config) => ({
      ...config,
      synced: synced ? [...new Set([...config.synced, project])] : config.synced.filter((name) => name !== project),
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

  /** A log's size, stat-ed at most once per poll interval however many clients follow it (and once if it's cached). */
  async logSize(path: string) {
    const entry = this.cache.get(`size:${path}`)
    if (entry && Date.now() - entry.at < this.ms("run")) return entry.value as number
    const size = (await this.files.stat(path))?.size ?? 0
    this.cache.set(`size:${path}`, { at: Date.now(), value: size })
    return size
  }

  /** One background round: refreshes what's synced or viewed, and polls runs as their activity warrants. */
  tick() {
    const now = Date.now()
    for (const [key, entry] of this.cache)
      if (!entry.loading && now - entry.at > 2 * this.ms("browse") && !key.startsWith("title:")) this.cache.delete(key)
    if (this.viewed("")) this.projects()
    const synced = new Set<Run>()
    for (const project of new Set([...this.config.synced, ...this.viewers.keys()])) {
      if (!project || !(this.viewed(project) || this.config.synced.includes(project))) continue
      const { runs } = this.viewed(project)
        ? this.listRuns(project)
        : background(
            () => this.listRuns(project),
            () => !this.viewed(project),
          )
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
      // open runs are checked every `run` seconds, those only listed or synced every `list`
      const every = this.ms(polling === "slow" ? "slowRun" : run.viewers > 0 ? "run" : "list")
      if (polling === "done" || polling === "stopped") this.track(this.keep(run)) // e.g. after a quiet while
      // a finished run's directory may be reused for a new run: check while someone looks at it
      if (polling === "done") {
        if (run.viewers > 0 && since > this.ms("slowRun")) this.replaceIfRerun(key, run)
      } else if (polling !== "stopped" && since >= every) this.sync(run)
    }
  }

  private async replaceIfRerun(key: string, run: Run) {
    run.lastSync = Date.now()
    const mtime = (await this.fs.stat(join(run.dir, "plan.json")))?.mtime
    if (mtime === run.planMtime) return
    this.disk.forget(run.dir) // rerun into the same directory
    const replacement = this.load(run.dir, run.project, run.source)
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

  async stop() {
    clearTimeout(this.timer)
    await Promise.allSettled(this.syncs)
    await this.disk.flush()
  }
}

const global = globalThis as { greendots?: Store }
export const store = () => {
  if (!global.greendots) {
    const store = new Store(loadConfig(), saveConfig)
    global.greendots = store
    // open event streams never end, so don't wait for them (as Next does) when asked to stop: e.g. by systemd
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => void store.stop().finally(() => process.exit(0)))
  }
  return global.greendots
}
