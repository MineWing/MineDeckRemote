import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlayerAction, PlayerView } from '../shared.ts'
import { InputError } from './core.ts'

interface PlayerFileEntry {
  uuid?: unknown
  name?: unknown
}

const UUID = /^[0-9a-f]{32}$/i
const USERNAME = /^[A-Za-z0-9_]{1,16}$/

export function normaliseUuid(value: unknown) {
  if (typeof value !== 'string') return
  const compact = value.replaceAll('-', '')
  if (!UUID.test(compact)) return
  const lower = compact.toLowerCase()
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`
}

async function readPlayerFile(directory: string, name: string): Promise<PlayerFileEntry[]> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, name), 'utf8'))
    return Array.isArray(value) ? value : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return []
    throw error
  }
}

export async function readPlayers(directory: string, onlineNames: Iterable<string>): Promise<PlayerView[]> {
  const [cached, ops, whitelist, banned] = await Promise.all([
    readPlayerFile(directory, 'usercache.json'),
    readPlayerFile(directory, 'ops.json'),
    readPlayerFile(directory, 'whitelist.json'),
    readPlayerFile(directory, 'banned-players.json'),
  ])
  const players = new Map<string, PlayerView>()
  const online = new Set([...onlineNames].map((name) => name.toLowerCase()))

  const merge = (entries: PlayerFileEntry[], field?: 'isOp' | 'isWhitelisted' | 'isBanned') => {
    for (const entry of entries) {
      const uuid = normaliseUuid(entry.uuid)
      if (!uuid || typeof entry.name !== 'string' || !USERNAME.test(entry.name)) continue
      const current = players.get(uuid) ?? {
        uuid,
        username: entry.name,
        isOnline: false,
        isOp: false,
        isWhitelisted: false,
        isBanned: false,
      }
      current.username = entry.name
      current.isOnline = online.has(entry.name.toLowerCase())
      if (field) current[field] = true
      players.set(uuid, current)
    }
  }

  merge(cached)
  merge(ops, 'isOp')
  merge(whitelist, 'isWhitelisted')
  merge(banned, 'isBanned')

  return [...players.values()].sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || a.username.localeCompare(b.username))
}

export function playerCommand(action: unknown, username: string) {
  if (!USERNAME.test(username)) throw new InputError('Player has an invalid username')
  const commands: Record<PlayerAction, string> = {
    op: `op ${username}`,
    deop: `deop ${username}`,
    'remove-whitelist': `whitelist remove ${username}`,
    kick: `kick ${username} Kicked by an operator`,
    ban: `ban ${username} Banned by an operator`,
  }
  if (typeof action !== 'string' || !(action in commands)) throw new InputError('Unknown player action', 404)
  return commands[action as PlayerAction]
}
