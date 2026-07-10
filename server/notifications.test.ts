import assert from 'node:assert/strict'
import test from 'node:test'
import { statusNotification } from '../src/App.tsx'

test('server lifecycle notifications describe starts, restarts, stops, and crashes', () => {
  const server = { name: 'Survival', status: 'starting' as const, autoRestart: true }
  assert.equal(statusNotification(server, 'stopped')?.title, 'Starting server')
  assert.equal(statusNotification(server, 'stopped', true)?.title, 'Restarting server')
  assert.equal(statusNotification({ ...server, status: 'running' }, 'starting')?.tone, 'success')
  assert.equal(statusNotification({ ...server, status: 'stopped' }, 'stopping')?.title, 'Server stopped')
  assert.match(statusNotification({ ...server, status: 'crashed' }, 'running')?.message ?? '', /Restarting in 5 seconds/)
})
