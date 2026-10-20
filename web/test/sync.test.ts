import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, openSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { ActivityLog } from "../src/lib/activity"
import { Config } from "../src/lib/config"
import { background, nodeFs } from "../src/lib/fs"
import { applyEvent, Run } from "../src/lib/run"
import { Store } from "../src/lib/store"
import { normalizePlan, type StatusEvent } from "../src/lib/types"

let root: string
const stores: Store[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greendots-"))
})
afterEach(() => {
  for (const store of stores.splice(0)) store.stop()
})

const ids = ["t.py::a", "t.py::b"]
/** A run as the original plugin wrote it: tests grouped by module, `log_file`s next to the plan. */
function makeRun(source: string, project: string, run: string, workers = 1, plan = true) {
  const dir = join(root, source, project, run)
  mkdirSync(dir, { recursive: true })
  if (plan) writePlan(dir, workers)
  return dir
}
function writePlan(dir: string, workers = 1) {
  const tests = ids.map((id) => ({ id, name: id.split("::")[1], params: {}, log_file: `${id}.log.jsonl` }))
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ worker_count: workers, row_params: [], groups: { t: tests } }))
}
const line = (event: Partial<StatusEvent>) => `${JSON.stringify({ time: 1, ...event })}\n`
const append = (dir: string, worker: number, text: string) => appendFileSync(join(dir, `status.${worker}.jsonl`), text)
const finishAll = (dir: string, worker = 0) =>
  append(
    dir,
    worker,
    ids.map((test) => line({ type: "finish", test, outcome: "passed" })).join("") + line({ type: "session_finish" }),
  )
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function makeStore(config: Record<string, unknown> = {}, save?: (config: Config) => void) {
  const sources = ["local", "network"].map((name) => ({ name, path: join(root, name) }))
  for (const { path } of sources) mkdirSync(path, { recursive: true })
  // no rate limit: these tests poll every millisecond (the rate limit has its own test)
  const base = { sources, cache: { dir: join(root, "cache") }, filesystem: { rate: 0 } }
  const store = new Store(Config.parse({ ...base, ...config }), save)
  stores.push(store)
  return store
}

describe("applyEvent", () => {
  const ev = (event: Partial<StatusEvent>) => ({ test: "x", time: 5, ...event }) as StatusEvent
  test("lifecycle", () => {
    let state = applyEvent({ status: "pending" }, ev({ type: "start" }))
    expect(state).toEqual({ status: "running", progress: 0, start: 5 })
    state = applyEvent(state, ev({ type: "progress", percentage: 0.5 }))
    expect(state.progress).toBe(0.5)
    state = applyEvent(state, ev({ type: "call", outcome: "failed", exception: "boom" }))
    state = applyEvent(state, ev({ type: "teardown", outcome: "failed", exception: "bang" }))
    expect(state).toMatchObject({ status: "failed", exception: "boom\n\nbang" })
    state = applyEvent(state, ev({ type: "finish", outcome: "failed", time: 9 }))
    expect(state).toMatchObject({ status: "failed", end: 9, progress: undefined })
  })
  test("skips and the original plugin's error outcome", () => {
    const skipped = applyEvent({ status: "running" }, ev({ type: "setup", outcome: "skipped", reason: "nope" }))
    expect(skipped).toEqual({ status: "skipped", reason: "nope" })
    expect(applyEvent({ status: "running" }, ev({ type: "finish", outcome: "error" })).status).toBe("failed")
  })
})

test("normalizePlan reads both plan formats", () => {
  const old = normalizePlan({ groups: { mod: [{ id: "a", name: "a", params: {}, log_file: "a.log.jsonl" }] } })
  expect(old).toMatchObject({ worker_count: 1, errors: [], tests: [{ id: "a", module: "mod", log: "a.log.jsonl" }] })
  const flat = normalizePlan({ tests: [{ id: "m.py::b", name: "b", params: {}, log: "b" }] })
  expect(flat.tests[0]).toMatchObject({ module: "m.py", log: "b" })
})

