import type { Plan, PlanTest } from "./types"

export type Column = { module: string; name: string; params: [string, string][] }
export type Grid = {
  rowParams: string[]
  rows: string[]
  columns: Column[]
  groups: { module: string; start: number; end: number }[]
  cells: { test: PlanTest; row: number; column: number }[]
}

const WIDE = 60

/** A compact layout for suites without row params: rows of up to `width` dots per module, named on hover. */
function byModule(tests: PlanTest[], width: number): Grid {
  const grid: Grid = { rowParams: [], rows: [], columns: [], groups: [], cells: [] }
  const modules = new Map<string, PlanTest[]>()
  for (const test of tests) modules.set(test.module, [...(modules.get(test.module) ?? []), test])
  for (const [module, moduleTests] of modules)
    moduleTests.forEach((test, index) => {
      if (index % width === 0) grid.rows.push(index ? "" : module)
      grid.cells.push({ test, row: grid.rows.length - 1, column: index % width })
    })
  width = Math.max(...grid.cells.map((cell) => cell.column + 1))
  grid.columns = Array.from({ length: width }, () => ({ module: "", name: "", params: [] }))
  return grid
}

/**
 * Splits a plan's tests into matrices, so tests that don't share params don't have to share one: first the tests
 * with the plan's row params, then, over and over, the tests with the param most of the rest have (its rows are the
 * params they all share), and last the tests without params.
 */
export function splitMatrices(plan: Plan) {
  const has = (test: PlanTest, param: string) => test.params[param] !== undefined
  const matrices: { rowParams: string[]; tests: PlanTest[] }[] = []
  let rest = plan.tests
  const take = (rowParams: string[], picked: (test: PlanTest) => boolean) => {
    const tests = rest.filter(picked)
    rest = rest.filter((test) => !picked(test))
    if (tests.length) matrices.push({ rowParams, tests })
  }
  take(plan.row_params, (test) => plan.row_params.some((param) => has(test, param)))
  while (rest.length) {
    const counts = new Map<string, number>()
    for (const test of rest)
      for (const param of Object.keys(test.params)) counts.set(param, (counts.get(param) ?? 0) + 1)
    const [top] = [...counts].sort(([, a], [, b]) => b - a)[0] ?? []
    if (top === undefined) break
    const tests = rest.filter((test) => has(test, top))
    take(
      Object.keys(tests[0].params).filter((param) => tests.every((test) => has(test, param))),
      (test) => has(test, top),
    )
  }
  take([], () => true)
  return matrices
}

/** Lays a plan's tests out as matrices of the ones `include`d (see `splitMatrices`); empty ones are left out. */
export function buildGrids(plan: Plan, include: (test: PlanTest) => boolean = () => true, width = WIDE): Grid[] {
  return splitMatrices(plan)
    .map(({ rowParams, tests }) => buildGrid(tests.filter(include), rowParams, width))
    .filter((grid) => grid.cells.length > 0)
}

/** Lays tests out as a matrix: rows by `rowParams` values, columns by module, name and other params. */
function buildGrid(tests: PlanTest[], rowParams: string[], width: number): Grid {
  const rows = new Map<string, number>()
  const columns = new Map<string, number>()
  const grid: Grid = { rowParams, rows: [], columns: [], groups: [], cells: [] }
  for (const test of tests) {
    const values = rowParams.map((param) => test.params[param])
    const rowKey = values.every((value) => value === undefined)
      ? "(no params)"
      : values.map((v) => String(v ?? "–")).join(" · ")
    const params = Object.entries(test.params)
      .filter(([param]) => !rowParams.includes(param))
      .map(([param, value]): [string, string] => [param, String(value)])
    const columnKey = JSON.stringify([test.module, test.name, params])
    if (!rows.has(rowKey)) rows.set(rowKey, grid.rows.push(rowKey) - 1)
    if (!columns.has(columnKey))
      columns.set(columnKey, grid.columns.push({ module: test.module, name: test.name, params }) - 1)
    grid.cells.push({ test, row: rows.get(rowKey) ?? 0, column: columns.get(columnKey) ?? 0 })
  }
  if (grid.rows.length === 1 && grid.columns.length > WIDE) return byModule(tests, Math.max(10, width))
  grid.columns.forEach((column, index) => {
    const last = grid.groups.at(-1)
    if (last?.module === column.module) last.end = index + 1
    else grid.groups.push({ module: column.module, start: index, end: index + 1 })
  })
  return grid
}
