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
  eulaRequired?: boolean
  pluginsInstalling?: boolean
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

export interface PaperBuild {
  id: number
  time: string
  name: string
  size: number
  sha256: string
  url: string
}

export type PlayerAction = 'op' | 'deop' | 'remove-whitelist' | 'kick' | 'ban'

export interface ConsoleLine {
  sequence: number
  line: string
}

export type SocketEvent =
  | { type: 'servers'; servers: ServerView[] }
  | { type: 'console'; serverId: string; line: string; sequence: number; epoch: string }

export const pluginLoaders = ['paper', 'spigot', 'bukkit', 'purpur', 'folia', 'velocity', 'bungeecord', 'waterfall'] as const
export type PluginLoader = typeof pluginLoaders[number]
export interface PluginTarget { loader: PluginLoader; gameVersion: string }
export interface ModrinthProject { id: string; slug: string; title: string; description: string; author: string; downloads: number; iconUrl: string | null }
export interface ModrinthVersion { id: string; projectId: string; name: string; number: string; published: string }
export interface PluginInstallItem extends ModrinthVersion { filename: string; size: number; sha512: string }
export interface PluginPlan { items: PluginInstallItem[]; fingerprint: string }