describe("Run", () => {
  test("waits for the plan, then tails status files incrementally", async () => {
    const dir = makeRun("local", "p", "r", 2, false)
    const run = new Run(nodeFs(), dir)
    expect(await run.sync()).toBe(false)
    writePlan(dir, 2)
    append(dir, 0, `${line({ type: "start", test: ids[0] })}{"type": "fin`)
    expect(await run.sync()).toBe(true)
    expect(run.summary()).toMatchObject({ total: 2, running: 1, pending: 1, done: false })
    const version = run.version
    append(dir, 0, 'ish", "test": "t.py::a", "outcome": "failed", "time": 2}\n')
    append(dir, 1, line({ type: "call", test: ids[1], outcome: "skipped", reason: "r" }))
    await run.sync()
    expect(run.changes(version)).toEqual({
      [ids[0]]: { status: "failed", start: 1, end: 2 },
      [ids[1]]: { status: "skipped", reason: "r" },
    })
    expect(run.done).toBe(true) // every test finished, even without session_finish (the original plugin)
  })

  test("reads big files in pieces", async () => {
    const dir = makeRun("local", "p", "r")
    finishAll(dir)
    const fs = nodeFs({ chunk: 16 })
    const run = new Run(fs, dir)
    await run.sync()
    expect(run.summary()).toMatchObject({ passed: 2, done: true })
    expect(fs.ops).toBeGreaterThan(20)
  })

  test("stops reading workers that finished", async () => {
    const fs = nodeFs()
    const dir = makeRun("local", "p", "r")
    append(dir, 0, line({ type: "start", test: ids[0] }) + line({ type: "session_finish" }))
    const run = new Run(fs, dir)
    await run.sync()
    const ops = fs.ops
    await run.sync()
    expect(fs.ops).toBe(ops)
  })

  test("applies plan updates made while running, and reads metadata.toml", async () => {
    const dir = makeRun("local", "p", "r")
    writeFileSync(join(dir, "metadata.toml"), 'name = "Nightly #7"\n')
    append(dir, 0, line({ type: "plan_update", row_params: ["board"] }))
    append(dir, 0, line({ type: "plan_update", test: ids[0], name: "nice", params: { board: "rpi" } }))
    const run = new Run(nodeFs(), dir)
    await run.sync()
    expect(run.title).toBe("Nightly #7")
    expect(run.plan?.row_params).toEqual(["board"])
    expect(run.plan?.tests[0]).toMatchObject({ name: "nice", module: "t", params: { board: "rpi" } })
  })
})

