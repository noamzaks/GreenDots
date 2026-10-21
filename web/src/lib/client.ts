"use client"

import type { MantineColor } from "@mantine/core"
import { useEffect, useRef, useState } from "react"
import type { LogChunk, LogLine, LogUpdate, Plan, Polling, RunUpdate, Status, Summary, TestState } from "./types"

export async function fetcher(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? response.statusText)
  return body
}

export type RunRef = { project: string; source: string; run: string }
export type LogTarget = { test: string } | { session: number | string }

const path = (...parts: string[]) => parts.map(encodeURIComponent).join("/")
const target = (log: LogTarget) => ("test" in log ? `test=${encodeURIComponent(log.test)}` : `session=${log.session}`)

/** The app's pages. */
export const pages = {
  project: (project: string) => `/project/${path(project)}`,
  run: ({ project, source, run }: RunRef) => `/project/${path(project)}/run/${path(source, run)}`,
  log: (ref: RunRef, log: LogTarget) => `${pages.run(ref)}/log?${target(log)}`,
}

/** The server's API. */
export const apis = {
  project: (project: string) => `/api/projects/${path(project)}`,
  run: ({ project, source, run }: RunRef) => `/api/projects/${path(project)}/runs/${path(source, run)}`,
  log: (ref: RunRef, log: LogTarget, rest = "") => `${apis.run(ref)}/log${rest}?${target(log)}`,
}

export const COLORS: Record<Status, MantineColor> = {
  passed: "green",
  failed: "red",
  skipped: "yellow",
  running: "blue",
  pending: "gray",
}

/** The headline of a pytest failure: its first `E ...` line, or else its last line. */
export function errorTitle(exception: string) {
  const lines = exception.split("\n").filter((line) => line.trim())
  return (lines.find((line) => line.startsWith("E ")) ?? lines.at(-1) ?? "").replace(/^E\s+/, "").trim()
}

/** A short, stable id for a string (FNV-1a). */
export function hash(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/**
 * Follows a server-sent event stream until the returned function is called. Browsers retry dropped streams by
 * themselves, but may give up for good: Firefox does when the network changes (e.g. a VM's interface comes or
 * goes). Those are reopened, waiting longer while they keep failing; the server then sends everything again.
 */
export function follow(url: string, onMessage: (data: unknown) => void, onError: (error?: string) => void = () => {}) {
  let source: EventSource | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let delay = 1000
  const open = () => {
    source = new EventSource(url)
    source.onmessage = (event) => {
      delay = 1000
      const data = JSON.parse(event.data)
      onError(data?.error)
      if (!data?.error) onMessage(data)
    }
    source.onerror = () => {
      onError("Disconnected, reconnecting…")
      if (source?.readyState !== EventSource.CLOSED) return
      retry = setTimeout(open, delay)
      delay = Math.min(delay * 2, 30_000)
    }
  }
  open()
  return () => {
    clearTimeout(retry)
    source?.close()
  }
}

/** What each stream last showed (the latest few), so a page opened again shows it while it's refreshed. */
const remembered = new Map<string, unknown>()
function remember<T>(key: string, value: T) {
  remembered.delete(key)
  remembered.set(key, value)
  for (const old of remembered.keys()) if (remembered.size > 10) remembered.delete(old)
  return value
}

/**
 * Follows a server-sent event stream. It's closed while the tab is hidden (so nobody's tab keeps the server
 * reading the share), unless `background` is set; on reconnecting, the server sends everything again. `fresh`:
 * a message came since it was (re)opened.
 */
export function useEventStream<T>(url: string | null, onMessage: (data: T) => void, background = false) {
  const handler = useRef(onMessage)
  useEffect(() => {
    handler.current = onMessage
  })
  const [error, setError] = useState<string>()
  const [fresh, setFresh] = useState(false)
  useEffect(() => {
    if (!url) return
    let close: (() => void) | undefined
    const visibility = () => {
      if (document.hidden && !background) {
        close?.()
        close = undefined
        setFresh(false)
      } else
        close ??= follow(
          url,
          (data) => {
            setFresh(true)
            handler.current(data as T)
          },
          (error) => {
            setError(error)
            if (error) setFresh(false)
          },
        )
    }
    visibility()
    document.addEventListener("visibilitychange", visibility)
    return () => {
      close?.()
      setFresh(false)
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [url, background])
  return { error, refreshing: !fresh }
}

/** The latest message of a stream (or, until one comes, the one it showed last time). */
export function useStream<T>(url: string | null) {
  const [latest, setLatest] = useState<{ url: string | null; data: T }>()
  const data = latest?.url === url ? latest.data : url ? (remembered.get(url) as T | undefined) : undefined
  const stream = useEventStream<T>(url, (data) => setLatest({ url, data: url ? remember(url, data) : data }))
  return { data, ...stream }
}

export type RunData = {
  version: number
  title?: string
  plan?: Plan
  summary?: Summary
  polling?: Polling
  tests: Map<string, TestState>
  waiting?: boolean
}

/** A run, kept up to date by its stream. */
export function useRun(ref: RunRef, background = false) {
  const url = apis.run(ref)
  const [data, setData] = useState(() => (remembered.get(url) as RunData) ?? { version: 0, tests: new Map() })
  const stream = useEventStream<RunUpdate | { waiting: true }>(
    url,
    (update) =>
      setData((data) => {
        if ("waiting" in update) return { ...data, waiting: true }
        const tests = new Map(update.full ? [] : data.tests)
        for (const [id, test] of Object.entries(update.tests)) tests.set(id, test)
        const { title, summary, polling, version } = update
        const plan = update.plan ? { ...update.plan } : data.plan
        return remember(url, { version, title, summary, polling, plan, tests })
      }),
    background,
  )
  return { ...data, ...stream }
}

type Log = { lines: LogLine[]; start: number; tailStart: number; size: number; test?: TestState; loaded: boolean }

/** A log, kept up to date by its stream (which starts at its end); older lines load on demand. */
export function useLog(ref: RunRef, log: LogTarget) {
  const url = apis.log(ref, log)
  const [state, setState] = useState<Log>(
    () => (remembered.get(url) as Log) ?? { lines: [], start: 0, tailStart: 0, size: 0, loaded: false },
  )
  const start = useRef<number | undefined>(state.loaded ? state.start : undefined)
  const loading = useRef(false)
  const stream = useEventStream<LogUpdate>(url, (update) => {
    if (update.full) start.current = update.start
    setState((state) =>
      remember(url, {
        lines: update.full ? update.lines : [...state.lines, ...update.lines],
        start: update.full ? update.start : state.start,
        tailStart: update.full ? update.start : state.tailStart,
        size: update.size,
        test: update.test,
        loaded: true,
      }),
    )
  })
  const loadOlder = async () => {
    if (!start.current || loading.current) return
    loading.current = true
    try {
      const chunk: LogChunk = await fetcher(`${apis.log(ref, log, "/lines")}&before=${start.current}`)
      start.current = chunk.start
      setState((state) => remember(url, { ...state, lines: [...chunk.lines, ...state.lines], start: chunk.start }))
    } finally {
      loading.current = false
    }
  }
  const loadAll = async () => {
    while (start.current) await loadOlder()
  }
  return { ...state, ...stream, loadOlder, loadAll }
}
