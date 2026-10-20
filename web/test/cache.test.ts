import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, expect, test } from "vitest"
import { cachedFs, DiskCache } from "../src/lib/cache"
import { nodeFs } from "../src/lib/fs"
import type { Snapshot } from "../src/lib/run"

let root: string
let run: string
let log: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greendots-cache-"))
  run = join(root, "share", "project", "run")
  log = join(run, "t.py::a.log.jsonl")
  mkdirSync(run, { recursive: true })
  writeFileSync(log, "0123456789abcdefghij") // 20 bytes: 5 chunks of 4
})

function make(limit = 1 << 20) {
  const remote = nodeFs({ chunk: 4 })
  const cache = new DiskCache(join(root, "cache"), limit)
  return { remote, cache, fs: cachedFs(remote, cache) }
}

const snapshot = (version: number): Snapshot => ({
  version,
  final: true,
  workers: [],
  plan: { worker_count: 1, row_params: [], errors: [], tests: [] },
  tests: {},
  modified: 0,
})
const summary = { passed: 1, failed: 0, skipped: 0, running: 0, pending: 0, total: 1, done: true, collectErrors: 0 }

test("reads logs of runs that aren't cached from the share, every time", async () => {
  const { remote, fs } = make()
  expect((await fs.read(log, 2, 5)).toString()).toBe("23456")
  await fs.read(log, 2, 5)
  expect(remote.ops).toBe(2)
})

test("keeps finished runs whole, and reads their logs from the share once, also after a restart", async () => {
  const { remote, cache, fs } = make()
  await cache.save(run, snapshot(42), { version: 42, summary })
  expect((await fs.read(log, 2, 9)).toString()).toBe("23456789a") // chunks 0 to 2
  expect(remote.ops).toBe(3)
  expect((await fs.read(log, 4, 4)).toString()).toBe("4567")
  expect((await fs.stat(log))?.size).toBe(20)
  const ops = remote.ops
  expect((await fs.stat(log))?.size).toBe(20)
  expect((await fs.read(log, 16, 10)).toString()).toBe("ghij") // the end of the file
  expect(remote.ops).toBe(ops + 2) // its last chunk, and the empty one after it
  await cache.flush()

  const restarted = make()
  await restarted.cache.loaded
  expect(restarted.cache.summary(run)).toEqual({ version: 42, summary })
  expect(await restarted.cache.snapshot(run, 42)).toEqual(snapshot(42))
  expect((await restarted.fs.read(log, 0, 12)).toString()).toBe("0123456789ab") // the chunks read before
  expect((await restarted.fs.stat(log))?.size).toBe(20)
  expect(restarted.remote.ops).toBe(0)

  const rerun = make() // rerun into the same directory: a new version, whose logs aren't cached
  expect(await rerun.cache.snapshot(run, 43)).toBeUndefined()
  await rerun.fs.read(log, 0, 4)
  expect(rerun.remote.ops).toBe(1)
})

test("evicts the runs used least recently beyond its limit", async () => {
  const runs = ["a", "b", "c"].map((name) => {
    const dir = join(root, "share", "project", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "log.jsonl"), "x".repeat(400))
    return dir
  })
  const { cache, fs } = make(1200) // room for two runs' 400 bytes of logs and their snapshots
  for (const dir of runs) {
    await cache.save(dir, snapshot(1), { version: 1, summary })
    await fs.read(join(dir, "log.jsonl"), 0, 400)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(readdirSync(join(root, "cache", "runs"))).toHaveLength(2) // "a", the oldest, went
  const { remote, cache: again, fs: fresh } = make(1200)
  expect(await again.snapshot(runs[2], 1)).toBeDefined()
  await fresh.read(join(runs[2], "log.jsonl"), 0, 400)
  expect(remote.ops).toBe(0)
})
