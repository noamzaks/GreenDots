import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Fs } from "./fs"
import type { Summary } from "./types"

/** A file in the cache: a path made at runtime, which the build mustn't try to trace. */
const at = (dir: string, name: string) => join(/*turbopackIgnore: true*/ dir, name)

const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 20)

/** Where the cache goes when the config doesn't say: the XDG cache directory, like other Linux apps. */
export const defaultCacheDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "greendots")

/** What's kept of a finished run, so lists show it without reading the share. */
export type CachedSummary = { version: number; summary: Summary; title?: string }

/**
 * A disk cache of finished runs, so the share is read once for them, however often they're looked at and
 * across restarts. A finished run's files don't change unless it's rerun into the same directory, which
 * rewrites its plan: so they're kept per `version` (its plan's mtime), in chunks, and a run's summary with it.
 *
 *   <dir>/runs/<run dir's hash>/summary.json              the latest summary, with its version
 *   <dir>/runs/<run dir's hash>/<version>-<chunk>/<file's hash>.<n>    the file's n-th chunk
 *   <dir>/runs/<run dir's hash>/<version>-<chunk>/<file's hash>.stat   its size and mtime
 *   <dir>/runs/<run dir's hash>/<version>-<chunk>/<file's hash>.missing  or that it doesn't exist
 *   <dir>/mtimes.json                                    run directories' mtimes, for sorting them
 *
 * At most `limit` bytes are kept: the runs used least recently go first.
 */
export class DiskCache {
  private frozen = new Map<string, number>() // run dir -> version, for runs whose files don't change anymore
  private size?: Promise<number>
  private touched = new Map<string, number>()
  private writing = Promise.resolve()

  constructor(
    public dir: string,
    public limit: number,
  ) {}

  private runDir = (run: string) => at(join(this.dir, "runs"), hash(run))
  private filesDir = (run: string, version: number, chunk: number) => at(this.runDir(run), `${version}-${chunk}`)

  /** The files of `run` are final at `version` (they're read from the cache from now on). */
  freeze(run: string, version: number) {
    this.frozen.set(run, version)
  }

  thaw(run: string) {
    this.frozen.delete(run)
  }

  /** The version a file's run is frozen at, if it is. */
  version(path: string) {
    return this.frozen.get(dirname(path))
  }

  async summary(run: string): Promise<CachedSummary | undefined> {
    try {
      return JSON.parse(await readFile(/*turbopackIgnore: true*/ join(this.runDir(run), "summary.json"), "utf8"))
    } catch {
      return undefined
    }
  }

  async saveSummary(run: string, summary: CachedSummary) {
    await this.write(join(this.runDir(run), "summary.json"), JSON.stringify(summary), this.runDir(run))
  }

  async chunk(path: string, version: number, size: number, index: number): Promise<Buffer | undefined> {
    const dir = this.filesDir(dirname(path), version, size)
    try {
      const bytes = await readFile(/*turbopackIgnore: true*/ at(dir, `${hash(path)}.${index}`))
      this.touch(this.runDir(dirname(path)))
      return bytes
    } catch {
      return undefined
    }
  }

  async saveChunk(path: string, version: number, size: number, index: number, bytes: Buffer) {
    const dir = this.filesDir(dirname(path), version, size)
    await this.write(at(dir, `${hash(path)}.${index}`), bytes, this.runDir(dirname(path)))
  }

  async stat(
    /*turbopackIgnore: true*/ path: string,
    version: number,
    size: number,
  ): Promise<{ size: number; mtime: number } | undefined> {
    try {
      return JSON.parse(
        await readFile(
          /*turbopackIgnore: true*/ at(this.filesDir(dirname(path), version, size), `${hash(path)}.stat`),
          "utf8",
        ),
      )
    } catch {
      return undefined
    }
  }

  async saveStat(path: string, version: number, size: number, value: { size: number; mtime: number }) {
    const dir = this.filesDir(dirname(path), version, size)
    await this.write(at(dir, `${hash(path)}.stat`), JSON.stringify(value), this.runDir(dirname(path)))
  }

  /** Whether a file of a frozen run is known not to exist (e.g. an optional metadata.toml). */
  async missing(path: string, version: number, size: number) {
    const file = at(this.filesDir(dirname(path), version, size), `${hash(path)}.missing`)
    return stat(/*turbopackIgnore: true*/ file).then(
      () => true,
      () => false,
    )
  }

  async saveMissing(path: string, version: number, size: number) {
    const dir = this.filesDir(dirname(path), version, size)
    await this.write(at(dir, `${hash(path)}.missing`), "", this.runDir(dirname(path)))
  }

