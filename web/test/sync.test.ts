import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, openSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { ActivityLog } from "../src/lib/activity"
import { Config } from "../src/lib/config"
import { nodeFs } from "../src/lib/fs"
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
  const store = new Store(Config.parse({ sources, ...config }), save)
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
    for (let i = 0; i < 3; i++) {
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
    const synced = makeRun("local", "synced", "r")
    makeRun("local", "other", "r")
    const store = makeStore({ synced: ["synced"], polling: { run: 0.001 } })
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
    const ops = store.fs.ops
    await tick() // listings are cached, the finished run isn't read again, "other" is never read
    expect(store.fs.ops).toBe(ops)
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

test("the activity log keeps the latest entries", () => {
  const activity = new ActivityLog(3)
  for (const path of ["a", "b", "c", "d", "e"]) activity.add({ kind: "stat", path })
  expect(activity.since(0).map((entry) => entry.path)).toEqual(["c", "d", "e"])
  expect(activity.since(4).map((entry) => entry.path)).toEqual(["e"])
})
