import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Config } from "./config"

/** The config file: `$GREENDOTS_CONFIG`, or `greendots/config.json` in the XDG config directory. */
export const configPath = () =>
  process.env.GREENDOTS_CONFIG ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "greendots", "config.json")

export function loadConfig(path = configPath()): Config {
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Can't read ${path}:`, error)
  }
  const parsed = Config.safeParse(raw)
  if (!parsed.success) console.error(`Invalid ${path}, using defaults:`, parsed.error.message)
  return parsed.success ? parsed.data : Config.parse({})
}

export function saveConfig(config: Config, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}
