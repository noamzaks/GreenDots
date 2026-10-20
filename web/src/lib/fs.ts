import { AsyncLocalStorage } from "node:async_hooks"
import { open, readdir, stat } from "node:fs/promises"
import type { ActivityKind, ActivityLog } from "./activity"

/** The few filesystem operations the server uses; each one may be a slow network round trip. */
export type Fs = {
  list(dir: string): Promise<string[]> // its directories; rejects when unreadable
  entries(dir: string): Promise<{ dirs: string[]; files: string[] }> // the same listing, with its files
  stat(path: string): Promise<{ size: number; mtime: number } | undefined>
  read(path: string, offset: number, length: number): Promise<Buffer>
  readText(path: string): Promise<string | undefined>
  /** The most bytes one `read` should ask for; bigger reads are split, each with its own timeout. */
  chunk: number
}

export type FsOptions = {
  concurrency?: number
  rate?: number
  timeout?: number
  chunk?: number
  activity?: ActivityLog
}

const lane = new AsyncLocalStorage<() => boolean>()

/**
 * Runs `work` in the background (e.g. prefetching, or keeping runs nobody has open up to date): its operations
 * wait for the ones someone is waiting for. `still` says whether it's still in the background: once a run is
 * opened, what's left of reading it isn't kept waiting.
 */
export const background = <T>(work: () => T, still: () => boolean = () => true) => lane.run(still, work)

type Job = { start: () => void; background?: () => boolean; gone?: boolean }

/**
 * Node's fs, sparing a slow share: operations someone waits for go first, `concurrency` at a time; background ones
 * go one at a time, at most `rate` a second (0: no limit), and only while no other operation waits. Operations
 * give up after `timeout` ms (an unreachable share hangs them), counted from when they were asked for, or from
 * when they start for background ones. A hung operation keeps its slot until it really ends, so they can't pile up.
 * Every operation is recorded in `activity`.
 */
export function nodeFs({ concurrency = 8, rate = 0, timeout = 30_000, chunk = 1 << 20, activity }: FsOptions = {}) {
  let waiting: Job[] = []
  let active = 0
  let behind = false // a background operation is running
  let next = 0 // when the next background operation may start
  let waking = false // pump is due when it may

  const pump = () => {
    waiting = waiting.filter((job) => !job.gone)
    while (active < fs.concurrency && waiting.length) {
      let index = waiting.findIndex((job) => !job.background?.())
      if (index < 0) {
        if (behind) return // one at a time
        const wait = next - performance.now()
        if (wait > 0) {
          if (!waking)
            setTimeout(() => {
              waking = false
              pump()
            }, wait)
          waking = true
          return
        }
        next = performance.now() + (fs.rate ? 1000 / fs.rate : 0)
        index = 0
      }
      waiting.splice(index, 1)[0].start()
    }
  }

  const run = <T>(kind: ActivityKind, path: string, op: () => Promise<T>): Promise<T> => {
    const still = lane.getStore()
    let start = performance.now()
    let clock: ReturnType<typeof setTimeout> | undefined
    return new Promise<T>((resolve, reject) => {
      const record = (extra: { bytes?: number; error?: string }) =>
        activity?.add({ kind, path, ms: performance.now() - start, ...extra })
      const tick = () => {
        clock = setTimeout(() => {
          job.gone = true // if it hasn't started, it won't
          record({ error: "ETIMEDOUT" })
          reject(Object.assign(new Error(`${path}: timed out`), { code: "ETIMEDOUT" }))
        }, fs.timeout)
      }
      const job: Job = {
        background: still,
        start: () => {
          const late = !!job.background?.()
          if (late) {
            start = performance.now()
            tick()
          }
          active++
          behind ||= late
          fs.ops++
          op()
            .then(
              (result) => {
                if (job.gone) return
                record({ bytes: Buffer.isBuffer(result) ? result.length : undefined })
                resolve(result)
              },
              (error) => {
                if (job.gone) return
                record({ error: (error as NodeJS.ErrnoException).code ?? String(error) })
                reject(error)
              },
            )
            .finally(() => {
              job.gone = true
              clearTimeout(clock)
              active--
              if (late) behind = false
              pump()
            })
        },
      }
      if (!still?.()) tick()
      waiting.push(job)
      pump()
    })
  }

  const fs = {
    ops: 0,
    rate,
    concurrency,
    timeout,
    chunk,
    entries: (dir: string) =>
      run("list", dir, async () => {
        const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith("."))
        const isDir = (e: (typeof entries)[number]) => e.isDirectory() || e.isSymbolicLink()
        return {
          dirs: entries.filter(isDir).map((e) => e.name),
          files: entries.filter((e) => !isDir(e)).map((e) => e.name),
        }
      }),
    list: (dir: string) => fs.entries(dir).then((entries) => entries.dirs),
    stat: (path: string) =>
      run("stat", path, () => stat(path)).then(
        (s) => ({ size: s.size, mtime: s.mtimeMs }),
        () => undefined,
      ),
    readText: async (path: string) => {
      const parts: Buffer[] = []
      try {
        for (let offset = 0; ; ) {
          const part = await fs.read(path, offset, fs.chunk)
          parts.push(part)
          offset += part.length
          if (part.length < fs.chunk) return Buffer.concat(parts).toString("utf8")
        }
      } catch {
        return undefined
      }
    },
    read: (path: string, offset: number, length: number) =>
      run("read", path, async () => {
        const file = await open(path)
        try {
          const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, offset)
          return buffer.subarray(0, bytesRead)
        } finally {
          await file.close()
        }
      }),
  }
  return fs
}
