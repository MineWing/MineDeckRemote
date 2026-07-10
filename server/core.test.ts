import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveInside } from './core.ts'
import { ServerManager, type StoredData } from './manager.ts'

test('file paths stay inside a server directory, including through symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'minedeck-'))
  const outside = await mkdtemp(join(tmpdir(), 'minedeck-outside-'))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config', 'server.properties'), 'motd=MineDeck')
  assert.equal(await resolveInside(root, 'config/server.properties'), join(root, 'config', 'server.properties'))
  await assert.rejects(resolveInside(root, '../secret'))
  await symlink(outside, join(root, 'escape'), 'junction')
  await assert.rejects(resolveInside(root, 'escape'))
})

test('the same server JAR cannot be registered twice through path aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-server-'))
  await writeFile(join(directory, 'server.jar'), 'placeholder')
  const data: StoredData = { version: 1, servers: [], stats: {} }
  const manager = new ServerManager(data, async () => undefined, () => undefined)
  const config = {
    id: '', name: 'Survival', directory, jar: 'server.jar', javaPath: 'java', minMemoryMb: 1024, maxMemoryMb: 2048,
    javaArgs: [], autoRestart: true, stopTimeoutSeconds: 30, createdAt: new Date().toISOString(),
  }
  await manager.add(config)
  await assert.rejects(manager.add({ ...config, id: '', name: 'Alias', jar: './server.jar' }), /already managed/)
  await manager.shutdown()
})
