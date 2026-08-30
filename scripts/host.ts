import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const HOST_STOP_TIMEOUT_MS = 15_000

let host: ChildProcess | undefined
let activeCommand: ChildProcess | undefined
let busy = false
let stopping = false

const status = (message: string) => process.stdout.write(`\nMineDeck host: ${message}\n`)

const runBuild = async () => {
  status('building…')
  const build = spawn(npm, ['run', 'build'], { stdio: 'inherit' })
  activeCommand = build
  const [code] = await once(build, 'exit') as [number | null]
  if (activeCommand === build) activeCommand = undefined
  return code === 0
}

const startHost = () => {
  const next = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
  })
  host = next
  activeCommand = next
  next.once('exit', (code, signal) => {
    if (host !== next) return
    host = undefined
    if (activeCommand === next) activeCommand = undefined
    if (!stopping && !busy) status(`stopped (${signal ?? `exit ${code ?? 'unknown'}`}). Type r and press Enter to start it again.`)
  })
  status('running. Type r and press Enter to rebuild and restart; press Ctrl+C to stop.')
}

const stopHost = async () => {
  const current = host
  if (!current || current.exitCode !== null || current.signalCode !== null) return
  const exited = once(current, 'exit')
  current.kill('SIGTERM')
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((done) => setTimeout(() => done(false), HOST_STOP_TIMEOUT_MS)),
  ])
  if (!graceful && current.exitCode === null && current.signalCode === null) {
    status('graceful shutdown timed out; force-stopping the old host.')
    current.kill('SIGKILL')
    await exited
  }
  if (host === current) host = undefined
}

const restart = async () => {
  if (busy || stopping) return
  busy = true
  try {
    // Build first so a compile error does not take a working host offline.
    if (!await runBuild()) {
      status('build failed; the existing host is still running. Fix the error and try again.')
      return
    }
    status('restarting… managed Minecraft servers will be stopped safely.')
    await stopHost()
    if (!stopping) startHost()
  } finally {
    busy = false
  }
}

const shutdown = async () => {
  if (stopping) return
  stopping = true
  status('stopping…')
  const command = activeCommand
  if (command && command !== host && command.exitCode === null && command.signalCode === null) command.kill('SIGTERM')
  await stopHost()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

if (process.stdin.isTTY) {
  const input = createInterface({ input: process.stdin })
  input.on('line', (line) => {
    if (line.trim().toLowerCase() === 'r') void restart()
  })
}

if (await runBuild()) startHost()
else {
  status('initial build failed. Fix the error, then type r and press Enter to try again.')
}
