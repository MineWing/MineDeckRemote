import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import { constants, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import trash from 'trash'
import { WebSocket, WebSocketServer } from 'ws'
import type { FileEntry, SocketEvent } from '../shared.ts'
import { importServerConfig, InputError, resolveInside, validateServerConfig, validateUploadName } from './core.ts'
import { ServerManager, type StoredData } from './manager.ts'

const scryptAsync = promisify(scrypt)
const DATA_PATH = resolve(process.env.MINEDECK_DATA ?? 'data/minedeck.json')
const PORT = Number(process.env.MINEDECK_PORT ?? 8787)
const HOST = process.env.MINEDECK_HOST ?? '0.0.0.0'
const SESSION_HOURS = 12
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024
const MAX_UPLOAD_FILES = 20

await mkdir(dirname(DATA_PATH), { recursive: true })

let data: StoredData
try {
  data = JSON.parse(await readFile(DATA_PATH, 'utf8')) as StoredData
  if (data.version !== 1 || !Array.isArray(data.servers) || !data.stats) throw new Error('unsupported data format')
} catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read ${DATA_PATH}: ${(error as Error).message}`)
  data = { version: 1, servers: [], stats: {} }
}

let saveQueue = Promise.resolve()
const save = () => {
  const snapshot = JSON.stringify(data, null, 2)
  saveQueue = saveQueue.then(async () => {
    const temporary = `${DATA_PATH}.tmp`
    await writeFile(temporary, snapshot, { mode: 0o600 })
    await rename(temporary, DATA_PATH)
  })
  return saveQueue
}

const hashPassword = async (password: string, salt = randomBytes(16).toString('hex')) => ({
  salt,
  hash: Buffer.from(await scryptAsync(password, salt, 64) as ArrayBuffer).toString('hex'),
})

let initialPassword: string | undefined
if (!data.auth) {
  initialPassword = process.env.MINEDECK_PASSWORD || randomBytes(15).toString('base64url')
  if (initialPassword.length < 12) throw new Error('MINEDECK_PASSWORD must be at least 12 characters')
  data.auth = await hashPassword(initialPassword)
  await save()
}

const verifyPassword = async (password: unknown) => {
  if (typeof password !== 'string' || password.length > 1_024 || !data.auth) return false
  const actual = Buffer.from(await scryptAsync(password, data.auth.salt, 64) as ArrayBuffer)
  const expected = Buffer.from(data.auth.hash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const tlsCert = process.env.MINEDECK_TLS_CERT
const tlsKey = process.env.MINEDECK_TLS_KEY
if (!!tlsCert !== !!tlsKey) throw new Error('Set both MINEDECK_TLS_CERT and MINEDECK_TLS_KEY to enable HTTPS')
const tls = tlsCert && tlsKey ? { cert: await readFile(tlsCert), key: await readFile(tlsKey) } : undefined
const app = Fastify({ logger: true, bodyLimit: MAX_FILE_BYTES + 64_000, https: tls ?? null })
await app.register(fastifyMultipart, {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES, parts: MAX_UPLOAD_FILES },
  throwFileSizeLimit: true,
})
const wss = new WebSocketServer({ noServer: true })
const sessions = new Map<string, number>()
const loginAttempts = new Map<string, { failures: number; blockedUntil: number }>()

const cookies = (header = '') => Object.fromEntries(header.split(';').map((part) => {
  const [key, ...value] = part.trim().split('=')
  return [key, decodeURIComponent(value.join('='))]
}).filter(([key]) => key))

const validSession = (header?: string) => {
  const token = cookies(header).md_session
  const expires = token ? sessions.get(token) : undefined
  if (!token || !expires || expires < Date.now()) {
    if (token) sessions.delete(token)
    return false
  }
  return true
}

const sessionCookie = (token: string, maxAge = SESSION_HOURS * 60 * 60) =>
  `md_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${tls ? '; Secure' : ''}`

const newSession = () => {
  const token = randomBytes(32).toString('base64url')
  sessions.set(token, Date.now() + SESSION_HOURS * 60 * 60 * 1_000)
  return token
}

const publish = (event: SocketEvent) => {
  const message = JSON.stringify(event)
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(message)
}
const manager = new ServerManager(data, save, publish)

app.setErrorHandler((error, _request, reply) => {
  const known = error as { statusCode?: number; message?: string }
  const status = error instanceof InputError ? error.statusCode : (known.statusCode && known.statusCode < 500 ? known.statusCode : 500)
  if (status === 500) app.log.error(error)
  reply.code(status).send({ error: status === 500 ? 'Internal server error' : known.message ?? 'Invalid request' })
})

app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/')) return
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.origin
    if (origin && new URL(origin).host !== request.headers.host) throw new InputError('Invalid request origin', 403)
  }
  const publicRoute = request.url === '/api/auth/session' || request.url === '/api/auth/login'
  if (!publicRoute && !validSession(request.headers.cookie)) return reply.code(401).send({ error: 'Authentication required' })
})

app.get('/api/auth/session', async (request) => ({ authenticated: validSession(request.headers.cookie), https: Boolean(tls) }))

app.post('/api/auth/login', async (request, reply) => {
  const key = request.ip
  const attempt = loginAttempts.get(key) ?? { failures: 0, blockedUntil: 0 }
  if (attempt.blockedUntil > Date.now()) throw new InputError('Too many login attempts; try again later', 429)
  const password = (request.body as { password?: unknown } | null)?.password
  if (!await verifyPassword(password)) {
    attempt.failures++
    if (attempt.failures >= 5) {
      attempt.failures = 0
      attempt.blockedUntil = Date.now() + 15 * 60_000
    }
    loginAttempts.set(key, attempt)
    throw new InputError('Invalid password', 401)
  }
  loginAttempts.delete(key)
  reply.header('Set-Cookie', sessionCookie(newSession()))
  return { ok: true }
})

app.post('/api/auth/logout', async (request, reply) => {
  const token = cookies(request.headers.cookie).md_session
  if (token) sessions.delete(token)
  reply.header('Set-Cookie', sessionCookie('', 0))
  return { ok: true }
})

app.post('/api/auth/password', async (request, reply) => {
  const body = request.body as { currentPassword?: unknown; newPassword?: unknown }
  if (!await verifyPassword(body?.currentPassword)) throw new InputError('Current password is incorrect', 401)
  if (typeof body.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 1_024) {
    throw new InputError('New password must be between 12 and 1024 characters')
  }
  data.auth = await hashPassword(body.newPassword)
  await save()
  sessions.clear()
  reply.header('Set-Cookie', sessionCookie(newSession()))
  return { ok: true }
})

app.get('/api/servers', async () => manager.list())

app.post('/api/servers', async (request) => manager.add(await validateServerConfig(request.body)))

app.post('/api/servers/import', async (request) => manager.add(await importServerConfig(request.body)))

app.put('/api/servers/:id', async (request) => {
  const { id } = request.params as { id: string }
  return manager.update(id, await validateServerConfig(request.body, manager.get(id)))
})

app.delete('/api/servers/:id', async (request) => {
  await manager.remove((request.params as { id: string }).id)
  return { ok: true }
})

app.post('/api/servers/:id/actions/:action', async (request) => {
  const { id, action } = request.params as { id: string; action: string }
  if (action === 'start') return manager.start(id)
  if (action === 'stop') manager.stop(id)
  else if (action === 'restart') return manager.restart(id)
  else if (action === 'kill') manager.kill(id)
  else throw new InputError('Unknown server action', 404)
  return { ok: true }
})

app.post('/api/servers/:id/command', async (request) => {
  manager.command((request.params as { id: string }).id, (request.body as { command?: unknown })?.command)
  return { ok: true }
})

app.get('/api/servers/:id/console', async (request) => ({ lines: manager.getConsole((request.params as { id: string }).id) }))

app.get('/api/servers/:id/files', async (request) => {
  const server = manager.get((request.params as { id: string }).id)
  const requested = (request.query as { path?: unknown }).path ?? ''
  if (typeof requested !== 'string') throw new InputError('Invalid path')
  const directory = await resolveInside(server.directory, requested)
  if (!(await stat(directory)).isDirectory()) throw new InputError('Path is not a directory')
  const entries: FileEntry[] = await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
    const details = await lstat(join(directory, entry.name))
    return {
      name: entry.name,
      type: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file',
      size: details.size,
      modifiedAt: details.mtime.toISOString(),
    }
  }))
  entries.sort((a, b) => Number(a.type !== 'directory') - Number(b.type !== 'directory') || a.name.localeCompare(b.name))
  return { path: requested, entries }
})

app.get('/api/servers/:id/file', async (request) => {
  const server = manager.get((request.params as { id: string }).id)
  const requested = (request.query as { path?: unknown }).path
  if (typeof requested !== 'string' || !requested) throw new InputError('File path is required')
  const path = await resolveInside(server.directory, requested)
  const details = await stat(path)
  if (!details.isFile()) throw new InputError('Path is not a file')
  if (details.size > MAX_FILE_BYTES) throw new InputError('File is larger than 2 MB', 413)
  const content = await readFile(path)
  if (content.includes(0)) throw new InputError('Binary files cannot be edited')
  return { path: requested, content: content.toString('utf8'), modifiedAt: details.mtime.toISOString() }
})

app.put('/api/servers/:id/file', async (request) => {
  const server = manager.get((request.params as { id: string }).id)
  const body = request.body as { path?: unknown; content?: unknown }
  if (typeof body.path !== 'string' || !body.path || typeof body.content !== 'string') throw new InputError('Path and text content are required')
  if (Buffer.byteLength(body.content) > MAX_FILE_BYTES) throw new InputError('File is larger than 2 MB', 413)
  const path = await resolveInside(server.directory, body.path, true)
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600).catch(() => {
    throw new InputError('File could not be opened safely')
  })
  try { await handle.writeFile(body.content, 'utf8') } finally { await handle.close() }
  return { ok: true }
})

app.post('/api/servers/:id/files/upload', async (request) => {
  if (!request.isMultipart()) throw new InputError('Uploads must use multipart form data')
  const server = manager.get((request.params as { id: string }).id)
  const requested = (request.query as { path?: unknown }).path ?? ''
  if (typeof requested !== 'string') throw new InputError('Invalid path')
  const directory = await resolveInside(server.directory, requested)
  if (!(await stat(directory)).isDirectory()) throw new InputError('Path is not a directory')

  const uploaded: string[] = []
  for await (const part of request.files()) {
    const name = validateUploadName(part.filename)
    const relativePath = requested ? `${requested}/${name}` : name
    const target = await resolveInside(server.directory, relativePath, true)
    const exists = await lstat(target).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (exists) {
      part.file.resume()
      throw new InputError(`${name} already exists`, 409)
    }

    const temporary = join(directory, `.minedeck-upload-${randomBytes(12).toString('hex')}.tmp`)
    try {
      await pipeline(part.file, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
      if (part.file.truncated) throw new InputError(`${name} is larger than 512 MB`, 413)
      await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw new InputError(`${name} already exists`, 409)
        throw error
      })
      await unlink(temporary)
      uploaded.push(name)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
  if (!uploaded.length) throw new InputError('Choose at least one file to upload')
  return { uploaded }
})

app.delete('/api/servers/:id/file', async (request) => {
  const server = manager.get((request.params as { id: string }).id)
  const requested = (request.body as { path?: unknown } | null)?.path
  if (typeof requested !== 'string' || !requested) throw new InputError('File path is required')
  const path = await resolveInside(server.directory, requested)
  if (!(await lstat(path)).isFile()) throw new InputError('Only files can be moved to the recycle bin')

  await trash(path, { glob: false }).catch((error) => {
    request.log.error(error, 'Could not move server file to the recycle bin')
    throw new InputError('File could not be moved to the recycle bin', 500)
  })
  const stillExists = await lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (stillExists) throw new InputError('File could not be moved to the recycle bin', 500)
  return { ok: true }
})

if (process.env.NODE_ENV === 'production') {
  await app.register(fastifyStatic, { root: resolve('dist') })
}

app.server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws' || !validSession(request.headers.cookie)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (client) => {
    wss.emit('connection', client, request)
    client.send(JSON.stringify({ type: 'servers', servers: manager.list() } satisfies SocketEvent))
  })
})

const address = await app.listen({ host: HOST, port: PORT })
if (initialPassword) {
  app.log.warn(`First-run admin password: ${initialPassword}`)
  app.log.warn('Sign in and change it from the dashboard. This password will not be shown again.')
}
const protocol = tls ? 'https' : 'http'
const localIp = Object.values(networkInterfaces()).flat().find((item) => item?.family === 'IPv4' && !item.internal)?.address
app.log.info(`MineDeck: ${address}`)
if (localIp && HOST === '0.0.0.0') app.log.info(`Other devices: ${protocol}://${localIp}:${PORT}`)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  app.log.info('Stopping managed servers…')
  await manager.shutdown()
  await app.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
