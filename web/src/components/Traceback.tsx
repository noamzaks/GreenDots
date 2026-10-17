import { Alert, Box, Text } from "@mantine/core"
import { IconAlertTriangle } from "@tabler/icons-react"
import { errorTitle } from "@/lib/client"

/** pytest's `path:line: Error` closing line, if it has one. */
const location = (traceback: string) => /^(\S+:\d+): \w+/.exec(traceback.trim().split("\n").at(-1) ?? "")?.[1]

/** A failure: its headline and location up top, then its traceback, scrolled to the end (where the error is). */
export function Traceback({ title, traceback, onClose }: { title?: string; traceback: string; onClose?: () => void }) {
  const where = location(traceback)
  return (
    <Alert
      color="red"
      icon={<IconAlertTriangle />}
      p="sm"
      withCloseButton={!!onClose}
      onClose={onClose}
      closeButtonLabel="Hide"
      title={title ?? `${errorTitle(traceback)}${where ? ` · ${where}` : ""}`}
    >
      <Box mah={160} style={{ overflow: "auto", display: "flex", flexDirection: "column-reverse" }}>
        <Text size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
          {traceback}
        </Text>
      </Box>
    </Alert>
  )
}
