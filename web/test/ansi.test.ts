import { expect, test } from "vitest"
import { ansi, plain } from "../src/lib/ansi"

test("styles text the way a terminal shows it, and drops other escapes", () => {
  expect(ansi("plain")).toEqual([{ text: "plain" }])
  const pieces = ansi("\x1b[1;31mFAILED\x1b[0m ok \x1b[38;5;196mred\x1b[39m \x1b[38;2;1;2;3mrgb\x1b[K\x1b]0;title\x07!")
  expect(pieces).toEqual([
    { text: "FAILED", style: expect.objectContaining({ color: "var(--mantine-color-red-6)", fontWeight: 700 }) },
    { text: " ok " },
    { text: "red", style: expect.objectContaining({ color: "rgb(255, 0, 0)" }) },
    { text: " " },
    { text: "rgb", style: expect.objectContaining({ color: "rgb(1, 2, 3)" }) },
    { text: "!", style: expect.objectContaining({ color: "rgb(1, 2, 3)" }) },
  ])
  expect(plain("\x1b[32mpassed\x1b[0m in 1s")).toBe("passed in 1s")
})
