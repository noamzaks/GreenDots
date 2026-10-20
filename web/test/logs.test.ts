import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, expect, test } from "vitest"
import { nodeFs } from "../src/lib/fs"
import { decodeFragment, LogReader } from "../src/lib/logs"

const [WINDOW, PREVIEW] = [256 * 1024, 16 * 1024]

let path: string
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "greendots-")), "t.log.jsonl")
})

// exactly how Python's json.dumps writes them (both plugins)
const entry = (message: string, name = "app") =>
  `${JSON.stringify({ name, level: "INFO", time: 1.5, message })
    .replace(/","/g, '", "')
    .replace(/":/g, '": ')
    .replace(/,"time/, ', "time')
    .replace(/5,"message/, '5, "message')}\n`

function write(...lines: string[]) {
  const text = lines.join("")
  writeFileSync(path, text)
  return Buffer.byteLength(text)
}

test("entries are formatted like Python's", () => {
  expect(entry("hi")).toBe('{"name": "app", "level": "INFO", "time": 1.5, "message": "hi"}\n')
})

test("reads the tail, then older and newer lines, without losing or repeating any", async () => {
  const messages = Array.from({ length: 20_000 }, (_, i) => `line ${i}`)
  const size = write(...messages.map((m) => entry(m)))
  const reader = new LogReader(nodeFs())
  const tail = await reader.before(path, size)
  expect(tail.end).toBe(size)
  const seen = [...tail.lines.map((l) => l.message)]
  for (let start = tail.start; start > 0; ) {
    const older = await reader.before(path, start)
    seen.unshift(...older.lines.map((l) => l.message))
    start = older.start
  }
  expect(seen).toEqual(messages)
  const forward = await reader.forward(path, 0, size)
  expect(forward.lines[0]).toMatchObject({ offset: 0, name: "app", level: "INFO", time: 1.5, message: "line 0" })
})

test("a line still being written is left for later", async () => {
  const size = write(entry("done"), '{"name": "app", "lev')
  const reader = new LogReader(nodeFs())
  const tail = await reader.before(path, size)
  expect(tail.lines.map((l) => l.message)).toEqual(["done"])
  expect((await reader.forward(path, tail.end, size)).lines).toEqual([])
})

test("once nothing more will be written, a last line without a newline is shown, however long", async () => {
  const reader = new LogReader(nodeFs())
  let size = write(entry("done"), "no newline at the end")
  const tail = await reader.before(path, size)
  const last = await reader.forward(path, tail.end, size, true)
  expect(last).toMatchObject({ end: size, lines: [{ message: "no newline at the end", length: 21 }] })
  size = write(entry("done"), "x".repeat(WINDOW * 2))
  const huge = await reader.forward(path, (await reader.before(path, size)).end, size, true)
  expect(huge).toMatchObject({ end: size, lines: [{ truncated: true, length: WINDOW * 2 }] })
})

test("huge lines are previewed, never skipped, and can be read in full", async () => {
  const huge = `${"é".repeat(1_500_000)}"\\ end` // 3 MB, with characters that need escaping
  const size = write(entry("before"), entry(huge), entry("after"))
  const reader = new LogReader(nodeFs())

  const forward = await reader.forward(path, 0, size)
  const all = [...forward.lines]
  for (let at = forward.end; at < size; ) {
    const next = await reader.forward(path, at, size)
    all.push(...next.lines)
    at = next.end
  }
  expect(all.map((l) => l.truncated ?? false)).toEqual([false, true, false])
  expect(all[1].message.length).toBeLessThanOrEqual(PREVIEW)
  expect(huge.startsWith(all[1].message)).toBe(true)
  expect(all[2].message).toBe("after")

  const tail = await reader.before(path, size)
  expect(tail.lines.at(-1)?.message).toBe("after")
  let start = tail.start
  const older: string[] = []
  while (start > 0) {
    const chunk = await reader.before(path, start)
    older.unshift(...chunk.lines.map((l) => (l.truncated ? "<huge>" : l.message)))
    start = chunk.start
  }
  expect(older).toEqual(["before", "<huge>"])

  let text = ""
  for (let from: number | undefined, done = false; !done; ) {
    const chunk = await reader.message(path, all[1].offset, size, from)
    if (!chunk) throw new Error("no chunk")
    text += chunk.text
    from = chunk.next
    done = chunk.done
  }
  expect(text).toBe(huge)
})

test("lines that aren't JSON are shown as they are", async () => {
  const size = write("plain text\n", `${"x".repeat(WINDOW * 2)}\n`)
  const reader = new LogReader(nodeFs())
  const { lines } = await reader.forward(path, 0, size)
  expect(lines[0]).toMatchObject({ message: "plain text", level: "INFO" })
  const rest = await reader.forward(path, lines[0].length, size)
  expect(rest.lines[0]).toMatchObject({ truncated: true, length: WINDOW * 2 + 1 })
  const chunk = await reader.message(path, rest.lines[0].offset, size)
  expect(chunk?.text.length).toBeGreaterThan(0)
})

test("decodeFragment stops before cut escapes and characters", () => {
  expect(decodeFragment(Buffer.from('ab\\u00e9cd"}'))).toEqual({ text: "abécd", used: 10, closed: true })
  expect(decodeFragment(Buffer.from("ab\\u00"))).toMatchObject({ text: "ab", used: 2, closed: false })
  expect(decodeFragment(Buffer.from("ab\\"))).toMatchObject({ text: "ab", used: 2 })
  expect(decodeFragment(Buffer.from("ab\\\\"))).toMatchObject({ text: "ab\\", used: 4 })
  const cut = Buffer.from("aé").subarray(0, 2)
  expect(decodeFragment(cut)).toMatchObject({ text: "a", used: 1 })
})
