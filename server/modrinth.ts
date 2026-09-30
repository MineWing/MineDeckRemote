import { createHash } from 'node:crypto'
import type { ModrinthProject, ModrinthVersion, PluginInstallItem, PluginPlan, PluginTarget } from '../shared.ts'
import { pluginLoaders } from '../shared.ts'
import { InputError, validateUploadName } from './core.ts'

const API = 'https://api.modrinth.com/v2'
const USER_AGENT = 'MineDeck/1.0.0 (https://github.com/MineWing/MineDeckRemote)'
export const MAX_PLUGIN_BYTES = 128 * 1024 * 1024
export type Fetcher = typeof fetch
interface Dependency { version_id: string | null; project_id: string | null; dependency_type: string }
interface Release extends ModrinthVersion {
  dependencies: Dependency[]
  files: { filename: string; size: number; url: string; hashes: { sha512: string }; primary: boolean }[]
  loaders: string[]
  game_versions: string[]
}
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/
export function modrinthId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new InputError('Invalid Modrinth project or version')
  return value
}
export function pluginTarget(value: unknown): PluginTarget {
  const body = value as Partial<PluginTarget> | null
  if (!body || !pluginLoaders.includes(body.loader!) || typeof body.gameVersion !== 'string' || !/^[\w.+-]{1,40}$/.test(body.gameVersion)) {
    throw new InputError('Choose a plugin server and Minecraft version')
  }
  return { loader: body.loader!, gameVersion: body.gameVersion }
}
export function trustedDownload(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'cdn.modrinth.com' && !url.port && !url.username && !url.password && url.pathname.startsWith('/data/')
  } catch { return false }
}

// Redirects are rejected before following them; all requests stay on Modrinth's hosts.
export async function modrinthResponse<T>(url: string, fetcher: Fetcher, consume: (response: Response, signal: AbortSignal) => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, redirect: 'error', signal: controller.signal })
    if (response.status === 429) throw new InputError('Modrinth is rate limiting requests. Please try again shortly.', 429)
    if (!response.ok) throw new InputError(`Modrinth returned ${response.status}. Please try again.`, 502)
    return await consume(response, controller.signal)
  } catch (error) {
    if (error instanceof InputError) throw error
    if (controller.signal.aborted) throw new InputError('Modrinth request timed out. Please try again.', 504)
    throw new InputError('Could not reach Modrinth or read its response. Please try again.', 502)
  } finally { clearTimeout(timeout) }
}
const json = (path: string, fetcher: Fetcher) => modrinthResponse(`${API}${path}`, fetcher, async (response) => {
  // Bound metadata as well as download bodies.
  if (!response.body) throw new InputError('Modrinth returned an empty response', 502)
  let size = 0
  const chunks: Uint8Array[] = []
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > 8 * 1024 * 1024) throw new InputError('Modrinth response was too large', 502)
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
})

export async function modrinthGameVersions(fetcher: Fetcher = fetch) {
  const data = await json('/tag/game_version', fetcher)
  if (!Array.isArray(data)) throw new InputError('Invalid Modrinth versions response', 502)
  return data.filter((item) => item?.version_type === 'release' && typeof item.version === 'string' && /^[\w.+-]{1,40}$/.test(item.version)).map((item) => item.version as string)
}

export async function searchPlugins(query: unknown, targetValue: unknown, offsetValue: unknown = 0, fetcher: Fetcher = fetch) {
  const target = pluginTarget(targetValue)
  if (typeof query !== 'string' || query.length > 120) throw new InputError('Search must be under 120 characters')
  const offset = Number(offsetValue)
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new InputError('Invalid search page')
  const params = new URLSearchParams({ query, facets: JSON.stringify([[`categories:${target.loader}`], [`versions:${target.gameVersion}`]]), limit: '20', offset: String(offset), index: query ? 'relevance' : 'downloads' })
  const body = await json(`/search?${params}`, fetcher) as { hits?: unknown; total_hits?: unknown }
  if (!body || !Array.isArray(body.hits) || typeof body.total_hits !== 'number') throw new InputError('Invalid Modrinth search response', 502)
  const projects = body.hits.flatMap((hit): ModrinthProject[] => {
    if (!hit || typeof hit.project_id !== 'string' || !idPattern.test(hit.project_id) || typeof hit.slug !== 'string' || !idPattern.test(hit.slug) || typeof hit.title !== 'string' || typeof hit.description !== 'string' || typeof hit.author !== 'string' || typeof hit.downloads !== 'number') return []
    return [{ id: hit.project_id, slug: hit.slug, title: hit.title, description: hit.description, author: hit.author, downloads: hit.downloads }]
  })
  return { projects, total: body.total_hits, offset }
}

