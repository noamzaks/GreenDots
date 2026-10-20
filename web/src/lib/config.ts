import * as z from "zod"

const seconds = (value: number) => z.number().positive().default(value)

/** GreenDots' settings: one JSON file, also edited on the settings page. */
export const Config = z.object({
  /** Directories holding `<project>/<run>/`, e.g. a local one and a network share. */
  sources: z
    .array(z.object({ name: z.string().regex(/^[\w-]+$/, "letters, digits, - and _ only"), path: z.string().min(1) }))
    .default([]),
  /** Projects whose latest runs are kept up to date in the background. */
  synced: z.array(z.string()).default([]),
  server: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().default(3000) }).prefault({}),
  polling: z
    .object({
      /** How often a changing run's status files are checked. */
      run: seconds(1),
      /** ... once it hasn't changed for `slowAfter`. */
      slowRun: seconds(60),
      slowAfter: seconds(600),
      /** Runs that haven't changed for this long aren't checked anymore, unless asked to. */
      stopAfter: seconds(3600),
      /** How long listings of viewed projects, or ones with runs in progress, are cached... */
      list: seconds(10),
      /** ... and of other projects and of the sources. */
      browse: seconds(300),
      /** How many of a synced project's latest runs are kept up to date. */
      recentRuns: z.number().int().min(0).default(5),
    })
    .prefault({}),
  filesystem: z
    .object({
      /** Operations on the sources at a time... */
      concurrency: z.number().int().min(1).default(8),
      /** ... and background ones (synced runs nobody has open) a second, at most (0: no limit). */
      rate: z.number().min(0).default(20),
      /** Operations taking longer fail (the share may be unreachable). */
      timeout: seconds(30),
      /** Files are read in pieces of at most this many KB, so a big one can't time out on a slow share. */
      chunk: z.number().int().min(64).default(1024),
    })
    .prefault({}),
  cache: z
    .object({
      /** Where finished runs are kept, so the share is read once for them ("": ~/.cache/greendots; read at startup). */
      dir: z.string().default(""),
      /** At most this many MB: the runs used least recently go first. */
      size: z.number().int().min(16).default(2048),
    })
    .prefault({}),
  logs: z
    .object({
      /** How much of a log is read at a time, in KB. */
      window: z.number().int().min(16).default(256),
      /** How much of a long line is shown inline, in KB. */
      preview: z.number().int().min(1).default(16),
    })
    .prefault({}),
  /** Entries kept on the activity page. */
  activity: z.number().int().min(100).default(5000),
})
export type Config = z.infer<typeof Config>
