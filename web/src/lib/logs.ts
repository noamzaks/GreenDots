import type { Fs } from "./fs"
import type { LogLine, MessageChunk } from "./types"

const CHUNK = 1024 * 1024 // read size when scanning through huge lines
const HEADER = /^\{"name": ("(?:[^"\\]|\\.)*"), "level": ("(?:[^"\\]|\\.)*"), "time": ([-+\d.eE]+), "message": "/

/**
 * Decodes the start of a JSON string's contents (after its opening quote), stopping before an
 * incomplete escape or UTF-8 sequence at the end of `bytes`, or at the closing quote.
 */
/** How many of `bytes` hold whole UTF-8 characters (the last one may be cut off). */
function wholeCharacters(bytes: Buffer): number {
  let start = bytes.length
  while (start > 0 && bytes.length - start < 4 && (bytes[start - 1] & 0xc0) === 0x80) start--
  if (start === 0) return bytes.length
  const lead = bytes[start - 1]
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return start - 1 + length > bytes.length ? start - 1 : bytes.length
}

export function decodeFragment(bytes: Buffer): { text: string; used: number; closed: boolean } {
  const end = wholeCharacters(bytes)
  const raw = bytes.toString("utf8", 0, end)
  let cut = raw.length
  let closed = false
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\") {
      const length = raw[i + 1] === "u" ? 6 : 2
      if (i + length > raw.length) {
        cut = i // an escape cut off at the end
        break
      }
      i += length - 1
    } else if (raw[i] === '"') {
      cut = i
      closed = true
      break
    }
  }
  const body = raw.slice(0, cut)
  let text: string
  try {
    text = JSON.parse(`"${body}"`)
  } catch {
    text = body // not valid JSON after all: show it as it is
  }
  return { text, used: Buffer.byteLength(body), closed }
}

function parseLine(bytes: Buffer, offset: number, size: number): LogLine {
  const line = { offset, length: bytes.length + 1 }
  if (bytes.length > size) return preview(bytes.subarray(0, size), line.offset, line.length)
  const text = bytes.toString()
  try {
    const entry = JSON.parse(text)
    if (entry && typeof entry === "object") {
      const { name = "", level = "INFO", time = 0, message = "" } = entry
      return { ...line, name: String(name), level: String(level), time: Number(time), message: String(message) }
    }
  } catch {}
  return { ...line, name: "", level: "INFO", time: 0, message: text } // not one of ours: show it raw
}

/** The lines in `bytes`, which hold complete lines (each ending with a newline) starting at `offset`. */
function splitLines(bytes: Buffer, offset: number, size: number): LogLine[] {
  const lines: LogLine[] = []
  for (let cursor = 0, newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, cursor)) {
    lines.push(parseLine(bytes.subarray(cursor, newline), offset + cursor, size))
    cursor = newline + 1
  }
  return lines
}

function preview(head: Buffer, offset: number, length: number): LogLine {
  const match = HEADER.exec(head.toString("latin1"))
  if (!match)
    return { offset, length, name: "", level: "INFO", time: 0, message: decodeFragment(head).text, truncated: true }
  return {
    offset,
    length,
    name: JSON.parse(match[1]),
    level: JSON.parse(match[2]),
    time: Number(match[3]),
    message: decodeFragment(head.subarray(match[0].length)).text,
    truncated: true,
  }
}

/** Reads JSON-lines logs in windows, from any line on, without ever dropping a line. */
export class LogReader {
  private ends = new Map<string, number>() // `${path}\0${line start}` -> line end, for huge lines

  /**
   * @param window how many bytes of a log are read at a time
   * @param preview how many bytes of a line are shown inline; the rest is fetched on demand
   */
  constructor(
    private fs: Fs,
    public window = 256 * 1024,
    public preview = 16 * 1024,
  ) {}

