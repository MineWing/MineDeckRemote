import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import trash from 'trash'
import type { PaperBuild } from '../shared.ts'
import { InputError, resolveInside } from './core.ts'

const PAPER_API = 'https://fill.papermc.io/v3/projects/paper'
const PAPER_USER_AGENT = 'MineDeck/1.0.0 (https://github.com/MineWing/MineDeckRemote)'
const MAX_PAPER_JAR_BYTES = 512 * 1024 * 1024
const VERSION_PATTERN = /^\d+(?:\.\d+){1,2}$/

type Fetcher = typeof fetch

interface PaperProjectResponse {
  versions?: Record<string, unknown>
}

interface PaperDownloadResponse {
  name?: unknown
  size?: unknown
  url?: unknown
  checksums?: { sha256?: unknown }
}

interface PaperBuildResponse {
  id?: unknown
  time?: unknown
  channel?: unknown
  downloads?: Record<string, PaperDownloadResponse | undefined>
}

const paperUrl = (path = '') => `${PAPER_API}${path}`

const isPaperUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'papermc.io' || url.hostname.endsWith('.papermc.io'))
  } catch {
    return false
  }
}

const paperFetch = async (url: string, fetcher: Fetcher, timeoutMs: number) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(url, {
      headers: { 'User-Agent': PAPER_USER_AGENT, Accept: '*/*' },
      signal: controller.signal,
    })
    if (!response.ok) throw new InputError(`Paper download service returned ${response.status}`, 502)
    if (!isPaperUrl(response.url || url)) throw new InputError('Paper download service returned an untrusted URL', 502)
    return response
  } catch (error) {
    if (error instanceof InputError) throw error
    if ((error as Error).name === 'AbortError') throw new InputError('Paper download service timed out', 504)
    throw new InputError('Paper download service is unavailable', 502)
  } finally {
    clearTimeout(timeout)
  }
}

const paperJson = async (url: string, fetcher: Fetcher) => {
  const response = await paperFetch(url, fetcher, 15_000)
  try {
    return await response.json() as unknown
  } catch {
    throw new InputError('Paper download service returned an invalid response', 502)
  }
}

export async function listPaperVersions(fetcher: Fetcher = fetch): Promise<string[]> {
  const body = await paperJson(paperUrl(), fetcher) as PaperProjectResponse
  if (!body || typeof body !== 'object' || !body.versions || typeof body.versions !== 'object') {
    throw new InputError('Paper download service returned an invalid response', 502)
  }

  const versions = Object.values(body.versions).flatMap((group) => Array.isArray(group) ? group : [])
  return versions.filter((version): version is string => typeof version === 'string' && VERSION_PATTERN.test(version))
}

export async function listPaperBuilds(version: unknown, fetcher: Fetcher = fetch): Promise<PaperBuild[]> {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new InputError('Invalid Paper version')
  const body = await paperJson(paperUrl(`/versions/${encodeURIComponent(version)}/builds`), fetcher)
  if (!Array.isArray(body)) throw new InputError('Paper download service returned an invalid response', 502)

  const builds = body.flatMap((candidate): PaperBuild[] => {
    const build = candidate as PaperBuildResponse
    const download = build?.downloads?.['server:default']
    if (
      build?.channel !== 'STABLE'
      || !Number.isInteger(build.id)
      || typeof build.time !== 'string'
      || typeof download?.name !== 'string'
      || typeof download.size !== 'number'
      || !Number.isSafeInteger(download.size)
      || download.size <= 0
      || download.size > MAX_PAPER_JAR_BYTES
      || typeof download.url !== 'string'
      || !isPaperUrl(download.url)
      || typeof download.checksums?.sha256 !== 'string'
      || !/^[a-f\d]{64}$/i.test(download.checksums.sha256)
    ) return []
    return [{
      id: build.id as number,
      time: build.time,
      name: download.name,
      size: download.size,
      sha256: download.checksums.sha256.toLowerCase(),
      url: download.url,
    }]
  })
  return builds.sort((a, b) => b.id - a.id)
}

export async function downloadPaperJar(
  directory: string,
  jar: string,
  version: unknown,
  buildId: unknown,
  fetcher: Fetcher = fetch,
) {
  if (!Number.isInteger(buildId)) throw new InputError('Invalid Paper build')
  const build = (await listPaperBuilds(version, fetcher)).find((item) => item.id === buildId)
  if (!build) throw new InputError('That stable Paper build is no longer available', 409)

  const target = await resolveInside(directory, jar, true)
  let handle
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new InputError(`${jar} already exists`, 409)
    throw new InputError('The Paper JAR could not be created')
  }

  try {
    const response = await paperFetch(build.url, fetcher, 5 * 60_000)
    if (!response.body) throw new InputError('Paper download returned an empty response', 502)

    const hash = createHash('sha256')
    let bytes = 0
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > build.size) return callback(new InputError('Paper JAR was larger than expected', 502))
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(response.body, verify, handle.createWriteStream())
    if (bytes !== build.size || hash.digest('hex') !== build.sha256) {
      throw new InputError('Paper JAR failed its integrity check', 502)
    }
    return { name: build.name, size: build.size, sha256: build.sha256 }
  } catch (error) {
    await handle.close().catch(() => undefined)
    const recycled = await trash(target, { glob: false }).then(() => true).catch(() => false)
    const message = error instanceof InputError ? error.message : 'Paper JAR download failed'
    throw new InputError(recycled ? message : `${message}; the incomplete file could not be moved to the recycle bin`, error instanceof InputError ? error.statusCode : 502)
  } finally {
    await handle.close().catch(() => undefined)
  }
}
