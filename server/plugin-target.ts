import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import * as yauzl from 'yauzl'
import type { PluginLoader, PluginTarget, ServerConfig } from '../shared.ts'
import { InputError, resolveInside } from './core.ts'

const metadataNames = new Set(['version.json', 'META-INF/versions.list', 'META-INF/MANIFEST.MF'])
const versionPattern = /^[\w.+-]{1,40}$/
const softwarePattern = /\b(Folia|Purpur|Paper|Spigot|CraftBukkit|Bukkit)\b/i
const loaderName = (name: string): PluginLoader => name.toLowerCase() === 'craftbukkit' ? 'bukkit' : name.toLowerCase() as PluginLoader

function jarMetadata(path: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, archive) => {
      if (error || !archive) { reject(error ?? new Error('Could not open server JAR')); return }
      const result = new Map<string, string>()
      let count = 0
      let settled = false
      const timeout = setTimeout(() => finish(new Error('Server JAR inspection timed out')), 5_000)
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        archive.close()
        if (error) reject(error)
        else resolve(result)
      }
      archive.on('error', finish)
      archive.on('end', () => finish())
      archive.on('entry', (entry: yauzl.Entry) => {
        if (++count > 100_000) { finish(new Error('Server JAR has too many entries')); return }
        if (!metadataNames.has(entry.fileName)) { archive.readEntry(); return }
        if (entry.uncompressedSize > 64 * 1024) { finish(new Error('Server metadata is too large')); return }
        archive.openReadStream(entry, (error, stream) => {
          if (error || !stream) { finish(error ?? new Error('Could not read server metadata')); return }
          const chunks: Buffer[] = []
          let length = 0
          stream.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > 64 * 1024) { stream.destroy(); finish(new Error('Server metadata is too large')) }
            else chunks.push(chunk)
          })
          stream.on('error', finish)
          stream.on('end', () => {
            if (settled) return
            result.set(entry.fileName, Buffer.concat(chunks).toString('utf8'))
            archive.readEntry()
          })
        })
      })
      archive.readEntry()
    })
  })
}

export function targetFromMetadata(metadata: Map<string, string>, log = ''): PluginTarget | undefined {
  const versions = metadata.get('META-INF/versions.list') ?? ''
  const manifest = metadata.get('META-INF/MANIFEST.MF') ?? ''
  let gameVersion: string | undefined
  try {
    const data = JSON.parse(metadata.get('version.json') ?? '{}') as { id?: unknown }
    if (typeof data.id === 'string' && versionPattern.test(data.id)) gameVersion = data.id
  } catch { /* Bundled version metadata and startup output can still identify the server. */ }
  gameVersion ??= versions.split(/\r?\n/).map((line) => line.split('\t')[1]).find((version) => version && versionPattern.test(version))
  gameVersion ??= manifest.match(/^Bukkit-Version:\s*(\d+(?:\.\d+){1,2})/mi)?.[1]
  const loggedVersion = log.match(/\[(?:Server thread|ServerMain)\/INFO\]: Starting minecraft server version ([\w.+-]+)/i)?.[1]
  gameVersion ??= loggedVersion
  // Use the actual bootstrap/implementation, never a user-renamable JAR filename.
  const bundledSoftware = versions.match(/\/(folia|purpur|paper|spigot|craftbukkit|bukkit)-/i)?.[1]
  const manifestSoftware = manifest.match(/^Implementation-Title:\s*(Folia|Purpur|Paper|Spigot|CraftBukkit|Bukkit)\b/mi)?.[1]
  const loggedSoftware = log.match(/\[(?:Server thread|ServerMain)\/INFO\]: This server is running (Folia|Purpur|Paper|Spigot|CraftBukkit|Bukkit)\b/i)?.[1]
    ?? log.match(/\[ServerMain\/INFO\]: \[bootstrap\] Loading (Folia|Purpur|Paper|Spigot|CraftBukkit|Bukkit)\b/i)?.[1]
  let software = bundledSoftware ?? manifestSoftware
  // Folia/Purpur can share Paper bootstrap metadata; a matching startup identifies the fork.
  if (loggedSoftware && (!loggedVersion || loggedVersion === gameVersion)) software = loggedSoftware
  if (!software || !softwarePattern.test(software) || !gameVersion || !versionPattern.test(gameVersion)) return undefined
  return { loader: loaderName(software), gameVersion }
}

export async function detectPluginTarget(config: Pick<ServerConfig, 'directory' | 'jar'>): Promise<PluginTarget> {
  const path = await resolveInside(config.directory, config.jar)
  const details = await stat(path)
  let metadata = new Map<string, string>()
  try { metadata = await jarMetadata(path) } catch { /* Older server distributions may only identify themselves in their startup log. */ }
  let log = ''
  try {
    const logPath = await resolveInside(config.directory, 'logs/latest.log')
    const file = await open(logPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const logDetails = await file.stat()
      // A log from before the current JAR was installed cannot establish compatibility.
      if (logDetails.isFile() && logDetails.mtimeMs >= details.mtimeMs) {
        const buffer = Buffer.alloc(Math.min(logDetails.size, 256 * 1024))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        log = buffer.subarray(0, bytesRead).toString('utf8')
      }
    } finally { await file.close() }
  } catch { /* No usable startup log yet. */ }
  const target = targetFromMetadata(metadata, log)
  if (!target) throw new InputError('Could not detect a supported plugin server and its Minecraft version. Start the server once, then refresh. Vanilla and mod-only servers cannot install plugins here.', 409)
  return target
}
