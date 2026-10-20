"use client"

import {
  ActionIcon,
  Affix,
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
  CopyButton,
  Group,
  Loader,
  Menu,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core"
import { useDebouncedValue, useDocumentTitle, useHotkeys, useLocalStorage, useMediaQuery } from "@mantine/hooks"
import { IconArrowDown, IconCheck, IconCopy, IconSearch, IconUsers } from "@tabler/icons-react"
import dayjs from "dayjs"
import { useEffect, useMemo, useRef, useState } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { FailureNavigation } from "@/components/FailureNavigation"
import { LEVELS, LogLine as Line } from "@/components/LogLine"
import { MessageViewer } from "@/components/MessageViewer"
import { Traceback } from "@/components/Traceback"
import { apis, COLORS, type LogTarget, pages, type RunRef, useLog } from "@/lib/client"
import { useQueryParam, useRunRef } from "@/lib/router"
import { clock } from "@/lib/time"
import type { LogLine } from "@/lib/types"

const FIRST_INDEX = 1_000_000_000 // Virtuoso's index of the first loaded line; older lines get smaller ones

export default function LogPage() {
  const ref = useRunRef()
  const [test] = useQueryParam("test")
  const [session] = useQueryParam("session")
  const target: LogTarget = session !== null ? { session } : { test: test ?? "" }
  return <LogView key={pages.log(ref, target)} run={ref} target={target} />
}

function LogView({ run: ref, target }: { run: RunRef; target: LogTarget }) {
  const { source, run } = ref
  const [test, session] = "test" in target ? [target.test, null] : [null, target.session]
  const log = useLog(ref, target)
  const list = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [settledAtBottom] = useDebouncedValue(atBottom, 400) // no flashing "Latest" while loading
  const [search, setSearch] = useQueryParam("search")
  const [debouncedSearch] = useDebouncedValue(search ?? "", 150)
  const [hiddenLevels, setHiddenLevels] = useLocalStorage<string[]>({
    key: "greendots-hidden-levels",
    defaultValue: [],
  })
  const [hiddenLoggers, setHiddenLoggers] = useLocalStorage<string[]>({
    key: "greendots-hidden-loggers",
    defaultValue: [],
  })
  const [timestamps, setTimestamps] = useLocalStorage({ key: "greendots-timestamps", defaultValue: true })
  const [expanded, setExpanded] = useState<LogLine>()
  const stacked = useMediaQuery("(max-width: 48em)") ?? false
  const title = session !== null ? `Session log of worker ${session}` : (test ?? "")
  useHotkeys([["Escape", () => !expanded && window.history.back()]])

  const levels = useMemo(() => {
    const seen = new Set(log.lines.map((line) => line.level))
    const custom = [...seen].filter((level) => !(level in LEVELS)).sort()
    return [...Object.keys(LEVELS).filter((level) => seen.has(level)), ...custom]
  }, [log.lines])
  const loggers = useMemo(
    () =>
      [...new Set(log.lines.map((line) => line.name))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [log.lines],
  )
  const loggerWidth = Math.min(160, Math.max(40, ...loggers.map((logger) => logger.length * 7.3)))
  const shown = useMemo(() => {
    const [levels, loggers, query] = [new Set(hiddenLevels), new Set(hiddenLoggers), debouncedSearch.toLowerCase()]
    return log.lines.filter(
      (line) =>
        !levels.has(line.level) &&
        !loggers.has(line.name) &&
        (!query || line.message.toLowerCase().includes(query) || line.name.toLowerCase().includes(query)),
    )
  }, [log.lines, hiddenLevels, hiddenLoggers, debouncedSearch])
  const older = shown.findIndex((line) => line.offset >= log.tailStart)
  const firstItemIndex = FIRST_INDEX - (older === -1 ? shown.length : older)
  const filterKey = `${hiddenLevels}|${hiddenLoggers}|${debouncedSearch}`
  const hiddenCount = hiddenLoggers.filter((logger) => loggers.includes(logger)).length
  const percent = log.size ? (100 * (log.size - log.start)) / log.size : 100
  const coverage = percent < 1 ? Number(percent.toPrecision(1)) : Math.round(percent) // e.g. 0.3, not 0

  // keep loading older lines until the view is filled (e.g. when the tail is a single huge line)
  const { loaded, start, lines, loadOlder } = log
  useEffect(() => {
    if (loaded && start > 0 && lines.length < 100) loadOlder()
  }, [loaded, start, lines.length, loadOlder])

  useDocumentTitle(`${title} · ${run} (${source}) · GreenDots`)
  return (
    <Stack h="calc(100dvh - 84px)" gap="sm">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap={4} wrap="nowrap" miw={0}>
          <Text ff={session === null ? "monospace" : undefined} fw={600} truncate="start" title={title}>
            {title}
          </Text>
          {test && (
            <CopyButton value={test}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? "Copied" : "Copy the test id"}>
                  <ActionIcon variant="subtle" color="gray" size="sm" onClick={copy} aria-label="Copy the test id">
                    {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
          {test && <FailureNavigation run={ref} test={test} />}
          {log.test && (
            <Badge size="lg" color={COLORS[log.test.status]} style={{ flexShrink: 0 }}>
              {log.test.status === "running"
                ? `running ${Math.round((log.test.progress ?? 0) * 100)}%`
                : log.test.status}
            </Badge>
          )}
        </Group>
      </Group>
      {log.test?.exception && <Traceback traceback={log.test.exception} />}
      <Group gap="xs">
        <Chip.Group
          multiple
          value={levels.filter((level) => !hiddenLevels.includes(level))}
          onChange={(visible) =>
            setHiddenLevels([...new Set([...hiddenLevels, ...levels])].filter((level) => !visible.includes(level)))
          }
        >
          {levels.map((level) => (
            <Chip key={level} value={level} color={LEVELS[level] ?? "gray"} size="xs">
              {level}
            </Chip>
          ))}
        </Chip.Group>
        {loggers.length > 1 && (
          <Menu closeOnItemClick={false} position="bottom-start" withinPortal>
            <Menu.Target>
              <Button size="compact-sm" variant="default" leftSection={<IconUsers size={14} />}>
                Loggers{hiddenCount ? ` (${hiddenCount} hidden)` : ""}
              </Button>
            </Menu.Target>
            <Menu.Dropdown mah={400} style={{ overflow: "auto" }}>
              <Menu.Item onClick={() => setHiddenLoggers(hiddenLoggers.filter((logger) => !loggers.includes(logger)))}>
                Show all
              </Menu.Item>
              <Menu.Divider />
              {loggers.map((logger) => (
                <Menu.Item key={logger}>
                  <Checkbox
                    size="xs"
                    label={logger || "(no name)"}
                    checked={!hiddenLoggers.includes(logger)}
                    onChange={(event) =>
                      setHiddenLoggers(
                        event.currentTarget.checked
                          ? hiddenLoggers.filter((hidden) => hidden !== logger)
                          : [...hiddenLoggers, logger],
                      )
                    }
                  />
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
        <Switch
          size="xs"
          label="Timestamps"
          checked={timestamps}
          onChange={(event) => setTimestamps(event.currentTarget.checked)}
        />
        <TextInput
          size="xs"
          style={{ flex: "1 1 200px" }}
          leftSection={<IconSearch size={14} />}
          placeholder="Search loaded lines"
          aria-label="Search loaded lines"
          value={search ?? ""}
          onChange={(event) => setSearch(event.currentTarget.value || null)}
          rightSectionWidth={90}
          rightSection={
            debouncedSearch && (
              <Text size="xs" c="dimmed">
                {shown.length.toLocaleString()} found
              </Text>
            )
          }
        />
      </Group>
      {log.loaded && (
        <Group gap="xs" mt={-6}>
          <Text size="xs" c="dimmed">
            {log.lines.length.toLocaleString()} lines loaded
            {coverage < 100 &&
              ` - the last ${coverage}% of the log; scroll up for more. Search and filters only see loaded lines.`}
          </Text>
          {coverage < 100 && (
            <Button size="compact-xs" variant="subtle" onClick={log.loadAll}>
              Load all
            </Button>
          )}
        </Group>
      )}
      <Box
        flex={1}
        mih={0}
        pos="relative"
        style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}
      >
        {!log.loaded ? (
          log.error ? (
            <Text c="red" p="md">
              {log.error}
            </Text>
          ) : (
            <Loader m="md" />
          )
        ) : (
          <Virtuoso
            ref={list}
            key={filterKey}
            data={shown}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={Math.max(0, shown.length - 1)}
            followOutput={(bottom) => bottom && "auto"}
            atBottomStateChange={setAtBottom}
            startReached={() => log.start > 0 && log.loadOlder()}
            increaseViewportBy={400}
            computeItemKey={(_, line) => line.offset}
            components={{
              Header: () =>
                shown.length > 0 ? (
                  <Text size="xs" c="dimmed" ta="center" py={6}>
                    {log.start === 0 ? (
                      "— start of log —"
                    ) : (
                      <Button size="compact-xs" variant="subtle" onClick={log.loadOlder}>
                        Load older lines
                      </Button>
                    )}
                  </Text>
                ) : null,
              EmptyPlaceholder: () => (
                <Stack p="md" gap="xs" align="start">
                  <Text c="dimmed">
                    {log.lines.length ? "No loaded lines match the filters." : "No log lines yet."}
                  </Text>
                  {log.lines.length > 0 && coverage < 100 && (
                    <Button size="xs" variant="default" onClick={log.loadAll}>
                      Load the whole log ({coverage}% loaded) to search all of it
                    </Button>
                  )}
                </Stack>
              ),
            }}
            itemContent={(index, line) => {
              const previous = shown[index - firstItemIndex - 1]
              const day = line.time ? dayjs.unix(line.time).format("YYYY-MM-DD") : undefined
              const previousDay = previous?.time ? dayjs.unix(previous.time).format("YYYY-MM-DD") : undefined
              return (
                <Line
                  line={line}
                  date={day && day !== previousDay ? day : undefined}
                  timestamps={timestamps}
                  loggerWidth={loggerWidth}
                  stacked={stacked}
                  search={debouncedSearch}
                  onExpand={setExpanded}
                />
              )
            }}
          />
        )}
        {!atBottom && !settledAtBottom && shown.length > 0 && (
          <Affix position={{ bottom: 32, right: 40 }} zIndex={10}>
            <Button
              size="xs"
              radius="xl"
              leftSection={<IconArrowDown size={14} />}
              onClick={() => list.current?.scrollToIndex({ index: "LAST", behavior: "smooth" })}
            >
              Latest
            </Button>
          </Affix>
        )}
      </Box>
      <MessageViewer
        url={expanded && `${apis.log(ref, target, "/line")}&offset=${expanded.offset}`}
        title={expanded && `${expanded.name || "line"} · ${expanded.time ? clock(expanded.time) : ""}`}
        onClose={() => setExpanded(undefined)}
      />
    </Stack>
  )
}