describe("Store", () => {
  test("merges projects and runs across sources, serving cached listings while refreshing them", async () => {
    utimesSync(makeRun("local", "p", "old"), 1, 1)
    makeRun("network", "p", "new")
    makeRun("network", "q", "r")
    writeFileSync(join(root, "local", "p", "metadata.toml"), 'name = "Project P"')
    const store = makeStore()
    expect(store.projects()).toMatchObject({ projects: [], loading: true }) // answers right away
    for (let i = 0; i < 4; i++) {
      store.projects()
      await store.settled()
    }
    const { projects } = store.projects()
    expect(projects.map((p) => p.name).sort()).toEqual(["p", "q"])
    const p = projects.find((project) => project.name === "p")
    expect(p?.title).toBe("Project P")
    expect(p?.runs.map((run) => `${run.source}/${run.name}`)).toEqual(["network/new", "local/old"])
    const ops = store.fs.ops
    store.projects()
    expect(store.fs.ops).toBe(ops)
  })

  test("reports a source that can't be read, and still shows the others", async () => {
    makeRun("local", "p", "r")
    const store = makeStore({
      sources: [
        { name: "local", path: join(root, "local") },
        { name: "gone", path: join(root, "gone") },
      ],
    })
    store.projects()
    await store.settled()
    const { projects, errors } = store.projects()
    expect(projects.map((p) => p.name)).toEqual(["p"])
    expect(errors).toMatchObject([{ source: "gone", error: expect.stringMatching(/ENOENT/) }])
  })

  test("rejects path traversal and unknown sources", async () => {
    const dir = makeRun("local", "p", "r")
    const store = makeStore()
    expect(store.run("..", "local", "p")).toBeUndefined()
    expect(store.run("p", "local", "../p")).toBeUndefined()
    expect(store.run("p", "elsewhere", "r")).toBeUndefined()
    expect(store.listRuns("..").runs).toEqual([])
    const run = store.run("p", "local", "r")
    if (!run) throw new Error("no run")
    expect(await store.logFile(run, { test: ids[0] })).toBe(join(dir, "t.py::a.log.jsonl"))
    expect(await store.logFile(run, { session: 1 })).toBe(join(dir, "session.1.log.jsonl"))
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ tests: [{ id: "x", log: "../../secret" }] }))
    const other = new Run(store.fs, dir)
    await other.sync()
    expect(await store.logFile(other, { test: "x" })).toBeUndefined()
  })

  test("saves synced projects in the config", () => {
    let saved: Config | undefined
    const store = makeStore({}, (config) => {
      saved = config
    })
    store.setSynced("p", true)
    store.setSynced("q", true)
    store.setSynced("p", false)
    expect(saved).toMatchObject({ synced: ["q"] })
    expect(Object.keys(saved?.syncedSince ?? {})).toEqual(["q"]) // when it was synced: older runs aren't
  })

  test("polls a run while it changes, more slowly once it doesn't, and stops after a while", async () => {
    const dir = makeRun("local", "p", "r")
    const store = makeStore({ polling: { run: 0.001, slowRun: 0.001, slowAfter: 0.05, stopAfter: 0.1 } })
    const run = store.run("p", "local", "r")
    if (!run) throw new Error("no run")
    await store.settled()
    append(dir, 0, line({ type: "start", test: ids[0] }))
    store.tick()
    await store.settled()
    expect(store.polling(run)).toBe("live")
    await sleep(70)
    expect(store.polling(run)).toBe("slow")
    await sleep(50)
    expect(store.polling(run)).toBe("stopped")
    const ops = store.fs.ops
    store.tick()
    await store.settled()
    expect(store.fs.ops).toBe(ops) // not read anymore
    await store.check(run)
    expect(store.polling(run)).toBe("live")
  })

  test("doesn't poll an old run that never finished", async () => {
    const dir = makeRun("local", "p", "r")
    append(dir, 0, line({ type: "start", test: ids[0] }))
    utimesSync(join(dir, "status.0.jsonl"), 1, 1)
    utimesSync(join(dir, "plan.json"), 1, 1)
    const store = makeStore()
    const run = store.run("p", "local", "r")
    await store.settled()
    expect(run && store.polling(run)).toBe("stopped")
  })

  test("tick syncs synced projects' latest runs and nothing else", async () => {
    const store = makeStore({ synced: ["synced"], polling: { run: 0.001, list: 0.001 } })
    await sleep(20) // past the filesystem's coarse clock: a run made after the project was synced
    const synced = makeRun("local", "synced", "r")
    makeRun("local", "other", "r")
    const tick = async () => {
      await sleep(5)
      store.tick()
      await store.settled()
    }
    await tick()
    await tick()
    await tick()
    append(synced, 0, line({ type: "start", test: ids[0] }))
    await tick()
    expect(store.runInfos("synced", 1, false).runs[0].summary?.running).toBe(1)
    finishAll(synced)
    await tick()
    store.configure(Config.parse({ ...store.config, polling: { ...store.config.polling, list: 10 } }))
    await tick()
    const ops = store.fs.ops
    await tick() // listings are cached, the finished run isn't read again, "other" is never read
    expect(store.fs.ops).toBe(ops)
  })

  test("syncing a project syncs its new runs, not the ones it already had", async () => {
    const old = makeRun("local", "p", "old")
    utimesSync(old, 1, 1) // made long before the project was synced
    let saved: Config | undefined
    const store = makeStore({ synced: ["p"], polling: { run: 0.001, list: 0.001, browse: 0.05 } }, (config) => {
      saved = config
    })
    expect(saved?.syncedSince.p).toBeGreaterThan(0) // projects synced before this was recorded: from now on
    const tick = async () => {
      await sleep(5)
      store.tick()
      store.projects() // the home page, which summarizes synced projects' latest runs
      await store.settled()
    }
    await tick()
    await tick()
    const touched = () => store.activity.since(0).filter((entry) => entry.path?.includes(`${join("p", "old")}/`))
    expect(touched()).toEqual([]) // not even its plan: it's read when someone opens it
    expect(store.runInfos("p", 0, false).runs.find((run) => run.name === "old")?.summary).toBeUndefined()
    await sleep(20) // past the filesystem's coarse clock
    const fresh = makeRun("local", "p", "new")
    append(fresh, 0, line({ type: "start", test: ids[0] }))
    const running = () => store.runInfos("p", 0, false).runs.find((run) => run.name === "new")?.summary?.running
    for (const end = Date.now() + 1000; Date.now() < end && running() !== 1; ) await tick() // within polling.browse
    expect(running()).toBe(1)
    expect(touched()).toEqual([])
  })
})

