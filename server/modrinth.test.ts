import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planPlugins, pluginVersions, searchPlugins, pluginTarget, trustedDownload, modrinthGameVersions, type Fetcher } from './modrinth.ts'
import { installPlugins } from './plugins.ts'

const target = { loader: 'paper', gameVersion: '1.21.11' }
const bytes = Buffer.from('test-only plugin JAR bytes')
const checksum = createHash('sha512').update(bytes).digest('hex')
const release = (id = 'Version1', project = 'Project1') => ({ id, project_id: project, name: `${project} release`, version_number: '1.0', date_published: '2026-01-01', version_type: 'release', loaders: ['paper'], game_versions: ['1.21.11'], dependencies: [] as { dependency_type: string; project_id: string | null; version_id: string | null }[], files: [{ primary: true, filename: 'plugin.jar', size: bytes.length, hashes: { sha512: checksum }, url: `https://cdn.modrinth.com/data/${project}/versions/${id}/plugin.jar` }] })
const mock = (versions = [release()], downloadBytes: Buffer = bytes): Fetcher => async (input, init) => {
  assert.equal(init?.redirect, 'error')
  assert.ok((init?.headers as Record<string, string>)['User-Agent']?.startsWith('MineDeck/'))
  const url = new URL(String(input))
  if (url.hostname === 'cdn.modrinth.com') return new Response(Uint8Array.from(downloadBytes))
  const id = url.pathname.split('/').at(-1)
  if (url.pathname.includes('/project/')) return Response.json(versions.filter((item) => item.project_id === url.pathname.split('/')[3]))
  const item = versions.find((item) => item.id === id)
  return item ? Response.json(item) : new Response('', { status: 404 })
}

test('Modrinth search uses loader/version facets and preserves plugin/mod hybrid projects', async () => {
  const fetcher: Fetcher = async (input) => {
    const url = new URL(String(input))
    assert.deepEqual(JSON.parse(url.searchParams.get('facets')!), [['categories:paper'], ['versions:1.21.11']])
    assert.equal(url.searchParams.get('query'), 'permissions & ranks')
    assert.equal(url.searchParams.get('offset'), '20')
    return Response.json({ hits: [{ project_id: 'Project1', slug: 'permissions', title: 'Permissions', description: 'Ranks', author: 'Author', downloads: 50, project_type: 'mod' }], total_hits: 21 })
  }
  const result = await searchPlugins('permissions & ranks', target, 20, fetcher)
  assert.equal(result.projects[0]?.id, 'Project1')
  assert.equal(result.total, 21)
  await assert.rejects(searchPlugins('x', target, -1, fetcher), /search page/)
  assert.throws(() => pluginTarget({ loader: 'fabric', gameVersion: '1.21.11' }), /Choose a plugin/)
})

test('search preserves trusted icons and handles missing or untrusted icons', async () => {
  const icons = ['https://cdn.modrinth.com/data/Project1/icon.webp', null, 'https://example.com/icon.png', 'http://cdn.modrinth.com/data/icon.png']
  const fetcher: Fetcher = async () => Response.json({ hits: icons.map((icon_url, index) => ({ project_id: `Project${index}`, slug: `plugin-${index}`, title: 'Plugin', description: 'Description', author: 'Author', downloads: 50, icon_url })), total_hits: icons.length })
  assert.deepEqual((await searchPlugins('', target, 0, fetcher)).projects.map((project) => project.iconUrl), [icons[0], null, null, null])
})

test('versions exclude prereleases and incompatible loaders even if the API returns them', async () => {
  const stable = release()
  const beta = { ...release('Beta'), version_type: 'beta' }
  const fabric = { ...release('Fabric'), loaders: ['fabric'] }
  assert.deepEqual((await pluginVersions('Project1', target, mock([stable, beta, fabric]))).map((item) => item.id), ['Version1'])
})