function release(value: unknown): Release {
  const item = value as Partial<{ id: string; project_id: string; name: string; version_number: string; date_published: string; loaders: string[]; game_versions: string[]; files: Release['files']; dependencies: Dependency[] }> | null
  if (!item || typeof item.id !== 'string' || !idPattern.test(item.id) || typeof item.project_id !== 'string' || !idPattern.test(item.project_id)
    || typeof item.name !== 'string' || typeof item.version_number !== 'string' || typeof item.date_published !== 'string'
    || !Array.isArray(item.loaders) || !Array.isArray(item.game_versions) || !Array.isArray(item.files) || !Array.isArray(item.dependencies)) {
    throw new InputError('Invalid Modrinth release response', 502)
  }
  return { id: item.id, projectId: item.project_id, name: item.name, number: item.version_number, published: item.date_published, loaders: item.loaders, game_versions: item.game_versions, files: item.files, dependencies: item.dependencies }
}
function compatible(item: Release, target: PluginTarget) {
  return item.loaders.includes(target.loader) && item.game_versions.includes(target.gameVersion)
}
async function releases(project: string, target: PluginTarget, fetcher: Fetcher) {
  const params = new URLSearchParams({ loaders: JSON.stringify([target.loader]), game_versions: JSON.stringify([target.gameVersion]), include_changelog: 'false' })
  const body = await json(`/project/${modrinthId(project)}/version?${params}`, fetcher)
  if (!Array.isArray(body)) throw new InputError('Invalid Modrinth releases response', 502)
  return body.filter((item) => item?.version_type === 'release').map(release).filter((item) => compatible(item, target)).sort((a, b) => b.published.localeCompare(a.published))
}
export async function pluginVersions(project: string, targetValue: unknown, fetcher: Fetcher = fetch): Promise<ModrinthVersion[]> {
  return (await releases(project, pluginTarget(targetValue), fetcher)).map(({ id, projectId, name, number, published }) => ({ id, projectId, name, number, published }))
}
export interface DownloadItem extends PluginInstallItem { url: string }
export interface DownloadPlan extends PluginPlan { items: DownloadItem[]; incompatibleProjects: string[] }

export async function planPlugins(versionId: unknown, targetValue: unknown, fetcher: Fetcher = fetch): Promise<DownloadPlan> {
  const target = pluginTarget(targetValue)
  const items = new Map<string, DownloadItem>()
  const seen = new Map<string, string>()
  const incompatible = new Set<string>()
  const visit = async (item: Release) => {
    if (!compatible(item, target)) throw new InputError(`${item.name} does not support ${target.loader} on Minecraft ${target.gameVersion}`, 409)
    const previous = seen.get(item.projectId)
    if (previous) {
      if (previous !== item.id) throw new InputError('Required dependencies need conflicting versions. Install them manually.', 409)
      return
    }
    if (seen.size >= 20) throw new InputError('This plugin has too many dependencies for one installation', 409)
    seen.set(item.projectId, item.id)
    for (const dependency of item.dependencies) {
      if (!dependency || typeof dependency.dependency_type !== 'string') throw new InputError('Invalid Modrinth dependency', 502)
      if (dependency.dependency_type === 'incompatible' && dependency.project_id) incompatible.add(dependency.project_id)
      if (dependency.dependency_type !== 'required') continue
      let required: Release | undefined
      if (dependency.version_id) required = release(await json(`/version/${modrinthId(dependency.version_id)}`, fetcher))
      else if (dependency.project_id) required = (await releases(modrinthId(dependency.project_id), target, fetcher))[0]
      if (!required) throw new InputError(`A required dependency of ${item.name} has no compatible release on Modrinth. Check the project's dependency list.`, 409)
      await visit(required)
    }
    const jars = item.files.filter((file) => file && typeof file.filename === 'string' && file.filename.toLowerCase().endsWith('.jar'))
    const file = jars.find((file) => file.primary) ?? (jars.length === 1 ? jars[0] : undefined)
    if (!file || typeof file.url !== 'string' || !trustedDownload(file.url) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_PLUGIN_BYTES || !/^[a-f0-9]{128}$/i.test(file.hashes?.sha512 ?? '')) {
      throw new InputError(`${item.name} has no supported, verifiable plugin JAR`, 409)
    }
    validateUploadName(file.filename)
    // A stable name prevents installing two managed versions of the same project.
    items.set(item.projectId, { id: item.id, projectId: item.projectId, name: item.name, number: item.number, published: item.published, filename: `modrinth-${item.projectId}.jar`, size: file.size, sha512: file.hashes.sha512.toLowerCase(), url: file.url })
  }
  await visit(release(await json(`/version/${modrinthId(versionId)}`, fetcher)))
  if ([...incompatible].some((project) => items.has(project))) throw new InputError('This installation contains incompatible dependencies', 409)
  const result = [...items.values()]
  if (result.reduce((size, item) => size + item.size, 0) > 512 * 1024 * 1024) throw new InputError('This installation exceeds 512 MB', 413)
  const incompatibleProjects = [...incompatible].sort()
  const fingerprint = createHash('sha256').update(JSON.stringify({ target, items: result, incompatibleProjects })).digest('hex')
  return { items: result, fingerprint, incompatibleProjects }
}
