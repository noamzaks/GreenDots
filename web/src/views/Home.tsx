"use client"

import { Alert, Anchor, Badge, Card, Group, Loader, SimpleGrid, Stack, Text, TextInput, Title } from "@mantine/core"
import { useDocumentTitle } from "@mantine/hooks"
import { IconSearch } from "@tabler/icons-react"
import { useState } from "react"
import { Link } from "wouter"
import { ProjectActions, usePins } from "@/components/ProjectActions"
import { RunBar } from "@/components/RunBar"
import { pages, useStream } from "@/lib/client"
import { ago } from "@/lib/time"
import type { ProjectInfo, Projects } from "@/lib/types"

function ProjectCard({ project }: { project: ProjectInfo }) {
  return (
    <Card withBorder padding="md">
      <Group justify="space-between" wrap="nowrap" mb={project.runs.length ? "xs" : 0}>
        <Anchor component={Link} href={pages.project(project.name)} fw={700} size="lg" truncate>
          {project.title ?? project.name}
        </Anchor>
        <ProjectActions project={project.name} synced={project.synced} />
      </Group>
      <Stack gap={6}>
        {project.runs.map((run) => (
          <Group key={`${run.source}/${run.name}`} wrap="nowrap" gap="sm">
            <Stack gap={0} flex={1} miw={0}>
              <Group gap={6} wrap="nowrap">
                <Anchor
                  component={Link}
                  href={pages.run({ project: project.name, ...run, run: run.name })}
                  size="sm"
                  truncate
                >
                  {run.title ?? run.name}
                </Anchor>
                <Badge size="xs" variant="default" style={{ flexShrink: 0 }}>
                  {run.source}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed" hiddenFrom="xs">
                {ago(run.summary?.started ?? run.mtime / 1000)}
              </Text>
              {run.summary && <RunBar summary={run.summary} size="xs" />}
            </Stack>
            <Text
              size="xs"
              c="dimmed"
              ta="right"
              miw={70}
              visibleFrom="xs"
              style={{ flexShrink: 0, whiteSpace: "nowrap" }}
            >
              {ago(run.summary?.started ?? run.mtime / 1000)}
            </Text>
          </Group>
        ))}
        {project.runs.length === 0 && (
          <Text size="sm" c="dimmed">
            No runs yet
          </Text>
        )}
      </Stack>
    </Card>
  )
}

export default function Home() {
  const { data, error, refreshing } = useStream<Projects>("/api/projects")
  const [search, setSearch] = useState("")
  const [pins] = usePins()
  useDocumentTitle("GreenDots")
  const projects = (data?.projects ?? [])
    .filter((project) => `${project.name} ${project.title ?? ""}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(b.synced) - Number(a.synced) || a.name.localeCompare(b.name))
  const pinned = projects.filter((project) => pins.includes(project.name))
  const sections = [
    { title: "Pinned", projects: pinned },
    {
      title: pinned.length ? "All projects" : "Projects",
      projects: projects.filter((project) => !pins.includes(project.name)),
    },
  ].filter((section) => section.projects.length)
  return (
    <Stack maw={1400} mx="auto" gap="lg">
      <Group justify="space-between">
        <Title order={2}>Projects</Title>
        <TextInput
          placeholder="Search projects"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          aria-label="Search projects"
        />
      </Group>
      <Text size="sm" c="dimmed" mt={-12}>
        Pin (📌) projects to the top. Sync (↻) keeps the results of their latest runs up to date, even while you're
        away.
      </Text>
      {error && <Text c="red">{error}</Text>}
      {data?.errors.map(({ source, error }) => (
        <Alert key={source} color="red" title={`Can't read the ${source} source`} p="sm">
          {error}
        </Alert>
      ))}
      {(!data || data.loading || refreshing) && <Loader size="sm" />}
      {data && !data.loading && !data.projects.length && (
        <Text c="dimmed">
          No projects yet. Add the directories your tests write to on the{" "}
          <Anchor component={Link} href="/settings">
            settings page
          </Anchor>
          , and run pytest with <code>--greendots=SOURCE/PROJECT/RUN</code>.
        </Text>
      )}
      {sections.map((section) => (
        <Stack key={section.title} gap="xs">
          {pinned.length > 0 && (
            <Text size="sm" fw={600} c="dimmed" tt="uppercase">
              {section.title}
            </Text>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
            {section.projects.map((project) => (
              <ProjectCard key={project.name} project={project} />
            ))}
          </SimpleGrid>
        </Stack>
      ))}
    </Stack>
  )
}
