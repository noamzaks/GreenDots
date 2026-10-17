#!/usr/bin/env node
// Starts the GreenDots server on the host and port from its config file (see src/lib/settings.ts).
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const app = join(dirname(fileURLToPath(import.meta.url)), "..")
const path =
  process.env.GREENDOTS_CONFIG ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "greendots", "config.json")
let server = {}
try {
  server = JSON.parse(readFileSync(path, "utf8")).server ?? {}
} catch {}
const next = createRequire(join(app, "package.json")).resolve("next/dist/bin/next")
const args = ["start", "-H", server.host ?? "127.0.0.1", "-p", String(server.port ?? 3000)]
// filesystem calls run on libuv's thread pool: a slow share must not take all of its (default 4) threads
const env = { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? "64" }
spawn(process.execPath, [next, ...args], { cwd: app, env, stdio: "inherit" }).on("exit", (code) =>
  process.exit(code ?? 0),
)
