"use client"

import { Badge, Box, Code, Group, Paper, Stack, Text, useComputedColorScheme, useMantineTheme } from "@mantine/core"
import { useDebouncedValue, useLocalStorage } from "@mantine/hooks"
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { apis, COLORS, type RunRef } from "@/lib/client"
import type { Grid } from "@/lib/grid"
import { mod } from "@/lib/platform"
import { clock, took } from "@/lib/time"
import type { LogChunk, PlanTest, TestState } from "@/lib/types"

const PENDING: TestState = { status: "pending" }
/** Error groups get these colors (by rank): none can be mistaken for a status color. */
export const ERROR_PALETTE = ["cyan", "pink", "lime", "indigo", "teal", "orange", "violet", "grape"]

export type Modifiers = { altKey: boolean; ctrlKey: boolean; metaKey: boolean }
type Hover = { row: number; column: number; test?: PlanTest; x: number; y: number }
type Props = {
  run: RunRef
  grid: Grid
  scroller: RefObject<HTMLDivElement | null> // scrolls this matrix (and the others of the run)
  tests: Map<string, TestState>
  errors: Map<string, string> // test id -> error id
  errorColors: Map<string, string> // error id -> CSS color
  cell: number // the size of a dot's cell, in pixels
  highlight?: string
  colorErrors?: boolean
  onOpen: (test: PlanTest, modifiers: Modifiers) => void
}

/** The sizes of the column headers and row labels, as the user dragged them. */
export const useMatrixLayout = (project: string) =>
  useLocalStorage<{ header?: number; labels?: number }>({ key: `greendots-layout-${project}`, defaultValue: {} })

/**
 * A matrix of dots. Only the visible part is drawn, so huge matrices stay cheap (and within canvas limits).
 * Hover or focus it and use the arrow keys to look at a test; click or press Enter to open its log.
 */
