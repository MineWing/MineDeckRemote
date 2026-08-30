import assert from 'node:assert/strict'
import test from 'node:test'
import { appendMetricHistory, isAppTheme, memoryForMaximum, navigateConsoleHistory, serverFormDisabled, shortcutLabel, statusNotification, usesAppleShortcutKeys } from '../src/App.tsx'
import type { ServerView } from '../shared.ts'

test('server lifecycle notifications describe starts, restarts, stops, and crashes', () => {
  const server = { name: 'Survival', status: 'starting' as const, autoRestart: true }
  assert.equal(statusNotification(server, 'stopped')?.title, 'Starting server')
  assert.equal(statusNotification(server, 'stopped', true)?.title, 'Restarting server')
  assert.equal(statusNotification({ ...server, status: 'running' }, 'starting')?.tone, 'success')
  assert.equal(statusNotification({ ...server, status: 'stopped' }, 'stopping')?.title, 'Server stopped')
  assert.match(statusNotification({ ...server, status: 'crashed' }, 'running')?.message ?? '', /Automatic restart scheduled/)
})

test('new servers can be submitted while running servers cannot be edited', () => {
  assert.equal(serverFormDisabled(false), false)
  assert.equal(serverFormDisabled(true), true)
  assert.equal(serverFormDisabled(false, 'stopped'), false)
  assert.equal(serverFormDisabled(false, 'crashed'), false)
  assert.equal(serverFormDisabled(false, 'running'), true)
})

test('the RAM slider keeps minimum memory within the selected maximum', () => {
  assert.deepEqual(memoryForMaximum(1024, 4096), { minMemoryMb: 1024, maxMemoryMb: 4096 })
  assert.deepEqual(memoryForMaximum(8192, 4096), { minMemoryMb: 4096, maxMemoryMb: 4096 })
})

test('editor shortcut labels follow the browser platform', () => {
  assert.equal(usesAppleShortcutKeys('MacIntel'), true)
  assert.equal(usesAppleShortcutKeys('Windows'), false)
  assert.equal(shortcutLabel('s', 'macOS'), '⌘S')
  assert.equal(shortcutLabel('s', 'Win32'), 'Ctrl+S')
  assert.equal(shortcutLabel('f', 'Linux x86_64'), 'Ctrl+F')
})

test('only bundled dark themes are accepted', () => {
  assert.equal(isAppTheme('dracula'), true)
  assert.equal(isAppTheme('terminal'), true)
  assert.equal(isAppTheme('light'), false)
  assert.equal(isAppTheme(null), false)
})

test('resource history samples live metrics without duplicating rapid updates', () => {
  const server = { id: 'survival', cpuPercent: 12.5, memoryMb: 768 } as ServerView
  const initial = appendMetricHistory({}, [server], 10_000)
  const rapid = appendMetricHistory(initial, [{ ...server, cpuPercent: 20, memoryMb: 800 }], 10_500)
  const sampled = appendMetricHistory(rapid, [{ ...server, cpuPercent: 25, memoryMb: 820 }], 11_000)

  assert.deepEqual(rapid.survival, [{ at: 10_000, cpuPercent: 20, memoryMb: 800 }])
  assert.equal(sampled.survival?.length, 2)
  assert.deepEqual(sampled.survival?.at(-1), { at: 11_000, cpuPercent: 25, memoryMb: 820 })
})

test('console arrow keys navigate sent commands and restore the current draft', () => {
  const history = ['list', 'say hello', 'save-all']
  const draft = { command: 'whitelist ', index: null, draft: '' }
  const latest = navigateConsoleHistory(history, draft, 'up')
  const previous = navigateConsoleHistory(history, latest, 'up')
  const oldest = navigateConsoleHistory(history, navigateConsoleHistory(history, previous, 'up'), 'up')

  assert.deepEqual(latest, { command: 'save-all', index: 2, draft: 'whitelist ' })
  assert.equal(previous.command, 'say hello')
  assert.deepEqual(oldest, { command: 'list', index: 0, draft: 'whitelist ' })
  assert.equal(navigateConsoleHistory(history, oldest, 'down').command, 'say hello')
  assert.deepEqual(navigateConsoleHistory(history, latest, 'down'), { command: 'whitelist ', index: null, draft: '' })
})
