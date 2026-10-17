import type { Plan, PlanTest } from "./types"

export type Column = { module: string; name: string; params: [string, string][] }
export type Grid = {
  rows: string[]
  columns: Column[]
  groups: { module: string; start: number; end: number }[]
  cells: { test: PlanTest; row: number; column: number }[]
}

const WIDE = 60

/** A compact layout for suites without row params: rows of up to `width` dots per module, named on hover. */
function byModule(tests: PlanTest[], width: number): Grid {
  const grid: Grid = { rows: [], columns: [], groups: [], cells: [] }
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

/** Lays tests out as a matrix: rows by `row_params` values, columns by module, name and other params. */
export function buildGrid(plan: Plan, include: (test: PlanTest) => boolean = () => true, width = WIDE): Grid {
  const rows = new Map<string, number>()
  const columns = new Map<string, number>()
  const grid: Grid = { rows: [], columns: [], groups: [], cells: [] }
  for (const test of plan.tests) {
    if (!include(test)) continue
    const values = plan.row_params.map((param) => test.params[param])
    const rowKey = values.every((value) => value === undefined)
      ? "(no params)"
      : values.map((v) => String(v ?? "–")).join(" · ")
    const params = Object.entries(test.params)
      .filter(([param]) => !plan.row_params.includes(param))
      .map(([param, value]): [string, string] => [param, String(value)])
    const columnKey = JSON.stringify([test.module, test.name, params])
    if (!rows.has(rowKey)) rows.set(rowKey, grid.rows.push(rowKey) - 1)
    if (!columns.has(columnKey))
      columns.set(columnKey, grid.columns.push({ module: test.module, name: test.name, params }) - 1)
    grid.cells.push({ test, row: rows.get(rowKey) ?? 0, column: columns.get(columnKey) ?? 0 })
  }
  if (grid.rows.length === 1 && grid.columns.length > WIDE)
    return byModule(
      grid.cells.map((cell) => cell.test),
      Math.max(10, width),
    )
  grid.columns.forEach((column, index) => {
    const last = grid.groups.at(-1)
    if (last?.module === column.module) last.end = index + 1
    else grid.groups.push({ module: column.module, start: index, end: index + 1 })
  })
  return grid
}