  /** The start of the line holding byte `position` (or `position` itself, after a newline). */
  async lineStart(path: string, position: number): Promise<number> {
    let end = position
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const bytes = await this.fs.read(path, start, end - start)
      const newline = bytes.lastIndexOf(10)
      if (newline >= 0) return start + newline + 1
      end = start
    }
    return 0
  }

  /** The end (after the newline) of the line starting at `start`, if it's complete. */
  async lineEnd(path: string, start: number, size: number): Promise<number | undefined> {
    const key = `${path}\0${start}`
    const known = this.ends.get(key)
    if (known !== undefined) return known
    for (let position = start; position < size; position += CHUNK) {
      const bytes = await this.fs.read(path, position, Math.min(CHUNK, size - position))
      const newline = bytes.indexOf(10)
      if (newline >= 0) {
        this.ends.set(key, position + newline + 1)
        return position + newline + 1
      }
    }
    return undefined
  }

  /**
   * Complete lines from `from` (a line start) on, about `window` bytes of them, but not past `until`. When the log
   * is `final` (nothing more will be written), a last line without a newline is complete too.
   */
  async forward(path: string, from: number, until: number, final = false): Promise<{ lines: LogLine[]; end: number }> {
    const lines: LogLine[] = []
    let position = from
    while (position < until && position - from < this.window) {
      const bytes = await this.fs.read(path, position, Math.min(this.window, until - position))
      const complete = bytes.lastIndexOf(10) + 1
      if (complete > 0) {
        lines.push(...splitLines(bytes.subarray(0, complete), position, this.preview))
        position += complete
        continue
      }
      // no newline in a whole window: a huge line, or one still being written (unless the log is final)
      const end =
        (bytes.length < this.window ? undefined : await this.lineEnd(path, position, until)) ??
        (final ? until : undefined)
      if (end === undefined) break
      const whole = end - position <= bytes.length && bytes.length <= this.preview
      lines.push(
        whole
          ? { ...parseLine(bytes, position, this.preview), length: end - position }
          : preview(bytes.subarray(0, this.preview), position, end - position),
      )
      position = end
    }
    return { lines, end: position }
  }

  /**
   * About `window` bytes of the complete lines before `end` - a line start, or the log's size (where a
   * last line may still be being written). One read, unless lines are longer than the window.
   */
  async before(
    path: string,
    end: number,
    window = this.window,
  ): Promise<{ lines: LogLine[]; start: number; end: number }> {
    const start = Math.max(0, end - Math.min(window, this.window))
    const bytes = await this.fs.read(path, start, end - start)
    const last = bytes.lastIndexOf(10)
    const first = start === 0 ? -1 : bytes.indexOf(10)
    if (last >= 0 && first < last) {
      const lines = splitLines(bytes.subarray(first + 1, last + 1), start + first + 1, this.preview)
      return { lines, start: start + first + 1, end: start + last + 1 }
    }
    // the window is inside a huge line: find where the last complete line before `end` starts and ends
    const lineEnd = last >= 0 ? start + last + 1 : await this.lineStart(path, start)
    if (lineEnd === 0) return { lines: [], start: 0, end: 0 }
    const lineStart = await this.lineStart(path, lineEnd - 1)
    const { lines } = await this.forward(path, lineStart, lineEnd)
    return { lines, start: lineStart, end: lineEnd }
  }

  /** A piece of a (huge) line's message, from byte `from` of the file (default: the message's start). */
  async message(path: string, offset: number, size: number, from?: number): Promise<MessageChunk> {
    const end = (await this.lineEnd(path, offset, size)) ?? size
    const head = await this.fs.read(path, offset, Math.min(4096, end - offset))
    const match = HEADER.exec(head.toString("latin1"))
    const messageStart = offset + (match?.[0].length ?? 0)
    const position = Math.max(from ?? messageStart, messageStart)
    const bytes = await this.fs.read(path, position, Math.min(CHUNK, end - position))
    if (!match) {
      const used = wholeCharacters(bytes) || bytes.length // not JSON: show the raw text
      const next = position + used
      const text = bytes.toString("utf8", 0, used).replace(/\n$/, "")
      return { text, start: offset, next, done: next >= end, total: end - offset }
    }
    const { text, used, closed } = decodeFragment(bytes)
    const next = position + Math.max(used, closed ? 0 : 1)
    return { text, start: messageStart, next, done: closed || next >= end - 1, total: end - messageStart }
  }
}