export function Matrix(props: Props) {
  const { run, grid, scroller, tests, errors, errorColors, cell, highlight, colorErrors, onOpen } = props
  const { rowParams } = grid
  const theme = useMantineTheme()
  const dark = useComputedColorScheme("light") === "dark"
  const id = useId()
  const area = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const corner = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 0, y: 0, width: 0, height: 0 })
  const [cornerWidth, setCornerWidth] = useState(0)
  const [hover, setHover] = useState<Hover>()
  const cursor = useRef<{ row: number; column: number }>(undefined) // for the keyboard, ahead of renders
  const [shownTest] = useDebouncedValue(hover?.test?.id, 300)
  const width = grid.columns.length * cell
  const height = grid.rows.length * cell
  const radius = cell * 0.36
  const byCell = useMemo(() => new Map(grid.cells.map((c) => [`${c.row},${c.column}`, c.test])), [grid])
  const labels = useMemo(
    () => grid.columns.map((c) => [c.name, ...c.params.map(([key, value]) => `${key}=${value}`)].join(" ")),
    [grid],
  )
  const showLabels = cell >= 14 && labels.some(Boolean)
  const showRows = rowParams.length > 0 || grid.rows.length > 1

  const [layout, setLayout] = useMatrixLayout(run.project)
  const longest = Math.max(0, ...labels.map((label) => label.length))
  const headerHeight = showLabels ? (layout.header ?? Math.min(320, Math.max(60, longest * 5.4 + 24))) : 24

  useEffect(() => {
    const outer = scroller.current
    if (!outer) return
    const update = () => {
      const [box, cells] = [outer.getBoundingClientRect(), area.current?.getBoundingClientRect()]
      if (!cells) return
      const [x, y] = [Math.max(0, box.left - cells.left), Math.max(0, box.top - cells.top)]
      const right = Math.min(width, box.right - cells.left)
      const bottom = Math.min(height, box.bottom - cells.top)
      setView({ x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) })
      setCornerWidth(corner.current?.offsetWidth ?? 0)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(outer)
    if (corner.current) observer.observe(corner.current)
    outer.addEventListener("scroll", update, { passive: true })
    return () => {
      observer.disconnect()
      outer.removeEventListener("scroll", update)
    }
  }, [scroller, width, height])

  useEffect(() => {
    const context = canvas.current?.getContext("2d")
    if (!context) return
    const ratio = window.devicePixelRatio || 1
    context.canvas.width = view.width * ratio
    context.canvas.height = view.height * ratio
    context.setTransform(ratio, 0, 0, ratio, -view.x * ratio, -view.y * ratio)
    const color = (status: TestState["status"]) => theme.colors[COLORS[status]][dark ? 7 : 6]
    const pending = dark ? theme.colors.dark[2] : theme.colors.gray[5]
    if (hover) {
      context.fillStyle = dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)"
      context.fillRect(0, hover.row * cell, width, cell)
      context.fillRect(hover.column * cell, 0, cell, height)
    }
    const circle = (x: number, y: number, r: number) => {
      context.beginPath()
      context.arc(x, y, r, 0, 2 * Math.PI)
    }
    context.lineWidth = Math.max(1, cell / 14)
    for (const { test, row, column } of grid.cells) {
      const [x, y] = [(column + 0.5) * cell, (row + 0.5) * cell]
      if (x < view.x - cell || x > view.x + view.width + cell || y < view.y - cell || y > view.y + view.height + cell)
        continue
      const state = tests.get(test.id) ?? PENDING
      const error = errors.get(test.id)
      const r = highlight && error !== highlight ? radius * 0.4 : radius
      if (state.status === "pending") {
        context.strokeStyle = pending
        circle(x, y, r - context.lineWidth / 2)
        context.stroke()
        continue
      }
      context.fillStyle = color(state.status)
      if (state.status === "running") {
        context.strokeStyle = color("running")
        circle(x, y, r - context.lineWidth / 2)
        context.stroke()
        context.beginPath()
        context.moveTo(x, y)
        context.arc(x, y, r, -Math.PI / 2, (state.progress ?? 0) * 2 * Math.PI - Math.PI / 2)
        context.fill()
        continue
      }
      circle(x, y, r)
      context.fill()
      if (colorErrors && error) {
        // a ring in the error group's color, around the (still red) failure
        context.strokeStyle = errorColors.get(error) ?? color("failed")
        context.lineWidth = Math.max(2, cell / 7)
        circle(x, y, r - context.lineWidth / 2)
        context.stroke()
        context.lineWidth = Math.max(1, cell / 14)
      }
    }
    if (hover) {
      context.strokeStyle = theme.colors.gray[dark ? 3 : 7]
      context.lineWidth = 1.5
      circle((hover.column + 0.5) * cell, (hover.row + 0.5) * cell, cell / 2 - 1)
      context.stroke()
    }
  }, [grid, tests, errors, errorColors, hover, highlight, colorErrors, view, width, height, cell, radius, dark, theme])

  const columnLabels = useMemo(
    () =>
      showLabels &&
      labels.map((label, index) => (
        <Text
          key={label + String(index)}
          data-column={index}
          fz={12}
          style={{
            position: "absolute",
            left: index * cell + cell / 2 - 3,
            bottom: 2,
            whiteSpace: "nowrap",
            transformOrigin: "0 100%",
            transform: "rotate(-60deg)",
          }}
        >
          {label}
        </Text>
      )),
    [labels, cell, showLabels],
  )
  const rowLabels = useMemo(
    () =>
      grid.rows.map((row, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: wrapped rows repeat their (empty) labels
          key={index}
          data-row={index}
          fz={Math.min(14, cell - 4)}
          ta="right"
          pr="sm"
          truncate
          style={{ height: cell, lineHeight: `${cell}px` }}
        >
          {row || "–"}
        </Text>
      )),
    [grid, cell],
  )

  /** Drag the corner's edges to resize the column headers or the row labels; double-click to reset. */
  const resize = (side: "header" | "labels") => ({
    title: "Drag to resize · double-click to reset",
    onPointerDown: (event: React.PointerEvent) => {
      const position = (e: PointerEvent | React.PointerEvent) => (side === "header" ? e.clientY : e.clientX)
      const [from, size] = [position(event), side === "header" ? headerHeight : (corner.current?.offsetWidth ?? 0)]
      const move = (e: PointerEvent) =>
        setLayout((layout) => ({ ...layout, [side]: Math.min(800, Math.max(24, size + position(e) - from)) }))
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
      event.preventDefault()
    },
    onDoubleClick: () => setLayout((layout) => ({ ...layout, [side]: undefined })),
  })

  const at = (row: number, column: number): Hover => {
    const rect = area.current?.getBoundingClientRect()
    const [x, y] = [(rect?.left ?? 0) + (column + 0.5) * cell, (rect?.top ?? 0) + (row + 0.5) * cell]
    return { row, column, test: byCell.get(`${row},${column}`), x, y }
  }
  const point = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const [row, column] = [
      Math.floor((event.clientY - rect.top) / cell),
      Math.floor((event.clientX - rect.left) / cell),
    ]
    return { ...at(row, column), x: event.clientX, y: event.clientY }
  }
  const keys = (event: React.KeyboardEvent) => {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    const current = cursor.current
    const test = current && byCell.get(`${current.row},${current.column}`)
    if (event.key === "Enter" && test) return onOpen(test, event)
    if (event.key === "Escape") {
      cursor.current = undefined
      return setHover(undefined)
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    const row = Math.min(grid.rows.length - 1, Math.max(0, (current?.row ?? 0) + (current ? move[0] : 0)))
    const column = Math.min(grid.columns.length - 1, Math.max(0, (current?.column ?? 0) + (current ? move[1] : 0)))
    cursor.current = { row, column }
    const [outer, cells] = [scroller.current, area.current?.getBoundingClientRect()]
    if (outer && cells) {
      // keep the cell in view, clear of the sticky headers
      const box = outer.getBoundingClientRect()
      const [left, top] = [cells.left + column * cell - box.left, cells.top + row * cell - box.top]
      if (left < cornerWidth) outer.scrollLeft += left - cornerWidth - cell
      if (left + cell > outer.clientWidth) outer.scrollLeft += left + 2 * cell - outer.clientWidth
      if (top < headerHeight + 28) outer.scrollTop += top - headerHeight - 28 - cell
      if (top + cell > outer.clientHeight) outer.scrollTop += top + 2 * cell - outer.clientHeight
    }
    requestAnimationFrame(() => setHover(at(row, column)))
  }
  const sticky = { position: "sticky", background: "var(--mantine-color-body)" } as const
  const scope = `[data-matrix="${id}"]`
  const dim =
    hover &&
    `${scope} [data-column]:not([data-column="${hover.column}"]), ${scope} [data-row]:not([data-row="${hover.row}"])`

  return (
    <Box
      data-matrix={id}
      className="matrix"
      tabIndex={0}
      role="application"
      aria-label="Test matrix: use the arrow keys to move between tests, Enter to open a test's log"
      onKeyDown={keys}
      onBlur={() => {
        cursor.current = undefined
        setHover(undefined)
      }}
      style={{
        display: "grid",
        gridColumn: "1 / -1",
        gridTemplateColumns: "subgrid", // the row labels line up with the other matrices'
        gridTemplateRows: `${headerHeight}px ${grid.groups.length > 1 || showLabels ? 28 : 0}px ${height}px`,
        paddingRight: showLabels ? Math.min(240, headerHeight * 0.6) : 16,
      }}
    >
      {dim && <style>{`${dim} { opacity: 0.4 }`}</style>}
      <Box
        ref={corner}
        c="dimmed"
        fz="sm"
        ta="right"
        pr={showRows ? "sm" : 0}
        style={{ ...sticky, top: 0, left: 0, zIndex: 3, display: "flex", alignItems: "end", justifyContent: "end" }}
      >
        {showRows && (rowParams.join(" · ") || (grid.rows.length > 1 ? "module" : ""))}
        {showLabels && (
          <Box
            className="resize-handle"
            pos="absolute"
            left={0}
            right={0}
            bottom={-3}
            h={6}
            style={{ cursor: "row-resize" }}
            {...resize("header")}
          />
        )}
        {showRows && (
          <Box
            className="resize-handle"
            pos="absolute"
            top={0}
            bottom={-28 - height}
            right={-8}
            w={6}
            style={{ cursor: "col-resize" }}
            {...resize("labels")}
          />
        )}
      </Box>
      <Box style={{ ...sticky, top: 0, zIndex: 2 }}>{columnLabels}</Box>
      <Box style={{ ...sticky, top: headerHeight, left: 0, zIndex: 3 }} />
      <Box style={{ ...sticky, top: headerHeight, zIndex: 2, display: "flex" }}>
        {grid.groups.map((group) => (
          <Box
            key={`${group.module}-${group.start}`}
            title={group.module}
            style={{
              width: (group.end - group.start) * cell,
              borderTop: "2px solid var(--mantine-color-default-border)",
            }}
          >
            {group.end - group.start > 2 && (
              // stays visible while scrolling through a wide group
              <Text
                size="xs"
                fw={600}
                c="dimmed"
                truncate
                px={4}
                style={{ position: "sticky", left: cornerWidth + 12, width: "fit-content", maxWidth: "100%" }}
              >
                {group.module}
              </Text>
            )}
          </Box>
        ))}
      </Box>
      <Box style={{ ...sticky, left: 0, zIndex: 1 }}>{showRows && rowLabels}</Box>
      <Box
        ref={area}
        pos="relative"
        w={width}
        style={{ cursor: hover?.test ? "pointer" : undefined }}
        onMouseMove={(event) => {
          const hovered = point(event)
          cursor.current = hovered
          setHover(hovered)
        }}
        onMouseLeave={() => setHover(undefined)}
        onClick={(event) => {
          const { test } = point(event)
          if (test) onOpen(test, event)
        }}
      >
        <canvas
          ref={canvas}
          style={{ position: "absolute", left: view.x, top: view.y, width: view.width, height: view.height }}
        />
      </Box>
      <Box aria-live="polite" className="visually-hidden">
        {hover?.test && `${hover.test.id}: ${tests.get(hover.test.id)?.status ?? "pending"}`}
      </Box>
      {hover?.test && shownTest === hover.test.id && (
        <TestCard run={run} hover={hover} state={tests.get(hover.test.id)} />
      )}
    </Box>
  )
}

