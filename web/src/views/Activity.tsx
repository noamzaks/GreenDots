"use client"

import { Badge, Box, Chip, Group, Paper, SimpleGrid, Stack, Switch, Table, Text, TextInput, Title } from "@mantine/core"
import { useDocumentTitle } from "@mantine/hooks"
import { IconSearch } from "@tabler/icons-react"
import { useEffect, useMemo, useState } from "react"
import { TableVirtuoso } from "react-virtuoso"
import useSWR from "swr"
import type { Activity, ActivityKind } from "@/lib/activity"
import { useEventStream } from "@/lib/client"
import type { Config } from "@/lib/config"
import { bytes } from "@/lib/format"
import { clock } from "@/lib/time"

const KINDS: Record<ActivityKind, { color: string; label: string }> = {
  list: { color: "violet", label: "Directory listings" },
  stat: { color: "blue", label: "Stats" },
  read: { color: "teal", label: "Reads" },
  sync: { color: "green", label: "Run syncs" },
  api: { color: "gray", label: "API requests" },
}

/** The latest filesystem operations, run syncs and API requests, newest first; none while paused. */
function useActivity(paused: boolean) {
  const [state, setState] = useState<{ entries: Activity[]; capacity: number }>({ entries: [], capacity: 0 })
  useEventStream<{ capacity: number; entries: Activity[] }>(paused ? null : "/api/activity", (batch) =>
    setState((state) => {
      const newest = state.entries[0]?.seq ?? 0
      const added = batch.entries.filter((entry) => entry.seq > newest).reverse()
      return { capacity: batch.capacity, entries: [...added, ...state.entries].slice(0, batch.capacity) }
    }),
  )
  return state
}

/** Shows paths in a source as `source:path`. */
function useShortPaths() {
  const { data } = useSWR<{ config: Config }>("/api/config")
  return (path: string) => {
    const source = data?.config.sources.find((s) => path === s.path || path.startsWith(`${s.path}/`))
    return source ? `${source.name}:${path.slice(source.path.length + 1) || "."}` : path
  }
}

export default function ActivityPage() {
  const [paused, setPaused] = useState(false)
  const { entries, capacity } = useActivity(paused)
  const short = useShortPaths()
  const [kinds, setKinds] = useState<string[]>(["list", "stat", "read", "sync"])
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [search, setSearch] = useState("")
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [])
  const shown = useMemo(
    () =>
      entries.filter(
        (entry) =>
          kinds.includes(entry.kind) &&
          (!errorsOnly || entry.error) &&
          short(entry.path).toLowerCase().includes(search.toLowerCase()),
      ),
    [entries, kinds, errorsOnly, search, short],
  )
  const lastMinute = entries.filter((entry) => now - entry.time < 60_000)
  useDocumentTitle("Activity · GreenDots")
  return (
    <Stack h="calc(100dvh - 84px)" gap="sm" maw={1400} mx="auto">
      <Group justify="space-between" align="baseline">
        <Title order={2}>Activity</Title>
        <Text size="sm" c="dimmed">
          The last {capacity.toLocaleString()} operations on the projects directory, run syncs and requests to this
          server
        </Text>
      </Group>
      <SimpleGrid cols={{ base: 3, sm: 5 }} spacing="xs">
        {(Object.keys(KINDS) as ActivityKind[]).map((kind) => {
          const recent = lastMinute.filter((entry) => entry.kind === kind)
          const total = recent.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
          return (
            <Paper key={kind} withBorder p="xs" opacity={kinds.includes(kind) ? 1 : 0.55}>
              <Text size="xs" c="dimmed">
                {KINDS[kind].label} / minute
              </Text>
              <Text fw={700} size="lg">
                {recent.length}
                {total > 0 && (
                  <Text span size="xs" c="dimmed" fw={400}>
                    {" "}
                    · {bytes(total)}
                  </Text>
                )}
              </Text>
            </Paper>
          )
        })}
      </SimpleGrid>
      <Group gap="xs">
        <Chip.Group multiple value={kinds} onChange={setKinds}>
          {(Object.keys(KINDS) as ActivityKind[]).map((kind) => (
            <Chip key={kind} value={kind} size="xs" color={KINDS[kind].color}>
              {kind}
            </Chip>
          ))}
        </Chip.Group>
        <Chip size="xs" color="red" checked={errorsOnly} onChange={setErrorsOnly}>
          errors only
        </Chip>
        <Switch size="xs" label="Pause" checked={paused} onChange={(event) => setPaused(event.currentTarget.checked)} />
        <TextInput
          size="xs"
          style={{ flex: "1 1 200px" }}
          leftSection={<IconSearch size={14} />}
          placeholder="Filter by path"
          aria-label="Filter by path"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </Group>
      <Box flex={1} mih={0} style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}>
        <TableVirtuoso
          data={shown}
          components={{
            Table: (props) => (
              <Table
                {...props}
                fz="xs"
                verticalSpacing={4}
                highlightOnHover
                miw={680}
                style={{ ...props.style, tableLayout: "fixed" }}
              />
            ),
            TableHead: Table.Thead,
            TableRow: Table.Tr,
            TableBody: Table.Tbody,
          }}
          fixedHeaderContent={() => (
            <Table.Tr bg="var(--mantine-color-body)">
              <Table.Th w={100}>Time</Table.Th>
              <Table.Th w={70}>Kind</Table.Th>
              <Table.Th>Path</Table.Th>
              <Table.Th w={160}>Details</Table.Th>
              <Table.Th w={80} ta="right">
                Size
              </Table.Th>
              <Table.Th w={80} ta="right">
                Took
              </Table.Th>
            </Table.Tr>
          )}
          itemContent={(_, entry) => (
            <>
              <Table.Td c="dimmed" ff="monospace">
                {clock(entry.time / 1000)}
              </Table.Td>
              <Table.Td>
                <Badge size="xs" variant="light" color={KINDS[entry.kind].color}>
                  {entry.kind}
                </Badge>
              </Table.Td>
              <Table.Td
                ff="monospace"
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={entry.path}
              >
                {short(entry.path)}
              </Table.Td>
              <Table.Td
                c={entry.error ? "red" : "dimmed"}
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {entry.error ?? entry.detail}
              </Table.Td>
              <Table.Td ta="right">{bytes(entry.bytes)}</Table.Td>
              <Table.Td ta="right">{entry.ms === undefined ? "" : `${entry.ms.toFixed(1)} ms`}</Table.Td>
            </>
          )}
        />
      </Box>
    </Stack>
  )
}
