import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectPluginTarget, targetFromMetadata } from './plugin-target.ts'

import { paperJar, olderPaperJar, vanillaJar } from './plugin-fixtures.ts'

test('server compatibility comes from its JAR metadata, regardless of filename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-target-'))
  await writeFile(join(directory, 'renamed.jar'), paperJar)
  assert.deepEqual(await detectPluginTarget({ directory, jar: 'renamed.jar' }), { loader: 'paper', gameVersion: '1.21.11' })
  await writeFile(join(directory, 'renamed.jar'), olderPaperJar)
  assert.deepEqual(await detectPluginTarget({ directory, jar: 'renamed.jar' }), { loader: 'paper', gameVersion: '1.20.6' })
})

test('unknown or vanilla servers cannot select an arbitrary plugin target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-target-'))
  await writeFile(join(directory, 'paper.jar'), vanillaJar)
  await assert.rejects(detectPluginTarget({ directory, jar: 'paper.jar' }), /Could not detect/)
  await writeFile(join(directory, 'paper.jar'), 'not a zip')
  await assert.rejects(detectPluginTarget({ directory, jar: 'paper.jar' }), /Could not detect/)
})

test('startup logs identify supported legacy servers but stale logs cannot override a replacement JAR', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-target-'))
  await writeFile(join(directory, 'server.jar'), vanillaJar)
  await mkdir(join(directory, 'logs'))
  const log = '[00:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.11\n[00:00:01] [Server thread/INFO]: This server is running Spigot version example\n'
  await writeFile(join(directory, 'logs/latest.log'), log)
  await utimes(join(directory, 'server.jar'), 100, 100)
  assert.deepEqual(await detectPluginTarget({ directory, jar: 'server.jar' }), { loader: 'spigot', gameVersion: '1.21.11' })
  await utimes(join(directory, 'logs/latest.log'), 50, 50)
  await assert.rejects(detectPluginTarget({ directory, jar: 'server.jar' }), /Could not detect/)
})

test('fork detection prefers current Folia output without substituting a different Minecraft version', () => {
  const metadata = new Map([['version.json', '{"id":"1.21.11"}'], ['META-INF/versions.list', 'hash\t1.21.11\t1.21.11/paper-1.21.11.jar']])
  const log = '[00:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.11\n[00:00:01] [Server thread/INFO]: This server is running Folia version example'
  assert.deepEqual(targetFromMetadata(metadata, log), { loader: 'folia', gameVersion: '1.21.11' })
  assert.deepEqual(targetFromMetadata(metadata, log.replace('version 1.21.11', 'version 1.20.6')), { loader: 'paper', gameVersion: '1.21.11' })
})
