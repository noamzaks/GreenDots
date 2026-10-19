import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, expect, test } from "vitest"
import { cachedFs, DiskCache } from "../src/lib/cache"
import { nodeFs } from "../src/lib/fs"

let root: string
let run: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greendots-cache-"))
  run = join(root, "share", "project", "run")
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, "log.jsonl"), "0123456789abcdefghij") // 20 bytes: 5 chunks of 4
})

function make(limit = 1 << 20) {
  const remote = nodeFs({ chunk: 4 })
  const cache = new DiskCache(join(root, "cache"), limit)
  return { remote, cache, fs: cachedFs(remote, cache) }
}

test("reads files of runs that aren't finished from the share, every time", async () => {
  const { remote, fs } = make()
  expect((await fs.read(join(run, "log.jsonl"), 2, 5)).toString()).toBe("23456")
  await fs.read(join(run, "log.jsonl"), 2, 5)
  expect(remote.ops).toBe(2)
})

test("reads files of finished runs from the share once, then from the disk, also after a restart", async () => {
  const { remote, cache, fs } = make()
  cache.freeze(run, 42)
  const path = join(run, "log.jsonl")
  expect((await fs.read(path, 2, 9)).toString()).toBe("23456789a") // chunks 0 to 2
  expect(remote.ops).toBe(3)
  expect((await fs.read(path, 4, 4)).toString()).toBe("4567")
  expect((await fs.readText(path)) ?? "").toBe("0123456789abcdefghij") // fetches the 2 chunks it lacks
  expect((await fs.stat(path))?.size).toBe(20)
  const ops = remote.ops
  expect((await fs.stat(path))?.size).toBe(20)
  expect((await fs.read(path, 18, 10)).toString()).toBe("ij") // the end of the file
  expect(remote.ops).toBe(ops)

  const restarted = make()
  restarted.cache.freeze(run, 42)
  expect((await restarted.fs.readText(path)) ?? "").toBe("0123456789abcdefghij")
  expect((await restarted.fs.stat(path))?.size).toBe(20)
  expect(restarted.remote.ops).toBe(0)

  const rerun = make()
  rerun.cache.freeze(run, 43) // rerun into the same directory: a new version
  await rerun.fs.read(path, 0, 4)
  expect(rerun.remote.ops).toBe(1)
})

test("keeps runs' summaries", async () => {
  const { cache } = make()
  expect(await cache.summary(run)).toBeUndefined()
  const summary = { passed: 1, failed: 0, skipped: 0, running: 0, pending: 0, total: 1, done: true, collectErrors: 0 }
  await cache.saveSummary(run, { version: 42, summary, title: "nightly" })
  expect(await make().cache.summary(run)).toEqual({ version: 42, summary, title: "nightly" })
})

test("evicts the runs used least recently beyond its limit", async () => {
  const runs = ["a", "b", "c"].map((name) => {
    const dir = join(root, "share", "project", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "log.jsonl"), "x".repeat(400))
    return dir
  })
  const { cache, fs } = make(1000) // room for two runs' 400 bytes
  for (const dir of runs) {
    cache.freeze(dir, 1)
    await fs.readText(join(dir, "log.jsonl"))
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(readdirSync(join(root, "cache", "runs"))).toHaveLength(2) // "a", the oldest, went
  const { remote, cache: again, fs: fresh } = make(1000)
  again.freeze(runs[2], 1)
  await fresh.readText(join(runs[2], "log.jsonl"))
  expect(remote.ops).toBe(0)
})
