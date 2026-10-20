import type { CSSProperties } from "react"

/** Escape sequences: SGR (`ESC[...m`, which styles text) and the rest (cursor moves, titles...), which are dropped. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escapes are what it's looking for
const ESCAPE = /\x1b\[([\d;:]*)([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]]/g

// the 16 terminal colors, as Mantine colors so they suit both color schemes
const BASIC = ["dark-4", "red-6", "green-6", "yellow-6", "blue-6", "grape-6", "cyan-6", "gray-5"]
const BRIGHT = ["dark-2", "red-4", "green-4", "yellow-4", "blue-4", "grape-4", "cyan-4", "gray-3"]
const basic = (index: number) => `var(--mantine-color-${(index < 8 ? BASIC : BRIGHT)[index % 8]})`

/** One of the 256 colors: the 16 basic ones, a 6×6×6 cube, then 24 grays. */
function color256(n: number) {
  if (n < 16) return basic(n)
  if (n >= 232) return `rgb(${Array(3).fill(8 + (n - 232) * 10)})`
  const level = (value: number) => (value ? 55 + value * 40 : 0)
  return `rgb(${level(Math.floor((n - 16) / 36))}, ${level(Math.floor((n - 16) / 6) % 6)}, ${level((n - 16) % 6)})`
}

type State = { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }

function apply(state: State, params: string): State {
  const codes = params ? params.split(/[;:]/).map(Number) : [0]
  const next = { ...state }
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    // 38 and 48 take a color: 5;n (256 colors) or 2;r;g;b
    const extended = () => {
      const color =
        codes[i + 1] === 5 ? color256(codes[i + 2]) : `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`
      i += codes[i + 1] === 5 ? 2 : 4
      return color
    }
    if (code === 0) for (const key of Object.keys(next)) delete next[key as keyof State]
    else if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 22) next.bold = next.dim = false
    else if (code === 23) next.italic = false
    else if (code === 24) next.underline = false
    else if (code >= 30 && code <= 37) next.fg = basic(code - 30)
    else if (code >= 90 && code <= 97) next.fg = basic(code - 82)
    else if (code >= 40 && code <= 47) next.bg = basic(code - 40)
    else if (code >= 100 && code <= 107) next.bg = basic(code - 92)
    else if (code === 38) next.fg = extended()
    else if (code === 48) next.bg = extended()
    else if (code === 39) next.fg = undefined
    else if (code === 49) next.bg = undefined
  }
  return next
}

const css = ({ fg, bg, bold, dim, italic, underline }: State): CSSProperties | undefined =>
  fg || bg || bold || dim || italic || underline
    ? {
        color: fg,
        backgroundColor: bg,
        fontWeight: bold ? 700 : undefined,
        opacity: dim ? 0.7 : undefined,
        fontStyle: italic ? "italic" : undefined,
        textDecoration: underline ? "underline" : undefined,
      }
    : undefined

/** Text with ANSI escapes (e.g. a colored terminal's output), as pieces styled the way a terminal would show them. */
export function ansi(text: string): { text: string; style?: CSSProperties }[] {
  if (!text.includes("\x1b")) return [{ text }]
  const pieces: { text: string; style?: CSSProperties }[] = []
  let state: State = {}
  let last = 0
  for (const match of text.matchAll(ESCAPE)) {
    if (match.index > last) pieces.push({ text: text.slice(last, match.index), style: css(state) })
    last = match.index + match[0].length
    if (match[2] === "m") state = apply(state, match[1])
  }
  if (last < text.length) pieces.push({ text: text.slice(last), style: css(state) })
  return pieces
}

/** The text without its escapes, e.g. to search it. */
export const plain = (text: string) => (text.includes("\x1b") ? text.replace(ESCAPE, "") : text)