test("filesystem operations time out, but keep their slot until they really end", async () => {
  const fifo = join(root, "fifo")
  execFileSync("mkfifo", [fifo])
  const activity = new ActivityLog()
  const fs = nodeFs({ timeout: 50, concurrency: 1, activity })
  await expect(fs.read(fifo, 0, 1)).rejects.toThrow(/timed out/) // opening a FIFO waits for a writer
  expect(activity.since(0)).toMatchObject([{ kind: "read", path: fifo, error: "ETIMEDOUT" }])
  await expect(fs.stat(root)).resolves.toBeUndefined() // queued behind the hung read: times out too
  openSync(fifo, "w") // let the hung read end
})

test("background operations go one at a time, at most `rate` a second, after the others", async () => {
  const activity = new ActivityLog()
  const fs = nodeFs({ rate: 10, timeout: 100, activity })
  const start = performance.now()
  const stats = background(() => Promise.all(Array.from({ length: 5 }, () => fs.stat(root))))
  await sleep(50)
  await fs.stat(join(root, "now")) // someone waits for this one: it doesn't wait for the background
  expect(performance.now() - start).toBeLessThan(100)
  expect((await stats).every(Boolean)).toBe(true) // the last one waited 400 ms, but its timeout started then
  expect(performance.now() - start).toBeGreaterThanOrEqual(390)
  expect(activity.since(0).map((entry) => entry.path)).toEqual([root, join(root, "now"), root, root, root, root])
  fs.rate = 0 // no limit
  const quick = performance.now()
  await background(() => Promise.all(Array.from({ length: 20 }, () => fs.stat(root))))
  expect(performance.now() - quick).toBeLessThan(200)
})

test("the activity log keeps the latest entries", () => {
  const activity = new ActivityLog(3)
  for (const path of ["a", "b", "c", "d", "e"]) activity.add({ kind: "stat", path })
  expect(activity.since(0).map((entry) => entry.path)).toEqual(["c", "d", "e"])
  expect(activity.since(4).map((entry) => entry.path)).toEqual(["e"])
})

