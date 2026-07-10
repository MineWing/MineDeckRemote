import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ServerConfig } from '../shared.ts'

export class InputError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

const text = (value: unknown, field: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new InputError(`${field} is invalid`)
  }
  return value.trim()
}

const integer = (value: unknown, field: string, min: number, max: number) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new InputError(`${field} must be between ${min} and ${max}`)
  }
  return value as number
}

export const expandHome = (value: string) =>
  value === '~' ? homedir() : value.startsWith(`~${sep}`) ? resolve(homedir(), value.slice(2)) : value

export async function validateServerConfig(
  value: unknown,
  existing?: ServerConfig,
): Promise<ServerConfig> {
  if (!value || typeof value !== 'object') throw new InputError('Invalid server configuration')
  const body = value as Record<string, unknown>
  const directory = expandHome(text(body.directory, 'Directory', 1000))
  if (!isAbsolute(directory)) throw new InputError('Directory must be an absolute path')

  const jar = text(body.jar, 'JAR file', 255)
  if (isAbsolute(jar) || jar.includes('\0') || !jar.toLowerCase().endsWith('.jar')) {
    throw new InputError('JAR must be a relative .jar path inside the server directory')
  }

  const javaArgs = body.javaArgs ?? []
  if (!Array.isArray(javaArgs) || javaArgs.length > 32 || javaArgs.some((arg) => typeof arg !== 'string' || arg.length > 200 || arg.includes('\0'))) {
    throw new InputError('Java arguments must be a list of at most 32 values')
  }

  const minMemoryMb = integer(body.minMemoryMb, 'Minimum memory', 256, 65_536)
  const maxMemoryMb = integer(body.maxMemoryMb, 'Maximum memory', 256, 65_536)
  if (minMemoryMb > maxMemoryMb) throw new InputError('Minimum memory cannot exceed maximum memory')
  if (typeof body.autoRestart !== 'boolean') throw new InputError('Auto restart must be true or false')

  await access(directory, constants.R_OK | constants.W_OK).catch(() => {
    throw new InputError('Server directory does not exist or is not readable and writable')
  })
  const jarPath = await resolveInside(directory, jar)
  if (!(await stat(jarPath)).isFile()) throw new InputError('JAR path is not a file')

  return {
    id: existing?.id ?? '',
    name: text(body.name, 'Name', 50),
    directory: await realpath(directory),
    jar,
    javaPath: text(body.javaPath ?? 'java', 'Java path', 1000),
    minMemoryMb,
    maxMemoryMb,
    javaArgs: javaArgs.map(String),
    autoRestart: body.autoRestart,
    stopTimeoutSeconds: integer(body.stopTimeoutSeconds, 'Stop timeout', 5, 120),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }
}

export async function importServerConfig(value: unknown): Promise<ServerConfig> {
  if (!value || typeof value !== 'object') throw new InputError('Invalid server import')
  const body = value as Record<string, unknown>
  const directory = expandHome(text(body.directory, 'Directory', 1000))
  if (!isAbsolute(directory)) throw new InputError('Directory must be an absolute path')

  let contents: string
  try {
    contents = await readFile(await resolveInside(directory, 'start.bat'), 'utf8')
  } catch {
    throw new InputError('No readable start.bat was found in the server directory')
  }

  const lines = contents.replace(/\^\s*\r?\n/g, ' ').split(/\r?\n/)
  let launch: { tokens: string[]; java: number; jar: number } | undefined
  for (const line of lines) {
    if (/^\s*(?:::|@?(?:echo|rem)(?:\s|$))/i.test(line)) continue
    const tokens = [...line.matchAll(/(?:"[^"]*"|[^\s"]+)+/g)].map(([token]) => token.replace(/"([^"]*)"/g, '$1'))
    const java = tokens.findIndex((token) => /(^|[\\/])java(?:\.exe)?$/i.test(token.replace(/^@/, '')))
    const jar = tokens.findIndex((token, index) => index > java && token.toLowerCase() === '-jar')
    if (java >= 0 && jar > java && tokens[jar + 1]) { launch = { tokens, java, jar }; break }
  }
  if (!launch) throw new InputError('start.bat must contain a Java command with -jar')

  let minMemoryMb: number | undefined
  let maxMemoryMb: number | undefined
  const javaArgs: string[] = []
  const factors: Record<string, number> = { '': 1 / 1_048_576, K: 1 / 1024, M: 1, G: 1024, T: 1_048_576 }
  for (const argument of launch.tokens.slice(launch.java + 1, launch.jar)) {
    if (!/^-Xm[sx]/i.test(argument)) { javaArgs.push(argument); continue }
    const match = argument.match(/^-Xm([sx])(\d+)([KMGT]?)$/i)
    if (!match) throw new InputError(`Unsupported memory setting in start.bat: ${argument}`)
    const memoryMb = Math.round(Number(match[2]) * factors[match[3]!.toUpperCase()]!)
    if (match[1]!.toLowerCase() === 's') minMemoryMb = memoryMb
    else maxMemoryMb = memoryMb
  }

  const javaPath = launch.tokens[launch.java]!.replace(/^@/, '').replace(/%([^%]+)%/g, (token, name: string) => process.env[name] ?? token)
  return validateServerConfig({
    name: text(body.name, 'Name', 50),
    directory,
    jar: launch.tokens[launch.jar + 1],
    javaPath,
    minMemoryMb: minMemoryMb ?? Math.min(maxMemoryMb ?? 1024, 1024),
    maxMemoryMb: maxMemoryMb ?? Math.max(minMemoryMb ?? 2048, 2048),
    javaArgs,
    autoRestart: true,
    stopTimeoutSeconds: 30,
  })
}

const isInside = (root: string, target: string) => {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

export async function resolveInside(root: string, requested = '', forWrite = false) {
  if (typeof requested !== 'string' || requested.includes('\0') || isAbsolute(requested)) {
    throw new InputError('Invalid path')
  }
  const rootPath = await realpath(root).catch(() => {
    throw new InputError('Server directory is unavailable')
  })
  const candidate = resolve(rootPath, requested || '.')
  if (!isInside(rootPath, candidate)) throw new InputError('Path leaves the server directory')

  const checked = await realpath(candidate).catch(async (error: NodeJS.ErrnoException) => {
    if (!forWrite || error.code !== 'ENOENT') throw new InputError('Path does not exist', 404)
    return realpath(dirname(candidate)).catch(() => {
      throw new InputError('Parent directory does not exist', 404)
    })
  })
  if (!isInside(rootPath, checked)) throw new InputError('Symbolic link leaves the server directory')
  return candidate
}
