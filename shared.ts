export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

export interface ServerConfig {
  id: string
  name: string
  directory: string
  jar: string
  javaPath: string
  minMemoryMb: number
  maxMemoryMb: number
  javaArgs: string[]
  autoRestart: boolean
  stopTimeoutSeconds: number
  createdAt: string
}

export interface ServerView extends ServerConfig {
  status: ServerStatus
  pid: number | null
  uptimeSeconds: number
  cpuPercent: number
  memoryMb: number
  onlinePlayers: number
  crashCount: number
  lastCrashAt: string | null
  exitCode: number | null
}

export interface FileEntry {
  name: string
  type: 'file' | 'directory' | 'link'
  size: number
  modifiedAt: string
}

export interface PlayerView {
  uuid: string
  username: string
  isOnline: boolean
  isOp: boolean
  isWhitelisted: boolean
  isBanned: boolean
}

export type PlayerAction = 'op' | 'deop' | 'remove-whitelist' | 'kick' | 'ban'

export type SocketEvent =
  | { type: 'servers'; servers: ServerView[] }
  | { type: 'console'; serverId: string; line: string }
