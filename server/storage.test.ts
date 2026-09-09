import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSaveQueue, fileVersion, readEditableFile, saveEditableFile } from './storage.ts'

const max = 2 * 1024 * 1024

test('atomic saving supports filenames at the filesystem name limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-storage-'))
  const path = join(directory, `${'a'.repeat(250)}.txt`)
  await writeFile(path, 'old')
  await saveEditableFile(path, 'new', fileVersion('old'), max)
  assert.equal(await readFile(path, 'utf8'), 'new')
})

test('persistence queue reports a failed save and still runs queued and subsequent saves', async () => {
  const enqueue = createSaveQueue()
  const events: string[] = []
  const failed = enqueue(async () => { events.push('failed'); throw new Error('disk full') })
  const success = enqueue(async () => { events.push('recovered') })
  await assert.rejects(failed, /disk full/)
  await success
  await enqueue(async () => { events.push('later') })
  assert.deepEqual(events, ['failed', 'recovered', 'later'])
})

test('atomic save replaces complete content, preserves mode, and returns the new version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-storage-'))
  const path = join(directory, 'server.properties')
  await writeFile(path, 'old', { mode: 0o640 })
  const original = await readEditableFile(path, max)
  const version = await saveEditableFile(path, 'new', original.version, max)
  assert.equal(await readFile(path, 'utf8'), 'new')
  assert.equal(version, fileVersion('new'))
  assert.equal((await stat(path)).mode & 0o777, 0o640)
  assert.deepEqual(await readdir(directory), ['server.properties'])
})

test('concurrent editors cannot both save the same version and rejected saves leave contents intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-storage-'))
  const path = join(directory, 'server.properties')
  await writeFile(path, 'original')
  const contents = ['first', 'second']
  const results = await Promise.allSettled(contents.map((content) =>
    saveEditableFile(path, content, fileVersion('original'), max),
  ))
  // Path resolution can finish in either order before writers enter the save queue.
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0]!.reason.statusCode, 409)
  const winner = contents[results.findIndex((result) => result.status === 'fulfilled')]!
  assert.equal(fulfilled[0]!.value, fileVersion(winner))
  assert.equal(await readFile(path, 'utf8'), winner)
  await saveEditableFile(path, 'third', fileVersion(winner), max)
  assert.equal(await readFile(path, 'utf8'), 'third')
})

test('external changes conflict, missing files require a null version, and symlinks are refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-storage-'))
  const path = join(directory, 'server.properties')
  await writeFile(path, 'external')
  await assert.rejects(saveEditableFile(path, 'overwrite', fileVersion('old'), max), { statusCode: 409 })
  assert.equal(await readFile(path, 'utf8'), 'external')
  await assert.rejects(saveEditableFile(join(directory, 'missing'), 'new', fileVersion('old'), max), { statusCode: 409 })
  await saveEditableFile(join(directory, 'new'), 'new', null, max)
  await symlink(path, join(directory, 'link'))
  await assert.rejects(saveEditableFile(join(directory, 'link'), 'overwrite', fileVersion('external'), max))
  assert.equal(await readFile(path, 'utf8'), 'external')
})

test('parent directory aliases share the same file save lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-storage-'))
  const alias = `${directory}-alias`
  await symlink(directory, alias)
  const path = join(directory, 'server.properties')
  await writeFile(path, 'original')
  const results = await Promise.allSettled([
    saveEditableFile(path, 'first', fileVersion('original'), max),
    saveEditableFile(join(alias, 'server.properties'), 'second', fileVersion('original'), max),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = results.find((result) => result.status === 'rejected')
  assert.equal(rejected?.reason.statusCode, 409)
})
