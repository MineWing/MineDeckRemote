import assert from 'node:assert/strict'
import test from 'node:test'
import { appendMetricHistory, serverFormDisabled, shortcutLabel, statusNotification, usesAppleShortcutKeys } from '../src/App.tsx'
import type { ServerView } from '../shared.ts'

test('server lifecycle notifications describe starts, restarts, stops, and crashes', () => {
  const server = { name: 'Survival', status: 'starting' as const, autoRestart: true }
  assert.equal(statusNotification(server, 'stopped')?.title, 'Starting server')
  assert.equal(statusNotification(server, 'stopped', true)?.title, 'Restarting server')
  assert.equal(statusNotification({ ...server, status: 'running' }, 'starting')?.tone, 'success')
  assert.equal(statusNotification({ ...server, status: 'stopped' }, 'stopping')?.title, 'Server stopped')
  assert.match(statusNotification({ ...server, status: 'crashed' }, 'running')?.message ?? '', /Restarting in 5 seconds/)
})

test('new servers can be submitted while running servers cannot be edited', () => {
  assert.equal(serverFormDisabled(false), false)
  assert.equal(serverFormDisabled(true), true)
  assert.equal(serverFormDisabled(false, 'stopped'), false)
  assert.equal(serverFormDisabled(false, 'crashed'), false)
  assert.equal(serverFormDisabled(false, 'running'), true)
})

test('editor shortcut labels follow the browser platform', () => {
  assert.equal(usesAppleShortcutKeys('MacIntel'), true)
  assert.equal(usesAppleShortcutKeys('Windows'), false)
  assert.equal(shortcutLabel('s', 'macOS'), '⌘S')
  assert.equal(shortcutLabel('s', 'Win32'), 'Ctrl+S')
  assert.equal(shortcutLabel('f', 'Linux x86_64'), 'Ctrl+F')
})

test('resource history samples live metrics without duplicating rapid updates', () => {
  const server = { id: 'survival', cpuPercent: 12.5, memoryMb: 768 } as ServerView
  const initial = appendMetricHistory({}, [server], 10_000)
  const rapid = appendMetricHistory(initial, [{ ...server, cpuPercent: 20, memoryMb: 800 }], 10_500)
  const sampled = appendMetricHistory(rapid, [{ ...server, cpuPercent: 25, memoryMb: 820 }], 12_000)

  assert.deepEqual(rapid.survival, [{ at: 10_000, cpuPercent: 20, memoryMb: 800 }])
  assert.equal(sampled.survival?.length, 2)
  assert.deepEqual(sampled.survival?.at(-1), { at: 12_000, cpuPercent: 25, memoryMb: 820 })
})