function TestCard({ run, hover, state = PENDING }: { run: RunRef; hover: Hover; state?: TestState }) {
  const test = hover.test?.id ?? ""
  const { data: log } = useSWR<LogChunk>(state.exception ? null : `${apis.log(run, { test }, "/lines")}&bytes=16384`)
  if (!hover.test) return null
  const [w, h] = [560, 340]
  // beside the dot, so the rows around it stay visible
  const left = hover.x + w + 40 < window.innerWidth ? hover.x + 24 : Math.max(8, hover.x - w - 24)
  const top = Math.max(8, Math.min(hover.y - 60, window.innerHeight - h - 8))
  const duration = state.start && state.end && state.end - state.start >= 0.1 ? took(state.start, state.end) : undefined
  const text =
    state.exception ??
    log?.lines
      .slice(-14)
      .map((l) => `${clock(l.time)} ${l.level[0]} ${l.message.slice(0, 500)}`)
      .join("\n")
  return (
    <Paper
      withBorder
      shadow="lg"
      p="sm"
      pos="fixed"
      left={left}
      top={top}
      maw={w}
      mah={h}
      style={{ zIndex: 300, pointerEvents: "none" }}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" gap="md">
          <Text size="sm" ff="monospace" truncate>
            {hover.test.id}
          </Text>
          <Badge color={COLORS[state.status]} style={{ flexShrink: 0 }}>
            {state.status === "running" ? `${Math.round((state.progress ?? 0) * 100)}%` : state.status}
          </Badge>
        </Group>
        {state.reason && <Text size="sm">{state.reason}</Text>}
        {duration && (
          <Text size="xs" c="dimmed">
            took {duration}
          </Text>
        )}
        {text && (
          <Code block style={{ maxHeight: 220, overflow: "hidden", display: "flex", flexDirection: "column-reverse" }}>
            {text}
          </Code>
        )}
        <Text size="xs" c="dimmed">
          Click: open log · {mod()}-click: new tab · Alt-click: filter by status
        </Text>
      </Stack>
    </Paper>
  )
}
