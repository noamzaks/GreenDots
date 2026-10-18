"use client"

import { Anchor, createTheme, MantineProvider } from "@mantine/core"
import { SWRConfig } from "swr"
import { fetcher } from "@/lib/client"

const theme = createTheme({
  primaryColor: "green",
  primaryShade: { light: 8, dark: 6 },
  defaultRadius: "md",
  // the original GreenDots' fonts
  fontFamily: "'Exo 2 Variable', sans-serif",
  headings: { fontFamily: "'Exo 2 Variable', sans-serif" },
  // links are neutral, so green keeps meaning "passed"
  components: { Anchor: Anchor.extend({ defaultProps: { c: "bright", underline: "hover" } }) },
})

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <SWRConfig value={{ fetcher: (url: string) => fetcher(url), revalidateOnFocus: false }}>{children}</SWRConfig>
    </MantineProvider>
  )
}
