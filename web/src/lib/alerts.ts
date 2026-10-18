"use client"

import { useLocalStorage } from "@mantine/hooks"
import confetti from "canvas-confetti"
import { useEffect, useRef } from "react"
import type { RunRef } from "./client"
import type { Summary } from "./types"

const HAPPY = ["🎉", "🥳", "🚀", "🌈", "🍾", "🟢"]
const SAD = ["💥", "🔥", "😱", "🐛", "🚨", "🔴"]
const pick = (emojis: string[]) => emojis[Math.floor(Math.random() * emojis.length)]

export function useNotificationsSetting() {
  const [enabled, setEnabled] = useLocalStorage({ key: "greendots-notifications", defaultValue: false })
  const toggle = async () => {
    if (!enabled && (await Notification.requestPermission()) !== "granted") return
    setEnabled(!enabled)
  }
  return [enabled && typeof Notification !== "undefined" && Notification.permission === "granted", toggle] as const
}

/** Notifies on the first failure and when the run finishes, and throws confetti when everything passed. */
export function useRunAlerts({ project, source, run }: RunRef, summary: Summary | undefined, notify: boolean) {
  const previous = useRef<Summary>(undefined)
  useEffect(() => {
    const before = previous.current
    previous.current = summary
    if (!before || !summary) return // only for changes seen live, not on page load
    const name = `${run} (${project}, ${source})`
    const counts = `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`
    const send = (title: string, body: string) =>
      notify && new Notification(title, { body, tag: `greendots-${source}-${project}-${run}`, icon: "/icon.svg" })
    if (!before.done && summary.done) {
      if (summary.failed) send(`Tests failed for ${name} ${pick(SAD)}`, counts)
      else {
        send(`Tests passed for ${name} ${pick(HAPPY)}`, counts)
        confetti({ particleCount: 200, spread: 100, origin: { y: 0.4 } })
      }
    } else if (!before.failed && summary.failed) send(`Tests failing for ${name} ${pick(SAD)}`, counts)
  }, [summary, project, source, run, notify])
}
