"use client"

import { Box, Button, CopyButton, Group, Loader, Modal, Progress, Text } from "@mantine/core"
import { IconCheck, IconCopy, IconDownload } from "@tabler/icons-react"
import { useEffect, useRef, useState } from "react"
import { Virtuoso } from "react-virtuoso"
import { fetcher } from "@/lib/client"
import { bytes } from "@/lib/format"
import type { MessageChunk } from "@/lib/types"

const ROW = 2000 // characters per row of text without newlines, so rows stay cheap to render

type Row = { text: string; continued: boolean } // `continued`: the rest of the previous row's line

function toRows(text: string, continued: boolean): Row[] {
  return text.split("\n").flatMap((line, index) => {
    const pieces = Math.max(1, Math.ceil(line.length / ROW))
    return Array.from({ length: pieces }, (_, i) => ({
      text: line.slice(i * ROW, (i + 1) * ROW),
      continued: i > 0 || (index === 0 && continued),
    }))
  })
}

/** Shows a whole (possibly huge) log line, loading it piece by piece as it's scrolled through. */
export function MessageViewer({ url, title, onClose }: { url?: string; title?: string; onClose: () => void }) {
  return (
    <Modal
      opened={!!url}
      onClose={onClose}
      size="90%"
      title={<Text fw={600}>Whole line{title ? ` · ${title}` : ""}</Text>}
      styles={{ body: { height: "75dvh", display: "flex", flexDirection: "column" } }}
    >
      {url && <Message url={url} />}
    </Modal>
  )
}

function Message({ url }: { url: string }) {
  const [state, setState] = useState({ rows: [] as Row[], loaded: 0, total: 0, done: false })
  // what was read so far: the text, its complete rows and the unfinished last row
  const reader = useRef({
    next: undefined as number | undefined,
    text: [] as string[],
    rows: [] as Row[],
    partial: undefined as Row | undefined,
    busy: false,
  })

  /** Loads the next `pieces` pieces of the line (or all of them). */
  const load = async (pieces = 1) => {
    const current = reader.current
    if (current.busy) return
    current.busy = true
    try {
      for (let i = 0; i < pieces; i++) {
        const chunk: MessageChunk = await fetcher(`${url}${current.next === undefined ? "" : `&from=${current.next}`}`)
        current.text.push(chunk.text)
        const added = toRows((current.partial?.text ?? "") + chunk.text, current.partial?.continued ?? false)
        current.partial = chunk.done ? undefined : added.pop()
        current.rows = [...current.rows, ...added]
        current.next = chunk.next
        const rows = current.partial ? [...current.rows, current.partial] : current.rows
        setState({ rows, loaded: chunk.next - chunk.start, total: chunk.total, done: chunk.done })
        if (chunk.done) break
      }
    } finally {
      current.busy = false
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads the first piece once
  useEffect(() => {
    load()
  }, [])
  const percent = Math.min((100 * state.loaded) / Math.max(state.total, 1), 100)
  return (
    <>
      <Group justify="space-between" mb="xs">
        <Text size="sm" c="dimmed">
          {!state.total
            ? "Loading…"
            : `${bytes(state.total)} · ${state.done ? "loaded completely" : `${percent.toFixed(1)}% loaded`}`}
        </Text>
        <Group gap="xs">
          {!state.done && (
            <Button size="xs" variant="default" onClick={() => load(Number.POSITIVE_INFINITY)}>
              Load everything
            </Button>
          )}
          <CopyButton value={state.done ? reader.current.text.join("") : ""}>
            {({ copied, copy }) => (
              <Button
                size="xs"
                variant="default"
                disabled={!state.done}
                leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                onClick={copy}
              >
                Copy
              </Button>
            )}
          </CopyButton>
          <Button
            size="xs"
            variant="default"
            component="a"
            href={`${url}&download`}
            leftSection={<IconDownload size={14} />}
          >
            Download
          </Button>
        </Group>
      </Group>
      {!state.done && <Progress value={percent} size="xs" mb="xs" />}
      {state.rows.length === 0 && !state.done ? (
        <Loader />
      ) : (
        <Virtuoso
          style={{ flex: 1 }}
          data={state.rows}
          endReached={() => !state.done && load()}
          itemContent={(_, row) => (
            <Box
              pl={6}
              style={{
                borderLeft: `2px solid ${row.continued ? "var(--mantine-color-default-border)" : "transparent"}`,
              }}
            >
              <Text ff="monospace" fz="xs" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {row.text || " "}
              </Text>
            </Box>
          )}
        />
      )}
    </>
  )
}
