import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Fs } from "./fs"
import type { Snapshot } from "./run"
import type { Summary } from "./types"

/** A file in the cache: a path made at runtime, which the build mustn't try to trace. */
const at = (dir: string, name: string) => join(/*turbopackIgnore: true*/ dir, name)

const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 20)

/** Where the cache goes when the config doesn't say: the XDG cache directory, like other Linux apps. */
export const defaultCacheDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "greendots")

/** What lists show of a cached run, without reading the share. */
export type CachedSummary = { version: number; summary: Summary; title?: string }

type Index = { mtimes: Record<string, number>; summaries: Record<string, CachedSummary> }
type Stat = { size: number; mtime: number } | null

/**
 * A disk cache, so the share is read once for what doesn't change, also across restarts:
 *
 *   <dir>/index.json                              run directories' mtimes (to sort them) and cached runs' summaries
 *   <dir>/runs/<run dir's hash>/run.json          a run that finished or stopped, whole (its snapshot)
 *   <dir>/runs/<run dir's hash>/<chunk>/<file's hash>.<n|stat>   a finished run's logs, in chunks, as they're read
 *
 * A finished run's files only change if it's rerun into the same directory, which rewrites its plan: so a
 * snapshot is kept with its version (the plan's mtime). Runs take at most `limit` bytes, the least used going first.
 */
export class DiskCache {
  private index: Index = { mtimes: {}, summaries: {} }
  readonly loaded: Promise<void>
  private saving?: ReturnType<typeof setTimeout>
  private versions = new Map<string, number>() // run dir -> the version cached of it
  private frozen = new Set<string>() // finished runs, whose logs are read from the cache
  private size?: Promise<number>
  private touched = new Map<string, number>()
  private evicting = Promise.resolve()

  constructor(
    public dir: string,
    public limit: number,
  ) {
    this.loaded = readFile(at(dir, "index.json"), "utf8").then(
      (text) => {
        this.index = { ...this.index, ...JSON.parse(text) }
      },
      () => {},
    )
  }

  private runDir = (run: string) => at(join(this.dir, "runs"), hash(run))

  mtime = (run: string): number | undefined => this.index.mtimes[run]
  summary = (run: string): CachedSummary | undefined => this.index.summaries[run]

  setMtime(run: string, mtime: number) {
    this.index.mtimes[run] = mtime
    this.saveIndex()
  }

  /** The run as it was cached, if it was at this version. */
  async snapshot(run: string, version: number): Promise<Snapshot | undefined> {
    try {
      const snapshot: Snapshot = JSON.parse(await readFile(at(this.runDir(run), "run.json"), "utf8"))
      if (snapshot.version !== version) return undefined
      this.versions.set(run, version)
      if (snapshot.final) this.frozen.add(run)
      this.touch(this.runDir(run))
      return snapshot
    } catch {
      return undefined
    }
  }

  /** Keeps a run, replacing an older version of it (and its logs), and its summary. */
  async save(run: string, snapshot: Snapshot, summary: CachedSummary) {
    this.index.summaries[run] = summary
    this.saveIndex()
    if (this.versions.get(run) !== snapshot.version) await rm(this.runDir(run), { recursive: true, force: true })
    this.versions.set(run, snapshot.version)
    await this.write(at(this.runDir(run), "run.json"), JSON.stringify(snapshot), this.runDir(run))
    if (snapshot.final) this.frozen.add(run)
  }

  /** Forgets a run that was rerun into the same directory. */
  forget(run: string) {
    this.versions.delete(run)
    this.frozen.delete(run)
    delete this.index.summaries[run]
    this.saveIndex()
  }

  /** Whether a file belongs to a finished run, so it won't change. */
  final = (path: string) => this.frozen.has(dirname(path))

  private file = (path: string, chunk: number, name: string) =>
    at(at(this.runDir(dirname(path)), String(chunk)), `${hash(path)}.${name}`)

  async chunk(path: string, chunk: number, index: number): Promise<Buffer | undefined> {
    return readFile(this.file(path, chunk, String(index))).catch(() => undefined)
  }

  saveChunk = (path: string, chunk: number, index: number, bytes: Buffer) =>
    this.write(this.file(path, chunk, String(index)), bytes, this.runDir(dirname(path)))

  async stat(path: string, chunk: number): Promise<Stat | undefined> {
    return readFile(this.file(path, chunk, "stat"), "utf8").then(JSON.parse, () => undefined)
  }

  saveStat = (path: string, chunk: number, value: Stat) =>
    this.write(this.file(path, chunk, "stat"), JSON.stringify(value), this.runDir(dirname(path)))

  /** How many bytes the runs take. */
  usage = () => this.used()

