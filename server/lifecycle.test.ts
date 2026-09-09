import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ServerConfig, SocketEvent } from '../shared.ts'
import { ServerManager, type StoredData } from './manager.ts'

const fixture = async (delay = 0, timeout = 1) => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-lifecycle-'))
  const executable = join(directory, 'fake-java')
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('Done (0.1s)!\\n');\nprocess.stdin.on('data', () => setTimeout(() => process.exit(0), ${delay}));\n`, { mode: 0o755 })
  await writeFile(join(directory, 'server.jar'), 'fixture')
  const config: ServerConfig = { id: 'test', name: 'Test', directory, jar: 'server.jar', javaPath: executable, minMemoryMb: 128, maxMemoryMb: 256, javaArgs: [], autoRestart: false, stopTimeoutSeconds: timeout, createdAt: new Date().toISOString() }
  const data: StoredData = { version: 1, servers: [config], stats: {} }
  const events: SocketEvent[] = []
  let failSave = false
  const manager = new ServerManager(data, async () => { if (failSave) throw new Error('disk unavailable') }, (event) => events.push(event))
  return { manager, data, events, config, setFailure(value: boolean) { failSave = value } }
}

const waitUntil = async (condition: () => boolean) => {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Fixture did not reach expected state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('concurrent starts launch exactly one process and reject conflicting mutations', async () => {
  const { manager, config, events } = await fixture()
  try {
    const outcomes = await Promise.allSettled([
      manager.start(config.id), manager.start(config.id),
      manager.update(config.id, { ...config, name: 'Changed' }), manager.remove(config.id),
    ])
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'rejected', 'rejected', 'rejected'])
    assert.equal(events.filter((event) => event.type === 'console' && event.line.includes('MineDeck: starting')).length, 1)
    assert.equal(manager.list()[0]?.name, 'Test')
  } finally { await manager.shutdown() }
})

test('concurrent registration rejects a duplicate name or JAR target', async () => {
  const { manager, data, config } = await fixture()
  data.servers.length = 0
  try {
    const outcomes = await Promise.allSettled([manager.add({ ...config }), manager.add({ ...config, name: 'Second' })])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.equal(manager.list().length, 1)
  } finally { await manager.shutdown() }
})

test('failed registration, updates, and removals roll back and later operations recover', async () => {
  const { manager, data, config, setFailure } = await fixture()
  try {
    setFailure(true)
    await assert.rejects(manager.update(config.id, { ...config, name: 'Failed change' }), /disk unavailable/)
    assert.equal(manager.list()[0]?.name, 'Test')
    await assert.rejects(manager.remove(config.id), /disk unavailable/)
    assert.equal(manager.list().length, 1)
    data.servers.length = 0
    await assert.rejects(manager.add({ ...config }), /disk unavailable/)
    assert.equal(manager.list().length, 0)
    setFailure(false)
    await manager.add({ ...config })
    assert.equal(manager.list().length, 1)
  } finally { await manager.shutdown() }
})

test('shutdown lets a slow process exit after the old eight-second limit', async () => {
  const { manager, config, events } = await fixture(8_200, 10)
  try {
    await manager.start(config.id)
    await waitUntil(() => manager.list()[0]?.status === 'running')
    const start = Date.now()
    await manager.shutdown()
    assert.ok(Date.now() - start >= 8_000)
    assert.equal(manager.list()[0]?.pid, null)
    assert.ok(events.some((event) => event.type === 'console' && event.line === 'MineDeck: process exited with code 0'))
    assert.ok(!events.some((event) => event.type === 'console' && event.line.includes('force-killing')))
    await assert.rejects(manager.start(config.id), /shutting down/)
  } finally { await manager.shutdown() }
})

test('shutdown waits for forced exit at the configured stop deadline', async () => {
  const { manager, config, events } = await fixture(10_000, 0.1)
  try {
    await manager.start(config.id)
    await waitUntil(() => manager.list()[0]?.status === 'running')
    await manager.shutdown()
    assert.equal(manager.list()[0]?.pid, null)
    assert.ok(events.some((event) => event.type === 'console' && event.line.includes('(SIGKILL)')))
  } finally { await manager.shutdown() }
})

test('process-close persistence errors are contained and state changes are published', async () => {
  const { manager, config, events, setFailure } = await fixture()
  try {
    await writeFile(config.javaPath, `#!${process.execPath}\nprocess.exit(1)\n`, { mode: 0o755 })
    setFailure(true)
    await manager.start(config.id)
    await waitUntil(() => events.some((event) => event.type === 'console' && event.line.includes('could not save crash statistics')))
    assert.equal(manager.list()[0]?.status, 'crashed')
    setFailure(false)
    await manager.update(config.id, { ...config, name: 'Recovered' })
    assert.equal(manager.list()[0]?.name, 'Recovered')
  } finally { await manager.shutdown() }
})

