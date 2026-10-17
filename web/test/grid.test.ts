import { expect, test } from "vitest"
import { errorTitle, hash } from "../src/lib/client"
import { buildGrids, splitMatrices } from "../src/lib/grid"
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
  const [grid, rest] = buildGrids(plan)
  expect(grid.rowParams).toEqual(["arch"])
  expect(grid.rows).toEqual(["x86", "arm"])
  expect(grid.columns.map((c) => [c.name, c.params])).toEqual([
    ["compile", [["opt", "O0"]]],
    ["compile", [["opt", "O2"]]],
    ["echo", []],
  ])
  expect(grid.groups).toEqual([
    { module: "build", start: 0, end: 2 },
    { module: "net", start: 2, end: 3 },
  ])
  expect(grid.cells.map(({ row, column }) => [row, column])).toEqual([
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 2],
  ])
  expect(rest).toMatchObject({ rowParams: [], rows: ["(no params)"], cells: [{ test: { name: "dns" } }] })
})

test("tests that don't share params get matrices of their own, biggest first", () => {
  const tests = [
    t("boot", "boot", { board: "rpi", os: "linux" }),
    t("build", "compile", { arch: "x86" }),
    t("boot", "boot", { board: "bbb", os: "linux" }),
    t("boot", "flash", { board: "rpi" }),
    t("net", "dns", {}),
    t("build", "compile", { arch: "arm" }),
  ]
  const matrices = splitMatrices({ worker_count: 1, row_params: [], tests, errors: [] })
  expect(matrices.map((m) => [m.rowParams, m.tests.length])).toEqual([
    [["board"], 3],
    [["arch"], 2],
    [[], 1],
  ])
  const withRowParams = splitMatrices({ worker_count: 1, row_params: ["arch"], tests, errors: [] })
  expect(withRowParams.map((m) => m.rowParams)).toEqual([["arch"], ["board"], []])
})

test("filters drop empty rows, columns and matrices", () => {
  const grids = buildGrids(plan, (test) => test.params.arch === "arm")
  expect(grids).toHaveLength(1)
  expect(grids[0].rows).toEqual(["arm"])
  expect(grids[0].columns.map((c) => c.name)).toEqual(["compile", "echo"])
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
  const [grid] = buildGrids({ worker_count: 1, row_params: [], tests, errors: [] })
  expect(grid.rows).toEqual(["m0", "m1"])
  expect(grid.columns).toHaveLength(50)
  expect(grid.cells.find((cell) => cell.test.name === "test_3")).toMatchObject({ row: 1, column: 1 })
  const [wrapped] = buildGrids({ worker_count: 1, row_params: [], tests, errors: [] }, undefined, 20)
  expect(wrapped.rows).toEqual(["m0", "", "", "m1", "", ""])
  expect(wrapped.columns).toHaveLength(20)
})