describe("the disk cache", () => {
  /** `count` finished runs of project "p", the newest first in the listing. */
  function finishedRuns(count: number) {
    return Array.from({ length: count }, (_, index) => {
      const dir = makeRun("local", "p", `r${index}`)
      finishAll(dir)
      utimesSync(dir, 1000 + index, 1000 + index)
      return dir
    })
  }
  const page = (store: Store) => store.runInfos("p", 0, true, 0, store.config.prefetch.runs) // the project page
  /** Keeps the project page open for `ms`: it's computed again whenever the store says something changed. */
  const browse = async (store: Store, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      page(store)
      await store.changed.wait(20)
    }
    await store.settled()
    return page(store)
  }

  test("a project page prefetches a few runs, one at a time, and keeps only their summaries", async () => {
    finishedRuns(10)
    const store = makeStore({ prefetch: { runs: 3, interval: 0.05 } })
    const unview = store.view("p")
    const summarized = (await browse(store, 400)).runs.filter((run) => run.summary)
    expect(summarized.map((run) => run.name)).toEqual(["r9", "r8", "r7"]) // the newest 3, not all 10
    expect(summarized.every((run) => run.polling === "done" && run.summary?.passed === 2)).toBe(true)
    const prefetched = store.activity.since(0).filter((entry) => entry.detail?.startsWith("prefetched"))
    expect(prefetched).toHaveLength(3)
    expect(prefetched[2].time - prefetched[0].time).toBeGreaterThanOrEqual(90) // 0.05s apart
    expect(store.loaded).toBe(0) // finished: only their summaries are kept, on disk
    unview()
  })

  test("after a restart, lists come from the cache and finished runs are read from the disk", async () => {
    const [newest] = finishedRuns(3).reverse()
    const first = makeStore({ prefetch: { runs: 3, interval: 0.01 } })
    const unview = first.view("p")
    await browse(first, 300)
    const opened = first.run("p", "local", "r2")
    await first.settled()
    await first.logs.before(join(newest, `${ids[0]}.log.jsonl`), 0) // a log read through the cache
    unview()
    await first.stop() // saves the index of mtimes and summaries
    expect(opened?.done).toBe(true)

    const store = makeStore()
    const ops = () => store.fs.ops
    store.view("p")
    const { runs } = await browse(store, 300)
    expect(runs.map((run) => [run.name, run.summary?.passed])).toEqual([
      ["r2", 2],
      ["r1", 2],
      ["r0", 2],
    ])
    const kinds = store.activity.since(0).map((entry) => entry.kind)
    expect(kinds.filter((kind) => kind !== "list")).toEqual([]) // no run directory is stat-ed, no run read
    const listed = ops()
    const run = store.run("p", "local", "r2")
    await store.settled()
    expect(run?.done && run.summary().passed).toBe(2)
    expect(ops()).toBe(listed + 1) // its plan's mtime, to know it wasn't rerun: the rest comes from the disk
  })

  test("a run is cached whole as it finishes: opening it again reads only its plan's mtime", async () => {
    const dir = makeRun("local", "p", "r", 2)
    append(dir, 0, line({ type: "start", test: ids[0] }))
    const first = makeStore({ polling: { run: 0.001 } })
    const run = first.run("p", "local", "r")
    run && run.viewers++ // its page is open
    await first.settled()
    finishAll(dir, 0)
    append(dir, 1, line({ type: "session_finish" }))
    await sleep(5)
    first.tick()
    await first.settled()
    expect(run?.done).toBe(true)
    await first.stop()

    const store = makeStore()
    const again = store.run("p", "local", "r")
    await store.settled()
    expect(again?.summary()).toEqual(run?.summary())
    expect(again?.changes(-1)).toEqual(run?.changes(-1))
    const operations = store.activity.since(0).filter((entry) => entry.kind !== "sync")
    expect(operations.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([`stat ${join(dir, "plan.json")}`])
  })

  test("a run that stopped without finishing is cached too, and tailed on from where it was", async () => {
    const dir = makeRun("local", "p", "r", 2)
    append(dir, 0, line({ type: "start", test: ids[0] }) + line({ type: "session_finish" }))
    append(dir, 1, line({ type: "start", test: ids[1] })) // a worker that crashed
    const polling = { run: 0.001, slowAfter: 0.01, stopAfter: 0.02 }
    const first = makeStore({ polling })
    first.run("p", "local", "r")
    await first.settled()
    await sleep(30)
    first.tick()
    await first.settled()
    await first.stop()

    const store = makeStore({ polling })
    const run = store.run("p", "local", "r")
    await store.settled()
    expect(run?.summary()).toMatchObject({ running: 2, done: false })
    expect(store.polling(run as Run)).toBe("stopped")
    const operations = () => store.activity.since(0).filter((entry) => entry.kind !== "sync")
    expect(operations().map((entry) => `${entry.kind} ${entry.path.split("/").pop()}`)).toEqual([
      "stat plan.json",
      "stat status.1.jsonl", // the worker that didn't finish: still where it was
    ])
    const finish = line({ type: "finish", test: ids[1], outcome: "passed" })
    append(dir, 1, finish)
    await store.check(run as Run)
    expect(run?.summary()).toMatchObject({ running: 1, passed: 1 })
    expect(operations().at(-1)).toMatchObject({ kind: "read", bytes: finish.length }) // only what's new
  })

  test("runs nobody has open are checked every polling.list seconds, in the background", async () => {
    const dir = makeRun("local", "p", "r")
    append(dir, 0, line({ type: "start", test: ids[0] }))
    const store = makeStore({ synced: ["p"], syncedSince: { p: 0 }, polling: { run: 0.001, list: 0.2 } })
    for (let i = 0; i < 3; i++) {
      store.projects() // lists the source and the project, then loads its latest run
      await store.settled()
    }
    const stats = () => store.activity.since(0).filter((entry) => entry.path === join(dir, "status.0.jsonl")).length
    const before = stats()
    for (let i = 0; i < 10; i++) {
      await sleep(5)
      store.tick()
      await store.settled()
    }
    expect(stats()).toBe(before) // not every `polling.run`
    await sleep(200)
    store.tick()
    await store.settled()
    expect(stats()).toBe(before + 1)
  })
})