test('required dependencies are planned once, before the requested plugin; optional dependencies are skipped', async () => {
  const root = release()
  root.dependencies = [{ project_id: 'Project2', version_id: null, dependency_type: 'required' }, { project_id: 'Optional', version_id: null, dependency_type: 'optional' }]
  const dependency = release('Version2', 'Project2')
  const plan = await planPlugins(root.id, target, mock([root, dependency]))
  assert.deepEqual(plan.items.map((item) => item.projectId), ['Project2', 'Project1'])
  assert.equal(plan.fingerprint.length, 64)
  assert.equal(plan.items[0]?.filename, 'modrinth-Project2.jar')
})

test('missing, incompatible and conflicting required dependencies cannot be installed', async () => {
  const root = release()
  root.dependencies = [{ project_id: 'Missing', version_id: null, dependency_type: 'required' }]
  await assert.rejects(planPlugins(root.id, target, mock([root])), /no compatible release/)
  root.dependencies = [{ project_id: 'Project2', version_id: 'Version2', dependency_type: 'required' }]
  await assert.rejects(planPlugins(root.id, target, mock([root, { ...release('Version2', 'Project2'), loaders: ['fabric'] }])), /does not support/)
  root.dependencies.push({ project_id: 'Project2', version_id: 'Version3', dependency_type: 'required' })
  await assert.rejects(planPlugins(root.id, target, mock([root, release('Version2', 'Project2'), release('Version3', 'Project2')])), /conflicting versions/)
})

test('downloads only accept Modrinth CDN URLs and verified safe JAR metadata', async () => {
  for (const url of ['http://cdn.modrinth.com/data/x', 'https://evil.com/plugin.jar', 'https://cdn.modrinth.com.evil.com/data/x', 'https://user@cdn.modrinth.com/data/x', 'https://cdn.modrinth.com:8443/data/x']) assert.equal(trustedDownload(url), false)
  const root = release()
  root.files[0]!.filename = '../plugin.jar'
  await assert.rejects(planPlugins(root.id, target, mock([root])), /invalid file name/)
  root.files[0]!.filename = 'plugin.jar'
  root.files[0]!.hashes.sha512 = 'incorrect'
  await assert.rejects(planPlugins(root.id, target, mock([root])), /verifiable/)
})

test('installation verifies bytes, recognizes repeat installs and refuses to overwrite another version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-plugins-'))
  const fetcher = mock()
  const plan = await planPlugins('Version1', target, fetcher)
  const body = { ...target, versionId: 'Version1', fingerprint: plan.fingerprint }
  const result = await installPlugins(directory, body, fetcher)
  assert.deepEqual(result.installed, ['modrinth-Project1.jar'])
  assert.deepEqual(await readFile(join(directory, 'plugins/modrinth-Project1.jar')), bytes)
  assert.deepEqual((await installPlugins(directory, body, fetcher)).alreadyInstalled, ['modrinth-Project1.jar'])
  await writeFile(join(directory, 'plugins/modrinth-Project1.jar'), 'older version')
  await assert.rejects(installPlugins(directory, body, fetcher), /another version/)
  assert.equal(await readFile(join(directory, 'plugins/modrinth-Project1.jar'), 'utf8'), 'older version')
})

test('a hash mismatch or changed plan leaves no loadable JAR behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-plugins-'))
  const plan = await planPlugins('Version1', target, mock())
  const body = { ...target, versionId: 'Version1', fingerprint: plan.fingerprint }
  await assert.rejects(installPlugins(directory, { ...body, fingerprint: 'stale' }, mock()), /changed/)
  await assert.rejects(installPlugins(directory, body, mock(undefined, Buffer.alloc(bytes.length))), /integrity/)
  assert.deepEqual(await readdir(join(directory, 'plugins')), [])
})

