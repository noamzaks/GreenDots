import { Group, Progress } from "@mantine/core"
import { IconAlertTriangle } from "@tabler/icons-react"
import { COLORS } from "@/lib/client"
import { STATUSES, type Summary } from "@/lib/types"

export const describe = (summary: Summary) =>
  [
    ...STATUSES.filter((status) => summary[status]).map((status) => `${summary[status].toLocaleString()} ${status}`),
    ...(summary.collectErrors ? [`${summary.collectErrors} failed to collect`] : []),
  ].join(" · ")

export function RunBar({ summary, size = "lg" }: { summary?: Summary; size?: "xs" | "lg" }) {
  const shown = STATUSES.filter((status) => summary?.[status])
  const label = summary ? describe(summary) : "Not loaded"
  return (
    <Group gap={6} wrap="nowrap" miw={size === "lg" ? 120 : 0} flex={1} title={label}>
      {!!summary?.collectErrors && (
        <IconAlertTriangle size={16} color="var(--mantine-color-red-6)" style={{ flexShrink: 0 }} />
      )}
      <Progress.Root size={size} flex={1} aria-label={label} role="img">
        {summary &&
          shown.map((status) => (
            <Progress.Section
              key={status}
              aria-hidden="true"
              role="presentation"
              value={(100 * summary[status]) / (summary.total + summary.collectErrors)}
              color={status === "pending" ? "transparent" : COLORS[status]}
              animated={status === "running"}
            />
          ))}
        {!!summary?.collectErrors && (
          <Progress.Section
            aria-hidden="true"
            role="presentation"
            value={Math.max(5, (100 * summary.collectErrors) / (summary.total + summary.collectErrors))}
            color="red"
            striped
          />
        )}
      </Progress.Root>
    </Group>
  )
}
