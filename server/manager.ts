import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { ServerConfig, ServerStatus, ServerView, SocketEvent } from '../shared.ts'
import { InputError, resolveInside } from './core.ts'

const execFileAsync = promisify(execFile)
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
const MAX_CONSOLE_LINES = 800

interface CrashStats {
  crashCount: number
  lastCrashAt: string | null
  exitCode: number | null
}

export interface StoredData {
  version: 1
  auth?: { salt: string; hash: string }
  servers: ServerConfig[]
  stats: Record<string, CrashStats>
}

interface Runtime {
  status: ServerStatus
  process?: ChildProcessWithoutNullStreams
  startedAt?: number
  cpuPercent: number
  memoryMb: number
  onlinePlayers: number
  console: string[]
  manualStop: boolean
  lastListAt: number
  stopTimer?: NodeJS.Timeout
  restartTimer?: NodeJS.Timeout
}

export class ServerManager {
  private states = new Map<string, Runtime>()
  private metricsTimer: NodeJS.Timeout
  private metricsBusy = false

  constructor(
    private data: StoredData,
    private save: () => Promise<void>,
    private publish: (event: SocketEvent) => void,
  ) {
    for (const server of data.servers) this.state(server.id)
    this.metricsTimer = setInterval(() => void this.updateMetrics(), 2_000)
  }

  list() {
    return this.data.servers.map((server) => this.view(server))
  }

  get(id: string) {
    const server = this.data.servers.find((item) => item.id === id)
    if (!server) throw new InputError('Server not found', 404)
    return server
  }

  getConsole(id: string) {
    this.get(id)
    return this.state(id).console
  }

  async add(config: ServerConfig) {
    if (this.data.servers.some((server) => server.name.toLowerCase() === config.name.toLowerCase())) {
      throw new InputError('A server with this name already exists', 409)
    }
    await this.ensureUniqueTarget(config)
    config.id = randomUUID()
    this.data.servers.push(config)
    this.state(config.id)
    await this.save()
    this.changed()
    return this.view(config)
  }

  async update(id: string, config: ServerConfig) {
    const current = this.get(id)
    if (this.state(id).process) throw new InputError('Stop the server before changing its configuration', 409)
    if (this.data.servers.some((server) => server.id !== id && server.name.toLowerCase() === config.name.toLowerCase())) {
      throw new InputError('A server with this name already exists', 409)
    }
    await this.ensureUniqueTarget(config, id)
    Object.assign(current, config, { id: current.id, createdAt: current.createdAt })
    await this.save()
    this.changed()
    return this.view(current)
  }

  async remove(id: string) {
    const server = this.get(id)
    const state = this.state(id)
    if (state.process) throw new InputError('Stop the server before removing it', 409)
    if (state.restartTimer) clearTimeout(state.restartTimer)
    this.data.servers.splice(this.data.servers.indexOf(server), 1)
    delete this.data.stats[id]
    this.states.delete(id)
    await this.save()
    this.changed()
  }

