import {
  Alert,
  Badge,
  Box,
  ColorSwatch,
  Drawer,
  Group,
  Spoiler,
  Stack,
  Switch,
  Text,
  UnstyledButton,
} from "@mantine/core"
import { useLocalStorage } from "@mantine/hooks"
import { IconAlertTriangle } from "@tabler/icons-react"
import { plural } from "@/lib/format"

export type ErrorGroup = [id: string, { title: string; example: string; count: number }]

type Props = {
  opened: boolean
  onClose: () => void
  errors: ErrorGroup[]
  colors: Map<string, string>
  collectErrors: number
  active?: string
  highlight?: string
  onHighlight: (id?: string) => void
  onPick: (id: string) => void
  onShowCollectErrors: () => void
}

/** Failures grouped by their message; hovering one highlights its tests, clicking one filters to them. */
export function ErrorsDrawer(props: Props) {
  const {
    opened,
    onClose,
    errors,
    colors,
    collectErrors,
    active,
    highlight,
    onHighlight,
    onPick,
    onShowCollectErrors,
  } = props
  const [fullExamples, setFullExamples] = useLocalStorage({ key: "greendots-full-examples", defaultValue: false })
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      title={<Text fw={600}>Errors by message</Text>}
      withOverlay={false}
      lockScroll={false}
      trapFocus={false}
      closeOnClickOutside={false}
      size={440}
      closeButtonProps={{ "aria-label": "Close errors" }}
    >
      <Stack gap="xs" onMouseLeave={() => onHighlight(undefined)}>
        <Switch
          size="xs"
          label="Show full examples"
          checked={fullExamples}
          onChange={(event) => setFullExamples(event.currentTarget.checked)}
        />
        {collectErrors > 0 && (
          <UnstyledButton onClick={onShowCollectErrors}>
            <Alert color="red" variant="light" p="xs" icon={<IconAlertTriangle size={16} />}>
              <Text size="sm">{plural(collectErrors, "file")} failed to collect - show</Text>
            </Alert>
          </UnstyledButton>
        )}
        {errors.length === 0 && <Text c="dimmed">No failures.</Text>}
        {errors.map(([id, { title, example, count }]) => (
          <Box
            key={id}
            p="xs"
            style={{
              border: `1px solid ${active === id ? "var(--mantine-color-red-5)" : "var(--mantine-color-default-border)"}`,
              borderRadius: "var(--mantine-radius-md)",
              background: highlight === id ? "var(--mantine-color-default-hover)" : undefined,
            }}
            onMouseEnter={() => onHighlight(id)}
          >
            <UnstyledButton
              w="100%"
              aria-label={`Show the ${plural(count, "test")} failing with: ${title}`}
              onClick={() => onPick(id)}
            >
              <Group wrap="nowrap" align="start" gap="xs">
                <ColorSwatch color={colors.get(id) ?? "red"} size={14} mt={3} style={{ flexShrink: 0 }} />
                <Badge color="gray" variant="outline" style={{ flexShrink: 0 }}>
                  {count.toLocaleString()}
                </Badge>
                <Text size="sm" ff="monospace" style={{ wordBreak: "break-word" }}>
                  {title}
                </Text>
              </Group>
            </UnstyledButton>
            {fullExamples ? (
              <Text size="xs" ff="monospace" mt={4} style={{ whiteSpace: "pre-wrap" }}>
                {example}
              </Text>
            ) : (
              <Spoiler maxHeight={0} showLabel="Show an example" hideLabel="Hide" mt={4}>
                <Text size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
                  {example}
                </Text>
              </Spoiler>
            )}
          </Box>
        ))}
      </Stack>
    </Drawer>
  )
}
