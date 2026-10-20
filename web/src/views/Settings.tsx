"use client"

import {
  ActionIcon,
  Alert,
  Button,
  Code,
  Fieldset,
  Group,
  Loader,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core"
import { useDocumentTitle } from "@mantine/hooks"
import { IconPlus, IconTrash } from "@tabler/icons-react"
import { useState } from "react"
import useSWR from "swr"
import type { Config } from "@/lib/config"
import { bytes } from "@/lib/format"

type Saved = { config: Config; path: string }

/** A numeric setting: `section.key`, with a label, unit and help text. */
type Field = {
  section: "polling" | "filesystem" | "logs" | "server" | "cache"
  key: string
  label: string
  unit: string
  help?: string
}

const FIELDS: Field[] = [
  { section: "polling", key: "run", label: "Check changing runs every", unit: "s" },
  { section: "polling", key: "slowAfter", label: "Check less often after no changes for", unit: "s" },
  { section: "polling", key: "slowRun", label: "... and then check every", unit: "s" },
  {
    section: "polling",
    key: "stopAfter",
    label: "Stop checking after no changes for",
    unit: "s",
    help: "Until asked to check again",
  },
  { section: "polling", key: "list", label: "List viewed projects, or ones with runs in progress, every", unit: "s" },
  { section: "polling", key: "browse", label: "List other projects and sources every", unit: "s" },
  { section: "polling", key: "recentRuns", label: "Latest runs kept up to date per synced project", unit: "" },
  { section: "filesystem", key: "concurrency", label: "Operations on the sources at a time", unit: "" },
  {
    section: "filesystem",
    key: "rate",
    label: "Background operations a second, at most",
    unit: "",
    help: "Keeping synced runs nobody has open up to date: one at a time, after the rest (0: no limit)",
  },
  { section: "filesystem", key: "timeout", label: "Give up on an operation after", unit: "s" },
  { section: "filesystem", key: "chunk", label: "Read files in pieces of", unit: "KB" },
  {
    section: "cache",
    key: "size",
    label: "Keep finished runs' files on disk, up to",
    unit: "MB",
    help: "So the share is read once for them; the runs used least recently go first",
  },
  { section: "logs", key: "window", label: "Read logs in pieces of", unit: "KB" },
  { section: "logs", key: "preview", label: "Show long lines up to", unit: "KB", help: "The rest opens in a viewer" },
  { section: "server", key: "port", label: "Port", unit: "", help: "Takes effect when the server restarts" },
]

export default function SettingsPage() {
  const { data, mutate } = useSWR<Saved>("/api/config")
  const cache = useSWR<{ dir: string; bytes: number }>("/api/cache")
  const [clearing, setClearing] = useState(false)
  const clear = async () => {
    setClearing(true)
    await cache
      .mutate(
        fetch("/api/cache", { method: "DELETE" }).then((response) => response.json()),
        { revalidate: false },
      )
      .finally(() => setClearing(false))
  }
  const [draft, setDraft] = useState<Config>()
  const [status, setStatus] = useState<{ error?: string; saved?: boolean }>({})
  useDocumentTitle("Settings · GreenDots")
  if (!data) return <Loader />
  const config = draft ?? data.config
  const change = (update: (config: Config) => void) => {
    const next = structuredClone(config)
    update(next)
    setDraft(next)
    setStatus({})
  }
  const save = async () => {
    const response = await fetch("/api/config", { method: "PUT", body: JSON.stringify(config) })
    const body = await response.json()
    if (!response.ok) return setStatus({ error: body.error })
    await mutate(body, { revalidate: false })
    setDraft(undefined)
    setStatus({ saved: true })
  }
  return (
    <Stack maw={900} mx="auto" gap="lg">
      <Group justify="space-between" align="baseline">
        <Title order={2}>Settings</Title>
        <Text size="sm" c="dimmed">
          Saved in <Code>{data.path}</Code>
        </Text>
      </Group>
      <Fieldset legend="Sources: directories holding <project>/<run>/, e.g. a local one and a network share">
        <Stack gap="xs">
          {config.sources.map((source, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: sources are edited in place
            <Group key={index} gap="xs" wrap="nowrap" align="start">
              <TextInput
                w={160}
                aria-label="Name"
                placeholder="network"
                value={source.name}
                onChange={(event) =>
                  change((c) => {
                    c.sources[index].name = event.currentTarget.value
                  })
                }
              />
              <TextInput
                flex={1}
                aria-label="Path"
                placeholder="/media/greendots"
                value={source.path}
                onChange={(event) =>
                  change((c) => {
                    c.sources[index].path = event.currentTarget.value
                  })
                }
              />
              <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                aria-label="Remove the source"
                onClick={() => change((c) => void c.sources.splice(index, 1))}
              >
                <IconTrash size={18} />
              </ActionIcon>
            </Group>
          ))}
          <Button
            variant="default"
            leftSection={<IconPlus size={16} />}
            w="fit-content"
            onClick={() => change((c) => void c.sources.push({ name: "", path: "" }))}
          >
            Add a source
          </Button>
        </Stack>
      </Fieldset>
      <Fieldset legend="Polling, filesystem, cache and logs">
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {FIELDS.map(({ section, key, label, unit, help }) => (
            <NumberInput
              key={`${section}.${key}`}
              label={label}
              description={help}
              rightSection={
                unit && (
                  <Text size="xs" c="dimmed">
                    {unit}
                  </Text>
                )
              }
              min={0}
              value={(config[section] as Record<string, number>)[key]}
              onChange={(value) =>
                change((c) => {
                  ;(c[section] as Record<string, number>)[key] = Number(value)
                })
              }
            />
          ))}
          <TextInput
            label="Host"
            description="Takes effect when the server restarts; 0.0.0.0 shares it with your network"
            value={config.server.host}
            onChange={(event) =>
              change((c) => {
                c.server.host = event.currentTarget.value
              })
            }
          />
          <TextInput
            label="Cache directory"
            description="Where finished runs are kept; takes effect when the server restarts"
            placeholder="~/.cache/greendots"
            value={config.cache.dir}
            onChange={(event) =>
              change((c) => {
                c.cache.dir = event.currentTarget.value
              })
            }
          />
          <NumberInput
            label="Activity entries kept"
            min={100}
            value={config.activity}
            onChange={(value) =>
              change((c) => {
                c.activity = Number(value)
              })
            }
          />
        </SimpleGrid>
      </Fieldset>
      <Fieldset legend="Cache">
        <Group justify="space-between">
          <Text size="sm">
            Finished runs are kept in <Code>{cache.data?.dir ?? "…"}</Code>
            {cache.data && `, taking ${bytes(cache.data.bytes)}`}, so the share is read once for them.
          </Text>
          <Button variant="light" color="red" loading={clearing} onClick={clear}>
            Clear the cache
          </Button>
        </Group>
      </Fieldset>
      {status.error && (
        <Alert color="red" title="Not saved">
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {status.error}
          </Text>
        </Alert>
      )}
      <Group>
        <Button onClick={save} disabled={!draft}>
          Save
        </Button>
        {draft && (
          <Button variant="default" onClick={() => setDraft(undefined)}>
            Discard changes
          </Button>
        )}
        {status.saved && (
          <Text size="sm" c="dimmed">
            Saved
          </Text>
        )}
      </Group>
    </Stack>
  )
}
