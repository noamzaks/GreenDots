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

type Saved = { config: Config; path: string }

/** A numeric setting: `section.key`, with a label, unit and help text. */
type Field = {
  section: "polling" | "filesystem" | "logs" | "server"
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
  { section: "filesystem", key: "timeout", label: "Give up on an operation after", unit: "s" },
  { section: "logs", key: "window", label: "Read logs in pieces of", unit: "KB" },
  { section: "logs", key: "preview", label: "Show long lines up to", unit: "KB", help: "The rest opens in a viewer" },
  { section: "server", key: "port", label: "Port", unit: "", help: "Takes effect when the server restarts" },
]

export default function SettingsPage() {
  const { data, mutate } = useSWR<Saved>("/api/config")
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
      <Fieldset legend="Polling, filesystem and logs">
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
