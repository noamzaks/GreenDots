import { expect, test } from "vitest"
import { errorTitle, hash } from "../src/lib/client"
import { buildGrid } from "../src/lib/grid"
import type { PlanTest } from "../src/lib/types"

const t = (module: string, name: string, params: PlanTest["params"]): PlanTest => ({
  id: `${module}::${name}${JSON.stringify(params)}`,
  module,
  name,
  params,
  log: "",
})
const plan = {
  errors: [],
  worker_count: 1,
  row_params: ["arch"],
  tests: [
    t("build", "compile", { arch: "x86", opt: "O0" }),
    t("build", "compile", { arch: "arm", opt: "O0" }),
    t("build", "compile", { arch: "x86", opt: "O2" }),
    t("net", "echo", { arch: "arm" }),
    t("net", "dns", {}),
  ],
}

test("lays tests out by row params and columns grouped by module", () => {
  const grid = buildGrid(plan)
  expect(grid.rows).toEqual(["x86", "arm", "(no params)"])
  expect(grid.columns.map((c) => [c.name, c.params])).toEqual([
    ["compile", [["opt", "O0"]]],
    ["compile", [["opt", "O2"]]],
    ["echo", []],
    ["dns", []],
  ])
  expect(grid.groups).toEqual([
    { module: "build", start: 0, end: 2 },
    { module: "net", start: 2, end: 4 },
  ])
  expect(grid.cells.map(({ row, column }) => [row, column])).toEqual([
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 2],
    [2, 3],
  ])
})

test("filters drop empty rows and columns", () => {
  const grid = buildGrid(plan, (test) => test.params.arch === "arm")
  expect(grid.rows).toEqual(["arm"])
  expect(grid.columns.map((c) => c.name)).toEqual(["compile", "echo"])
})

test("groups errors by their pytest headline", () => {
  const exception = "def test():\n>   assert x\nE   AssertionError: boom\nE   more\n\nt.py:3: AssertionError"
  expect(errorTitle(exception)).toBe("AssertionError: boom")
  expect(errorTitle("Traceback...\nValueError: nope\n")).toBe("ValueError: nope")
  expect(hash("a")).toBe(hash("a"))
  expect(hash("a")).not.toBe(hash("b"))
})

test("suites that would be one long row get rows per module, wrapped to the width", () => {
  const tests = Array.from({ length: 100 }, (_, i) => t(`m${i % 2}`, `test_${i}`, {}))
  const grid = buildGrid({ worker_count: 1, row_params: [], tests, errors: [] })
  expect(grid.rows).toEqual(["m0", "m1"])
  expect(grid.columns).toHaveLength(50)
  expect(grid.cells.find((cell) => cell.test.name === "test_3")).toMatchObject({ row: 1, column: 1 })
  const wrapped = buildGrid({ worker_count: 1, row_params: [], tests, errors: [] }, undefined, 20)
  expect(wrapped.rows).toEqual(["m0", "", "", "m1", "", ""])
  expect(wrapped.columns).toHaveLength(20)
})
