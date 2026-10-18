"use client"

import {
  ActionIcon,
  Badge,
  Box,
  Button,
  CloseButton,
  CopyButton,
  Group,
  Kbd,
  Loader,
  Menu,
  Pill,
  Popover,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core"
import {
  useDebouncedValue,
  useDocumentTitle,
  useHotkeys,
  useLocalStorage,
  useMediaQuery,
  useViewportSize,
} from "@mantine/hooks"
import {
  IconAlertTriangle,
  IconBell,
  IconBellOff,
  IconBug,
  IconCheck,
  IconCopy,
  IconFileText,
  IconHelp,
  IconSearch,
} from "@tabler/icons-react"
import { type LiqeQuery, test as matches, parse } from "liqe"
import { useMemo, useRef, useState } from "react"
import { Link, useLocation } from "wouter"
import { ErrorsDrawer } from "@/components/ErrorsDrawer"
import { ERROR_PALETTE, Matrix, useMatrixLayout } from "@/components/Matrix"
import { FilterHelp, Shortcuts } from "@/components/RunHelp"
import { Traceback } from "@/components/Traceback"
import { useNotificationsSetting, useRunAlerts } from "@/lib/alerts"
import { apis, COLORS, errorTitle, hash, pages, type RunRef, useRun } from "@/lib/client"
import { plural } from "@/lib/format"
import { buildGrids } from "@/lib/grid"
import { mod } from "@/lib/platform"
import { useQueryParam, useRunRef } from "@/lib/router"
import { ago, took } from "@/lib/time"
import { useTitle } from "@/lib/titles"
import { STATUSES, type Status } from "@/lib/types"

const DENSITIES = { comfortable: 22, compact: 14, dense: 8 }

export default function RunPage() {
  const ref = useRunRef()
  return <RunView key={pages.run(ref)} {...ref} />
}

function RunView(ref: RunRef) {
  const { project, source, run } = ref
  const [, navigate] = useLocation()
  const [notify, toggleNotify] = useNotificationsSetting()
  const { plan, tests, summary, title, polling, error } = useRun(ref, notify)
  useDocumentTitle(
    `${summary?.failed ? `✗${summary.failed} ` : ""}${title ?? run} (${source}) · ${project} · GreenDots`,
  )
  useTitle(pages.run(ref), title)
  useRunAlerts(ref, summary, notify)
  const [q, setQuery] = useQueryParam("q")
  const query = q ?? ""
  const [errorsParam, setErrorsParam] = useQueryParam("errors")
  const showErrors = errorsParam === "true"
  const setShowErrors = (show: boolean) => setErrorsParam(show ? "true" : null)
  const [density, setDensity] = useLocalStorage<keyof typeof DENSITIES>({
    key: `greendots-density-${project}`,
    defaultValue: "comfortable",
  })
  const [highlight, setHighlight] = useState<string>()
  const [help, setHelp] = useState(false)
  const [collectErrorsHidden, setCollectErrorsHidden] = useLocalStorage({
    key: `greendots-collect-errors-hidden-${source}/${project}/${run}`,
    defaultValue: false,
  })
  const mobile = useMediaQuery("(max-width: 48em)")
  const cell = DENSITIES[density] ?? 22
  // how many dots fit across (next to the row labels), for wrapping suites without row params
  const columns = Math.floor((useViewportSize().width - (showErrors && !mobile ? 440 : 0) - 240) / cell)
  const filterInput = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [layout] = useMatrixLayout(project)
  useHotkeys([
    ["mod+K", () => filterInput.current?.select()],
    ["mod+E", () => setShowErrors(!showErrors)],
    ["shift+?", () => setHelp(true)],
    ["g", () => document.querySelector<HTMLElement>(".matrix")?.focus()],
  ])

  const [debouncedQuery] = useDebouncedValue(query, 200)
  const filter = useMemo(() => {
    try {
      return { parsed: debouncedQuery.trim() ? (parse(debouncedQuery) as LiqeQuery) : undefined }
    } catch {
      return { invalid: true }
    }
  }, [debouncedQuery])

  // failures, grouped by their headline, most common first
  const { errors, errorOf, errorColors } = useMemo(() => {
    const groups = new Map<string, { title: string; example: string; count: number }>()
    const errorOf = new Map<string, string>()
    for (const [id, { status, exception = "" }] of tests) {
      if (status !== "failed" && !exception) continue
      const title = errorTitle(exception) || "Failed without details"
      const key = hash(title)
      const group = groups.get(key) ?? { title, example: exception, count: 0 }
      groups.set(key, { ...group, count: group.count + 1 })
      errorOf.set(id, key)
    }
    const errors = [...groups].sort(([, a], [, b]) => b.count - a.count)
    const palette = (rank: number) => ERROR_PALETTE[rank % ERROR_PALETTE.length]
    const errorColors = new Map(errors.map(([key], rank) => [key, `var(--mantine-color-${palette(rank)}-5)`]))
    return { errors, errorOf, errorColors }
  }, [tests])

  // the layout only depends on test states while filtering
  const filtering = useMemo(
    () => filter.parsed && { parsed: filter.parsed, tests, errorOf, titles: new Map(errors) },
    [filter.parsed, tests, errorOf, errors],
  )
  const grids = useMemo(() => {
    if (!plan || !filtering) return plan ? buildGrids(plan, undefined, columns) : []
    const { parsed, tests, errorOf, titles } = filtering
    return buildGrids(
      plan,
      (test) => {
        const state = tests.get(test.id)
        const error = errorOf.get(test.id)
        const fields = { id: test.id, name: test.name, module: test.module, status: state?.status ?? "pending" }
        const message = error && titles.get(error)?.title
        return matches(parsed, { ...test.params, ...fields, error, message, reason: state?.reason })
      },
      columns,
    )
  }, [plan, filtering, columns])
  const params = useMemo(() => [...new Set(plan?.tests.flatMap((test) => Object.keys(test.params)))], [plan])
  const canvasColors = useMemo(() => {
    // the canvas needs real colors, not CSS variables
    const style = getComputedStyle(document.documentElement)
    return new Map([...errorColors].map(([key, color]) => [key, style.getPropertyValue(color.slice(4, -1)) || color]))
  }, [errorColors])

  if (!plan)
    return error ? (
      <Text c="dimmed">
        Waiting for {run}/plan.json… ({error})
      </Text>
    ) : (
      <Loader />
    )

  const shown = grids.reduce((count, grid) => count + grid.cells.length, 0)
  const shownIds = grids.flatMap((grid) => grid.cells.map((cell) => JSON.stringify(cell.test.id))).join(" ")
  const activeError = /(?:^|\s)error:(\w+)/.exec(query)?.[1]
  const activeTitle = activeError && errors.find(([key]) => key === activeError)?.[1].title
  const toggleStatus = (status: Status) => setQuery(query.trim() === `status:${status}` ? null : `status:${status}`)
  const subtitle = [
    summary?.started && `started ${ago(summary.started)}`,
    summary?.done && summary.ended && `took ${took(summary.started, summary.ended)}`,
    polling === "live" && "running",
    polling === "slow" && "no recent changes, checking every minute",
  ].filter(Boolean)

  return (
    <Stack pr={showErrors ? { base: 0, md: 440 } : 0} gap="sm" h="calc(100dvh - 84px)">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="sm" align="baseline" miw={0}>
          <Title order={3} lineClamp={1}>
            {title ?? run}
          </Title>
          <Badge size="xs" variant="default" style={{ flexShrink: 0, alignSelf: "center" }}>
            {source}
          </Badge>
          <Text size="sm" c="dimmed">
            {subtitle.join(" · ")}
          </Text>
          {polling === "stopped" && (
            <Tooltip label="It may have stopped (e.g. crashed) without finishing. It isn't checked anymore, to spare the share.">
              <Badge color="yellow" variant="light">
                no updates{summary?.updated ? ` for ${ago(summary.updated / 1000).replace(" ago", "")}` : ""}
              </Badge>
            </Tooltip>
          )}
          {polling === "stopped" && (
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => fetch(`${apis.run(ref)}/check`, { method: "POST" })}
            >
              Check again
            </Button>
          )}
        </Group>
        <Group gap={4} wrap="nowrap">
          <Tooltip label="Dot size">
            <SegmentedControl
              size="xs"
              value={density}
              onChange={(value) => setDensity(value as keyof typeof DENSITIES)}
              data={[
                { value: "comfortable", label: "●" },
                { value: "compact", label: "•" },
                { value: "dense", label: "·" },
              ]}
              aria-label="Dot size"
            />
          </Tooltip>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Tooltip label="Session logs: output outside of tests">
                <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Session logs">
                  <IconFileText size={18} />
                </ActionIcon>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Output outside of tests, per worker</Menu.Label>
              {Array.from({ length: plan.worker_count }, (_, worker) => `${worker}`).map((worker) => (
                <Menu.Item key={worker} component={Link} href={pages.log(ref, { session: worker })}>
                  Worker {worker}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <Tooltip label="Keyboard and mouse shortcuts (?)">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              onClick={() => setHelp(true)}
              aria-label="Shortcuts"
              visibleFrom="sm"
            >
              <IconHelp size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      {!collectErrorsHidden &&
        plan.errors.map((error) => (
          <Traceback
            key={error.id}
            title={`${error.id} failed to collect: its tests aren't in the matrix`}
            traceback={error.exception}
            onClose={() => setCollectErrorsHidden(true)}
          />
        ))}
      <Group gap="xs" align="start">
        <Stack gap={4} style={{ flex: "1 1 280px" }}>
          <TextInput
            ref={filterInput}
            aria-label="Filter tests"
            leftSection={<IconSearch size={16} />}
            placeholder={mobile ? "Filter tests" : `Filter tests (${mod()} K), e.g. status:failed arch:arm`}
            value={query}
            error={filter.invalid && "Invalid query - see the syntax help (?)"}
            onChange={(event) => setQuery(event.currentTarget.value || null)}
            rightSectionWidth={56}
            rightSection={
              <Group gap={2} wrap="nowrap">
                {query && <CloseButton size="sm" aria-label="Clear the filter" onClick={() => setQuery(null)} />}
                <Popover position="bottom-end" withArrow shadow="md">
                  <Popover.Target>
                    <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Filter syntax">
                      <IconHelp size={16} />
                    </ActionIcon>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <FilterHelp params={params} onPick={setQuery} />
                  </Popover.Dropdown>
                </Popover>
              </Group>
            }
          />
          {(filter.parsed || activeTitle) && (
            <Group gap="xs">
              <Text size="xs" c="dimmed">
                Showing {shown.toLocaleString()} of {plan.tests.length.toLocaleString()} tests
              </Text>
              {activeTitle && (
                <Pill withRemoveButton onRemove={() => setQuery(null)} size="sm">
                  {activeTitle.slice(0, 80)}
                </Pill>
              )}
            </Group>
          )}
        </Stack>
        <Group gap={6} mt={4}>
          {STATUSES.filter((status) => summary?.[status]).map((status) => {
            const active = query.trim() === `status:${status}`
            return (
              <Tooltip
                key={status}
                label={active ? "Show all tests" : `Show only ${status} tests (or Alt-click a dot)`}
              >
                <Badge
                  component="button"
                  aria-pressed={active}
                  color={COLORS[status]}
                  variant={active ? "filled" : "light"}
                  size="lg"
                  style={{ cursor: "pointer", border: 0 }}
                  onClick={() => toggleStatus(status)}
                >
                  {summary?.[status].toLocaleString()} {status}
                </Badge>
              </Tooltip>
            )
          })}
          {plan.errors.length > 0 && (
            <Badge
              component="button"
              color="red"
              variant="filled"
              size="lg"
              leftSection={<IconAlertTriangle size={14} />}
              style={{ cursor: "pointer" }}
              onClick={() => setCollectErrorsHidden(!collectErrorsHidden)}
            >
              {plural(plan.errors.length, "collection error")}
            </Badge>
          )}
        </Group>
        <Group gap={4} wrap="nowrap">
          <Tooltip
            label={
              notify
                ? "Notifying on failures and when the run finishes"
                : "Notify me on failures and when the run finishes"
            }
          >
            <ActionIcon
              variant={notify ? "light" : "default"}
              size="lg"
              onClick={toggleNotify}
              aria-label="Notifications"
              aria-pressed={notify}
            >
              {notify ? <IconBell size={18} /> : <IconBellOff size={18} />}
            </ActionIcon>
          </Tooltip>
          <CopyButton value={shownIds}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? "Copied" : "Copy the ids of the shown tests (for pytest)"}>
                <ActionIcon variant="default" size="lg" onClick={copy} aria-label="Copy test ids">
                  {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
          <Tooltip
            label={
              <>
                Errors grouped by message <Kbd size="xs">{mod()} E</Kbd>
              </>
            }
          >
            <Button
              variant={showErrors ? "filled" : errors.length + plan.errors.length ? "light" : "default"}
              color={errors.length + plan.errors.length ? "red" : undefined}
              leftSection={<IconBug size={18} />}
              onClick={() => setShowErrors(!showErrors)}
              aria-pressed={showErrors}
            >
              Errors ({errors.length + plan.errors.length})
            </Button>
          </Tooltip>
        </Group>
      </Group>
      {grids.length > 0 ? (
        <Box
          ref={scroller}
          style={{
            display: "grid",
            gridTemplateColumns: `${layout.labels ? `${layout.labels}px` : "fit-content(320px)"} max-content`,
            gap: "24px 12px",
            alignContent: "start",
            overflow: "auto",
            flex: 1,
            minHeight: 0,
          }}
        >
          {grids.map((grid) => (
            <Matrix
              key={grid.rowParams.join() || "-"}
              run={ref}
              grid={grid}
              scroller={scroller}
              tests={tests}
              errors={errorOf}
              errorColors={canvasColors}
              cell={cell}
              highlight={highlight}
              colorErrors={showErrors}
              onOpen={(test, event) => {
                const url = pages.log(ref, { test: test.id })
                if (event.altKey) setQuery(`status:${tests.get(test.id)?.status ?? "pending"}`)
                else if (event.ctrlKey || event.metaKey) window.open(url)
                else navigate(url)
              }}
            />
          ))}
        </Box>
      ) : (
        <Text c="dimmed">{plan.tests.length ? "No tests match the filter." : "This run has no tests."}</Text>
      )}
      <ErrorsDrawer
        opened={showErrors}
        onClose={() => setShowErrors(false)}
        errors={errors}
        colors={errorColors}
        collectErrors={plan.errors.length}
        active={activeError}
        highlight={highlight}
        onHighlight={setHighlight}
        onPick={(id) => {
          setQuery(`error:${id}`)
          if (mobile) setShowErrors(false)
        }}
        onShowCollectErrors={() => setCollectErrorsHidden(false)}
      />
      <Shortcuts opened={help} onClose={() => setHelp(false)} />
    </Stack>
  )
}
