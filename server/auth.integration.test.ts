import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'

// Keep isolated data fixtures for inspection; never touch the user's host/data.
test('host contains malformed upgrades and protocol errors, rejects foreign origins, and revokes live sessions', { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-auth-'))
  const password = 'isolated-test-password'
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, NODE_ENV: 'test', MINEDECK_DATA: join(directory, 'data.json'), MINEDECK_HOST: '127.0.0.1', MINEDECK_PORT: '0', MINEDECK_PASSWORD: password, MINEDECK_MDNS_HOST: '', MINEDECK_TLS_CERT: '', MINEDECK_TLS_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const sockets: WebSocket[] = []
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit')
      child.kill('SIGTERM')
      await stopped
    }
  })
  const base = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Host startup timed out: ${output}`)), 10_000)
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Host exited: ${output}`)) })
    child.stdout.on('data', () => {
      const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      if (address) { clearTimeout(timeout); resolve(address) }
    })
  })
  const connect = (cookie: string, origin?: string) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } })
    socket.on('error', () => undefined)
    sockets.push(socket)
    return socket
  }
  const rejectUpgrade = async (cookie: string, origin?: string) => {
    const socket = connect(cookie, origin)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); socket.terminate() })
      socket.once('open', () => reject(new Error('Unauthenticated socket connected')))
      socket.once('error', reject)
    })
    assert.equal(status, 401)
  }
  await rejectUpgrade('md_session=%')
  assert.equal((await fetch(base + '/api/auth/session')).status, 200)
  const login = async () => {
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  let cookie = await login()
  await rejectUpgrade(cookie, 'https://unrelated.invalid')
  const socket = connect(cookie, base)
  await once(socket, 'open')
  const closed = once(socket, 'close')
  assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 200)
  await closed
  assert.equal((await fetch(base + '/api/servers', { headers: { Cookie: cookie } })).status, 401)
  cookie = await login()
  const second = connect(cookie, base)
  await once(second, 'open')
  const incorrect = await fetch(base + '/api/auth/password', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'incorrect-password', newPassword: 'replacement-password' }) })
  assert.equal(incorrect.status, 403)
  assert.equal((await fetch(base + '/api/servers', { headers: { Cookie: cookie } })).status, 200)
  assert.equal(second.readyState, WebSocket.OPEN)
  const revoked = once(second, 'close')
  const changed = await fetch(base + '/api/auth/password', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: password, newPassword: 'replacement-password' }) })
  assert.equal(changed.status, 200)
  await revoked
  assert.equal((await fetch(base + '/api/servers', { headers: { Cookie: cookie } })).status, 401)
  const currentCookie = changed.headers.get('set-cookie')!.split(';')[0]!
  const protocol = connect(currentCookie, base)
  await once(protocol, 'open')
  const protocolClosed = once(protocol, 'close')
  // An unmasked client frame violates the WebSocket protocol; the host must survive.
  const transport = (protocol as unknown as { _socket: { write(data: Buffer): void } })._socket
  transport.write(Buffer.from([0x81, 0x01, 0x61]))
  await protocolClosed
  assert.equal((await fetch(base + '/api/auth/session')).status, 200)
  assert.equal(child.exitCode, null)
})
