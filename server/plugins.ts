import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import trash from 'trash'
import { InputError, resolveInside } from './core.ts'
import type { ServerConfig } from '../shared.ts'
import { detectPluginTarget } from './plugin-target.ts'
import { MAX_PLUGIN_BYTES, modrinthResponse, planPlugins, type DownloadItem, type Fetcher } from './modrinth.ts'

export async function installedPlugins(directory: string) {
  const path = await resolveInside(directory, 'plugins', true)
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!details) return []
  if (details.isSymbolicLink() || !details.isDirectory()) throw new InputError('The plugins folder must be a real directory', 409)
  const entries = await readdir(path, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).map((entry) => entry.name).sort()
}

async function hashFile(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const details = await file.stat()
    if (!details.isFile() || details.size > MAX_PLUGIN_BYTES) throw new InputError('Existing plugin cannot be verified', 409)
    const hash = createHash('sha512')
    for await (const chunk of file.createReadStream()) hash.update(chunk)
    return hash.digest('hex')
  } finally { await file.close() }
}

async function download(item: DownloadItem, path: string, fetcher: Fetcher) {
  const file = await open(path, 'wx', 0o600)
  try {
    await modrinthResponse(item.url, fetcher, async (response, signal) => {
      if (!response.body) throw new InputError('Modrinth returned an empty plugin file', 502)
      let bytes = 0
      const hash = createHash('sha512')
      const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > item.size) return callback(new InputError('Plugin download exceeded its advertised size', 502))
        hash.update(chunk)
        callback(null, chunk)
      } })
      const destination = new Writable({ write(chunk: Buffer, _encoding, callback) {
        void file.writeFile(chunk).then(() => callback(), callback)
      } })
      await pipeline(response.body, verify, destination, { signal })
      if (bytes !== item.size || hash.digest('hex') !== item.sha512) throw new InputError('Plugin download failed its integrity check', 502)
      await file.sync()
    }, 120_000)
  } finally { await file.close() }
}

export async function installPlugins(directory: string, value: unknown, fetcher: Fetcher = fetch, beforePublish?: () => Promise<void>) {
  const body = value as { versionId?: unknown; loader?: unknown; gameVersion?: unknown; fingerprint?: unknown } | null
  if (!body || typeof body.fingerprint !== 'string') throw new InputError('Review an installation before installing')
  const plan = await planPlugins(body.versionId, body, fetcher)
  if (plan.fingerprint !== body.fingerprint) throw new InputError('The available files or dependencies changed. Review the installation again.', 409)
  const existing = await installedPlugins(directory)
  for (const project of plan.incompatibleProjects) {
    if (existing.includes(`modrinth-${project}.jar`)) throw new InputError(`An installed plugin conflicts with this release: modrinth-${project}.jar`, 409)
  }
  const pluginDirectory = await resolveInside(directory, 'plugins', true)
  await mkdir(pluginDirectory, { recursive: true })
  // Recheck after creation so a directory symlink is never accepted.
  await installedPlugins(directory)
  const pending: { item: DownloadItem; temporary: string; target: string }[] = []
  const installed: string[] = []
  const alreadyInstalled: string[] = []
  const temporaryFiles: string[] = []
  try {
    for (const item of plan.items) {
      const target = await resolveInside(directory, `plugins/${item.filename}`, true)
      const exists = await lstat(target).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      if (exists) {
        if (await hashFile(target) !== item.sha512) throw new InputError(`${item.filename} already contains another version. Move it to Trash in Files before installing a replacement.`, 409)
        alreadyInstalled.push(item.filename)
        continue
      }
      // Recognize an identical JAR uploaded manually, regardless of its filename.
      let matching: string | undefined
      for (const name of existing) {
        const path = await resolveInside(directory, `plugins/${name}`)
        const details = await lstat(path)
        if (details.size === item.size && await hashFile(path) === item.sha512) { matching = name; break }
      }
      if (matching) { alreadyInstalled.push(matching); continue }
      pending.push({ item, target, temporary: join(pluginDirectory, `.minedeck-plugin-${randomBytes(12).toString('hex')}.tmp`) })
    }
    for (const entry of pending) {
      temporaryFiles.push(entry.temporary)
      await download(entry.item, entry.temporary, fetcher)
    }
    await beforePublish?.()
    // Publish only complete, verified files. Hard links refuse to replace existing JARs.
    for (const entry of pending) {
      await link(entry.temporary, entry.target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw new InputError(`${entry.item.filename} appeared during the download. Review the plugins folder.`, 409)
        throw error
      })
      installed.push(entry.item.filename)
    }
  } catch (error) {
    // Preserve recoverability on failed installations, including published dependencies.
    for (const name of installed) await trash(join(pluginDirectory, name), { glob: false })
    throw error
  } finally {
    for (const path of temporaryFiles) {
      const exists = await lstat(path).then(() => true).catch(() => false)
      if (exists) await trash(path, { glob: false })
    }
  }
  return { installed, alreadyInstalled }
}

export async function installServerPlugins(config: ServerConfig, value: unknown, fetcher: Fetcher = fetch) {
  const target = await detectPluginTarget(config)
  const body = value as { versionId?: unknown; fingerprint?: unknown } | null
  return installPlugins(config.directory, { versionId: body?.versionId, fingerprint: body?.fingerprint, ...target }, fetcher, async () => {
    const current = await detectPluginTarget(config)
    if (current.loader !== target.loader || current.gameVersion !== target.gameVersion) {
      throw new InputError('The server version changed during download. Refresh and review compatible plugins again.', 409)
    }
  })
}
