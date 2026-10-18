import "@fontsource-variable/exo-2"
import "@fontsource/jockey-one"
import "@mantine/core/styles.css"
import "./globals.css"
import { ColorSchemeScript, mantineHtmlProps } from "@mantine/core"
import type { Metadata } from "next"
import { Providers } from "@/components/Providers"

// no title here: the views set it, and a streamed one would override theirs
export const metadata: Metadata = { description: "Live pytest matrix viewer" }

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
