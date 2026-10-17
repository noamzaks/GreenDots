import { ActionIcon, Group, Text, Tooltip } from "@mantine/core"
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react"
import useSWR from "swr"
import { useLocation } from "wouter"
import { apis, pages, type RunRef } from "@/lib/client"

/** Moves to the previous or next failed test of the run. */
export function FailureNavigation({ run, test }: { run: RunRef; test: string }) {
  const { data: failed = [] } = useSWR<string[]>(`${apis.run(run)}/failed`)
  const [, navigate] = useLocation()
  const index = failed.indexOf(test)
  const go = (id?: string) => id && navigate(pages.log(run, { test: id }))
  if (!failed.length || (failed.length === 1 && index === 0)) return null
  return (
    <Group gap={2} wrap="nowrap">
      <Tooltip label="Previous failed test">
        <ActionIcon
          variant="subtle"
          color="gray"
          disabled={index <= 0 && index !== -1}
          onClick={() => go(failed[index === -1 ? 0 : index - 1])}
          aria-label="Previous failed test"
        >
          <IconChevronLeft size={18} />
        </ActionIcon>
      </Tooltip>
      <Text size="xs" c="dimmed" visibleFrom="sm" style={{ whiteSpace: "nowrap" }}>
        {index === -1 ? `${failed.length} failed` : `${index + 1}/${failed.length} failed`}
      </Text>
      <Tooltip label="Next failed test">
        <ActionIcon
          variant="subtle"
          color="gray"
          disabled={index === failed.length - 1}
          onClick={() => go(failed[index + 1])}
          aria-label="Next failed test"
        >
          <IconChevronRight size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}
