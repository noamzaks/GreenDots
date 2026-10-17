"use client"

import { useEffect, useSyncExternalStore } from "react"

/** Display names of projects and runs (from their metadata.toml), for the breadcrumbs. */
const titles = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

export function useTitle(path: string, title?: string) {
  useEffect(() => {
    if (!title || titles.get(path) === title) return
    titles.set(path, title)
    version++
    for (const listener of listeners) listener()
  }, [path, title])
}

export function useTitles() {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version,
    () => version,
  )
  return titles
}
