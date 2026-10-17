import { ActionIcon, Group, Tooltip } from "@mantine/core"
import { IconPin, IconPinFilled, IconRefresh } from "@tabler/icons-react"
import { apis } from "@/lib/client"

const set = (project: string, change: { synced?: boolean; pinned?: boolean }) =>
  fetch(apis.project(project), { method: "PUT", body: JSON.stringify(change) })

/** Pin a project to the top, and sync its latest runs in the background (so they're always up to date). */
export function ProjectActions({ project, synced, pinned }: { project: string; synced: boolean; pinned: boolean }) {
  return (
    <Group gap={4} wrap="nowrap">
      <Tooltip label={pinned ? "Unpin" : "Pin to the top"}>
        <ActionIcon
          variant={pinned ? "light" : "subtle"}
          color={pinned ? "green" : "gray"}
          aria-label="Pin to the top"
          aria-pressed={pinned}
          onClick={() => set(project, { pinned: !pinned })}
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
          onClick={() => set(project, { synced: !synced })}
        >
          <IconRefresh size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}