  async mtimes(): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(/*turbopackIgnore: true*/ join(this.dir, "mtimes.json"), "utf8"))
    } catch {
      return {}
    }
  }

  async saveMtimes(mtimes: Record<string, number>) {
    await this.write(join(this.dir, "mtimes.json"), JSON.stringify(mtimes))
  }

  /** Marks a run's cache directory as used (at most once a minute), so it's evicted last. */
  private touch(dir: string) {
    const now = Date.now()
    if (now - (this.touched.get(dir) ?? 0) < 60_000) return
    this.touched.set(dir, now)
    utimes(/*turbopackIgnore: true*/ dir, new Date(), new Date()).catch(() => {})
  }

  /**
   * Writes a file atomically, counting it against the limit if it's in a run's cache directory `run`. A full
   * disk or an unwritable directory just means less caching.
   */
  private async write(path: string, data: string | Buffer, run?: string) {
    try {
      await mkdir(/*turbopackIgnore: true*/ dirname(path), { recursive: true })
      await writeFile(/*turbopackIgnore: true*/ `${path}.tmp`, data)
      await rename(/*turbopackIgnore: true*/ `${path}.tmp`, path)
    } catch {
      return
    }
    if (!run) return
    this.touch(run)
    const size = (await this.used()) + Buffer.byteLength(data)
    this.size = Promise.resolve(size)
    if (size > this.limit) this.writing = this.writing.then(() => this.evict())
  }

  /** How many bytes the cache holds (counted once, then kept up to date). */
  private used() {
    this.size ??= du(join(this.dir, "runs"))
    return this.size
  }

  /** Removes the runs used least recently until the cache is under 90% of its limit. */
  private async evict() {
    const root = join(this.dir, "runs")
    const runs = await Promise.all(
      (await readdir(/*turbopackIgnore: true*/ root).catch(() => [])).map(async (name) => {
        const path = join(root, name)
        return {
          path,
          used: (await stat(/*turbopackIgnore: true*/ path).catch(() => undefined))?.mtimeMs ?? 0,
          size: await du(path),
        }
      }),
    )
    let size = runs.reduce((total, run) => total + run.size, 0)
    for (const run of runs.sort((a, b) => a.used - b.used)) {
      if (size <= this.limit * 0.9) break
      await rm(/*turbopackIgnore: true*/ run.path, { recursive: true, force: true })
      size -= run.size
    }
    this.size = Promise.resolve(size)
  }
}

async function du(path: string): Promise<number> {
  const entries = await readdir(/*turbopackIgnore: true*/ path, { withFileTypes: true }).catch(() => [])
  let size = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    size += entry.isDirectory()
      ? await du(child)
      : ((await stat(/*turbopackIgnore: true*/ child).catch(() => undefined))?.size ?? 0)
  }
  return size
}

/**
 * The sources' files, through the disk cache: files of frozen runs are read and stat-ed once from the share,
 * in `fs.chunk` pieces, and from the cache from then on. Other files are read from the share every time.
 */
export function cachedFs(fs: Fs, cache: DiskCache): Fs {
  const pending = new Map<string, Promise<Buffer>>() // chunks being fetched, so they're fetched once
  const chunk = async (path: string, version: number, size: number, index: number) => {
    const cached = await cache.chunk(path, version, size, index)
    if (cached) return cached
    if (await cache.missing(path, version, size)) throw Object.assign(new Error(`${path}: missing`), { code: "ENOENT" })
    const key = `${path}\0${version}\0${size}\0${index}`
    let fetching = pending.get(key)
    if (!fetching) {
      fetching = fs.read(path, index * size, size).then(
        async (bytes) => {
          await cache.saveChunk(path, version, size, index, bytes)
          return bytes
        },
        async (error) => {
          if (error?.code === "ENOENT") await cache.saveMissing(path, version, size)
          throw error
        },
      )
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
    stat: async (path) => {
      const version = cache.version(path)
      if (version === undefined) return fs.stat(path)
      const known = await cache.stat(path, version, fs.chunk)
      if (known) return known
      if (await cache.missing(path, version, fs.chunk)) return undefined
      const value = await fs.stat(path)
      if (value) await cache.saveStat(path, version, fs.chunk, value)
      else await cache.saveMissing(path, version, fs.chunk)
      return value
    },
    read: async (path, offset, length) => {
      const version = cache.version(path)
      if (version === undefined) return fs.read(path, offset, length)
      const size = fs.chunk
      const parts: Buffer[] = []
      for (let index = Math.floor(offset / size); index * size < offset + length; index++) {
        const bytes = await chunk(path, version, size, index)
        parts.push(bytes)
        if (bytes.length < size) break // the end of the file
      }
      const start = offset - Math.floor(offset / size) * size
      return Buffer.concat(parts).subarray(start, start + length)
    },
    readText: async (path) => {
      if (cache.version(path) === undefined) return fs.readText(path)
      const parts: Buffer[] = []
      try {
        for (let offset = 0; ; ) {
          const part = await cached.read(path, offset, fs.chunk)
          parts.push(part)
          offset += part.length
          if (part.length < fs.chunk) return Buffer.concat(parts).toString("utf8")
        }
      } catch {
        return undefined
      }
    },
  }
  return cached
}