  async start(id: string) {
    const config = this.get(id)
    const state = this.state(id)
    if (state.process || state.status === 'starting' || state.status === 'running' || state.status === 'stopping') {
      throw new InputError('Server is already running or changing state', 409)
    }
    const target = await this.target(config)
    for (const other of this.data.servers) {
      if (other.id !== id && this.state(other.id).process && await this.target(other) === target) {
        throw new InputError('This server is already running through another configuration', 409)
      }
    }
    if (state.restartTimer) clearTimeout(state.restartTimer)

    const child = spawn(
      config.javaPath,
      [`-Xms${config.minMemoryMb}M`, `-Xmx${config.maxMemoryMb}M`, ...config.javaArgs, '-jar', config.jar, 'nogui'],
      { cwd: config.directory, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    state.process = child
    state.status = 'starting'
    state.startedAt = Date.now()
    state.cpuPercent = 0
    state.memoryMb = 0
    state.onlinePlayers = 0
    state.manualStop = false
    this.log(id, `MineDeck: starting ${config.name} (PID ${child.pid ?? 'pending'})`)
    this.pipe(id, child.stdout)
    this.pipe(id, child.stderr, 'stderr: ')
    child.once('error', (error) => this.log(id, `MineDeck: ${error.message}`))
    child.once('close', (code, signal) => void this.closed(id, child, code, signal))
    this.changed()
    return this.view(config)
  }

  stop(id: string) {
    const config = this.get(id)
    const state = this.state(id)
    if (!state.process) throw new InputError('Server is not running', 409)
    if (state.status === 'stopping') throw new InputError('Server is already stopping', 409)
    state.manualStop = true
    state.status = 'stopping'
    this.log(id, 'MineDeck: requesting a graceful stop')
    state.process.stdin.write('stop\n')
    state.stopTimer = setTimeout(() => {
      this.log(id, 'MineDeck: stop timed out; force-killing the process')
      state.process?.kill('SIGKILL')
    }, config.stopTimeoutSeconds * 1_000)
    this.changed()
  }

  async restart(id: string) {
    const state = this.state(id)
    if (!state.process) return this.start(id)
    const exited = once(state.process, 'close')
    this.stop(id)
    await exited
    return this.start(id)
  }

  kill(id: string) {
    this.get(id)
    const state = this.state(id)
    if (!state.process) throw new InputError('Server is not running', 409)
    state.manualStop = true
    this.log(id, 'MineDeck: force-killing the process')
    if (!state.process.kill('SIGKILL')) throw new InputError('Could not kill the server process', 500)
  }

  command(id: string, command: unknown) {
    this.get(id)
    if (typeof command !== 'string' || !command.trim() || command.length > 1_000 || /[\r\n\0]/.test(command)) {
      throw new InputError('Command must be one non-empty line under 1000 characters')
    }
    const state = this.state(id)
    if (!state.process || (state.status !== 'running' && state.status !== 'starting')) {
      throw new InputError('Server is not running', 409)
    }
    state.process.stdin.write(`${command.trim()}\n`)
    this.log(id, `> ${command.trim()}`)
  }

  async shutdown() {
    clearInterval(this.metricsTimer)
    const waits: Promise<unknown>[] = []
    for (const [id, state] of this.states) {
      if (state.restartTimer) clearTimeout(state.restartTimer)
      if (!state.process) continue
      const exited = once(state.process, 'close')
      try { this.stop(id) } catch { /* already stopping */ }
      waits.push(Promise.race([exited, new Promise((done) => setTimeout(done, 8_000))]).then(() => state.process?.kill('SIGKILL')))
    }
    await Promise.allSettled(waits)
  }

  private state(id: string) {
    let state = this.states.get(id)
    if (!state) {
      state = { status: 'stopped', cpuPercent: 0, memoryMb: 0, onlinePlayers: 0, console: [], manualStop: false, lastListAt: 0 }
      this.states.set(id, state)
    }
    return state
  }

  private async target(config: ServerConfig) {
    return realpath(await resolveInside(config.directory, config.jar))
  }

  private async ensureUniqueTarget(config: ServerConfig, exceptId?: string) {
    const target = await this.target(config)
    for (const other of this.data.servers) {
      if (other.id !== exceptId && await this.target(other) === target) {
        throw new InputError('This server JAR is already managed by another configuration', 409)
      }
    }
  }

  private view(config: ServerConfig): ServerView {
    const state = this.state(config.id)
    const stats = this.data.stats[config.id] ?? { crashCount: 0, lastCrashAt: null, exitCode: null }
    return {
      ...config,
      status: state.status,
      pid: state.process?.pid ?? null,
      uptimeSeconds: state.startedAt && state.process ? Math.floor((Date.now() - state.startedAt) / 1_000) : 0,
      cpuPercent: state.cpuPercent,
      memoryMb: state.memoryMb,
      onlinePlayers: state.onlinePlayers,
      ...stats,
    }
  }

  private pipe(id: string, stream: NodeJS.ReadableStream, prefix = '') {
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const lines = `${pending}${chunk}`.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) if (line) this.log(id, prefix + line)
    })
    stream.on('end', () => { if (pending) this.log(id, prefix + pending) })
  }

  private log(id: string, rawLine: string) {
    const state = this.state(id)
    const line = rawLine.replace(ANSI, '')
    state.console.push(line)
    if (state.console.length > MAX_CONSOLE_LINES) state.console.splice(0, state.console.length - MAX_CONSOLE_LINES)
    const players = line.match(/There are (\d+) of a max/i)
    if (players) state.onlinePlayers = Number(players[1])
    if (state.status === 'starting' && /Done \([\d.]+s\)!|For help, type/i.test(line)) {
      state.status = 'running'
      this.changed()
    }
    this.publish({ type: 'console', serverId: id, line })
  }

  private async closed(id: string, process: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null) {
    const state = this.state(id)
    if (state.process !== process) return
    if (state.stopTimer) clearTimeout(state.stopTimer)
    state.process = undefined
    state.startedAt = undefined
    state.cpuPercent = 0
    state.memoryMb = 0
    state.onlinePlayers = 0
    const manual = state.manualStop
    state.status = manual ? 'stopped' : 'crashed'
    this.log(id, `MineDeck: process exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`)

    const config = this.data.servers.find((server) => server.id === id)
    if (!manual && config) {
      const stats = this.data.stats[id] ?? { crashCount: 0, lastCrashAt: null, exitCode: null }
      stats.crashCount++
      stats.lastCrashAt = new Date().toISOString()
      stats.exitCode = code
      this.data.stats[id] = stats
      await this.save()
      if (config.autoRestart) {
        this.log(id, 'MineDeck: automatic restart in 5 seconds')
        state.restartTimer = setTimeout(() => void this.start(id).catch((error) => this.log(id, `MineDeck: restart failed: ${error.message}`)), 5_000)
      }
    }
    this.changed()
  }

  private async updateMetrics() {
    if (this.metricsBusy) return
    this.metricsBusy = true
    try {
      await Promise.all([...this.states.entries()].map(async ([id, state]) => {
        const pid = state.process?.pid
        if (!pid) return
        if (process.platform !== 'win32') {
          try {
            const { stdout } = await execFileAsync('ps', ['-o', '%cpu=,rss=', '-p', String(pid)])
            const [cpu, rss] = stdout.trim().split(/\s+/)
            state.cpuPercent = Number(cpu) || 0
            state.memoryMb = Math.round((Number(rss) || 0) / 1024)
          } catch { state.cpuPercent = state.memoryMb = 0 }
        }
        if (state.status === 'running' && Date.now() - state.lastListAt > 15_000) {
          state.process?.stdin.write('list\n')
          state.lastListAt = Date.now()
        }
        void id
      }))
      this.changed()
    } finally {
      this.metricsBusy = false
    }
  }

  private changed() {
    this.publish({ type: 'servers', servers: this.list() })
  }
}
