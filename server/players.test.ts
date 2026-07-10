import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normaliseUuid, playerCommand, readPlayers } from './players.ts'

const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5'

test('player records combine cache, operator, whitelist, ban, and online state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-players-'))
  await Promise.all([
    writeFile(join(directory, 'usercache.json'), JSON.stringify([{ uuid, name: 'Notch' }, { uuid: 'invalid', name: 'Ignored' }])),
    writeFile(join(directory, 'ops.json'), JSON.stringify([{ uuid, name: 'Notch', level: 4 }])),
    writeFile(join(directory, 'whitelist.json'), JSON.stringify([{ uuid, name: 'Notch' }])),
    writeFile(join(directory, 'banned-players.json'), '[]'),
  ])

  assert.deepEqual(await readPlayers(directory, ['notch']), [{
    uuid,
    username: 'Notch',
    isOnline: true,
    isOp: true,
    isWhitelisted: true,
    isBanned: false,
  }])
})

test('player UUIDs and management commands are strictly validated', () => {
  assert.equal(normaliseUuid('069A79F444E94726A5BEFCA90E38AAF5'), uuid)
  assert.equal(normaliseUuid('../not-a-uuid'), undefined)
  assert.equal(playerCommand('deop', 'Player_1'), 'deop Player_1')
  assert.equal(playerCommand('remove-whitelist', 'Player_1'), 'whitelist remove Player_1')
  assert.throws(() => playerCommand('ban', 'Player\nstop'))
  assert.throws(() => playerCommand('unknown', 'Player_1'))
})
