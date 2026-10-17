import { open, readdir, readFile, stat } from "node:fs/promises"
import pLimit from "p-limit"
import type { ActivityKind, ActivityLog } from "./activity"

/** The few filesystem operations the server uses; each one may be a slow network round trip. */
export type Fs = {
  list(dir: string): Promise<string[]> // rejects when unreadable
  stat(path: string): Promise<{ size: number; mtime: number } | undefined>
  read(path: string, offset: number, length: number): Promise<Buffer>
  readText(path: string): Promise<string | undefined>
}

export type FsOptions = { concurrency?: number; timeout?: number; activity?: ActivityLog }

/**
 * Node's fs, with at most `concurrency` operations at a time so a slow share isn't flooded, giving up on
 * operations after `timeout` ms (an unreachable share hangs them), and recording every one in `activity`.
 * A hung operation keeps its slot until it really ends, so they can't pile up.
 */
export function nodeFs({ concurrency = 8, timeout = 30_000, activity }: FsOptions = {}) {
  const limit = pLimit(concurrency)
  const fs = {
    ops: 0,
    set concurrency(value: number) {
      limit.concurrency = value
    },
    timeout,
    list: (dir: string) =>
      run("list", dir, async () => {
        const entries = await readdir(dir, { withFileTypes: true })
        return entries
          .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
          .map((e) => e.name)
      }),
    stat: (path: string) =>
      run("stat", path, () => stat(path)).then(
        (s) => ({ size: s.size, mtime: s.mtimeMs }),
        () => undefined,
      ),
    readText: (path: string) => run("read", path, () => readFile(path, "utf8")).catch(() => undefined),
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
  const run = <T>(kind: ActivityKind, path: string, op: () => Promise<T>): Promise<T> => {
    const start = performance.now()
    const record = (extra: { bytes?: number; error?: string }) =>
      activity?.add({ kind, path, ms: performance.now() - start, ...extra })
    const task = limit(() => {
      fs.ops++
      return op()
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(`${path}: timed out`), { code: "ETIMEDOUT" })),
        fs.timeout,
      )
    })
    return Promise.race([task, timedOut]).then(
      (result) => {
        clearTimeout(timer)
        const bytes =
          typeof result === "string" ? Buffer.byteLength(result) : Buffer.isBuffer(result) ? result.length : undefined
        record({ bytes })
        return result
      },
      (error) => {
        clearTimeout(timer)
        record({ error: (error as NodeJS.ErrnoException).code ?? String(error) })
        throw error
      },
    )
  }
  return fs
}
