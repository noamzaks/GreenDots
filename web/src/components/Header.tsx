"use client"

import {
  ActionIcon,
  Anchor,
  AppShell,
  Box,
  Breadcrumbs,
  Group,
  Text,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core"
import { useMediaQuery } from "@mantine/hooks"
import { IconActivity, IconMoon, IconSettings, IconSun } from "@tabler/icons-react"
import { Link, useLocation, useSearchParams } from "wouter"
import { pages } from "@/lib/client"
import { useTitles } from "@/lib/titles"

const decode = (part = "") => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/** Where the current page is, as [label, link] crumbs; the last one is the page itself. */
function useCrumbs(): [string, string?][] {
  const [location] = useLocation()
  const [search] = useSearchParams()
  const titles = useTitles()
  const [kind, project, , source, run, log] = location.split("/").filter(Boolean).map(decode)
  if (kind === "activity") return [["Activity"]]
  if (kind === "settings") return [["Settings"]]
  if (kind !== "project") return []
  const crumbs: [string, string?][] = [[titles.get(pages.project(project)) ?? project, pages.project(project)]]
  if (run) {
    const page = pages.run({ project, source, run })
    crumbs.push([titles.get(page) ?? run, page])
  }
  const [test, session] = [search.get("test"), search.get("session")]
  if (log) crumbs.push([session !== null ? `session log ${session}` : (test?.split("::").at(-1) ?? "log")])
  else crumbs[crumbs.length - 1] = [crumbs[crumbs.length - 1][0]]
  return crumbs
}

export function Header() {
  const [location] = useLocation()
  const { toggleColorScheme } = useMantineColorScheme()
  const mobile = useMediaQuery("(max-width: 48em)")
  const crumbs = useCrumbs()
  // on small screens, only the page and a link back to its parent fit
  const shown = mobile ? crumbs.slice(-2) : crumbs
  const icon = (href: string, label: string, Icon: typeof IconActivity) => (
    <Tooltip label={label}>
      <ActionIcon
        component={Link}
        href={href}
        variant={location === href ? "light" : "subtle"}
        color={location === href ? "green" : "gray"}
        aria-label={label}
      >
        <Icon />
      </ActionIcon>
    </Tooltip>
  )
  return (
    <AppShell.Header px="md">
      <Group h="100%" justify="space-between" wrap="nowrap">
        <Breadcrumbs style={{ minWidth: 0, flexWrap: "nowrap" }} separatorMargin={6}>
          <Anchor component={Link} href="/" ff="'Jockey One', sans-serif" size="xl" c="green" underline="never">
            {/* centered on the capitals, which centering in the line box only does in some browsers */}
            <Box
              component="span"
              display="inline-block"
              w={12}
              h={12}
              mr={6}
              bg="green"
              style={{ borderRadius: "50%", verticalAlign: "calc((1cap - 12px) / 2)" }}
            />
            GreenDots
          </Anchor>
          {shown.map(([label, href]) =>
            href ? (
              <Anchor key={href} component={Link} href={href} truncate maw={{ base: 120, sm: 240 }}>
                {label}
              </Anchor>
            ) : (
              <Text key={label} truncate maw={{ base: 140, sm: 400 }} title={label}>
                {label}
              </Text>
            ),
          )}
        </Breadcrumbs>
        <Group gap={4} wrap="nowrap">
          {icon("/activity", "Activity: filesystem operations, syncs and requests", IconActivity)}
          {icon("/settings", "Settings", IconSettings)}
          <Tooltip label="Toggle light / dark">
            <ActionIcon variant="subtle" color="gray" onClick={toggleColorScheme} aria-label="Toggle color scheme">
              <IconSun className="mantine-light-hidden" />
              <IconMoon className="mantine-dark-hidden" />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
    </AppShell.Header>
  )
}
