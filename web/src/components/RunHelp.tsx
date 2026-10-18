import { Code, Group, Kbd, List, Modal, Stack, Text, UnstyledButton } from "@mantine/core"
import { mod } from "@/lib/platform"
import type { PlanTest } from "@/lib/types"

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

/** Example `-k` expressions made of the run's own names, e.g. `test_run and not ssh`. */
function examples(tests: PlanTest[]) {
  const functions = [...new Set(tests.map((test) => test.id.split("::").at(-1)?.split("[")[0] ?? ""))].filter(Boolean)
  const ids = tests.map((test) => /\[(.+)\]$/.exec(test.id)?.[1]).filter((id): id is string => !!id)
  const values = [...new Set(ids.flatMap((id) => id.split("-")))].filter((value) => /^[\w.]+$/.test(value))
  const [a, b] = functions
  const [x] = values
  return [
    a,
    x && `${a} and not ${x}`,
    b && `${a} or ${b}`,
    b && x && `(${a} or ${b}) and ${x}`,
    `not ${tests[0]?.id.split("::")[0].split("/").at(-1) ?? "slow"}`,
  ].filter((example): example is string => !!example)
}

export function FilterHelp({ tests, onPick }: { tests: PlanTest[]; onPick: (query: string) => void }) {
  return (
    <Stack gap="xs" maw={380}>
      <Text size="sm">
        Filter like{" "}
        <a
          href="https://docs.pytest.org/en/stable/how-to/usage.html#specifying-which-tests-to-run"
          target="_blank"
          rel="noreferrer"
        >
          pytest -k
        </a>
        : a word matches tests with it in their file, class or name (with params, e.g. <Code>x86</Code>), markers or
        keywords, ignoring case. Combine words with <Code>and</Code>, <Code>or</Code>, <Code>not</Code> and parentheses.
      </Text>
      <Text size="sm">Click a status count or Alt-click a dot to show only tests with that status.</Text>
      <Text size="sm" fw={600}>
        Examples
      </Text>
      <List size="sm" spacing={2}>
        {examples(tests).map((example) => (
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
