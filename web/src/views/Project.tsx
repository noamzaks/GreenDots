"use client"

import { Anchor, Badge, Group, Loader, Stack, Table, Text, Title } from "@mantine/core"
import { useDocumentTitle } from "@mantine/hooks"
import { Link, useLocation } from "wouter"
import { ProjectActions } from "@/components/ProjectActions"
import { describe, RunBar } from "@/components/RunBar"
import { apis, COLORS, pages, useStream } from "@/lib/client"
import { plural } from "@/lib/format"
import { useProgressive } from "@/lib/progressive"
import { useParam } from "@/lib/router"
import { ago, took } from "@/lib/time"
import { useTitle } from "@/lib/titles"
import type { ProjectRuns } from "@/lib/types"

const number = { fontVariantNumeric: "tabular-nums", textAlign: "right" } as const

export default function ProjectPage() {
  const project = useParam("project")
  const [, navigate] = useLocation()
  const { data, error, refreshing } = useStream<ProjectRuns>(apis.project(project))
  useDocumentTitle(`${data?.title ?? project} · GreenDots`)
  useTitle(pages.project(project), data?.title)
  const { count, sentinel } = useProgressive(data?.runs.length ?? 0)
  if (!data) return error ? <Text c="red">{error}</Text> : <Loader />
  return (
    <Stack maw={1400} mx="auto" gap="md">
      <Group gap="sm">
        <Title order={2}>{data.title ?? project}</Title>
        <ProjectActions project={project} synced={data.synced} />
        {(data.loading || refreshing) && <Loader size="xs" />}
      </Group>
      {!data.loading && data.runs.length === 0 && <Text c="dimmed">No runs yet.</Text>}
      <Table highlightOnHover verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Run</Table.Th>
            <Table.Th w="35%">Results</Table.Th>
            <Table.Th style={number} visibleFrom="sm">
              Passed
            </Table.Th>
            <Table.Th style={number} visibleFrom="sm">
              Failed
            </Table.Th>
            <Table.Th style={number} visibleFrom="sm">
              Skipped
            </Table.Th>
            <Table.Th visibleFrom="sm">Started</Table.Th>
            <Table.Th visibleFrom="sm">Took</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.runs.slice(0, count).map(({ source, name, title, mtime, summary, polling }) => {
            const page = pages.run({ project, source, run: name })
            return (
              <Table.Tr key={`${source}/${name}`} style={{ cursor: "pointer" }} onClick={() => navigate(page)}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Anchor
                      component={Link}
                      href={page}
                      onClick={(event: React.MouseEvent) => event.stopPropagation()}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      {title ?? name}
                    </Anchor>
                    <Badge size="xs" variant="default">
                      {source}
                    </Badge>
                  </Group>
                </Table.Td>
                <Table.Td>
                  <RunBar summary={summary} />
                  <Text size="xs" c="dimmed" hiddenFrom="sm" mt={4}>
                    {[summary && describe(summary), ago(summary?.started ?? mtime / 1000)].filter(Boolean).join(" · ")}
                  </Text>
                </Table.Td>
                <Table.Td style={number} c={COLORS.passed} visibleFrom="sm">
                  {summary?.passed.toLocaleString()}
                </Table.Td>
                <Table.Td style={number} c={COLORS.failed} visibleFrom="sm">
                  {[
                    summary?.failed?.toLocaleString(),
                    summary?.collectErrors && plural(summary.collectErrors, "collection error"),
                  ]
                    .filter(Boolean)
                    .join(" + ")}
                </Table.Td>
                <Table.Td style={number} c="yellow.8" visibleFrom="sm">
                  {summary?.skipped ? summary.skipped.toLocaleString() : ""}
                </Table.Td>
                <Table.Td visibleFrom="sm">{ago(summary?.started ?? mtime / 1000)}</Table.Td>
                <Table.Td visibleFrom="sm">
                  {summary?.done
                    ? took(summary.started, summary.ended)
                    : polling === "stopped"
                      ? "no updates"
                      : summary && "running"}
                </Table.Td>
              </Table.Tr>
            )
          })}
        </Table.Tbody>
      </Table>
      {count < data.runs.length && <div ref={sentinel} />}
    </Stack>
  )
}
