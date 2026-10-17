import { Signal } from "./signal"

export type ActivityKind = "list" | "stat" | "read" | "sync" | "api"
export type Activity = {
  seq: number
  time: number
  kind: ActivityKind
  path: string
  detail?: string
  bytes?: number
  ms?: number
  error?: string
}

/** The last `capacity` filesystem operations, syncs and API requests, oldest dropped first. */
export class ActivityLog {
  readonly changed = new Signal()
  private entries: Activity[] = []
  seq = 0

  constructor(public capacity = 5000) {}

  add(entry: Omit<Activity, "seq" | "time">) {
    this.entries.push({ ...entry, seq: ++this.seq, time: Date.now() })
    // drop the oldest in batches, so adding stays cheap
    if (this.entries.length > this.capacity * 1.1) this.entries = this.entries.slice(-this.capacity)
    this.changed.notify()
  }

  /** The latest `capacity` entries newer than `seq`, oldest first. */
  since(seq: number): Activity[] {
    const latest = this.entries.slice(-this.capacity)
    const first = latest.findIndex((entry) => entry.seq > seq)
    return first === -1 ? [] : latest.slice(first)
  }
}