test('console snapshot sequences match streamed lines across the retention limit', async () => {
  const { manager, config, events } = await fixture()
  try {
    await writeFile(config.javaPath, `#!${process.execPath}\nfor (let i = 0; i < 810; i++) console.log('fixture ' + i);\nprocess.stdin.on('data', () => process.exit(0));\n`, { mode: 0o755 })
    await manager.start(config.id)
    await waitUntil(() => events.some((event) => event.type === 'console' && event.line === 'fixture 809'))
    const snapshot = manager.getConsoleSnapshot(config.id)
    assert.equal(snapshot.entries.length, 800)
    const last = events.filter((event) => event.type === 'console').at(-1)!
    assert.equal(last.type, 'console')
    if (last.type === 'console') {
      assert.deepEqual(snapshot.entries.at(-1), { sequence: last.sequence, line: last.line })
      assert.equal(snapshot.epoch, last.epoch)
    }
  } finally { await manager.shutdown() }
})

test('stop and restart requests follow an in-flight start', async () => {
  const { manager, config } = await fixture()
  try {
    const [started] = await Promise.all([manager.start(config.id), manager.stop(config.id)])
    assert.ok(started.pid)
    const restarted = await manager.restart(config.id)
    assert.ok(restarted.pid)
    assert.notEqual(restarted.pid, started.pid)
    await manager.kill(config.id)
  } finally { await manager.shutdown() }
})

test('other persisted transactions observe rollback before saving', async () => {
  const { manager, config, setFailure } = await fixture()
  try {
    setFailure(true)
    const mutation = manager.update(config.id, { ...config, name: 'Uncommitted' })
    const accountTransaction = manager.transaction(async () => manager.list()[0]?.name)
    await assert.rejects(mutation, /disk unavailable/)
    assert.equal(await accountTransaction, 'Test')
  } finally { await manager.shutdown() }
})

test('force-kill during restart kills the old process and cancels its replacement', async () => {
  const { manager, config, events } = await fixture(10_000, 1)
  try {
    await manager.start(config.id)
    await waitUntil(() => manager.list()[0]?.status === 'running')
    const restarting = manager.restart(config.id)
    const rejected = assert.rejects(restarting, /cancelled/)
    await waitUntil(() => manager.list()[0]?.status === 'stopping')
    await manager.kill(config.id)
    await rejected
    assert.equal(manager.list()[0]?.pid, null)
    assert.equal(events.filter((event) => event.type === 'console' && event.line.includes('MineDeck: starting')).length, 1)
  } finally { await manager.shutdown() }
})

test('shutdown stops other servers while a restart is waiting for exit', async () => {
  const { manager, config, events } = await fixture(250, 1)
  await writeFile(join(config.directory, 'second.jar'), 'fixture')
  const second = await manager.add({ ...config, name: 'Second', jar: 'second.jar' })
  try {
    await manager.start(config.id)
    await manager.start(second.id)
    await waitUntil(() => manager.list().every((server) => server.status === 'running'))
    const restarting = manager.restart(config.id)
    const rejected = assert.rejects(restarting, /shutting down/)
    await waitUntil(() => manager.list()[0]?.status === 'stopping')
    await manager.shutdown()
    await rejected
    const secondStop = events.findIndex((event) => event.type === 'console' && event.serverId === second.id && event.line.includes('requesting a graceful stop'))
    const firstExit = events.findIndex((event) => event.type === 'console' && event.serverId === config.id && event.line.includes('process exited'))
    assert.ok(secondStop >= 0 && secondStop < firstExit)
    assert.ok(manager.list().every((server) => server.pid === null))
  } finally { await manager.shutdown() }
})

for (const action of ['stop', 'kill'] as const) {
  test(`${action} cancels a pending automatic restart after a crash`, async () => {
    const { manager, config, events } = await fixture()
    try {
      config.autoRestart = true
      await writeFile(config.javaPath, `#!${process.execPath}\nprocess.exit(1)\n`, { mode: 0o755 })
      await manager.start(config.id)
      await waitUntil(() => events.some((event) => event.type === 'console' && event.line.includes('automatic restart in 5 seconds')))
      assert.equal(manager.list()[0]?.pid, null)
      await manager[action](config.id)
      assert.equal(manager.list()[0]?.status, 'stopped')
      await assert.rejects(manager[action](config.id), /Server is not running/)
      await new Promise((resolve) => setTimeout(resolve, 5_100))
      assert.equal(manager.list()[0]?.pid, null)
      assert.equal(events.filter((event) => event.type === 'console' && event.line.includes('MineDeck: starting')).length, 1)
    } finally { await manager.shutdown() }
  })
}

test('stop cancels an automatic restart callback queued behind another transaction', async () => {
  const { manager, config, events } = await fixture()
  let release: (() => void) | undefined
  try {
    config.autoRestart = true
    await writeFile(config.javaPath, `#!${process.execPath}\nprocess.exit(1)\n`, { mode: 0o755 })
    await manager.start(config.id)
    await waitUntil(() => events.some((event) => event.type === 'console' && event.line.includes('automatic restart in 5 seconds')))
    const blocked = manager.transaction(() => new Promise<void>((resolve) => { release = resolve }))
    await waitUntil(() => Boolean(release))
    const stopping = manager.stop(config.id)
    await new Promise((resolve) => setTimeout(resolve, 5_100))
    release!()
    await blocked
    await stopping
    // Drain the callback that fired while the persistence queue was blocked.
    await manager.transaction(async () => {})
    assert.equal(manager.list()[0]?.status, 'stopped')
    assert.equal(manager.list()[0]?.pid, null)
    assert.equal(events.filter((event) => event.type === 'console' && event.line.includes('MineDeck: starting')).length, 1)
  } finally {
    release?.()
    await manager.shutdown()
  }
})
