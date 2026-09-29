import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acceptEula, readEula } from './eula.ts'

test('EULA parsing ignores comments and preserves CRLF and other settings on acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-eula-'))
  assert.equal(await readEula(directory), undefined)
  const path = join(directory, 'eula.txt')
  await writeFile(path, '# eula=true\r\n  eula = false\r\nother=false\r\n')
  assert.equal((await readEula(directory))?.required, true)
  await acceptEula(directory)
  assert.equal(await readFile(path, 'utf8'), '# eula=true\r\n  eula = true\r\nother=false\r\n')
  assert.equal((await readEula(directory))?.required, false)
  await acceptEula(directory)
})

test('EULA acceptance cannot follow a link outside the server directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-eula-'))
  const outside = await mkdtemp(join(tmpdir(), 'minedeck-eula-outside-'))
  const target = join(outside, 'eula.txt')
  await writeFile(target, 'eula=false\n')
  await symlink(target, join(directory, 'eula.txt'))
  await assert.rejects(acceptEula(directory), /Symbolic link leaves/)
  assert.equal(await readFile(target, 'utf8'), 'eula=false\n')
})
