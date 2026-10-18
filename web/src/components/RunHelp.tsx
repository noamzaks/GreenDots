import { Code, Group, Kbd, List, Modal, Stack, Text, UnstyledButton } from "@mantine/core"
import { mod } from "@/lib/platform"

export function Shortcuts({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const rows: [string, React.ReactNode][] = [
    ["Filter tests", <Kbd key="k">{mod()} K</Kbd>],
    ["Show errors, grouped by message", <Kbd key="e">{mod()} E</Kbd>],
    ["Focus the matrix", <Kbd key="g">G</Kbd>],
    ["Move between tests", <Kbd key="a">← ↑ → ↓</Kbd>],
    ["Open the test's log", <Kbd key="r">Enter</Kbd>],
    ["Open the log / in a new tab", `Click / ${mod()}-click`],
    ["Show only tests with that status", "Alt-click"],
    ["This help", <Kbd key="q">?</Kbd>],
  ]
  return (
    <Modal opened={opened} onClose={onClose} title="Keyboard and mouse">
      <Stack gap="xs">
        {rows.map(([action, keys]) => (
          <Group key={action} justify="space-between">
            <Text size="sm">{action}</Text>
            {typeof keys === "string" ? (
              <Text size="sm" c="dimmed">
                {keys}
              </Text>
            ) : (
              keys
            )}
          </Group>
        ))}
      </Stack>
    </Modal>
  )
}

export function FilterHelp({ params, onPick }: { params: string[]; onPick: (query: string) => void }) {
  const examples = [
    "status:failed",
    "status:failed AND module:network",
    "name:/compile|link/",
    "-status:passed",
    ...params.slice(0, 1).map((param) => `${param}:x86`),
  ]
  return (
    <Stack gap="xs" maw={380}>
      <Text size="sm">
        Filter with{" "}
        <a href="https://github.com/gajus/liqe#query-syntax" target="_blank" rel="noreferrer">
          Liqe
        </a>{" "}
        queries: <Code>field:value</Code>, <Code>field:/regex/</Code>, <Code>AND</Code>, <Code>OR</Code>, and{" "}
        <Code>-</Code> to exclude.
      </Text>
      <Text size="sm">
        Fields: <Code>status</Code> <Code>name</Code> <Code>module</Code> <Code>id</Code> <Code>message</Code>{" "}
        <Code>error</Code> <Code>reason</Code> <Code>keywords</Code>
        {params.map((param) => (
          <Code key={param} ml={4}>
            {param}
          </Code>
        ))}
      </Text>
      <Text size="sm" fw={600}>
        Examples
      </Text>
      <List size="sm" spacing={2}>
        {examples.map((example) => (
          <List.Item key={example}>
            <UnstyledButton onClick={() => onPick(example)}>
              <Code>{example}</Code>
            </UnstyledButton>
          </List.Item>
        ))}
      </List>
    </Stack>
  )
}
