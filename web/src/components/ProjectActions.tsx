import { ActionIcon, Group, Tooltip } from "@mantine/core"
import { useLocalStorage } from "@mantine/hooks"
import { IconPin, IconPinFilled, IconRefresh } from "@tabler/icons-react"
import { apis } from "@/lib/client"

/** The projects pinned to the top, kept in this browser. */
export function usePins() {
  const [pins, setPins] = useLocalStorage<string[]>({ key: "greendots-pinned", defaultValue: [] })
  const toggle = (project: string) =>
    setPins((pins) => (pins.includes(project) ? pins.filter((pin) => pin !== project) : [...pins, project]))
  return [pins, toggle] as const
}

/** Pin a project to the top, and sync its latest runs in the background (so they're always up to date). */
export function ProjectActions({ project, synced }: { project: string; synced: boolean }) {
  const [pins, togglePin] = usePins()
  const pinned = pins.includes(project)
  return (
    <Group gap={4} wrap="nowrap">
      <Tooltip label={pinned ? "Unpin" : "Pin to the top"}>
        <ActionIcon
          variant={pinned ? "light" : "subtle"}
          color={pinned ? "green" : "gray"}
          aria-label="Pin to the top"
          aria-pressed={pinned}
          onClick={() => togglePin(project)}
        >
          {pinned ? <IconPinFilled size={18} /> : <IconPin size={18} />}
        </ActionIcon>
      </Tooltip>
      <Tooltip
        label={
          synced
            ? "Syncing the latest runs in the background (click to stop)"
            : "Sync the latest runs in the background"
        }
      >
        <ActionIcon
          variant={synced ? "light" : "subtle"}
          color={synced ? "green" : "gray"}
          aria-label="Sync in the background"
          aria-pressed={synced}
          onClick={() => fetch(apis.project(project), { method: "PUT", body: JSON.stringify({ synced: !synced }) })}
        >
          <IconRefresh size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}