test('plugin directories cannot point outside the server and manual identical JARs are recognized', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-plugins-'))
  const outside = await mkdtemp(join(tmpdir(), 'minedeck-plugins-outside-'))
  await symlink(outside, join(directory, 'plugins'))
  const plan = await planPlugins('Version1', target, mock())
  const body = { ...target, versionId: 'Version1', fingerprint: plan.fingerprint }
  await assert.rejects(installPlugins(directory, body, mock()), /Symbolic link leaves/)
  assert.deepEqual(await readdir(outside), [])
  const manual = await mkdtemp(join(tmpdir(), 'minedeck-plugins-manual-'))
  await mkdir(join(manual, 'plugins'))
  await writeFile(join(manual, 'plugins/custom-name.jar'), bytes)
  assert.deepEqual((await installPlugins(manual, body, mock())).alreadyInstalled, ['custom-name.jar'])
})

test('Modrinth errors are actionable and the release catalog excludes snapshots', async () => {
  await assert.rejects(modrinthGameVersions(async () => new Response('', { status: 429 })), /rate limiting/)
  await assert.rejects(modrinthGameVersions(async () => new Response('not json')), /read its response/)
  assert.deepEqual(await modrinthGameVersions(async () => Response.json([{ version: '1.21.11', version_type: 'release' }, { version: '26w01a', version_type: 'snapshot' }])), ['1.21.11'])
})

test('server installation ignores forged compatibility fields and rejects a plugin for another Minecraft version', async () => {
  const { paperJar } = await import('./plugin-fixtures.ts')
  const { installServerPlugins } = await import('./plugins.ts')
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-enforce-target-'))
  await writeFile(join(directory, 'server.jar'), paperJar)
  const wrong = { ...release(), game_versions: ['1.20.6'] }
  const wrongTarget = { loader: 'paper', gameVersion: '1.20.6' }
  const plan = await planPlugins(wrong.id, wrongTarget, mock([wrong]))
  const config = { id: 'fixture', name: 'Fixture', directory, jar: 'server.jar', javaPath: 'java', javaArgs: [], minMemoryMb: 256, maxMemoryMb: 512, autoRestart: false, stopTimeoutSeconds: 5, createdAt: '' }
  await assert.rejects(installServerPlugins(config, { ...wrongTarget, versionId: wrong.id, fingerprint: plan.fingerprint }, mock([wrong])), /does not support paper on Minecraft 1.21.11/)
  assert.deepEqual(await readdir(directory), ['server.jar'])
})

test('a changed server version during download prevents publishing a plugin', async () => {
  const { paperJar, olderPaperJar } = await import('./plugin-fixtures.ts')
  const { installServerPlugins } = await import('./plugins.ts')
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-changing-target-'))
  await writeFile(join(directory, 'server.jar'), paperJar)
  const normal = mock()
  const changed: Fetcher = async (input, init) => {
    if (String(input).startsWith('https://cdn.modrinth.com/')) await writeFile(join(directory, 'server.jar'), olderPaperJar)
    return normal(input, init)
  }
  const plan = await planPlugins('Version1', target, normal)
  const config = { id: 'fixture', name: 'Fixture', directory, jar: 'server.jar', javaPath: 'java', javaArgs: [], minMemoryMb: 256, maxMemoryMb: 512, autoRestart: false, stopTimeoutSeconds: 5, createdAt: '' }
  await assert.rejects(installServerPlugins(config, { versionId: 'Version1', fingerprint: plan.fingerprint }, changed), /server version changed/)
  assert.deepEqual(await readdir(join(directory, 'plugins')), [])
})

test('a failed dependency download publishes none of the planned plugins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-dependency-failure-'))
  const root = release()
  root.dependencies = [{ project_id: 'Dependency', version_id: 'DependencyVersion', dependency_type: 'required' }]
  const dependency = release('DependencyVersion', 'Dependency')
  const fetcher = mock([root, dependency])
  const plan = await planPlugins(root.id, target, fetcher)
  const broken: Fetcher = async (input, init) => String(input).includes('/data/Project1/') ? new Response(Uint8Array.from(Buffer.alloc(bytes.length))) : fetcher(input, init)
  await assert.rejects(installPlugins(directory, { ...target, versionId: root.id, fingerprint: plan.fingerprint }, broken), /integrity/)
  assert.deepEqual(await readdir(join(directory, 'plugins')), [])
})
