import { Highlight } from "@mantine/core"
import { ansi } from "@/lib/ansi"

/** Text with its ANSI colors, and `search` highlighted. */
export function Ansi({ text, search = "" }: { text: string; search?: string }) {
  return ansi(text).map(({ text, style }, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one text, in order
    <span key={index} style={style}>
      <Highlight span inherit highlight={search}>
        {text}
      </Highlight>
    </span>
  ))
}
