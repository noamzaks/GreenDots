import { Box, Button, Divider, Group, Text } from "@mantine/core"
import dayjs from "dayjs"
import { memo } from "react"
import { Ansi } from "@/components/Ansi"
import { bytes } from "@/lib/format"
import { clock } from "@/lib/time"
import type { LogLine as Line } from "@/lib/types"

const SHORT: Record<string, string> = { DEBUG: "DBG", INFO: "INF", WARNING: "WRN", ERROR: "ERR", CRITICAL: "CRT" }

export const LEVELS: Record<string, string> = {
  DEBUG: "cyan",
  INFO: "blue",
  WARNING: "yellow",
  ERROR: "red",
  CRITICAL: "grape",
}
const tint = (color: string) => `color-mix(in srgb, var(--mantine-color-${color}-light) 45%, transparent)`
const TINTS: Record<string, string> = { WARNING: tint("yellow"), ERROR: tint("red"), CRITICAL: tint("grape") }

type LineProps = {
  line: Line
  date?: string
  timestamps: boolean
  loggerWidth: number
  stacked: boolean
  search: string
  onExpand: (line: Line) => void
}

export const LogLine = memo(function LogLine({
  line,
  date,
  timestamps,
  loggerWidth,
  stacked,
  search,
  onExpand,
}: LineProps) {
  const meta = (
    <>
      {timestamps && (
        <Text span c="dimmed" fz={12} ff="monospace" title={dayjs.unix(line.time).format("YYYY-MM-DD HH:mm:ss.SSS")}>
          {line.time ? (stacked ? clock(line.time).slice(0, 8) : clock(line.time)) : ""}
        </Text>
      )}
      <Text span fz={12} ff="monospace" fw={700} c={LEVELS[line.level] ?? "gray"} title={line.level}>
        {stacked ? (SHORT[line.level] ?? line.level) : line.level[0] || "?"}
      </Text>
      <Text span c="dimmed" fz={12} ff="monospace" truncate title={line.name}>
        {line.name}
      </Text>
    </>
  )
  const message = (
    <Box style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", minWidth: 0 }}>
      <Box
        style={
          line.truncated
            ? {
                maxHeight: "8lh",
                overflow: "hidden",
                maskImage: "linear-gradient(to bottom, black 60%, transparent)",
              }
            : undefined
        }
      >
        <Text span fz={12} ff="monospace">
          <Ansi text={line.message} search={search} />
        </Text>
      </Box>
      {line.truncated && (
        <Button size="compact-xs" variant="light" mt={2} onClick={() => onExpand(line)}>
          Show the whole line ({bytes(line.length)})
        </Button>
      )}
    </Box>
  )
  return (
    <>
      {date && <Divider label={date} labelPosition="center" my={4} mx="xs" styles={{ label: { fontSize: 11 } }} />}
      <Box
        px="xs"
        bg={TINTS[line.level]}
        style={{
          display: "grid",
          gridTemplateColumns: stacked ? "1fr" : `${timestamps ? "92px " : ""}14px ${loggerWidth}px minmax(0, 1fr)`,
          columnGap: 10,
          fontFamily: "var(--mantine-font-family-monospace)",
          fontSize: 12,
          lineHeight: 1.55,
        }}
      >
        {stacked ? (
          <Group gap={8} wrap="nowrap">
            {meta}
          </Group>
        ) : (
          meta
        )}
        {message}
      </Box>
    </>
  )
})