  /** Forgets everything: runs, their summaries and run directories' mtimes. */
  async clear() {
    await this.evicting
    clearTimeout(this.saving)
    this.saving = undefined
    this.index = { mtimes: {}, summaries: {} }
    this.versions.clear()
    this.frozen.clear()
    this.touched.clear()
    await rm(join(this.dir, "runs"), { recursive: true, force: true })
    await rm(at(this.dir, "index.json"), { force: true })
    this.size = Promise.resolve(0)
  }

  /** Saves the index a few seconds after it changes. */
  private saveIndex() {
    this.saving ??= setTimeout(() => void this.flush(), 5000)
  }

  /** Saves the index now, if it changed. */
  async flush() {
    if (!this.saving) return
    clearTimeout(this.saving)
    this.saving = undefined
    await this.write(at(this.dir, "index.json"), JSON.stringify(this.index))
  }

  /** Marks a run's cache directory as used (at most once a minute), so it's evicted last. */
  private touch(dir: string) {
    const now = Date.now()
    if (now - (this.touched.get(dir) ?? 0) < 60_000) return
    this.touched.set(dir, now)
    utimes(dir, new Date(), new Date()).catch(() => {})
  }

  /**
   * Writes a file atomically, counting it against the limit if it's in a run's cache directory `run`. A full
   * disk or an unwritable directory just means less caching.
   */
  private async write(path: string, data: string | Buffer, run?: string) {
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(`${path}.tmp`, data)
      await rename(`${path}.tmp`, path)
    } catch {
      return
    }
    if (!run) return
    this.touch(run)
    this.size = Promise.resolve((await this.used()) + Buffer.byteLength(data))
    if ((await this.size) > this.limit) this.evicting = this.evicting.then(() => this.evict())
  }

  /** How many bytes the runs take (counted once, then kept up to date). */
  private used() {
    this.size ??= du(join(this.dir, "runs"))
    return this.size
  }

  /** Removes the runs used least recently until the cache is under 90% of its limit. */
  private async evict() {
    const root = join(this.dir, "runs")
    const runs = await Promise.all(
      (await readdir(root).catch(() => [])).map(async (name) => {
        const path = at(root, name)
        return { path, used: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0, size: await du(path) }
      }),
    )
    let size = runs.reduce((total, run) => total + run.size, 0)
    const gone = new Set<string>()
    for (const run of runs.sort((a, b) => a.used - b.used)) {
      if (size <= this.limit * 0.9) break
      await rm(run.path, { recursive: true, force: true })
      gone.add(run.path)
      size -= run.size
    }
    for (const run of this.versions.keys())
      if (gone.has(this.runDir(run))) {
        this.versions.delete(run)
        this.frozen.delete(run)
      }
    this.size = Promise.resolve(size)
  }
}

async function du(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  let size = 0
  for (const entry of entries) {
    const child = at(path, entry.name)
    size += entry.isDirectory() ? await du(child) : ((await stat(child).catch(() => undefined))?.size ?? 0)
  }
  return size
}

/**
 * The sources' files, through the disk cache: files of finished, cached runs are stat-ed once and read
 * once from the share, in `fs.chunk` pieces, and from the cache from then on. Other files come from the share.
 */
export function cachedFs(fs: Fs, cache: DiskCache): Fs {
  const pending = new Map<string, Promise<Buffer>>() // chunks being fetched, so they're fetched once
  const chunk = async (path: string, size: number, index: number) => {
    const cached = await cache.chunk(path, size, index)
    if (cached) return cached
    const key = `${path}\0${size}\0${index}`
    let fetching = pending.get(key)
    if (!fetching) {
      fetching = fs.read(path, index * size, size).then(async (bytes) => {
        await cache.saveChunk(path, size, index, bytes)
        return bytes
      })
      pending.set(key, fetching)
      fetching.finally(() => pending.delete(key)).catch(() => {})
    }
    return fetching
  }
  const cached: Fs = {
    get chunk() {
      return fs.chunk
    },
    list: (dir) => fs.list(dir),
    entries: (dir) => fs.entries(dir),
    stat: async (path) => {
      if (!cache.final(path)) return fs.stat(path)
      const known = await cache.stat(path, fs.chunk)
      if (known !== undefined) return known ?? undefined
      const value = await fs.stat(path)
      await cache.saveStat(path, fs.chunk, value ?? null)
      return value
    },
    read: async (path, offset, length) => {
      if (!cache.final(path)) return fs.read(path, offset, length)
      const size = fs.chunk
      const parts: Buffer[] = []
      for (let index = Math.floor(offset / size); index * size < offset + length; index++) {
        const bytes = await chunk(path, size, index)
        parts.push(bytes)
        if (bytes.length < size) break // the end of the file
      }
      const start = offset % size
      return Buffer.concat(parts).subarray(start, start + length)
    },
    readText: (path) => fs.readText(path),
  }
  return cached
}
